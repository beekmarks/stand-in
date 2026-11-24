#!/usr/bin/env node
// Site sweep: tries Stand-in on many popular websites, the way a first-time visitor would use them, to find
// problems before people do. Unlike `npm run site-check`, nothing here is written for a particular site:
// one generic visitor closes a cookie notice, opens a menu in the site's navigation and clicks a link in it,
// follows a link on the page, searches for "help", scrolls, and follows a link that opens a new tab, using
// real (trusted) mouse and keyboard input through the real recorder. Each step is skipped when the site has
// nothing suitable.
//
//   npm run site-sweep                          every site in scripts/sweep-sites.json
//   npm run site-sweep -- news shopping         only these kinds of site
//   npm run site-sweep -- github.com bbc.com    only these sites
//   npm run site-sweep -- --extended            a second set of 100 sites (scripts/sweep-sites-extended.json)
//   npm run site-sweep -- --jobs 2 --headless   two at a time; without a display
//
// After each site it checks that:
//   - a playable H.264 video was made, and the recorder reported no problems;
//   - everything stayed in the one recorded tab;
//   - the replay plan has a step for each thing the visitor did (a missing one would break replay);
//   - the plan isn't fragile, which today's replay might not show: it uses no id that changes on every
//     visit, saves where each link goes, doesn't make a needed click optional, doesn't wait for a chat
//     answer after a search, and has no extra click from pressing Enter (each one a problem Stand-in had);
//   - the plan replays (as a rehearsal) and ends on the same page the recording did.
//
//   npm run site-sweep -- --check-plans .runs/site-sweep-<time>   re-checks saved plans, visiting nothing
// Results go to .runs/site-sweep-<time>/report.md, grouped by kind of problem, with a screenshot of each
// site at the end of its recording. Sites change, and some block automated browsers from data centres:
// those are reported as "blocked", not as Stand-in problems. A failure is a lead to look at, not proof.

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recorder = join(root, 'tools', 'recorder', 'record.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (promise, ms, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms))]);

async function freePort() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const {port} = server.address();
  await new Promise(r => server.close(r));
  return port;
}

// Runs the recorder and collects its output; waitFor resolves when a pattern appears.
function run(args, cwd) {
  const child = spawn(process.execPath, [recorder, ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
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
    proc.exited.then(code => { clearTimeout(timer); if (!pattern.test(proc.output)) reject(new Error(`recorder exited (${code}) before ${pattern}`)); });
  });
  return proc;
}

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

const BLOCKED = /access denied|just a moment|attention required|verify (that )?you are (a )?human|are you a robot|robot or human|captcha|pardon our interruption|request (was )?blocked|unusual traffic|403 forbidden|bot detected|security check|quick verification|press (&|and) hold|not a bot|confirm you'?re (a )?human|having a technical issue/i;
// Cookie buttons, in English and the languages of the extended set's sites outside the US.
const CONSENT = /^\s*(reject all|reject|decline( all)?|necessary (cookies )?only|only (allow )?(essential|necessary)( cookies)?|accept( all)?( cookies)?|allow( all)?( cookies)?|agree( and (proceed|continue))?|i agree|i accept|got it|ok(ay)?|continue|alle ablehnen|ablehnen|alle akzeptieren|akzeptieren|zustimmen|einverstanden|tout refuser|refuser|tout accepter|accepter|j'accepte|continuer sans accepter|rechazar( todo| todas)?|aceptar( todo| todas| y cerrar)?|rifiuta( tutto| tutti)?|accetta( tutto| tutti)?|accetto|rejeitar( todos)?|aceitar( todos| tudo)?|alles accepteren|weigeren|(すべて)?同意(する)?|すべて許可|拒否(する)?|(모두 )?동의|거부|확인)\s*$/i;

// The generic visitor. Each step finds something suitable on the page, moves the mouse there like a person
// and clicks; `did` records what it did, so the plan can be checked against it.
function visitor(page, did) {
  const tabs = () => page.context().pages().filter(p => !p.url().startsWith('devtools')).length;
  const blockedNow = async () => {
    const words = await page.evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 1500) ?? ''}`).catch(() => '');
    return BLOCKED.test(words) ? (BLOCKED.exec(words)?.[0] ?? 'blocked') : null;
  };
  // Sites can start blocking partway through, after a few pages; note that too.
  const note = async (kind, what, extra = {}) => {
    await sleep(300);
    did.push({kind, what, url: page.url(), tabs: tabs(), blocked: await blockedNow() ?? undefined, ...extra});
  };
  const moveAndClick = async ({x, y}) => {
    await page.mouse.move(x, y, {steps: 12});
    await sleep(250);
    await page.mouse.click(x, y);
  };
  // Scroll to a marked element with the mouse wheel, as a person would (so it's in the plan), and return
  // its centre once it's in view.
  const reach = async item => {
    if (!item?.mark) return item;
    const {width, height} = page.viewportSize() ?? {width: 1280, height: 800};
    await page.mouse.move(width / 2, height / 2, {steps: 4});
    for (let i = 0; i < 25; i++) {
      const r = await page.evaluate(() => {
        const el = document.querySelector('[data-sweep-pick]');
        const b = el?.getBoundingClientRect();
        return b && {x: b.x + b.width / 2, y: b.y + b.height / 2};
      }).catch(() => null);
      if (!r) return null;
      if (r.y > 100 && r.y < height - 100) return {...item, x: r.x, y: r.y};
      await page.mouse.wheel(0, Math.max(-500, Math.min(500, r.y - height / 2)));
      await sleep(300);
    }
    return null;
  };
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded', {timeout: 15000}).catch(() => {});
    await sleep(1800);
  };
  // Visible elements matching `kind` in the main page, scrolled into view, with their centres.
  const find = (kind, extra) => page.evaluate(([kind, extra]) => {
    const shown = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.1 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const text = el => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
    // Shown somewhere on the page, perhaps further down; marked so the visitor can scroll to it with the wheel.
    const anywhere = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.1;
    };
    const mark = (el, extra = {}) => {
      document.querySelectorAll('[data-sweep-pick]').forEach(n => n.removeAttribute('data-sweep-pick'));
      el.setAttribute('data-sweep-pick', '');
      return [{mark: true, text: text(el).slice(0, 60), ...extra}];
    };
    const sameSite = a => { try { const u = new URL(a.href); return u.hostname.split('.').slice(-2).join('.') === location.hostname.split('.').slice(-2).join('.'); } catch { return false; } };
    const realLink = a => /^https?:/i.test(a.href) &&
      !(a.getAttribute('href') ?? '').startsWith('#') && new URL(a.href).href.split('#')[0] !== location.href.split('#')[0];
    const centre = el => { const r = el.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, text: text(el).slice(0, 60)}; };
    const inChrome = el => !!el.closest('header,nav,footer,[role=navigation],[role=banner],[role=contentinfo],[role=dialog],[aria-modal=true]');
    if (kind === 'nav') {
      // Top-level items in the site's navigation, near the top of the page.
      return [...document.querySelectorAll('header a, header button, nav a, nav button, [role=navigation] a, [role=navigation] button, [role=menubar] [role=menuitem]')]
        .filter(el => shown(el) && el.getBoundingClientRect().top < 260 && text(el).length >= 2 && text(el).length <= 30)
        .slice(0, 10).map(el => ({...centre(el), opens: el.matches('[aria-haspopup],[aria-expanded]')}));
    }
    if (kind === 'visibleLinks') return [...document.querySelectorAll('a[href]')].filter(shown).map(a => a.href + '|' + text(a));
    if (kind === 'revealed') {
      const before = new Set(extra);
      return [...document.querySelectorAll('a[href]')].filter(a => shown(a) && !before.has(a.href + '|' + text(a)) && realLink(a) &&
        text(a).length >= 3 && a.target !== '_blank').slice(0, 5).map(centre);
    }
    if (kind === 'link') {
      const links = [...document.querySelectorAll('main a[href], article a[href], a[href]')].filter(a => !inChrome(a) && realLink(a) &&
        sameSite(a) && a.target !== '_blank' && text(a).length >= 4 && text(a).length <= 80);
      const seen = new Set();
      const unique = links.filter(a => !seen.has(a) && seen.add(a));
      const pick = unique.slice(2).find(anywhere) ?? unique.find(anywhere);
      return pick ? mark(pick) : [];
    }
    if (kind === 'search') {
      const box = [...document.querySelectorAll('input[type=search], input[name=q], textarea[name=q], input[name=query], input[name*=search i], input[id*=search i], input[placeholder*=search i], input[aria-label*=search i], [role=searchbox], [role=combobox][aria-label*=search i], input[placeholder*=such i], input[placeholder*=recherch i], input[placeholder*=busca i], input[placeholder*=cerca i], input[placeholder*=検索], input[placeholder*=검색], input[aria-label*=such i], input[aria-label*=recherch i], input[aria-label*=busca i], input[aria-label*=cerca i], input[aria-label*=検索], input[aria-label*=검색]')]
        .find(el => !el.disabled && !el.readOnly && anywhere(el));
      if (box) return mark(box, {box: true});
      const opener = [...document.querySelectorAll('button, a, [role=button]')].find(el => shown(el) && /^(search|suche|suchen|rechercher|recherche|buscar|cerca|検索|검색)$|^open search|^show search/i.test(text(el)) );
      return opener ? [{...centre(opener), box: false}] : [];
    }
    if (kind === 'newtab') {
      const link = [...document.querySelectorAll('a[href][target=_blank]')].find(a => realLink(a) && text(a).length >= 2 && anywhere(a));
      return link ? mark(link) : [];
    }
    return [];
  }, [kind, extra]).catch(() => []);

  return {
    async look(ms = 1500) { await sleep(ms); },
    blocked: blockedNow,
    async cookies() {
      for (const frame of page.frames()) {
        const button = frame.getByRole('button', {name: CONSENT}).or(frame.getByRole('link', {name: CONSENT}));
        const count = await button.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 6); i++) {
          const b = button.nth(i);
          if (!await b.isVisible().catch(() => false)) continue;
          const box = await b.boundingBox().catch(() => null);
          if (!box) continue;
          const name = (await b.innerText().catch(() => '')).trim();
          // "Continue" or "OK" alone could be any button (a sign-up form's): only near words about cookies.
          if (/^(continue|ok(ay)?|확인)$/i.test(name) && !await b.evaluate(el => {
            for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++)
              if (/cookie|consent|クッキー|쿠키/i.test(n.innerText ?? '')) return true;
            return false;
          }).catch(() => false)) continue;
          await moveAndClick({x: box.x + box.width / 2, y: box.y + box.height / 2});
          await note('cookies', name, {frame: frame !== page.mainFrame()});
          await sleep(800);
          return true;
        }
      }
      return false;
    },
    // Point at navigation items until one opens a menu, then click a link in it.
    async menu() {
      const items = await find('nav');
      for (const item of items.slice(0, 6)) {
        const before = await find('visibleLinks');
        await page.mouse.move(item.x, item.y, {steps: 10});
        await sleep(1000);
        let links = await find('revealed', before);
        let how = 'pointing';
        if (links.length) {
          // Make sure pointing is what showed them: they should go when the pointer leaves (a carousel moving
          // into view doesn't). Then point again.
          const {width, height} = page.viewportSize() ?? {width: 1280, height: 800};
          await page.mouse.move(width - 15, height - 15, {steps: 6});
          await sleep(900);
          const away = await find('revealed', before);
          if (away.length >= links.length) continue;
          await page.mouse.move(item.x, item.y, {steps: 8});
          await sleep(1000);
          links = await find('revealed', before);
        }
        if (!links.length && item.opens) {
          await page.mouse.click(item.x, item.y);
          await sleep(900);
          links = await find('revealed', before);
          how = 'clicking';
          if (!links.length) continue;
          await note('menu-toggle', item.text);
        }
        if (!links.length) continue;
        const link = links[0];
        const from = page.url();
        await moveAndClick(link);
        await settle();
        await note('menu', `${item.text} > ${link.text}`, {how, navigated: page.url() !== from});
        return true;
      }
      return false;
    },
    async link() {
      const link = await reach((await find('link'))[0]);
      if (!link) return false;
      const from = page.url();
      await moveAndClick(link);
      await settle();
      await note('link', link.text, {navigated: page.url() !== from});
      return true;
    },
    async search() {
      let box = await reach((await find('search'))[0]);
      if (!box) return false;
      if (!box.box) {
        await moveAndClick(box);
        await sleep(900);
        await note('search-open', box.text);
        box = await reach((await find('search'))[0]);
        if (!box?.box) return false;
      }
      await moveAndClick(box);
      await sleep(400);
      // Only type if the click really put the cursor in a text box.
      const inBox = await page.evaluate(() => {
        let a = document.activeElement;
        while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
        return !!a && (a.matches('input, textarea') || a.isContentEditable);
      }).catch(() => false);
      if (!inBox) { await note('search-missed', box.text || 'search box'); return false; }
      await page.keyboard.type('help', {delay: 110});
      await sleep(500);
      const from = page.url();
      await page.keyboard.press('Enter');
      await settle();
      await note('search', box.text || 'search box', {navigated: page.url() !== from});
      return true;
    },
    async scroll() {
      const {width, height} = page.viewportSize() ?? {width: 1280, height: 800};
      await page.mouse.move(width / 2, height / 2, {steps: 5});
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 300); await sleep(120); }
      await sleep(1200);
      await note('scroll', 'down');
    },
    async newTab() {
      const link = await reach((await find('newtab'))[0]);
      if (!link) return false;
      const from = page.url();
      await moveAndClick(link);
      await sleep(4000);
      await settle();
      await note('newtab', link.text, {navigated: page.url() !== from});
      return true;
    },
  };
}

// What the visitor did, as plan steps it should have produced.
// `link`: a click on a web link that went somewhere, which must be found again on replay.
function expectedSteps(did) {
  const want = [];
  for (const d of did) {
    if (['cookies', 'menu-toggle'].includes(d.kind)) want.push({action: 'click', why: `${d.kind}: ${d.what}`, name: d.what});
    if (['search-open', 'search-missed'].includes(d.kind)) want.push({action: 'click', why: `${d.kind}: ${d.what}`});
    if (['link', 'newtab'].includes(d.kind)) want.push({action: 'click', why: `${d.kind}: ${d.what}`, link: !!d.navigated, name: d.what});
    // A menu item that went nowhere may not have been clicked at all (the menu closed first), and then the
    // demo has nothing of it to record.
    if (d.kind === 'menu' && d.navigated) {
      if (d.how === 'pointing') want.push({action: 'hover', why: `menu opened by pointing: ${d.what}`});
      want.push({action: 'click', why: `menu: ${d.what}`, link: !!d.navigated, name: d.what.split(' > ').at(-1)});
    }
    if (d.kind === 'search') want.push({action: 'type', why: 'search for "help"', text: 'help', search: true});
  }
  return want;
}

// Matches the plan's steps with what the visitor did, in order: what's missing, and which step is which.
function matchSteps(steps, did) {
  const missing = [], matched = [];
  let i = 0;
  for (const w of expectedSteps(did)) {
    const fits = (s, j) => j >= i && s.action === w.action && (w.text == null || s.text === w.text);
    // A link the visitor clicked by name is that step, not a stray click on the way (on text, say).
    // (Either name may be cut short, so the start is enough.)
    const key = n => typeof n === 'string' ? n.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 20) : null;
    const named = w.name ? steps.findIndex((s, j) => fits(s, j) && key(s.target?.name ?? s.target?.text) === key(w.name)) : -1;
    const at = named >= 0 ? named : steps.findIndex(fits);
    if (at < 0) missing.push(w.why); else { matched.push({want: w, step: steps[at], at}); i = at + 1; }
  }
  return {missing, matched};
}

// Ids a site generates afresh on each visit (React's "_R_5l7d_", "offer-0-WBVvC"): a plan that uses one
// breaks next time. The same test Stand-in uses when recording.
const randomPart = p => p.length >= 4 && ((/\d/.test(p) && /[A-Z]/.test(p.slice(1))) ||
  (p.length <= 10 && (p.match(/[A-Z]/g) ?? []).length >= 2 && /[a-z]/.test(p) && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(p)));
const generatedId = id => /\d{3,}|[a-f0-9]{8,}|^(css|sc|jsx|ng|ember)-|__|^(?::r|«r|_r_)/i.test(id) ||
  /^[A-Z][A-Za-z]+-(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]{5,8}$/.test(id) ||
  id.split(/[-_:.]/).some(randomPart) || (/^[a-zA-Z]{5,8}$/.test(id) && (id.match(/[A-Z]/g) ?? []).length >= 2);
// Ids and style (class) names in a CSS selector.
const idsIn = text => [...(text ?? '').matchAll(/[#.]((?:\\.|[\w-])+)|\[id=["']?([^"'\]]+)/g)].map(m => (m[1] ?? m[2]).replace(/\\/g, ''));
const describe = t => t?.name ?? t?.label ?? t?.placeholder ?? t?.testId ?? t?.css ?? JSON.stringify(t);

// Things that make a plan fragile even when today's replay happens to work. Each one is a problem Stand-in
// once had; this keeps checking for them on every site.
function planIssues(steps, did) {
  const issues = [];
  const {matched} = matchSteps(steps, did);
  for (const s of steps) {
    const bad = [s.target, s.around].flatMap(t => t && typeof t === 'object' ? [...idsIn(t.css), ...idsIn(t.frame)] : typeof t === 'string' ? idsIn(t) : [])
      .filter(generatedId);
    if (bad.length) issues.push(`uses a name the site makes up afresh on each visit (${bad.join(', ')}) in a ${s.action} step`);
  }
  for (const {want, step} of matched) {
    const t = step.target ?? {};
    if (want.link && t.role === 'link' && !t.href) issues.push(`link saved without where it goes: "${describe(t)}"`);
    if (want.link && step.optional) issues.push(`a click the demo needs is optional, so replay may skip it: "${describe(t)}"`);
  }
  steps.forEach((s, i) => {
    const next = steps.slice(i + 1).find(n => n.action !== 'wait');
    const searched = s.action === 'type' && s.submit && s.text === 'help';
    if (searched && next?.action === 'waitForStable') issues.push('waits for a chat answer after a search');
    // The visitor scrolls after searching, so a click straight after pressing Enter came from the key.
    if (searched && next?.action === 'click') issues.push(`extra click straight after pressing Enter: "${describe(next.target)}"`);
  });
  return [...new Set(issues)];
}

// Every site gets at most this long, so a page that stops responding can't stall the sweep.
const SITE_LIMIT_MS = 10 * 60 * 1000;

async function sweepSite(site, kind, options) {
  const running = {};
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve('limit'), SITE_LIMIT_MS); });
  const work = checkOneSite(site, kind, options, running);
  const first = await Promise.race([work, limit]);
  clearTimeout(timer);
  if (first !== 'limit') return first;
  for (const child of [running.live, running.replay]) if (child?.exitCode === null) child.kill('SIGKILL');
  await running.browser?.close().catch(() => {});
  const r = await Promise.race([work, sleep(15000).then(() => null)]);
  const result = r ?? {site, kind, did: [], problems: [], notes: [], output: ''};
  result.problems.push({type: 'sweep could not finish', detail: `the site took over ${SITE_LIMIT_MS / 60000} minutes (the page may have stopped responding)`});
  return result;
}

async function checkOneSite(site, kind, {out, headless}, running) {
  const name = site.replace(/[^a-z0-9.-]/gi, '_');
  const cwd = join(out, name);
  await mkdir(cwd, {recursive: true});
  const port = await freePort();
  const {findChrome} = await import(recorder);
  const chrome = await findChrome(process.env.CHROME_PATH);
  const wrapper = join(cwd, 'chrome.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec '${chrome.replaceAll("'", "'\\''")}' ${headless ? '--headless=new ' : ''}--remote-debugging-port=${port} "$@"\n`, {mode: 0o755});
  const r = {site, kind, did: [], problems: [], notes: []};
  const t0 = Date.now();
  const live = run([site, '--chrome', wrapper], cwd);
  running.live = live.child;
  let browser;
  try {
    await live.waitFor(/Ready\./, 60000);
    r.readyAfter = (Date.now() - t0) / 1000;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    running.browser = browser;
    const page = browser.contexts()[0].pages().find(p => !p.url().startsWith('devtools')) ?? browser.contexts()[0].pages()[0];
    await page.bringToFront();
    await sleep(2500);
    const v = visitor(page, r.did);
    const blocked = await v.blocked();
    await doubleShift(page);
    await live.waitFor(/Recording this tab/, 15000);
    if (blocked) r.blocked = blocked;
    else {
      // Every step has a time limit, so one stuck page can't stall the sweep.
      const attempt = async (what, fn, ms = 30000) => {
        try { return await withTimeout(fn(), ms, what); } catch (error) { r.notes.push(`${what}: ${error.message.split('\n')[0]}`); return false; }
      };
      await v.look();
      await attempt('cookies', () => v.cookies(), 15000);
      // The visitor carries on from wherever each step leads (going back wouldn't be in the plan).
      await attempt('menu', () => v.menu(), 40000);
      await attempt('link', () => v.link());
      await attempt('search', () => v.search());
      await attempt('scroll', () => v.scroll(), 15000);
      await attempt('new tab', () => v.newTab());
      r.blocked = await v.blocked() ?? r.did.find(d => d.blocked)?.blocked;
    }
    await page.screenshot({path: join(cwd, 'end.png')}).catch(() => {});
    r.finalUrl = page.url();
    r.tabsAtEnd = page.context().pages().filter(p => !p.url().startsWith('devtools')).length;
    const stoppedAt = Date.now();
    await doubleShift(page);
    await live.waitFor(/Your video is ready|ERROR/, 240000);
    const code = await withTimeout(live.exited, 30000, 'the recorder exiting');
    r.finishedAfterStop = (Date.now() - stoppedAt) / 1000;
    if (code !== 0) r.problems.push({type: 'recorder error', detail: /ERROR: ([^\n]*)/.exec(live.output)?.[1] ?? `exited ${code}`});
    const [video] = await readdir(join(cwd, 'recordings')).catch(() => []);
    const [planFile] = (await readdir(join(cwd, 'demos')).catch(() => [])).filter(f => f.endsWith('.json'));
    if (!video) r.problems.push({type: 'no video', detail: 'no video file was saved'});
    else {
      const bytes = await readFile(join(cwd, 'recordings', video));
      r.video = {file: join(name, 'recordings', video), mb: +(bytes.length / 1e6).toFixed(1)};
      r.length = /Your video is ready: \S+ \(([^)]*)\)/.exec(live.output)?.[1];
      if (!bytes.includes('avcC')) r.problems.push({type: 'video not H.264', detail: video});
    }
    for (const line of live.output.split('\n'))
      if (/Could not capture|couldn't be moved|isn't in the video|incomplete/i.test(line)) r.problems.push({type: 'recorder warning', detail: line.replace(/^\[stand-in\]\s*/, '')});
    const leaks = r.did.filter(d => d.tabs > 1);
    if (leaks.length || r.tabsAtEnd > 1)
      r.problems.push({type: 'left the recorded tab', detail: leaks.map(d => `${d.kind} "${d.what}" left ${d.tabs} tabs`).join('; ') || `${r.tabsAtEnd} tabs at the end`});
    if (planFile && !r.blocked) {
      const planPath = join(cwd, 'demos', planFile);
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      r.plan = join(name, 'demos', planFile);
      r.planSteps = plan.steps.map(s => s.action);
      const {missing} = matchSteps(plan.steps, r.did);
      if (missing.length) r.problems.push({type: 'plan is missing a step', detail: missing.join('; ')});
      const fragile = planIssues(plan.steps, r.did);
      if (fragile.length) r.problems.push({type: 'fragile plan', detail: fragile.join('; ')});
      // Replay as a rehearsal, and check it ends on the page the recording ended on.
      const end = new URL(r.finalUrl);
      const check = {...plan, steps: [...plan.steps,
        {action: 'waitFor', url: `${end.origin}${end.pathname}**`, timeout: 15000, note: 'site sweep: same page as the recording'}]};
      const checkPath = join(cwd, 'demos', 'sweep-replay.json');
      await writeFile(checkPath, JSON.stringify(check, null, 2));
      const replay = run(['replay', checkPath, '--rehearse', '--confirm-signed-in', ...(headless ? ['--headless'] : [])], cwd);
      running.replay = replay.child;
      const replayCode = await withTimeout(replay.exited, 300000, 'the replay').catch(error => { replay.child.kill('SIGKILL'); r.replayError = error.message; return -1; });
      r.replayOutput = replay.output;
      if (replayCode !== 0) {
        const failed = /Step (\d+) of (\d+) failed: ([^\n]*)\n\s*([^\n]*)/.exec(replay.output);
        const last = failed && +failed[1] === check.steps.length;
        r.problems.push(last ? {type: 'replay ended on a different page', detail: `expected ${end.origin}${end.pathname}`}
          : {type: 'replay failed', detail: failed ? `step ${failed[1]}: ${failed[3]} (${failed[4].trim()})` : (r.replayError ?? /ERROR: ([^\n]*)/.exec(replay.output)?.[1] ?? `exited ${replayCode}`)});
      }
    }
  } catch (error) {
    r.problems.push({type: 'sweep could not finish', detail: error.message.split('\n')[0]});
  } finally {
    await browser?.close().catch(() => {});
    if (live.child.exitCode === null) live.child.kill('SIGKILL');
    r.output = live.output;
    r.seconds = Math.round((Date.now() - t0) / 1000);
    // Save disk space: the browser profile is never needed afterwards, and a video only when there was a problem.
    await rm(join(cwd, '.sessions'), {recursive: true, force: true}).catch(() => {});
    if (!r.problems.length) await rm(join(cwd, 'recordings'), {recursive: true, force: true}).catch(() => {});
  }
  return r;
}

// ---- Run ----
const args = process.argv.slice(2);

// `--check-plans <folder>`: check the plans an earlier sweep saved, without visiting any site.
if (args[0] === '--check-plans') {
  const dir = resolve(args[1] ?? '');
  const results = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'));
  let found = 0;
  for (const r of results) {
    if (!r.plan) continue;
    const plan = JSON.parse(await readFile(join(dir, r.plan), 'utf8').catch(() => 'null'));
    if (!plan) continue;
    const issues = [...matchSteps(plan.steps, r.did).missing.map(m => `missing step: ${m}`), ...planIssues(plan.steps, r.did)];
    if (issues.length) found++;
    console.log(`${r.site.padEnd(24)} ${issues.length ? issues.join('\n' + ' '.repeat(25)) : 'ok'}`);
  }
  console.log(`\n${found} of ${results.filter(r => r.plan).length} plans have something to look at.`);
  process.exit(0);
}

const headless = args.includes('--headless');
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Math.max(1, +args[jobsAt + 1] || 1) : 1;
const chosen = args.filter((a, i) => !a.startsWith('--') && (jobsAt < 0 || i !== jobsAt + 1));
// --extended: the second set of 100 sites, in scripts/sweep-sites-extended.json.
const listFile = args.includes('--extended') ? 'sweep-sites-extended.json' : 'sweep-sites.json';
const {sites} = JSON.parse(await readFile(join(root, 'scripts', listFile), 'utf8'));
const all = Object.entries(sites).flatMap(([kind, list]) => list.map(site => ({site, kind})));
const queue = chosen.length ? all.filter(s => chosen.includes(s.kind) || chosen.includes(s.site)) : all;
for (const c of chosen) if (!sites[c] && !all.some(s => s.site === c)) queue.push({site: c, kind: 'other'});
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = join(root, '.runs', `site-sweep-${stamp}`);
await mkdir(out, {recursive: true});
console.log(`Sweeping ${queue.length} sites, ${jobs} at a time. Results: ${out}`);

const results = [];
const verdict = r => r.blocked ? 'blocked' : r.problems.length ? 'problem' : 'ok';
const save = async () => {
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await writeFile(join(out, 'report.md'), report(results));
};
let next = 0;
await Promise.all(Array.from({length: jobs}, async () => {
  while (next < queue.length) {
    const {site, kind} = queue[next++];
    const r = await sweepSite(site, kind, {out, headless});
    results.push(r);
    const did = r.did.map(d => d.kind).join(', ') || 'nothing';
    console.log(`${String(results.length).padStart(3)}/${queue.length} ${site.padEnd(24)} ${verdict(r).padEnd(8)} ${r.blocked ? r.blocked : r.problems.map(p => p.type).join('; ') || `did: ${did}`}`);
    await save();
  }
}));

function report(results) {
  const by = v => results.filter(r => verdict(r) === v);
  const lines = ['# Stand-in site sweep', '', `${new Date().toLocaleString()} · ${headless ? 'headless' : 'visible'} Chrome · ${results.length} sites`, '',
    `- **Worked:** ${by('ok').length}`, `- **Problems:** ${by('problem').length}`, `- **Blocked by the site** (bot check, not Stand-in): ${by('blocked').length}`, ''];
  const types = {};
  for (const r of by('problem')) for (const p of r.problems) (types[p.type] ??= []).push({r, p});
  if (Object.keys(types).length) lines.push('## Problems by kind', '');
  for (const [type, list] of Object.entries(types).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${type} (${list.length})`, '');
    for (const {r, p} of list) lines.push(`- **${r.site}** (${r.kind}): ${p.detail} · [screenshot](${r.site.replace(/[^a-z0-9.-]/gi, '_')}/end.png)`);
    lines.push('');
  }
  lines.push('## Every site', '', '| Site | Kind | Result | What the visitor did | Video | Ready | Finished | Plan steps |', '|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const did = r.did.map(d => d.kind + (d.how === 'clicking' ? ' (click)' : '')).join(', ') || '–';
    lines.push(`| ${r.site} | ${r.kind} | ${verdict(r) === 'ok' ? '✅' : verdict(r) === 'blocked' ? `🚫 ${r.blocked}` : `❌ ${r.problems.map(p => p.type).join('; ')}`} | ${did} | ` +
      `${r.video ? `${r.length ?? ''} ${r.video.mb} MB` : '–'} | ${r.readyAfter?.toFixed(0) ?? '–'} s | ${r.finishedAfterStop?.toFixed(0) ?? '–'} s | ${r.planSteps?.join(', ') ?? '–'} |`);
  }
  for (const r of by('problem')) {
    lines.push('', `## ${r.site}`, '', ...r.problems.map(p => `- ${p.type}: ${p.detail}`), ...(r.notes.length ? ['', 'Visitor notes:', ...r.notes.map(n => `- ${n}`)] : []),
      '', '```', (r.output + (r.replayOutput ?? '')).trim().split('\n').slice(-30).join('\n'), '```');
  }
  return lines.join('\n') + '\n';
}

await save();
const counts = ['ok', 'problem', 'blocked'].map(v => results.filter(r => verdict(r) === v).length);
console.log(`\n${counts[0]} worked, ${counts[1]} had problems, ${counts[2]} blocked the browser. Report: ${join(out, 'report.md')}`);
