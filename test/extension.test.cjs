'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCommands} = require('../extension.cjs');

function fixture({folders = [{name: 'Workspace', uri: {scheme: 'file', fsPath: '/work space'}}],
  input = 'https://example.com', selections = [], active, nodeProblem = null, errorChoice, messageChoice} = {}) {
  const tasks = [], errors = [], opened = [], messages = [], commandsRun = [], documents = [], endListeners = [];
  const vscode = {
    workspace: {workspaceFolders: folders},
    window: {
      activeTextEditor: active,
      showInputBox: async options => {
        assert.equal(options.validateInput('https://example.com'), null);
        assert.equal(options.validateInput('example.com'), null);
        assert.match(options.validateInput('not a URL'), /website address/);
        assert.match(options.validateInput('https://user:pass@example.com'), /user name or password/);
        return input;
      },
      showOpenDialog: async () => selections.shift(),
      showQuickPick: async choices => choices[0],
      showErrorMessage: async (message, ...items) => { errors.push({message, items}); return errorChoice; },
      showInformationMessage: async (message, ...items) => { messages.push({kind: 'info', message, items}); return messageChoice; },
      showWarningMessage: async (message, ...items) => { messages.push({kind: 'warning', message, items}); return messageChoice; },
      showTextDocument: async uri => documents.push(uri),
    },
    commands: {executeCommand: async (...args) => commandsRun.push(args)},
    env: {openExternal: async uri => opened.push(uri)},
    Uri: {parse: value => value, file: value => ({file: value})},
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
    tasks: {
      executeTask: async task => { tasks.push(task); return {task}; },
      onDidEndTaskProcess: listener => {
        const entry = {listener, disposed: false};
        endListeners.push(entry);
        return {dispose() { entry.disposed = true; }};
      },
    },
  };
  // Pretend the task's process ended after writing `result` to the file the extension asked for.
  const finish = async (result, index = 0) => {
    const task = tasks[index];
    if (result) require('node:fs').writeFileSync(task.execution.options.env.STAND_IN_RESULT, JSON.stringify(result));
    for (const entry of endListeners.filter(e => !e.disposed)) await entry.listener({execution: {task}, exitCode: result?.ok ? 0 : 1});
    await new Promise(resolve => setImmediate(resolve));
  };
  return {commands: createCommands(vscode, '/extension path', {nodeCheck: () => nodeProblem}), tasks, errors, opened,
    messages, commandsRun, documents, finish};
}

test('record command launches the bundled recorder in the selected workspace', async () => {
  const {commands, tasks} = fixture();
  await commands.record();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].execution.command, 'node');
  assert.deepEqual(tasks[0].execution.args, ['/extension path/tools/recorder/record.mjs', 'https://example.com/']);
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

test('a website without https:// is accepted and completed', async () => {
  const {commands, tasks} = fixture({input: 'wikipedia.org'});
  await commands.record();
  assert.equal(tasks[0].execution.args[1], 'https://wikipedia.org/');
});

test('when the video is ready, VS Code says so and offers to open it', async () => {
  const {commands, tasks, messages, opened, finish} = fixture({messageChoice: 'Open Video'});
  await commands.record();
  assert.match(tasks[0].execution.options.env.STAND_IN_RESULT, /stand-in-result-.*\.json$/);
  await finish({ok: true, video: '/work space/recordings/example.com-2026-11-21-14-05.mp4',
    plan: '/work space/demos/example.com-2026-11-21-14-05.json'});
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'info');
  assert.match(messages[0].message, /video is ready: example\.com-2026-11-21-14-05\.mp4/);
  assert.deepEqual(messages[0].items, ['Open Video', 'Show in Folder', 'Open Replay Plan']);
  assert.deepEqual(opened, [{file: '/work space/recordings/example.com-2026-11-21-14-05.mp4'}]);
});

test('the ready message can reveal the video or open the plan', async () => {
  const reveal = fixture({messageChoice: 'Show in Folder'});
  await reveal.commands.record();
  await reveal.finish({ok: true, video: '/v.mp4', plan: '/p.json'});
  assert.deepEqual(reveal.commandsRun, [['revealFileInOS', {file: '/v.mp4'}]]);
  const plan = fixture({messageChoice: 'Open Replay Plan'});
  await plan.commands.record();
  await plan.finish({ok: true, video: '/v.mp4', plan: '/p.json'});
  assert.deepEqual(plan.documents, [{file: '/p.json'}]);
});

test('a failed replay with a partial video warns and still offers the video', async () => {
  const {commands, messages, finish} = fixture({selections: [[{fsPath: '/plans/demo.json'}]]});
  await commands.replay();
  await finish({ok: false, video: '/r/demo-replay-incomplete.mp4', plan: '/plans/demo.json',
    error: 'Step 2 of 5 failed: click the link “Next”\n  details'});
  assert.equal(messages[0].kind, 'warning');
  assert.match(messages[0].message, /stopped early.*Step 2 of 5 failed/);
  assert.doesNotMatch(messages[0].message, /details/);
});

test('a failure without a video shows the reason; a cancelled run shows nothing', async () => {
  const failed = fixture();
  await failed.commands.record();
  await failed.finish({ok: false, error: 'Couldn’t open https://nope.invalid/: the address could not be found.'});
  assert.match(failed.errors[0].message, /could not be found.*terminal/);
  const cancelled = fixture();
  await cancelled.commands.record();
  await cancelled.finish(null);
  assert.equal(cancelled.errors.length + cancelled.messages.length, 0);
});
