#!/usr/bin/env node
// Site check: makes real demo videos of real websites with Stand-in, the way a person would, and reports
// how long each took from start to finished video and what went wrong. Run it after changes:
//
//   node scripts/site-check.mjs                 all sites, visible Chrome
//   node scripts/site-check.mjs wikipedia mdn   only these
//   node scripts/site-check.mjs --headless      without a display (CI)
//
// For each site it runs the real command-line recorder, waits for "Ready", presses Shift twice, performs
// the demo with real (trusted) mouse and keyboard input, presses Shift twice again, and waits for "Your
// video is ready". Then it replays the saved plan. Results go to .runs/site-check-<time>/report.md.
// Sites change: a failure is a lead to look at, not proof of a bug.

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recorder = join(root, 'tools', 'recorder', 'record.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A person's pace: move to things before clicking, type at a readable speed, pause to look.
function person(page) {
  const point = async locator => {
    await locator.first().waitFor({state: 'visible', timeout: 15000});
    await locator.first().scrollIntoViewIfNeeded();
    const box = await locator.first().boundingBox();
    return {x: box.x + box.width / 2, y: box.y + box.height / 2};
  };
  return {
    async click(locator) {
      const {x, y} = await point(locator);
      await page.mouse.move(x, y, {steps: 12});
      await sleep(250);
      await page.mouse.click(x, y);
    },
    async hover(locator) {
      const {x, y} = await point(locator);
      await page.mouse.move(x, y, {steps: 12});
      await sleep(900);
    },
    async type(text) { await page.keyboard.type(text, {delay: 90}); },
    async press(key) { await page.keyboard.press(key); },
    async scroll(dy, times = 6) { for (let i = 0; i < times; i++) { await page.mouse.wheel(0, dy); await sleep(80); } },
    async look(ms = 1500) { await sleep(ms); },
  };
}

// Each site: where to start and what a short demo there looks like. Keep them short and robust.
const SITES = {
  wikipedia: {url: 'wikipedia.org', async demo(page, p) {
    await p.click(page.getByLabel('Search Wikipedia'));
    await p.type('Apollo 11');
    await p.press('Enter');
    await page.waitForURL(/wiki\/Apollo_11/, {timeout: 20000});
    await p.look();
    await p.scroll(400);
    await p.look();
  }},
  github: {url: 'github.com/microsoft/vscode', async demo(page, p) {
    await p.click(page.getByRole('link', {name: 'Issues', exact: false}).first());
    await page.waitForURL(/issues/, {timeout: 20000});
    await p.look();
    await p.click(page.getByRole('link', {name: 'Code', exact: true}).first());
    await p.look();
    await p.scroll(500);
  }},
  mdn: {url: 'developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat', async demo(page, p) {
    await p.click(page.getByRole('button', {name: 'Run'}).first()); // inside a web component
    await p.look();
    await p.scroll(500);
    await p.look();
  }},
  hackernews: {url: 'news.ycombinator.com', async demo(page, p) {
    await p.click(page.getByRole('link', {name: 'new', exact: true}));
    await p.look();
    await p.click(page.getByRole('link', {name: 'past', exact: true}));
    await p.look();
  }},
  weather: {url: 'forecast.weather.gov/MapClick.php?lat=42.3912&lon=-71.5681', async demo(page, p) {
    await p.scroll(500);
    await p.look();
    await p.click(page.getByRole('link', {name: /Hourly Weather Forecast/}).first());
    await page.waitForLoadState('load');
    await p.look(2500);
  }},
  // weather.gov's top menus open when you point at them; their links are hidden until then.
  menu: {url: 'www.weather.gov', async demo(page, p) {
    await p.look();
    await p.hover(page.getByRole('link', {name: 'FORECAST', exact: true}));
    await p.click(page.getByRole('link', {name: 'Graphical', exact: true}));
    await page.waitForURL(u => !/^https:\/\/www\.weather\.gov\/?$/.test(u.href), {timeout: 20000});
    await p.look(2000);
  }},
  // weather.gov's "Read More" link opens a new tab; Stand-in should keep it in the recorded tab.
  newtab: {url: 'www.weather.gov', async demo(page, p) {
    await p.look();
    await p.click(page.getByRole('link', {name: /Read More/}).first());
    await page.waitForURL(/noaa\.gov/, {timeout: 20000});
    if (page.context().pages().length !== 1) throw new Error('The link opened a separate tab.');
    await p.look(2000);
    await p.scroll(400);
  }},
  duckduckgo: {url: 'duckduckgo.com', async demo(page, p) {
    await p.click(page.locator('input[name="q"], textarea[name="q"]').first());
    await p.type('mdn array flat');
    await p.press('Enter');
    await page.waitForURL(/[?&]q=/, {timeout: 20000});
    await p.look(2500);
    await p.scroll(400);
  }},
  bbc: {url: 'bbc.com', async demo(page, p) {
    await p.look(2000);
    await p.scroll(500, 8);
    await p.look();
    await p.scroll(-500, 4);
  }},
};

async function freePort() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const {port} = server.address();
  await new Promise(r => server.close(r));
  return port;
}

// Runs the recorder; resolves when `pattern` appears in its output. Returns helpers to wait for more.
function run(args, cwd, env) {
  const child = spawn(process.execPath, [recorder, ...args], {cwd, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  const proc = {child, output: '', exited: once(child, 'close').then(([code]) => code)};
  const waiters = [];
  const read = data => {
    proc.output += data;
    for (const w of [...waiters]) if (w.pattern.test(proc.output)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  proc.waitFor = (pattern, ms) => new Promise((resolve, reject) => {
    if (pattern.test(proc.output)) return resolve();
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), ms);
    waiters.push({pattern, resolve: () => { clearTimeout(timer); resolve(); }});
    proc.exited.then(code => { clearTimeout(timer); if (!pattern.test(proc.output)) reject(new Error(`exited (${code}) before ${pattern}`)); });
  });
  return proc;
}

// Stand-in's start/stop shortcut, the way a person presses it.
async function doubleShift(page) {
  // Like a keyboard: each key event carries the time it was pressed, so a page busy loading can't make the
  // two taps look further apart than they were.
  const cdp = await page.context().newCDPSession(page);
  const now = Date.now() / 1000;
  const key = {key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16};
  await Promise.all([
    cdp.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...key, timestamp: now}),
    cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', ...key, timestamp: now + 0.06}),
    cdp.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', ...key, timestamp: now + 0.18}),
    cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', ...key, timestamp: now + 0.24}),
  ]);
  await cdp.detach().catch(() => {});
}

async function checkSite(name, site, {headless, out}) {
  const cwd = join(out, name);
  await mkdir(cwd, {recursive: true});
  const port = await freePort();
  // Stand-in's own Chrome, plus a debugging port so this script can act in the page like a person.
  const {findChrome} = await import(recorder);
  const chrome = await findChrome(process.env.CHROME_PATH);
  const wrapper = join(out, `${name}-chrome.sh`);
  await writeFile(wrapper, `#!/bin/sh\nexec '${chrome.replaceAll("'", "'\\''")}' ${headless ? '--headless=new ' : ''}--remote-debugging-port=${port} "$@"\n`,
    {mode: 0o755});
  const result = {site: name, url: site.url, steps: [], ok: false};
  const t0 = Date.now();
  const mark = step => result.steps.push({step, at: (Date.now() - t0) / 1000});
  const live = run([site.url, '--chrome', wrapper], cwd);
  let browser;
  try {
    await live.waitFor(/Ready\./, 60000);
    mark('ready');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages().find(p => !p.url().startsWith('devtools')) ?? browser.contexts()[0].pages()[0];
    await page.bringToFront();
    await doubleShift(page);
    await live.waitFor(/Recording this tab/, 15000);
    mark('recording');
    await site.demo(page, person(page));
    mark('demo done');
    await doubleShift(page);
    await live.waitFor(/Your video is ready|ERROR/, 180000);
    const code = await live.exited;
    mark('video ready');
    if (code !== 0) throw new Error(`recorder exited with ${code}`);
    const [video] = await readdir(join(cwd, 'recordings'));
    const [plan] = await readdir(join(cwd, 'demos'));
    const bytes = await readFile(join(cwd, 'recordings', video));
    result.video = {file: join(name, 'recordings', video), mb: +(bytes.length / 1e6).toFixed(1), h264: bytes.includes('avcC')};
    result.length = /Your video is ready: \S+ \(([^)]*)\)/.exec(live.output)?.[1] ?? '';
    result.plan = join(name, 'demos', plan);
    result.ok = result.video.h264;
    // The plan should replay too.
    const replay = run(['replay', join(cwd, 'demos', plan), ...(headless ? ['--headless'] : [])], cwd);
    const replayCode = await replay.exited;
    mark('replay done');
    result.replay = replayCode === 0 ? 'ok' : (/ERROR: ([^\n]*)/.exec(replay.output)?.[1] ?? `exited ${replayCode}`);
    result.replayOutput = replay.output;
  } catch (error) {
    result.error = error.message;
  } finally {
    await browser?.close().catch(() => {});
    if (live.child.exitCode === null) live.child.kill('SIGKILL');
    result.output = live.output;
    result.seconds = (Date.now() - t0) / 1000;
  }
  return result;
}

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const chosen = args.filter(a => !a.startsWith('--'));
const names = chosen.length ? chosen : Object.keys(SITES);
const unknown = names.filter(n => !SITES[n]);
if (unknown.length) { console.error(`Unknown sites: ${unknown.join(', ')}. Choose from: ${Object.keys(SITES).join(', ')}`); process.exit(2); }
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = join(root, '.runs', `site-check-${stamp}`);
await mkdir(out, {recursive: true});
const results = [];
for (const name of names) {
  process.stdout.write(`${name.padEnd(12)} `);
  const r = await checkSite(name, SITES[name], {headless, out});
  results.push(r);
  const at = s => r.steps.find(x => x.step === s)?.at;
  console.log(r.ok ? `video in ${(at('video ready') - at('demo done')).toFixed(1)} s after stopping${r.length ? ` (${r.length})` : ''}; replay ${r.replay}`
    : `FAILED: ${r.error ?? 'no H.264 video'}`);
}
const lines = ['# Stand-in site check', '', `${new Date().toLocaleString()} · ${headless ? 'headless' : 'visible'} Chrome`, '',
  '| Site | Video | Ready after launch | Finished after stopping | Length | Replay |', '|---|---|---|---|---|---|'];
for (const r of results) {
  const at = s => r.steps.find(x => x.step === s)?.at;
  lines.push(`| ${r.site} | ${r.ok ? `✅ ${r.video.mb} MB` : `❌ ${r.error ?? 'not H.264'}`} | ${at('ready')?.toFixed(1) ?? '–'} s | ` +
    `${at('video ready') && at('demo done') ? (at('video ready') - at('demo done')).toFixed(1) + ' s' : '–'} | ${r.length || '–'} | ` +
    `${r.replay === 'ok' ? '✅' : r.replay ? `❌ ${r.replay}` : '–'} |`);
}
for (const r of results.filter(r => !r.ok || (r.replay && r.replay !== 'ok'))) {
  lines.push('', `## ${r.site}`, '', '```', (r.output + (r.replayOutput ?? '')).trim().split('\n').slice(-25).join('\n'), '```');
}
await writeFile(join(out, 'report.md'), lines.join('\n') + '\n');
await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} sites made a video. Report: ${join(out, 'report.md')}`);
process.exit(failed ? 1 : 0);
