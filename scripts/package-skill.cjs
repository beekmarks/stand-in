'use strict';

const {createWriteStream} = require('node:fs');
const {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {pipeline} = require('node:stream/promises');
const yazl = require('yazl');

const root = path.resolve(__dirname, '..');

function replaceOnce(text, from, to) {
  if (!text.includes(from)) throw new Error(`Skill packaging expected to find: ${from}`);
  return text.replace(from, to);
}

async function createSkillDirectory(destination) {
  const recorder = path.join(root, 'tools', 'recorder');
  const manifest = JSON.parse(await readFile(path.join(recorder, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(recorder, 'package-lock.json'), 'utf8'));
  const targetRecorder = path.join(destination, 'recorder');
  await mkdir(targetRecorder, {recursive: true});
  await mkdir(path.join(destination, 'docs'), {recursive: true});

  let skill = await readFile(path.join(root, '.github/skills/stand-in/SKILL.md'), 'utf8');
  skill = replaceOnce(skill, '../../../tools/recorder/record.mjs', './recorder/record.mjs');
  skill = replaceOnce(skill, '../../../docs/plan-format.md', './docs/plan-format.md');
  skill = replaceOnce(skill, '../../../tools/recorder/plan.schema.json', './recorder/plan.schema.json');
  skill = replaceOnce(skill,
    'The installed extension includes its dependencies; do not install packages into its directory. In a source\ncheckout, if dependencies are missing, run `npm ci` in `tools/recorder`.',
    'This standalone skill includes its recorder dependencies; do not install packages into its directory.');
  skill = replaceOnce(skill,
    'Use the **Stand-in: Record Website** command, or run',
    'Run');
  await writeFile(path.join(destination, 'SKILL.md'), skill);

  let reference = await readFile(path.join(root, 'docs/plan-format.md'), 'utf8');
  reference = replaceOnce(reference, '../tools/recorder/plan.schema.json', '../recorder/plan.schema.json');
  await writeFile(path.join(destination, 'docs/plan-format.md'), reference);
  for (const file of ['record.mjs', 'plan.schema.json', 'package.json', 'package-lock.json']) {
    await cp(path.join(recorder, file), path.join(targetRecorder, file));
  }
  await cp(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));

  for (const name of Object.keys(manifest.dependencies)) {
    const source = path.join(root, 'node_modules', name);
    const installed = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    const expected = lock.packages[`node_modules/${name}`];
    if (!expected || installed.version !== expected.version) {
      throw new Error(`Installed ${name} does not match the recorder lockfile; run npm install in the repository.`);
    }
    if (Object.keys(installed.dependencies ?? {}).length) {
      throw new Error(`${name} has additional dependencies; update skill packaging before distributing it.`);
    }
    await cp(source, path.join(targetRecorder, 'node_modules', name), {recursive: true});
  }
}

async function addDirectory(zip, directory, prefix) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const source = path.join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await addDirectory(zip, source, name);
    else if (entry.isFile()) zip.addFile(source, name);
    else throw new Error(`Unexpected non-file in skill package: ${source}`);
  }
}

async function packageSkill(output) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'stand-in-skill-'));
  try {
    const skill = path.join(temporary, 'stand-in');
    await createSkillDirectory(skill);
    await mkdir(path.dirname(output), {recursive: true});
    const zip = new yazl.ZipFile();
    await addDirectory(zip, skill, 'stand-in');
    zip.addFile(path.join(root, 'docs/company-pilot-guide.md'), 'START-HERE.md');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(output));
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

if (require.main === module) {
  const {version} = require('../package.json');
  const output = path.join(root, 'dist', `stand-in-skill-${version}.zip`);
  packageSkill(output).then(() => console.log(`Created ${output}`), error => {
    console.error(`Could not package Stand-in skill: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {createSkillDirectory, packageSkill};
