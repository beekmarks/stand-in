'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCommands} = require('../extension.cjs');

function fixture({folders = [{name: 'Workspace', uri: {scheme: 'file', fsPath: '/work space'}}],
  input = 'https://example.com', selections = [], active, nodeProblem = null, errorChoice} = {}) {
  const tasks = [], errors = [], opened = [];
  const vscode = {
    workspace: {workspaceFolders: folders},
    window: {
      activeTextEditor: active,
      showInputBox: async options => {
        assert.equal(options.validateInput('https://example.com'), null);
        assert.match(options.validateInput('not a URL'), /complete/);
        assert.match(options.validateInput('https://user:pass@example.com'), /credentials/);
        return input;
      },
      showOpenDialog: async () => selections.shift(),
      showQuickPick: async choices => choices[0],
      showErrorMessage: async (message, ...items) => { errors.push({message, items}); return errorChoice; },
    },
    env: {openExternal: async uri => opened.push(uri)},
    Uri: {parse: value => value},
    TaskScope: {Global: 1},
    TaskRevealKind: {Always: 1},
    TaskPanelKind: {Dedicated: 2},
    ProcessExecution: class {
      constructor(command, args, options) { Object.assign(this, {command, args, options}); }
    },
    Task: class {
      constructor(definition, scope, name, source, execution) {
        Object.assign(this, {definition, scope, name, source, execution});
      }
    },
    tasks: {executeTask: async task => tasks.push(task)},
  };
  return {commands: createCommands(vscode, '/extension path', {nodeCheck: () => nodeProblem}), tasks, errors, opened};
}

test('record command launches the bundled recorder in the selected workspace', async () => {
  const {commands, tasks} = fixture();
  await commands.record();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].execution.command, 'node');
  assert.deepEqual(tasks[0].execution.args, ['/extension path/tools/recorder/record.mjs', 'https://example.com']);
  assert.equal(tasks[0].execution.options.cwd, '/work space');
});

test('cancelling the URL or output folder does not start a recording', async () => {
  const first = fixture({input: null});
  await first.commands.record();
  assert.equal(first.tasks.length, 0);
  const second = fixture({folders: [], selections: [undefined]});
  await second.commands.record();
  assert.equal(second.tasks.length, 0);
});

test('replay chooses a plan and leaves signed-in approval to the terminal', async () => {
  const {commands, tasks} = fixture({selections: [[{fsPath: '/plans/my demo.json'}]]});
  await commands.replay();
  assert.deepEqual(tasks[0].execution.args, ['/extension path/tools/recorder/record.mjs', 'replay', '/plans/my demo.json']);
  assert.equal(tasks[0].execution.options.cwd, '/work space');
});

test('a folder is chosen when no workspace is open', async () => {
  const {commands, tasks} = fixture({folders: [], selections: [[{fsPath: '/chosen folder'}]]});
  await commands.record();
  assert.equal(tasks[0].execution.options.cwd, '/chosen folder');
});

test('a multi-folder workspace asks which folder should receive the recording', async () => {
  const folders = [
    {name: 'First', uri: {scheme: 'file', fsPath: '/first'}},
    {name: 'Second', uri: {scheme: 'file', fsPath: '/second'}},
  ];
  const {commands, tasks} = fixture({folders});
  await commands.record();
  assert.equal(tasks[0].execution.options.cwd, '/first');
});

test('a missing or old Node.js is reported before anything starts', async () => {
  const {commands, tasks, errors, opened} = fixture({nodeProblem: 'Stand-in needs Node.js 24.11 or newer.',
    errorChoice: 'Download Node.js'});
  await commands.record();
  assert.equal(tasks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /24\.11/);
  assert.deepEqual(errors[0].items, ['Download Node.js']);
  assert.deepEqual(opened, ['https://nodejs.org/en/download']);
});

test('the Node.js check accepts the running version only when it is new enough', () => {
  const {checkNode} = require('../extension.cjs');
  const result = checkNode();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 24 || (major === 24 && minor >= 11)) assert.equal(result, null);
  else assert.match(result, /24\.11/);
});
