import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {findChrome, keepInOneTab, liveCapture, liveRecording, oneTabInit, requireSupportedNode, StepBuilder} from '../record.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let browser, dir;
before(async () => {
  await mkdir(join(root, '.runs'), {recursive: true});
  dir = await mkdtemp(join(root, '.runs', 'recorder-test-'));
  browser = await chromium.launch({executablePath: await findChrome(process.env.CHROME_PATH), headless: true});
});
after(async () => {
  await browser?.close();
  if (dir) await rm(dir, {recursive: true, force: true});
});

async function waitForLiveState(page, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__standInLiveState()) === expected) return;
    await page.waitForTimeout(20);
  }
  assert.fail(`Live recording did not reach state ${expected}`);
}


// The start/stop shortcut: Shift pressed twice, quickly.
async function doubleShift(page) {
  await page.keyboard.press('Shift');
  await page.keyboard.press('Shift');
}

// Stands in for Chrome's recorder: writes a placeholder file where the video would go.
async function fakeRecorder(_page, {file}) {
  await writeFile(file, 'video', {flag: 'wx'});
  return {file, stop: async () => ({file, size: 5, complete: true})};
}

test('unsupported Node versions produce actionable guidance', () => {
  assert.throws(() => requireSupportedNode('20.18.0'), /needs Node\.js 22 or newer \(found 20\.18\.0\).*nodejs\.org/);
  assert.doesNotThrow(() => requireSupportedNode('22.0.0'));
  assert.doesNotThrow(() => requireSupportedNode('24.11.0'));
});

test('live recording saves the actual tab across navigation', async () => {
  const ctx = await browser.newContext({viewport: {width: 640, height: 480}});
  const page = await ctx.newPage();
  const first = join(dir, 'live-first.html'), second = join(dir, 'live-second.html');
  const videoPath = join(dir, 'live.mp4');
  try {
    await writeFile(first, '<body style="background:red"></body>');
    await writeFile(second, '<body style="background:blue"></body>');
    const {done} = await liveRecording({ctx, page, videoPath,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto(pathToFileURL(first).href);
    const help = page.locator('stand-in-live-help');
    await help.waitFor();
    assert.match(await help.locator('div').innerText(), /press Shift twice, quickly, to start[\s\S]*again to stop/);
    await help.getByRole('button', {name: 'Dismiss'}).click();
    assert.equal(await help.count(), 0);
    await page.reload();
    await help.waitFor();
    const otherPage = await ctx.newPage();
    await otherPage.goto('about:blank');
    assert.equal(await otherPage.evaluate(() => window.__standInLiveState()), 'unavailable');
    assert.equal(await otherPage.locator('stand-in-live-help').count(), 0);
    await otherPage.close();
    await page.bringToFront();
    const screenshot = await page.screenshot();
    const helpPixel = await page.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return [...context.getImageData(Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.94), 1, 1).data];
    }, screenshot.toString('base64'));
    assert.ok(helpPixel[0] < 60 && helpPixel[1] < 60 && helpPixel[2] < 60, JSON.stringify(helpPixel));
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    assert.equal(await help.count(), 0);
    await page.waitForTimeout(1200);
    await page.goto(pathToFileURL(second).href);
    await page.waitForTimeout(1200);
    assert.equal(await help.count(), 0);
    await doubleShift(page);
    await done;
    const video = await readFile(videoPath);
    assert.ok(video.length > 1000);
    const pixels = await page.evaluate(async data => {
      const video = document.createElement('video');
      video.src = `data:video/mp4;base64,${data}`;
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error('Recorded MP4 could not be decoded'));
      });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      const sample = async time => {
        video.currentTime = time;
        await new Promise(resolve => { video.onseeked = resolve; });
        context.drawImage(video, 0, 0);
        return [
          context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
          context.getImageData(Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.94), 1, 1).data,
        ].map(v => [...v]);
      };
      return [await sample(0.05), await sample(0.3), await sample(video.duration - 0.3)];
    }, video.toString('base64'));
    for (const pixel of pixels[0]) assert.ok(pixel[0] > 200 && pixel[2] < 40, JSON.stringify(pixels));
    for (const pixel of pixels[1]) assert.ok(pixel[0] > 200 && pixel[2] < 40, JSON.stringify(pixels));
    for (const pixel of pixels[2]) assert.ok(pixel[2] > 200 && pixel[0] < 40, JSON.stringify(pixels));
  } finally { await ctx.close(); }
});
test('live instructions return if recording fails to start', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let signalFailure;
  const failed = new Promise(resolve => { signalFailure = resolve; });
  let attempts = 0;
  try {
    const {done} = await liveRecording({ctx, page, videoPath: join(dir, 'retry.mp4'),
      startRecording: async (...args) => {
        if (++attempts === 1) { signalFailure(); throw new Error('test start failure'); }
        return fakeRecorder(...args);
      },
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto('about:blank');
    const help = page.locator('stand-in-live-help');
    await help.waitFor();
    await doubleShift(page);
    await failed;
    await help.waitFor();
    assert.match(await help.locator('div').innerText(), /press Shift twice/);
    // The original shortcut still works.
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await page.keyboard.press('Control+Shift+Digit9');
    await done;
  } finally { await ctx.close(); }
});

test('recording can be started and stopped without the page shortcut', async () => {
  const ctx = await browser.newContext({viewport: {width: 640, height: 480}});
  const page = await ctx.newPage();
  const file = join(dir, 'live-terminal.html'), videoPath = join(dir, 'live-terminal.mp4');
  try {
    await writeFile(file, '<body style="background:green"><p>Terminal control</p></body>');
    const {done, toggle, state} = await liveRecording({ctx, page, videoPath,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto(pathToFileURL(file).href);
    await page.locator('stand-in-live-help').waitFor();
    assert.equal(await toggle(), 'recording');
    assert.equal(state(), 'recording');
    assert.equal(await page.locator('stand-in-live-help').count(), 0);
    await page.waitForTimeout(1000);
    assert.equal(await toggle(), 'saved');
    await done;
    assert.ok((await readFile(videoPath)).length > 1000);
  } finally {
    await ctx.close();
  }
});

test('closing the tab while recording saves the video so far instead of losing it', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const videoPath = join(dir, 'closed.mp4');
  try {
    const {done} = await liveRecording({ctx, page, videoPath,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    const busy = join(dir, 'busy.html');
    await writeFile(busy, '<p id=t></p><script>setInterval(() => t.textContent = performance.now(), 30)</script>');
    await page.goto(pathToFileURL(busy).href);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.waitForTimeout(5000); // Chrome hands over the video in pieces every few seconds
    await page.close();
    const result = await done;
    assert.match(result.cutShort, /tab was closed/);
    const video = await readFile(videoPath);
    assert.ok(video.length > 1000 && video.includes('moof') && video.includes('mdat'));
    // The file ends with a whole piece, so players can open it.
    const verify = await browser.newPage();
    try {
      await verify.goto(pathToFileURL(videoPath).href);
      const seconds = await verify.evaluate(async () => {
        const v = document.querySelector('video');
        if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, {once: true}));
        return v.duration;
      });
      assert.ok(seconds > 1, `only ${seconds} s saved`);
    } finally { await verify.close(); }
  } finally { await ctx.close(); }
});

test('closing the tab before recording starts saves nothing and says so', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const videoPath = join(dir, 'never.mp4');
  try {
    const {done} = await liveRecording({ctx, page, videoPath, plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto('about:blank');
    await page.close();
    await assert.rejects(done, /closed before recording started/);
    assert.equal(existsSync(videoPath), false);
  } finally { await ctx.close(); }
});

test('live shortcut works in focused iframes across navigation', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const first = join(dir, 'live-frame-first.html'), second = join(dir, 'live-frame-second.html');
  try {
    const html = '<iframe srcdoc="<input>"></iframe>';
    await writeFile(first, html);
    await writeFile(second, html);
    const {done} = await liveRecording({ctx, page, videoPath: join(dir, 'frame.mp4'),
      startRecording: fakeRecorder,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto(pathToFileURL(first).href);
    const field = page.frameLocator('iframe').locator('input');
    await field.focus();
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    assert.equal(await field.inputValue(), '');
    await page.goto(pathToFileURL(second).href);
    await page.frameLocator('iframe').locator('input').focus();
    await doubleShift(page);
    await done;
  } finally { await ctx.close(); }
});

test('links, forms and scripts that open a new tab stay in the recorded tab', async () => {
  const servers = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const pages = {'/one-tab-target.html': '<h1>Arrived</h1>', '/one-tab.html': `
      <a href="one-tab-target.html?link" target="_blank">Blank link</a>
      <a href="one-tab-target.html?named" target="somewhere">Named link</a>
      <form action="one-tab-target.html" target="_blank"><input name="form" value="1"><button>Send</button></form>
      <button onclick="window.open('one-tab-target.html?open', '_blank', 'noopener')">Open</button>
      <button onclick="const w = window.open(); w.location = location.origin + '/one-tab-target.html?later'">Open later</button>
      <a href="one-tab-target.html?middle">Middle</a>
      <button onclick="window.open('one-tab-target.html?popup', 'signin', 'width=400,height=400')">Sign in</button>`};
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(pages[new URL(req.url, 'http://x').pathname] ?? '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const start = `http://127.0.0.1:${server.address().port}/one-tab.html`;
    await ctx.addInitScript(oneTabInit);
    let recording = true;
    keepInOneTab(ctx, page, {active: () => recording});
    const onlyOneTab = async what => {
      for (let i = 0; i < 50 && ctx.pages().length > 1; i++) await page.waitForTimeout(100);
      assert.equal(ctx.pages().length, 1, `${what} left another tab open`);
    };
    const tries = [
      ['link', 'Blank link', 'link', {}], ['link', 'Named link', 'named', {}], ['button', 'Send', 'form=1', {}],
      ['button', 'Open', 'open', {}], ['button', 'Open later', 'later', {}], ['link', 'Middle', 'middle', {button: 'middle'}],
    ];
    for (const [role, name, query, options] of tries) {
      await page.goto(start);
      await page.getByRole(role, {name, exact: true}).click(options);
      await page.waitForURL(u => u.search.includes(query), {timeout: 10000}).catch(error => { throw new Error(`${name}: ${error.message.split('\n')[0]} (at ${page.url()}, ${ctx.pages().length} tabs)`); });
      assert.equal(await page.locator('h1').innerText(), 'Arrived', name);
      await onlyOneTab(name);
    }
    // A sized pop-up window, such as a sign-in window, is left open: closing it would break the site.
    await page.goto(start);
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('button', {name: 'Sign in'}).click()]);
    await page.waitForTimeout(1500);
    assert.ok(!popup.isClosed(), 'the pop-up window stays open');
    assert.equal(page.url(), start);
    await popup.close();
    // Before recording starts (signing in, say), a new tab is left as it is.
    recording = false;
    await page.getByRole('link', {name: 'Middle'}).click({button: 'middle'});
    await page.waitForTimeout(1500);
    assert.equal(ctx.pages().length, 2);
    assert.equal(page.url(), start);
  } finally {
    await ctx.close();
    for (const server of servers) server.close();
  }
});

test('only a quick double Shift starts recording, not typing or Shift-clicking', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const {done} = await liveRecording({ctx, page, videoPath: join(dir, 'double-shift.mp4'),
      startRecording: fakeRecorder,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    const file = join(dir, 'double-shift.html');
    await writeFile(file, '<input><button>Go</button>');
    await page.goto(pathToFileURL(file).href);
    const field = page.locator('input');
    await field.click();
    // Capitals: Shift, a letter, Shift, a letter.
    await page.keyboard.type('Hello World ABC');
    await page.keyboard.press('Shift+A');
    await page.keyboard.press('Shift+B');
    // Shift-clicking twice.
    await page.keyboard.down('Shift');
    await page.getByRole('button', {name: 'Go'}).click();
    await page.keyboard.up('Shift');
    await page.keyboard.down('Shift');
    await page.getByRole('button', {name: 'Go'}).click();
    await page.keyboard.up('Shift');
    // Two Shift presses far apart.
    await page.keyboard.press('Shift');
    await page.waitForTimeout(700);
    await page.keyboard.press('Shift');
    // Holding Shift down (the key repeats).
    await page.waitForTimeout(500);
    await page.keyboard.down('Shift');
    await page.keyboard.down('Shift');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__standInLiveState()), 'ready');
    assert.equal(await field.inputValue(), 'Hello World ABCAB');
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await doubleShift(page);
    await done;
  } finally { await ctx.close(); }
});

// Runs the CLI against a page from `html`, in headless Chrome it can reach, until it is ready to record.
// With `elsewhere`, the CLI starts in another folder and is told where to save, the way the VS Code extension
// starts it when no folder is open.
async function liveCli(name, html, extraArgs = [], {elsewhere = false} = {}) {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const cwd = join(dir, name), wrapper = join(dir, `${name}-chrome`);
  await mkdir(cwd);
  const chrome = await findChrome(process.env.CHROME_PATH);
  const quoted = `'${chrome.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexec ${quoted} --headless=new --remote-debugging-port=${port} "$@"\n`, {mode: 0o755});
  const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), url, '--chrome', wrapper, ...extraArgs],
    {cwd: elsewhere ? await mkdtemp(join(dir, 'start-')) : cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: elsewhere ? {...process.env, STAND_IN_FOLDER: cwd} : process.env});
  const run = {child, url, cwd, output: '', connected: null, exited: once(child, 'close'),
    async close() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await run.connected?.close().catch(() => {});
      await new Promise(resolve => server.close(() => resolve()));
    }};
  let timer;
  const ready = new Promise(resolve => {
    const read = data => { run.output += data; if (/Press Shift twice, quickly, in the page to start/i.test(run.output)) resolve(); };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
  try {
    await Promise.race([ready,
      run.exited.then(([code]) => { throw new Error(`CLI exited before opening the site (${code}): ${run.output}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI did not become ready: ${run.output}`)), 20000); })]);
  } catch (error) { await run.close(); throw error; } finally { clearTimeout(timer); }
  run.connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  run.page = run.connected.contexts()[0].pages().find(p => p.url() === url);
  assert.ok(run.page, 'The recorded page was not opened');
  return run;
}

test('the one-command CLI saves both files', {skip: process.platform === 'win32', timeout: 60000}, async () => {
  const run = await liveCli('cli', '<button onclick="this.textContent=\'Clicked\'">Click me</button>');
  const {page, cwd, url} = run;
  try {
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByRole('button', {name: 'Click me'}).click();
    await page.waitForTimeout(1000);
    await doubleShift(page);
    const [code] = await run.exited;
    const output = run.output;
    assert.equal(code, 0, output);
    const [videoName] = await readdir(join(cwd, 'recordings'));
    const [planName] = await readdir(join(cwd, 'demos'));
    // Readable local-time names, the same for the video and the plan.
    assert.match(videoName, /^127\.0\.0\.1-\d{4}-\d\d-\d\d-\d\d-\d\d\.mp4$/);
    assert.equal(planName, videoName.replace(/\.mp4$/, '.json'));
    const videoBytes = await readFile(join(cwd, 'recordings', videoName));
    assert.ok(videoBytes.length > 1000);
    // Converted to H.264 so QuickTime on Intel Macs and other older players can open it.
    assert.ok(videoBytes.includes('avcC') && !videoBytes.includes('av1C'), 'The video was not converted to H.264');
    // The H.264 level must allow 60 fps at this size (level 3.1 here), or strict players refuse or stutter.
    assert.ok(videoBytes[videoBytes.indexOf('avcC') + 7] >= 31, 'H.264 level too low for 60 fps');
    assert.match(output, /Your video is ready: recordings\//);
    const plan = JSON.parse(await readFile(join(cwd, 'demos', planName), 'utf8'));
    assert.equal(plan.url, url);
    assert.ok(plan.steps.some(s => s.action === 'click' && s.target?.name === 'Click me'));
  } finally { await run.close(); }
});

test('a link that opens a new tab is recorded and replayed in the same tab', {skip: process.platform === 'win32', timeout: 90000}, async () => {
  const run = await liveCli('new-tab', `<script>document.write(location.search.includes('next')
    ? '<h1>Second page</h1><input aria-label="Notes">'
    : '<a href="/?next" target="_blank">Read more</a>')</script>`);
  const {page, cwd} = run;
  try {
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByRole('link', {name: 'Read more'}).click();
    await page.waitForURL(u => u.search.includes('next'));
    assert.equal(page.context().pages().length, 1, 'the link opened in the recorded tab');
    await page.getByRole('textbox', {name: 'Notes'}).fill('');
    await page.getByRole('textbox', {name: 'Notes'}).pressSequentially('hello', {delay: 40});
    await page.waitForTimeout(1000);
    await doubleShift(page);
    const [code] = await run.exited;
    assert.equal(code, 0, run.output);
    const [planName] = await readdir(join(cwd, 'demos'));
    const planPath = join(cwd, 'demos', planName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert.ok(plan.steps.some(s => s.action === 'click' && s.target?.name === 'Read more'));
    assert.ok(plan.steps.some(s => s.action === 'type' && s.text === 'hello'));
    // Replay follows the link in the same tab too, so the typing step finds its box.
    const replayed = join(cwd, 'replayed.mp4');
    const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath, '--headless',
      '--output', replayed], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [replayCode] = await once(child, 'close');
    assert.equal(replayCode, 0, output);
    assert.match(output, /Your video is ready/);
  } finally { await run.close(); }
});

test('links in menus that open on hover or click are recorded and replayed', {skip: process.platform === 'win32', timeout: 120000}, async () => {
  // Three common menus: CSS hover, a script on mouseenter, and a click toggle. Each item leads to a page
  // that says which link was followed.
  const html = `<style>
      nav > div { display: inline-block; position: relative; margin-right: 40px; }
      .menu { display: none; position: absolute; top: 100%; left: 0; background: #eee; padding: 8px; }
      .css:hover .menu, .open .menu { display: block; }
    </style>
    <script>
      if (location.search) document.write('<h1>Arrived at ' + location.search.slice(1) + '</h1>');
    </script>
    <nav>
      <div class="css"><a href="/?products">Products</a><div class="menu"><a href="/?funds">Mutual funds</a></div></div>
      <div class="js"><a href="/?planning">Planning</a><div class="menu"><a href="/?advisors">Financial Advisors</a></div></div>
      <div class="toggle"><button aria-expanded="false" aria-controls="more">More</button><div id="more" class="menu"><a href="/?help">Help center</a></div></div>
    </nav>
    <script>
      const js = document.querySelector('.js');
      js.addEventListener('mouseenter', () => setTimeout(() => js.classList.add('open'), 150));
      js.addEventListener('mouseleave', () => js.classList.remove('open'));
      const toggle = document.querySelector('.toggle');
      toggle.querySelector('button').addEventListener('click', e => {
        toggle.classList.toggle('open');
        e.currentTarget.setAttribute('aria-expanded', toggle.classList.contains('open'));
      });
    </script>`;
  const run = await liveCli('menus', html);
  const {page, cwd, url} = run;
  try {
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    // Point at "Planning", wait for its menu, then click inside it.
    await page.getByRole('link', {name: 'Planning'}).hover();
    await page.getByRole('link', {name: 'Financial Advisors'}).click();
    await page.waitForURL(u => u.search === '?advisors');
    await page.waitForTimeout(800);
    await doubleShift(page);
    const [code] = await run.exited;
    assert.equal(code, 0, run.output);
    const [planName] = await readdir(join(cwd, 'demos'));
    const planPath = join(cwd, 'demos', planName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const kinds = plan.steps.filter(s => s.action !== 'wait').map(s => `${s.action} ${s.target?.name}`);
    assert.deepEqual(kinds, ['hover Planning', 'click Financial Advisors']);

    const rehearse = async steps => {
      await writeFile(planPath, JSON.stringify({...plan, url, steps}));
      const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath, '--headless',
        '--rehearse', '--confirm-signed-in'], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const [replayCode] = await once(child, 'close');
      return {code: replayCode, output};
    };
    const check = arrived => ({action: 'waitFor', target: {role: 'heading', name: `Arrived at ${arrived}`}, timeout: 5000});
    // As recorded.
    let result = await rehearse([...plan.steps, check('advisors')]);
    assert.equal(result.code, 0, result.output);
    // Plans without the "point at" step (recorded before this fix) find the menu themselves: hover menus
    // by pointing at their nav item, and a click toggle by clicking it.
    for (const [name, arrived] of [['Financial Advisors', 'advisors'], ['Mutual funds', 'funds'], ['Help center', 'help']]) {
      result = await rehearse([{action: 'click', target: {role: 'link', name}}, check(arrived)]);
      assert.equal(result.code, 0, `${name}: ${result.output}`);
      assert.match(result.output, /opening the menu/);
    }
  } finally { await run.close(); }
});

test('recording and replay work on a site that switches off eval', {skip: process.platform === 'win32', timeout: 90000}, async () => {
  // Like americanexpress.com, which replaces eval with one that throws.
  const run = await liveCli('no-eval', `<script>window.eval = function monkeypatchedEval() { throw new Error('eval is disabled'); };</script>
    <button onclick="this.textContent = 'Clicked'">Click me</button>`);
  const {page, cwd} = run;
  try {
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByRole('button', {name: 'Click me'}).click();
    await page.waitForTimeout(800);
    await doubleShift(page);
    const [code] = await run.exited;
    assert.equal(code, 0, run.output);
    assert.doesNotMatch(run.output, /eval is disabled/);
    const [planName] = await readdir(join(cwd, 'demos'));
    const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', join(cwd, 'demos', planName),
      '--headless', '--rehearse'], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stderr.on('data', data => { output += data; });
    const [replayCode] = await once(child, 'close');
    assert.equal(replayCode, 0, output);
  } finally { await run.close(); }
});

test('Ctrl+C while recording saves the video and plan instead of losing them', {skip: process.platform === 'win32', timeout: 60000}, async () => {
  const run = await liveCli('ctrl-c', '<button onclick="this.textContent=\'Clicked\'">Click me</button>', [],
    {elsewhere: true});
  try {
    await doubleShift(run.page);
    await waitForLiveState(run.page, 'recording');
    await run.page.getByRole('button', {name: 'Click me'}).click();
    await run.page.waitForTimeout(4000);
    run.child.kill('SIGINT');
    const [code] = await run.exited;
    assert.equal(code, 0, run.output);
    assert.match(run.output, /Stopped with Ctrl\+C\. Saving what was recorded/);
    assert.match(run.output, /Your video is ready/);
    const [videoName] = await readdir(join(run.cwd, 'recordings'));
    assert.ok((await readFile(join(run.cwd, 'recordings', videoName))).includes('avcC'));
    const [planName] = await readdir(join(run.cwd, 'demos'));
    const plan = JSON.parse(await readFile(join(run.cwd, 'demos', planName), 'utf8'));
    assert.ok(plan.steps.some(s => s.target?.name === 'Click me'));
  } finally { await run.close(); }
});

test('quitting Chrome while recording keeps the video', {skip: process.platform === 'win32', timeout: 60000}, async () => {
  const run = await liveCli('quit-chrome', '<p id=t></p><script>setInterval(() => t.textContent = Date.now(), 30)</script>');
  try {
    await doubleShift(run.page);
    await waitForLiveState(run.page, 'recording');
    await run.page.waitForTimeout(5000); // Chrome hands over the video in pieces every few seconds
    const cdp = await run.connected.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    const [code] = await run.exited;
    assert.equal(code, 0, run.output);
    assert.match(run.output, /(tab|Chrome) was closed\. Saving what was recorded/);
    assert.match(run.output, /Your video is ready/);
    const [videoName] = await readdir(join(run.cwd, 'recordings'));
    assert.ok((await readFile(join(run.cwd, 'recordings', videoName))).includes('avcC'));
  } finally { await run.close(); }
});

test('one capture saves video and replayable actions after signed-in preparation', {timeout: 90000}, async () => {
  let actionCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; require-trusted-types-for 'script'");
    if (req.url === '/acted') { actionCount++; res.end('ok'); return; }
    if (req.url === '/frame') {
      res.end('<label>Message <input></label><button onclick="fetch(\'/acted\')">Send</button>');
      return;
    }
    if (req.url === '/next') {
      res.end('<iframe id="demo-frame" src="/frame"></iframe>');
      return;
    }
    res.end(req.headers.cookie?.includes('session=test')
      ? '<p>Signed in</p><input placeholder="Preparation"><a href="/next">Next</a>'
      : '<p>Sign in</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const profileDir = join(dir, 'combined-session');
  try {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: await findChrome(process.env.CHROME_PATH), headless: true,
      viewport: {width: 640, height: 480},
    });
    const page = ctx.pages()[0];
    const planPath = join(dir, 'combined.json'), videoPath = join(dir, 'combined.mp4');
    let saved;
    try {
      const plan = {fps: 30, viewport: {width: 640, height: 480}};
      const capture = await liveCapture({ctx, page, plan, planPath, profileDir});
      const {done} = await liveRecording({ctx, page, plan, videoPath, capture});
      await page.goto(`${url}/sign-in`);
      await ctx.addCookies([{name: 'session', value: 'test', url, expires: Date.now() / 1000 + 300}]);
      await page.goto(`${url}/start`);
      await page.getByPlaceholder('Preparation').fill('exclude me');
      await doubleShift(page);
      await waitForLiveState(page, 'recording');
      await page.getByRole('link', {name: 'Next'}).click();
      const frame = page.frameLocator('#demo-frame');
      await frame.getByLabel('Message').fill('hello');
      await frame.getByRole('button', {name: 'Send'}).click();
      await page.waitForTimeout(1000);
      await doubleShift(page);
      await done;
      assert.ok((await readFile(videoPath)).length > 1000);
      saved = JSON.parse(await readFile(planPath, 'utf8'));
      assert.equal(saved.url, `${url}/start`);
      assert.equal(saved.profileDir, 'combined-session');
      assert.ok(saved.steps.some(s => s.action === 'click' && s.target?.name === 'Next'));
      assert.ok(saved.steps.some(s => s.action === 'type' && s.target?.frame === '#demo-frame' && s.text === 'hello' && s.clear));
      assert.ok(saved.steps.some(s => s.action === 'click' && s.target?.frame === '#demo-frame' && s.target?.name === 'Send'));
      assert.doesNotMatch(JSON.stringify(saved.steps), /exclude me|Digit9|ControlOrMeta\+9|"Shift"/);
      saved.steps.unshift(
        {action: 'caption', text: 'A replay caption'},
        {action: 'highlight', target: {role: 'link', name: 'Next'}, ms: 1000},
      );
    } finally { await ctx.close(); }
    const script = join(root, 'tools/recorder/record.mjs');
    // A plan you just recorded replays without being asked to confirm it; an edited one is asked about.
    // (Not spawnSync: this process is also the web server the replay needs.)
    const rehearse = async () => {
      const child = spawn(process.execPath, [script, 'replay', planPath, '--headless', '--rehearse'], {stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stderr.on('data', data => { output += data; });
      const [code] = await once(child, 'close');
      return {code, output};
    };
    const asRecorded = await rehearse();
    assert.equal(asRecorded.code, 0, asRecorded.output);
    await writeFile(planPath, JSON.stringify(saved));
    const refused = spawnSync(process.execPath, [script, 'replay', planPath, '--headless', '--rehearse'], {encoding: 'utf8'});
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /new or has changed.*\n.*explicit approval/);
    const replayVideo = join(dir, 'replayed.mp4');
    const child = spawn(process.execPath, [script, 'replay', planPath, '--headless', '--confirm-signed-in', '--output', replayVideo],
      {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    const video = await readFile(replayVideo);
    assert.ok(video.length > 1000);
    const check = await browser.newPage();
    try {
      const darkPixels = await check.evaluate(async data => {
        const video = document.createElement('video');
        video.src = `data:video/mp4;base64,${data}`;
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error('Replay MP4 could not be decoded'));
        });
        video.currentTime = 2;
        await new Promise(resolve => { video.onseeked = resolve; });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        const pixels = context.getImageData(canvas.width * 0.3, canvas.height * 0.85,
          canvas.width * 0.4, canvas.height * 0.1).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) dark++;
        return dark;
      }, video.toString('base64'));
      assert.ok(darkPixels > 200, `Replay caption was not visible (${darkPixels} dark pixels)`);
    } finally { await check.close(); }
    // Approved once, the edited plan isn't asked about again.
    const again = await rehearse();
    assert.equal(again.code, 0, again.output);
    assert.equal(actionCount, 4); // recording, the first rehearsal, the replay, the second rehearsal
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a plan save failure leaves the video intact and reports failure', async () => {
  const ctx = await browser.newContext({viewport: {width: 640, height: 480}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'existing-plan.json'), videoPath = join(dir, 'plan-failure.mp4');
  await writeFile(planPath, 'keep');
  try {
    const plan = {fps: 30, viewport: {width: 640, height: 480}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath, capture,
      startRecording: fakeRecorder});
    await page.goto('about:blank');
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await doubleShift(page);
    await assert.rejects(done, /EEXIST/);
    assert.equal(await readFile(videoPath, 'utf8'), 'video');
    assert.equal(await readFile(planPath, 'utf8'), 'keep');
  } finally { await ctx.close(); }
});

test('the CLI refuses to overwrite an existing video', async () => {
  const output = join(dir, 'existing.mp4');
  await writeFile(output, 'keep');
  const result = spawnSync(process.execPath, [join(root, 'tools/recorder/record.mjs'),
    'https://example.com', '--output', output], {encoding: 'utf8', cwd: dir});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/);
  assert.equal(await readFile(output, 'utf8'), 'keep');
});

test('the installed symlink runs the CLI', async () => {
  const link = join(dir, 'stand-in');
  await symlink(join(root, 'tools/recorder/record.mjs'), link);
  const result = spawnSync(process.execPath, [link, '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stand-in <website>/);
});

test('obsolete plans are rejected without changing their files', async () => {
  const planPath = join(dir, 'old-plan.json');
  const original = JSON.stringify({extends: 'old-site.json', steps: []});
  await writeFile(planPath, original);
  const result = spawnSync(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain a URL|Unsupported plan fields/);
  assert.equal(await readFile(planPath, 'utf8'), original);
});

test('captured passwords are replaced by placeholders', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const planPath = join(dir, 'password-plan.json');
  try {
    const pagePath = join(dir, 'password.html');
    await writeFile(pagePath, '<label>Password <input type="password"></label>');
    const plan = {fps: 30, viewport: {width: 640, height: 480}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'password-video.mp4'), capture,
      startRecording: fakeRecorder});
    await page.goto(pathToFileURL(pagePath).href);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByLabel('Password').fill('secret-password');
    await doubleShift(page);
    await done;
    const contents = await readFile(planPath, 'utf8');
    assert.doesNotMatch(contents, /secret-password/);
    assert.match(contents, /SET-ME: password/);
    const result = spawnSync(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /uncaptured password/);
  } finally { await ctx.close(); }
});

test('pauses after a submitted question become waits for the answer', () => {
  const box = {placeholder: 'Ask a question'}, link = {role: 'link', name: 'Next'};
  const build = (events, endGap = 1000) => {
    const b = new StepBuilder();
    let t = 1000;
    for (const [dt, ev] of events) {
      t += dt;
      b.add({...ev, t}, null);
    }
    return b.finish(t + endGap);
  };
  const ask = [[0, {kind: 'input', target: box, value: 'How do I open an account?'}], [300, {kind: 'enter', target: box}],
    [5, {kind: 'input', target: box, value: 'How do I open an account?\n'}]];
  // Enter, then a 9 s pause, then a click: the pause follows the answer.
  let steps = build([...ask, [9000, {kind: 'click', target: link}]]);
  assert.deepEqual(steps.map(s => s.action), ['type', 'waitForStable', 'click']);
  assert.deepEqual(steps[1].around, box);
  assert.equal(steps[1].minMs, 3000);
  assert.equal(steps.filter(s => s.action === 'type').length, 1);
  // A Send button after typing works the same way.
  steps = build([[0, {kind: 'input', target: box, value: 'Hi'}], [400, {kind: 'click', target: {role: 'button', name: 'Send'}}],
    [6000, {kind: 'click', target: link}]]);
  assert.deepEqual(steps.map(s => s.action), ['type', 'click', 'waitForStable', 'click']);
  // If the page navigated after submitting (a search, a form), keep a fixed wait.
  const b = new StepBuilder();
  b.add({kind: 'input', target: box, value: 'shoes', t: 1000}, null);
  b.add({kind: 'enter', target: box, t: 1300}, null);
  b.noteNavigation(1800);
  b.add({kind: 'click', target: link, t: 7300}, null);
  assert.deepEqual(b.finish(8000).map(s => s.action), ['type', 'wait', 'click']);
  // Signing in is not a question.
  steps = build([[0, {kind: 'input', target: {label: 'Password'}, value: '', secret: true}],
    [300, {kind: 'enter', target: {label: 'Password'}}], [6000, {kind: 'click', target: link}]]);
  assert.deepEqual(steps.map(s => s.action), ['type', 'wait', 'click']);
  // A pause at the end of the recording after a question also waits for the answer.
  steps = build(ask, 8000);
  assert.equal(steps.at(-1).action, 'waitForStable');
});

// A page with the things real sites throw at the recorder: a cookie banner, repeated links and test ids,
// web components (shadow DOM) with slotted labels, a code editor inside a component, a date-like <select>,
// an ad frame that doesn't scroll, a submit button, and a <body> class that sounds like a pop-up (as on Wikipedia).
const TRICKY_PAGE = `<!doctype html><meta charset="utf-8"><body class="overlay-banner-open">
<style>body{margin:0;font:16px sans-serif} .card{height:120px;border:1px solid #ccc;margin:8px}
  .cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px}</style>
<div class="cookie-banner" id="cookies">We use cookies. <button onclick="cookies.remove()">Accept all</button></div>
<div id="cards">${[1, 2, 3].map(n => `<div class="card"><h3>Story ${n}</h3>
  <a href="#story-${n}" data-testid="card-link" onclick="document.body.dataset.story=${n}">Read more</a></div>`).join('')}</div>
<fancy-button id="launch">Launch</fancy-button>
<code-box></code-box>
<label>Period <select id="period"><option value="0">3pm Fri, Nov 20</option><option value="12">5pm Sat, Nov 21</option></select></label>
<form onsubmit="event.preventDefault(); document.body.dataset.saved = 1"><input type="submit" value="Save"></form>
<a href="#issues" onclick="document.body.dataset.issues = 1"><span aria-hidden="true">5k+</span> Issues <span>(5k+)</span></a>
<iframe id="ad" srcdoc="<body style='margin:0;background:#fd0;height:100%'>Ad</body>" style="width:600px;height:200px;border:0"></iframe>
<div style="height:3000px"></div>
<script>
customElements.define('fancy-button', class extends HTMLElement {
  constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML =
    '<button aria-labelledby="l"><span id="l"><slot></slot></span></button>';
    this.shadowRoot.querySelector('button').onclick = () => { document.body.dataset.launched = (+document.body.dataset.launched || 0) + 1; }; }
});
customElements.define('code-box', class extends HTMLElement {
  constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML =
    '<div class="editor"><div class="content" contenteditable="true" style="min-height:40px;border:1px solid #999"></div></div>'; }
});
</script>`;

test('pointing that reveals a menu drawn elsewhere on the page is recorded, typing suggestions are not', {timeout: 60000}, async () => {
  // "Locations" draws its menu at the end of the page when pointed at, with nothing linking the two; the
  // search box shows suggestions as you type.
  const html = `<nav style="padding:10px"><button id="loc">Locations</button></nav>
    <input aria-label="Find" style="margin:10px"><div id="suggest"></div>
    <script>
      document.querySelector('#loc').addEventListener('mouseenter', () => {
        if (document.querySelector('.portal')) return;
        const menu = document.createElement('div');
        menu.className = 'portal';
        menu.style = 'position:absolute;top:40px;left:10px;background:#eee;padding:10px';
        menu.innerHTML = '<a href="#dallas" onclick="document.body.dataset.went = 1">Dallas</a>';
        document.body.append(menu);
      });
      document.querySelector('input').addEventListener('input', e => {
        document.querySelector('#suggest').innerHTML = '<a href="#s">' + e.target.value + ' help</a>';
      });
    </script>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = await browser.newContext({viewport: {width: 1000, height: 700}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'portal-menu.json');
  try {
    const plan = {fps: 30, viewport: {width: 1000, height: 700}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'portal-menu.mp4'), capture, startRecording: fakeRecorder});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByRole('button', {name: 'Locations'}).hover();
    await page.waitForTimeout(400);
    await page.getByRole('link', {name: 'Dallas'}).click();
    await page.waitForTimeout(300);
    await page.getByLabel('Find').click();
    await page.keyboard.type('get', {delay: 30});
    await page.waitForTimeout(400);
    await page.getByRole('link', {name: 'get help'}).click();
    await page.waitForTimeout(300);
    await doubleShift(page);
    await done;
    const steps = JSON.parse(await readFile(planPath, 'utf8')).steps.filter(s => s.action !== 'wait');
    assert.deepEqual(steps.map(s => `${s.action} ${s.target?.name ?? s.target?.label ?? ''}`.trim()),
      ['hover Locations', 'click Dallas', 'type Find', 'click get help'], JSON.stringify(steps));
  } finally {
    await ctx.close();
    server.close();
  }
});

test('links are found by where they go when names repeat or change', {timeout: 60000}, async () => {
  const pages = {
    '/': `<header><a href="/promo">Warnings</a></header>
      <main><a href="/warnings">Warnings</a> <a href="/dallas">Downtown Dallas Sunny 61°</a>
      <a href="/start?_ga=2.1.2.3">Get started</a> <a href="/start/now?utm_source=nav&amp;id=5&amp;_ga=9.8.7">Get started</a>
      <p><a id="card-list-items_1-0" href="/index-funds">Investing in Index Funds: Key Benefits and Drawbacks for Long-Term Savers</a></p></main>`,
  };
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const path = new URL(req.url, 'http://x').pathname;
    res.end(pages[path] ?? `<h1>Arrived at ${path}</h1>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ctx = await browser.newContext({viewport: {width: 1000, height: 700}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'links-by-address.json');
  try {
    // Recording keeps each link's address.
    const plan = {fps: 30, viewport: {width: 1000, height: 700}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'links-by-address.mp4'), capture, startRecording: fakeRecorder});
    await page.goto(url);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByRole('link', {name: 'Get started'}).nth(1).click();
    await page.waitForURL(/start\/now/);
    await page.goBack();
    await page.getByRole('link', {name: /Index Funds/}).click();
    await page.waitForURL(/index-funds/);
    await page.goBack();
    await page.locator('main').getByRole('link', {name: 'Warnings'}).click();
    await page.waitForURL(/warnings/);
    await page.waitForTimeout(300);
    await doubleShift(page);
    await done;
    const [start, headline, click] = JSON.parse(await readFile(planPath, 'utf8')).steps.filter(s => s.action === 'click');
    // Tracking codes are left out of the address; other parts of it stay.
    assert.equal(start.target.href, '/start/now?id=5', JSON.stringify(start));
    // A long headline is saved by its start and where it goes, not by its place in a list.
    assert.deepEqual(headline.target, {role: 'link', name: 'Investing in Index Funds: Key Benefits and Drawbacks for', href: '/index-funds'});
    assert.equal(click.target.href, '/warnings', JSON.stringify(click));

    // Replay picks the "Warnings" link that goes to the same place, not the first one on the page.
    const {Actor} = await import('../record.mjs');
    const replayPage = await ctx.newPage();
    const actor = new Actor(replayPage, {viewport: {width: 1000, height: 700}, pace: 'brisk'});
    await replayPage.goto(url);
    await actor.run({action: 'click', target: {role: 'link', name: 'Warnings', href: '/warnings'}}, 5000);
    await replayPage.waitForURL(/\/warnings$/);
    // A link whose address now carries different tracking codes is still the one picked.
    await replayPage.goto(url);
    await replayPage.evaluate(() => { document.querySelectorAll('a')[4].setAttribute('href', '/start/now?utm_source=new&id=5&_ga=1.1'); });
    await actor.run({action: 'click', target: {role: 'link', name: 'Get started', href: '/start/now?id=5'}}, 5000);
    await replayPage.waitForURL(/\/start\/now/);
    // And finds a link whose name has changed since, by where it goes.
    await replayPage.goto(url);
    await actor.run({action: 'click', target: {role: 'link', name: 'Downtown Dallas Cloudy 53°', href: '/dallas'}}, 4000);
    await replayPage.waitForURL(/\/dallas$/);
  } finally {
    await ctx.close();
    server.close();
  }
});

test('pressing Enter in a form records no extra click on its button', {timeout: 60000}, async () => {
  const html = `<form onsubmit="event.preventDefault(); document.body.dataset.sent = (+(document.body.dataset.sent || 0) + 1)">
      <input aria-label="Search" name="q"><button>Search</button></form>
    <button onclick="document.body.dataset.other = 1">Other</button>`;
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = await browser.newContext({viewport: {width: 1000, height: 700}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'enter-submit.json');
  try {
    const plan = {fps: 30, viewport: {width: 1000, height: 700}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'enter-submit.mp4'), capture, startRecording: fakeRecorder});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.getByLabel('Search').click();
    await page.keyboard.type('help', {delay: 30});
    await page.keyboard.press('Enter');
    // A pause after searching is an ordinary wait: search results aren't a chat answer next to the box.
    await page.waitForTimeout(3000);
    // Space on a focused button isn't a step of its own, so its click is kept.
    await page.getByRole('button', {name: 'Other'}).focus();
    await page.keyboard.press(' ');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.body.dataset.sent), '1');
    await doubleShift(page);
    await done;
    const all = JSON.parse(await readFile(planPath, 'utf8')).steps;
    assert.ok(!all.some(s => s.action === 'waitForStable'), JSON.stringify(all));
    const steps = all.filter(s => s.action !== 'wait');
    assert.deepEqual(steps.map(s => s.action), ['type', 'click'], JSON.stringify(steps));
    assert.equal(steps[0].text, 'help');
    assert.equal(steps[0].submit, true);
    assert.deepEqual(steps[1].target, {role: 'button', name: 'Other'});
  } finally {
    await ctx.close();
    server.close();
  }
});

test('capture avoids generated ids and treats clicks in pop-up frames as optional', {timeout: 60000}, async () => {
  const pages = {
    '/': `<div id="_R_5l7d_" style="padding:30px;background:#eee;cursor:pointer" onclick="document.body.dataset.panel = 1">Panel</div>
      <p style="margin:20px">Just some text to read.</p>
      <iframe id="offer-0-WBVvC" src="/offer" style="position:fixed;bottom:0;left:0;width:320px;height:160px;border:0"></iframe>`,
    '/offer': '<div style="width:300px;height:140px;background:#c33" onclick="this.dataset.clicked = 1"></div>',
  };
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(pages[new URL(req.url, 'http://x').pathname] ?? ''); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = await browser.newContext({viewport: {width: 1000, height: 700}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'generated-ids.json');
  try {
    const plan = {fps: 30, viewport: {width: 1000, height: 700}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'generated-ids.mp4'), capture, startRecording: fakeRecorder});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await page.mouse.click(500, 30);
    await page.getByText('Just some text to read.').click();
    await page.mouse.click(150, 620);
    await page.waitForTimeout(600);
    await doubleShift(page);
    await done;
    const clicks = JSON.parse(await readFile(planPath, 'utf8')).steps.filter(s => s.action === 'click');
    assert.equal(clicks.length, 3, JSON.stringify(clicks));
    // React's ids ("_R_5l7d_") and random tokens ("WBVvC") change on every visit, so they're not used.
    assert.doesNotMatch(JSON.stringify(clicks), /_R_5l7d_|WBVvC/);
    assert.ok(!clicks[0].optional);
    // A click on plain text is incidental: skipped on replay if the text isn't there.
    assert.equal(clicks[1].optional, true, JSON.stringify(clicks[1]));
    // The frame floats over the page like a paywall or offer, which may not appear on replay.
    assert.equal(clicks[2].optional, true, JSON.stringify(clicks[2]));
    assert.equal(clicks[2].target.frame, 'iframe[src^="/offer"]');
  } finally {
    await ctx.close();
    server.close();
  }
});

test('capture copes with banners, repeated links, web components, frames and selects', {timeout: 60000}, async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(TRICKY_PAGE); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ctx = await browser.newContext({viewport: {width: 1000, height: 700}});
  const page = await ctx.newPage();
  const planPath = join(dir, 'tricky.json');
  const click = async locator => {
    const box = await locator.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(120);
  };
  try {
    const plan = {fps: 30, viewport: {width: 1000, height: 700}};
    const capture = await liveCapture({ctx, page, plan, planPath, profileDir: dir});
    const {done} = await liveRecording({ctx, page, plan, videoPath: join(dir, 'tricky.mp4'), capture,
      startRecording: fakeRecorder});
    await page.goto(url);
    await doubleShift(page);
    await waitForLiveState(page, 'recording');
    await click(page.getByRole('button', {name: 'Accept all'}));
    await click(page.getByRole('link', {name: 'Read more'}).nth(1));
    await click(page.getByRole('button', {name: 'Launch'}));
    await click(page.locator('code-box .content'));
    await page.keyboard.type('let x = 1;', {delay: 20});
    await page.locator('#period').focus();
    await page.keyboard.press('ArrowDown'); // a person's change, unlike selectOption()
    await click(page.getByRole('button', {name: 'Save'}));
    await click(page.getByRole('link', {name: 'Issues'}));
    const ad = await page.locator('#ad').boundingBox();
    await page.mouse.move(ad.x + 100, ad.y + 100);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
    await page.waitForTimeout(800);
    await doubleShift(page);
    await done;
    const {steps} = JSON.parse(await readFile(planPath, 'utf8'));
    const find = action => steps.filter(s => s.action === action);
    const clicks = find('click');
    assert.deepEqual(clicks[0], {action: 'click', target: {role: 'button', name: 'Accept all'}, optional: true, timeout: 3000});
    assert.deepEqual(clicks[1].target, {role: 'link', name: 'Read more', nth: 1});
    assert.deepEqual(clicks[2].target, {role: 'button', name: 'Launch'});
    assert.ok(!clicks.slice(1).some(s => s.optional), JSON.stringify(clicks));
    const typed = find('type')[0];
    assert.equal(typed.text, 'let x = 1;');
    assert.match(typed.target.css, /code-box div\.editor > div\.content$/);
    assert.deepEqual(find('select')[0], {action: 'select', target: {label: 'Period'}, label: '5pm Sat, Nov 21', value: '12'});
    assert.deepEqual(clicks.at(-2).target, {role: 'button', name: 'Save'});
    // Named as screen readers (and Playwright) read it, without the text hidden from them.
    assert.deepEqual(clicks.at(-1).target, {role: 'link', name: 'Issues (5k+)'});
    const scroll = find('scroll')[0];
    assert.ok(scroll && !scroll.target && scroll.by > 300, JSON.stringify(steps));

    // The plan finds the same elements again, even when the select's label has changed.
    const replayPage = await ctx.newPage();
    await replayPage.goto(url);
    await replayPage.evaluate(() => { document.querySelector('#period option[value="12"]').textContent = '5pm Sun, Nov 22'; });
    const {Actor} = await import('../record.mjs');
    const actor = new Actor(replayPage, {viewport: {width: 1000, height: 700}, pace: 'brisk'});
    for (const step of steps) {
      try { await actor.run(step, step.timeout ?? 5000); } catch (error) { if (!step.optional) throw error; }
    }
    const state = await replayPage.evaluate(() => ({...document.body.dataset, period: document.querySelector('#period').value,
      code: document.querySelector('code-box').shadowRoot.querySelector('.content').innerText, cookies: !!document.querySelector('#cookies'),
      scrolled: scrollY}));
    assert.deepEqual({...state, scrolled: state.scrolled > 300},
      {story: '2', launched: '1', saved: '1', issues: '1', period: '12', code: 'let x = 1;', cookies: false, scrolled: true});
  } finally {
    await ctx.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a pop-up that is already gone on replay is skipped quickly', {timeout: 30000}, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.setContent('<button onclick="document.body.dataset.ok = 1">Continue</button>');
    const {Actor} = await import('../record.mjs');
    const actor = new Actor(page, {viewport: {width: 800, height: 600}, pace: 'brisk'});
    const started = Date.now();
    await assert.rejects(actor.run({action: 'click', target: {role: 'button', name: 'Accept all'}}, 3000), /Timeout 3000ms/);
    assert.ok(Date.now() - started < 5000);
    await actor.run({action: 'click', target: {role: 'button', name: 'Continue'}}, 3000);
    assert.equal(await page.evaluate(() => document.body.dataset.ok), '1');
  } finally { await ctx.close(); }
});

test('a failed replay explains the step in plain words and keeps the video so far', {timeout: 90000}, async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button>Start</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cwd = join(dir, 'failing-replay');
  await mkdir(join(cwd, 'demos'), {recursive: true});
  const planPath = join(cwd, 'demos', 'checkout.json');
  await writeFile(planPath, JSON.stringify({url: `http://127.0.0.1:${server.address().port}/`, viewport: {width: 640, height: 480},
    steps: [{action: 'click', target: {role: 'button', name: 'Start'}}, {action: 'click', target: {role: 'button', name: 'Pay now'}, timeout: 1500}]}));
  try {
    const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath, '--headless'],
      {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    assert.notEqual(code, 0);
    assert.match(output, /2\/2 {2}click the button “Pay now”/);
    assert.match(output, /Step 2 of 2 failed: click the button “Pay now”\n {2}Couldn't find the button “Pay now” on the page within 2 seconds\./);
    assert.match(output, /edit step 2 in demos\/checkout\.json/);
    assert.doesNotMatch(output, /\n\s+at .*\.m?js:\d+/, 'No stack trace for a problem the person can fix');
    assert.match(output, /Saved what was recorded before the problem: recordings\/checkout-replay-incomplete\.mp4/);
    assert.ok((await readFile(join(cwd, 'recordings', 'checkout-replay-incomplete.mp4'))).length > 1000);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('command-line mistakes get one plain sentence, not a stack trace', () => {
  const script = join(root, 'tools/recorder/record.mjs');
  const missing = spawnSync(process.execPath, [script, 'replay', join(dir, 'nope.json')], {encoding: 'utf8'});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /There is no replay plan at .*nope\.json/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
  const ftp = spawnSync(process.execPath, [script, 'ftp://example.com'], {encoding: 'utf8'});
  assert.match(ftp.stderr, /http or https website address/);
  const word = spawnSync(process.execPath, [script, 'hn'], {encoding: 'utf8'});
  assert.match(word.stderr, /"hn" isn't a complete website address/);
  assert.doesNotMatch(ftp.stderr, /\n\s+at /);
});

test('hesitations are shortened in the plan, but waits for answers are not', () => {
  const b = new StepBuilder();
  const link = {role: 'link', name: 'Next'}, other = {role: 'link', name: 'Back'};
  b.add({kind: 'click', target: link, t: 1000}, null);
  b.add({kind: 'click', target: other, t: 12200}, null); // 11.2 s of hesitation
  b.add({kind: 'click', target: link, t: 14700}, null); // 2.5 s: kept as it was
  const steps = b.finish(15000);
  const waits = steps.filter(s => s.action === 'wait');
  assert.equal(waits[0].ms, 3000);
  assert.match(waits[0].note, /paused 11\.2s.*shortened/);
  assert.equal(waits.length, 1, 'short pauses need no wait step');
});

test('pauses in a live video are shortened; motion is kept', {timeout: 90000}, async () => {
  const {makePlayable, recordToFile} = await import('../record.mjs');
  const ctx = await browser.newContext({viewport: {width: 640, height: 360}});
  const page = await ctx.newPage();
  const page1 = join(dir, 'pauses.html');
  // Still for 4 s, then a moving box for 2 s, then still for 6 s, then a change, then still until the end.
  await writeFile(page1, `<body style="margin:0;background:#fff"><div id=box style="position:absolute;width:80px;height:80px;background:#e33;left:0;top:100px"></div>
    <script>const start = performance.now();
    requestAnimationFrame(function move(now) { const t = (now - start) / 1000;
      if (t > 4 && t < 6) box.style.left = ((t - 4) * 250) + 'px';
      if (t > 12) document.body.style.background = '#cfc';
      requestAnimationFrame(move); });</script></body>`);
  const file = join(dir, 'pauses.mp4');
  try {
    await page.goto(pathToFileURL(page1).href);
    const rec = await recordToFile(page, {file, frameRate: 30, maxWidth: 640, maxHeight: 360});
    await page.waitForTimeout(16000);
    const raw = await rec.stop();
    assert.ok(raw.complete && raw.size > 1000);
    const chrome = await findChrome(process.env.CHROME_PATH);
    const result = await makePlayable({chromium, chromePath: chrome, file, trim: true});
    assert.ok(result.ok, result.reason);
    // About 16 s in; out: ≤0.5 s lead + 2 s of motion + 3 s pause + ≤1.5 s ending (plus timing slack).
    const after = result.duration - result.removed;
    assert.ok(result.duration > 14, `recorded only ${result.duration} s`);
    assert.ok(after > 5 && after < 9, `${result.duration} s became ${after} s`);
    // The motion is all there: the box ends up far to the right in the shortened video too.
    // (Served over HTTP: a canvas can't read pixels from a file:// video.)
    const video = await readFile(file);
    const server = createServer((req, res) => {
      if (req.url === '/v.mp4') { res.setHeader('Content-Type', 'video/mp4'); res.end(video); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<video muted></video>'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const check = await browser.newPage();
    try {
      await check.goto(`http://127.0.0.1:${server.address().port}/`);
      const pixel = await check.evaluate(async seconds => {
        // (As a blob, so it can be seeked without a server that handles ranges.)
        const v = document.querySelector('video');
        v.src = URL.createObjectURL(await (await fetch('/v.mp4')).blob());
        await new Promise(r => v.addEventListener('loadeddata', r, {once: true}));
        v.currentTime = v.duration - seconds;
        await new Promise(r => v.addEventListener('seeked', r, {once: true}));
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0);
        return [...g.getImageData(Math.round(530 * v.videoWidth / 640), Math.round(140 * v.videoHeight / 360), 1, 1).data];
      }, 0.3);
      assert.ok(pixel[0] > 180 && pixel[1] < 120, `expected the red box at the end, got ${pixel}`);
    } finally { await check.close(); await new Promise(resolve => server.close(resolve)); }
  } finally { await ctx.close(); }
});

test('Ctrl+C during a replay keeps the video so far', {skip: process.platform === 'win32', timeout: 90000}, async () => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button>Start</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cwd = join(dir, 'replay-ctrl-c');
  await mkdir(join(cwd, 'demos'), {recursive: true});
  const planPath = join(cwd, 'demos', 'long.json');
  await writeFile(planPath, JSON.stringify({url: `http://127.0.0.1:${server.address().port}/`, viewport: {width: 640, height: 480},
    steps: [{action: 'click', target: {role: 'button', name: 'Start'}}, {action: 'wait', ms: 60000}]}));
  try {
    const child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), 'replay', planPath, '--headless'],
      {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    const waiting = new Promise(resolve => {
      const read = data => { output += data; if (/2\/2 {2}wait/.test(output)) resolve(); };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
    });
    const exited = once(child, 'close');
    await waiting;
    await new Promise(resolve => setTimeout(resolve, 5000));
    child.kill('SIGINT');
    await exited;
    assert.match(output, /Stopped with Ctrl\+C/);
    assert.match(output, /Saved what was recorded before the problem: recordings\/long-replay-incomplete\.mp4/);
    assert.ok((await readFile(join(cwd, 'recordings', 'long-replay-incomplete.mp4'))).includes('avcC'));
    assert.equal(existsSync(join(cwd, 'recordings', 'long-replay.mp4')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
