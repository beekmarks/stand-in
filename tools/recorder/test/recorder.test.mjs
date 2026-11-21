import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {findChromeBinary, startRecording} from 'chrome-capture';
import {findChrome, liveCapture, liveRecording, requireSupportedNode, StepBuilder} from '../record.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
let browser, dir;
before(async () => {
  await mkdir(join(root, '.runs'), {recursive: true});
  dir = await mkdtemp(join(root, '.runs', 'recorder-test-'));
  browser = await chromium.launch({executablePath: await findChrome(process.env.CHROME_PATH, findChromeBinary), headless: true});
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

test('unsupported Node versions produce actionable guidance', () => {
  assert.throws(() => requireSupportedNode('24.10.0'), /24\.11 or newer.*24\.10\.0.*reopen VS Code/);
  assert.throws(() => requireSupportedNode('22.22.0'), /24\.11 or newer/);
  assert.doesNotThrow(() => requireSupportedNode('24.11.0'));
  assert.doesNotThrow(() => requireSupportedNode('25.0.0'));
});

test('live recording saves the actual tab across navigation', async () => {
  const ctx = await browser.newContext({viewport: {width: 640, height: 480}});
  const page = await ctx.newPage();
  const first = join(dir, 'live-first.html'), second = join(dir, 'live-second.html');
  const videoPath = join(dir, 'live.mp4');
  try {
    await writeFile(first, '<body style="background:red"></body>');
    await writeFile(second, '<body style="background:blue"></body>');
    const {done} = await liveRecording({ctx, page, videoPath, startRecording,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto(pathToFileURL(first).href);
    const help = page.locator('stand-in-live-help');
    await help.waitFor();
    assert.match(await help.locator('div').innerText(), /Ctrl\+Shift\+9.*start[\s\S]*again to stop/);
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
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    assert.equal(await help.count(), 0);
    await page.waitForTimeout(1200);
    await page.goto(pathToFileURL(second).href);
    await page.waitForTimeout(1200);
    assert.equal(await help.count(), 0);
    await page.keyboard.press('Control+Shift+Digit9');
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
      startRecording: async () => {
        if (++attempts === 1) { signalFailure(); throw new Error('test start failure'); }
        return {stop: async () => Buffer.from('video')};
      },
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto('about:blank');
    const help = page.locator('stand-in-live-help');
    await help.waitFor();
    await page.keyboard.press('Control+Shift+Digit9');
    await failed;
    await help.waitFor();
    assert.match(await help.locator('div').innerText(), /Ctrl\+Shift\+9/);
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
    const {done, toggle, state} = await liveRecording({ctx, page, videoPath, startRecording,
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

test('closing a live tab before stopping reports that no video was saved', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const {done} = await liveRecording({ctx, page, videoPath: join(dir, 'closed.mp4'), startRecording,
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto('about:blank');
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await page.close();
    await assert.rejects(done, /closed before the recording could be saved/);
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
      startRecording: async () => ({stop: async () => Buffer.from('video')}),
      plan: {fps: 30, viewport: {width: 640, height: 480}}});
    await page.goto(pathToFileURL(first).href);
    const field = page.frameLocator('iframe').locator('input');
    await field.focus();
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    assert.equal(await field.inputValue(), '');
    await page.goto(pathToFileURL(second).href);
    await page.frameLocator('iframe').locator('input').focus();
    await page.keyboard.press('Control+Shift+Digit9');
    await done;
  } finally { await ctx.close(); }
});

test('the one-command CLI saves both files', {skip: process.platform === 'win32', timeout: 60000}, async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<button onclick="this.textContent=\'Clicked\'">Click me</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const cwd = join(dir, 'cli'), wrapper = join(dir, 'test-chrome');
  await mkdir(cwd);
  const chrome = await findChrome(process.env.CHROME_PATH, findChromeBinary);
  const quoted = `'${chrome.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexec ${quoted} --headless=new --remote-debugging-port=${port} "$@"\n`, {mode: 0o755});
  let child, connected, timer;
  try {
    child = spawn(process.execPath, [join(root, 'tools/recorder/record.mjs'), url, '--chrome', wrapper],
      {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    const ready = new Promise(resolve => {
      const read = data => {
        output += data;
        if (/press Ctrl\+Shift\+9 in the page to start/i.test(output)) resolve();
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
    });
    const exited = once(child, 'close');
    await Promise.race([
      ready,
      exited.then(([code]) => { throw new Error(`CLI exited before opening the site (${code}): ${output}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI did not become ready: ${output}`)), 20000); }),
    ]);
    clearTimeout(timer);
    connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = connected.contexts()[0].pages().find(p => p.url() === url);
    assert.ok(page, 'The recorded page was not opened');
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await page.getByRole('button', {name: 'Click me'}).click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Control+Shift+Digit9');
    const [code] = await exited;
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
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill();
    await connected?.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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
      executablePath: await findChrome(process.env.CHROME_PATH, findChromeBinary), headless: true,
      viewport: {width: 640, height: 480},
    });
    const page = ctx.pages()[0];
    const planPath = join(dir, 'combined.json'), videoPath = join(dir, 'combined.mp4');
    try {
      const plan = {fps: 30, viewport: {width: 640, height: 480}};
      const capture = await liveCapture({ctx, page, plan, planPath, profileDir});
      const {done} = await liveRecording({ctx, page, plan, videoPath, startRecording, capture});
      await page.goto(`${url}/sign-in`);
      await ctx.addCookies([{name: 'session', value: 'test', url, expires: Date.now() / 1000 + 300}]);
      await page.goto(`${url}/start`);
      await page.getByPlaceholder('Preparation').fill('exclude me');
      await page.keyboard.press('Control+Shift+Digit9');
      await waitForLiveState(page, 'recording');
      await page.getByRole('link', {name: 'Next'}).click();
      const frame = page.frameLocator('#demo-frame');
      await frame.getByLabel('Message').fill('hello');
      await frame.getByRole('button', {name: 'Send'}).click();
      await page.waitForTimeout(1000);
      await page.keyboard.press('Control+Shift+Digit9');
      await done;
      assert.ok((await readFile(videoPath)).length > 1000);
      const saved = JSON.parse(await readFile(planPath, 'utf8'));
      assert.equal(saved.url, `${url}/start`);
      assert.equal(saved.profileDir, 'combined-session');
      assert.ok(saved.steps.some(s => s.action === 'click' && s.target?.name === 'Next'));
      assert.ok(saved.steps.some(s => s.action === 'type' && s.target?.frame === '#demo-frame' && s.text === 'hello' && s.clear));
      assert.ok(saved.steps.some(s => s.action === 'click' && s.target?.frame === '#demo-frame' && s.target?.name === 'Send'));
      assert.doesNotMatch(JSON.stringify(saved.steps), /exclude me|Digit9|ControlOrMeta\+9/);
      saved.steps.unshift(
        {action: 'caption', text: 'A replay caption'},
        {action: 'highlight', target: {role: 'link', name: 'Next'}, ms: 1000},
      );
      await writeFile(planPath, JSON.stringify(saved));
    } finally { await ctx.close(); }
    const script = join(root, 'tools/recorder/record.mjs');
    const refused = spawnSync(process.execPath, [script, 'replay', planPath, '--headless', '--rehearse'], {encoding: 'utf8'});
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /explicit approval/);
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
    assert.equal(actionCount, 2);
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
      startRecording: async () => ({stop: async () => Buffer.from('video')})});
    await page.goto('about:blank');
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await page.keyboard.press('Control+Shift+Digit9');
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
      startRecording: async () => ({stop: async () => Buffer.from('video')})});
    await page.goto(pathToFileURL(pagePath).href);
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await page.getByLabel('Password').fill('secret-password');
    await page.keyboard.press('Control+Shift+Digit9');
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
// an ad frame that doesn't scroll, and a submit button.
const TRICKY_PAGE = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:16px sans-serif} .card{height:120px;border:1px solid #ccc;margin:8px}
  .cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px}</style>
<div class="cookie-banner" id="cookies">We use cookies. <button onclick="cookies.remove()">Accept all</button></div>
<div id="cards">${[1, 2, 3].map(n => `<div class="card"><h3>Story ${n}</h3>
  <a href="#story-${n}" data-testid="card-link" onclick="document.body.dataset.story=${n}">Read more</a></div>`).join('')}</div>
<fancy-button id="launch">Launch</fancy-button>
<code-box></code-box>
<label>Period <select id="period"><option value="0">3pm Fri, Nov 20</option><option value="12">5pm Sat, Nov 21</option></select></label>
<form onsubmit="event.preventDefault(); document.body.dataset.saved = 1"><input type="submit" value="Save"></form>
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
      startRecording: async () => ({stop: async () => Buffer.from('video')})});
    await page.goto(url);
    await page.keyboard.press('Control+Shift+Digit9');
    await waitForLiveState(page, 'recording');
    await click(page.getByRole('button', {name: 'Accept all'}));
    await click(page.getByRole('link', {name: 'Read more'}).nth(1));
    await click(page.getByRole('button', {name: 'Launch'}));
    await click(page.locator('code-box .content'));
    await page.keyboard.type('let x = 1;', {delay: 20});
    await page.locator('#period').focus();
    await page.keyboard.press('ArrowDown'); // a person's change, unlike selectOption()
    await click(page.getByRole('button', {name: 'Save'}));
    const ad = await page.locator('#ad').boundingBox();
    await page.mouse.move(ad.x + 100, ad.y + 100);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(40); }
    await page.waitForTimeout(800);
    await page.keyboard.press('Control+Shift+Digit9');
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
    assert.deepEqual(clicks.at(-1).target, {role: 'button', name: 'Save'});
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
      {story: '2', launched: '1', saved: '1', period: '12', code: 'let x = 1;', cookies: false, scrolled: true});
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
