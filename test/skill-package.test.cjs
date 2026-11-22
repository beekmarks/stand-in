'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFile, execFileSync} = require('node:child_process');
const {createWriteStream} = require('node:fs');
const {mkdir, mkdtemp, readFile, rm, stat, writeFile} = require('node:fs/promises');
const {createServer} = require('node:http');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {pipeline} = require('node:stream/promises');
const {promisify} = require('node:util');
const yauzl = require('yauzl');
const {packageSkill} = require('../scripts/package-skill.cjs');

async function extract(zipPath, destination) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(zipPath, {lazyEntries: true}, (error, file) => error ? reject(error) : resolve(file)));
  const names = [];
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        names.push(entry.fileName);
        const output = path.join(destination, entry.fileName);
        await mkdir(path.dirname(output), {recursive: true});
        const input = await new Promise((res, rej) =>
          zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream)));
        await pipeline(input, createWriteStream(output));
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.readEntry();
  });
  return names;
}

test('standalone skill archive contains working, self-contained recorder resources', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'stand-in-package-test-'));
  try {
    const archive = path.join(temp, 'skill.zip');
    await packageSkill(archive);
    const names = await extract(archive, temp);
    assert.ok(names.includes('START-HERE.md'));
    assert.ok(names.includes('stand-in/SKILL.md'));
    assert.ok(names.includes('stand-in/recorder/node_modules/playwright-core/package.json'));
    assert.ok(names.includes('stand-in/recorder/node_modules/mediabunny/package.json'));
    assert.ok(names.every(name => (name === 'START-HERE.md' || name.startsWith('stand-in/')) &&
      !name.includes('/.sessions/') && !name.includes('/recordings/') && !name.includes('/demos/')));
    const skill = await readFile(path.join(temp, 'stand-in/SKILL.md'), 'utf8');
    assert.match(skill, /\]\(\.\/recorder\/record\.mjs\)/);
    assert.match(skill, /\]\(\.\/docs\/plan-format\.md\)/);
    assert.doesNotMatch(skill, /\.\.\/\.\.\/\.\.\//);
    const cwd = path.join(temp, 'stand-in/recorder');
    assert.match(execFileSync(process.execPath, ['record.mjs', '--help'], {cwd, encoding: 'utf8'}),
      /stand-in replay/);
    execFileSync(process.execPath, ['--input-type=module', '-e',
      "await import('playwright-core'); await import('mediabunny')"], {cwd});
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
});

test('extracted skill records a replay without the source repository',
  {skip: process.env.RUN_SKILL_RECORDING_TEST !== '1', timeout: 60000}, async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'stand-in-skill-recording-'));
    let clicks = 0;
    const server = createServer((request, response) => {
      if (request.url === '/clicked') {
        clicks++;
        response.end('ok');
      } else {
        response.setHeader('content-type', 'text/html');
        response.end('<button onclick="fetch(\'/clicked\')">Show result</button>');
      }
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const archive = path.join(temp, 'skill.zip');
      await packageSkill(archive);
      await extract(archive, temp);
      const plan = path.join(temp, 'plan.json');
      const video = path.join(temp, 'video.mp4');
      await writeFile(plan, JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/`,
        viewport: {width: 640, height: 480}, fps: 30,
        steps: [{action: 'click', target: {role: 'button', name: 'Show result'}, pauseAfter: 1000}],
      }));
      await promisify(execFile)(process.execPath, [
        path.join(temp, 'stand-in/recorder/record.mjs'), 'replay', plan, '--headless', '--output', video,
      ], {cwd: temp, timeout: 55000});
      assert.equal(clicks, 1);
      assert.ok((await stat(video)).size > 1000);
      assert.ok((await readFile(video)).includes('avcC'), 'The skill converts the video to H.264 too');
    } finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(temp, {recursive: true, force: true});
    }
  });
