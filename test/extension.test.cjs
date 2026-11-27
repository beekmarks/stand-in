'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCommands, recorderRuntime} = require('../extension.cjs');

// VS Code's per-user and per-workspace storage.
const memento = (values = {}) => ({get: key => values[key], update: async (key, value) => { values[key] = value; }, values});
const videos = fs.mkdtempSync(path.join(os.tmpdir(), 'stand-in-videos-'));

function fixture({folders = [{name: 'Workspace', uri: {scheme: 'file', fsPath: '/work space'}}],
  input = 'https://example.com', selections = [], active, nodeProblem = null, errorChoice, messageChoice,
  memory = memento(), workspaceMemory = memento(), runtime} = {}) {
  const tasks = [], errors = [], opened = [], messages = [], commandsRun = [], documents = [], endListeners = [],
    inputs = [], picks = [];
  const vscode = {
    workspace: {workspaceFolders: folders},
    window: {
      activeTextEditor: active,
      showInputBox: async options => {
        assert.equal(options.validateInput('https://example.com'), null);
        assert.equal(options.validateInput('example.com'), null);
        assert.match(options.validateInput('not a URL'), /website address/);
        assert.match(options.validateInput('https://user:pass@example.com'), /user name or password/);
        inputs.push(options);
        return input;
      },
      showOpenDialog: async () => selections.shift(),
      showQuickPick: async choices => { picks.push(choices); return choices[0]; },
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
  const commands = createCommands(vscode, '/extension path', {memory, workspaceMemory, videosFolder: () => videos,
    runtime: runtime ?? (() => nodeProblem ? {problem: nodeProblem} : {command: 'node', env: {}})});
  return {commands, tasks, errors, opened, messages, commandsRun, documents, finish, inputs, picks, memory, workspaceMemory};
}

test('record command launches the bundled recorder in the selected workspace', async () => {
  const {commands, tasks} = fixture();
  await commands.record();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].execution.command, 'node');
  assert.deepEqual(tasks[0].execution.args, ['/extension path/tools/recorder/record.mjs', 'https://example.com/']);
  assert.equal(tasks[0].execution.options.cwd, '/work space');
  assert.equal(tasks[0].execution.options.env.STAND_IN_FOLDER, '/work space');
});

test('cancelling the address does not start a recording', async () => {
  const {commands, tasks} = fixture({input: null});
  await commands.record();
  assert.equal(tasks.length, 0);
});

test('the address box offers the last site recorded', async () => {
  const memory = memento();
  const first = fixture({input: ' wikipedia.org ', memory});
  await first.commands.record();
  assert.equal(first.inputs[0].value, undefined);
  const second = fixture({memory});
  await second.commands.record();
  assert.equal(second.inputs[0].value, 'wikipedia.org');
});

test('replay chooses a plan and leaves signed-in approval to the terminal', async () => {
  const {commands, tasks} = fixture({selections: [[{fsPath: '/plans/my demo.json'}]]});
  await commands.replay();
  assert.deepEqual(tasks[0].execution.args, ['/extension path/tools/recorder/record.mjs', 'replay', '/plans/my demo.json']);
  assert.equal(tasks[0].execution.options.cwd, '/work space');
});

test('the plan open in the editor replays at once, next to its recording', async () => {
  let saved = false;
  const plan = {uri: {scheme: 'file', fsPath: '/videos/demos/wikipedia.org-2026-11-22-07-04.json'}, isDirty: true,
    getText: () => JSON.stringify({url: 'https://www.wikipedia.org/', steps: []}), save: async () => { saved = true; }};
  const {commands, tasks} = fixture({active: {document: plan}, selections: [() => assert.fail('no file dialog')]});
  await commands.replay();
  assert.equal(tasks[0].execution.args[2], '/videos/demos/wikipedia.org-2026-11-22-07-04.json');
  assert.equal(tasks[0].execution.options.cwd, '/videos');
  assert.ok(saved, 'unsaved edits are saved before replaying');
});

test('another JSON file in the editor is not mistaken for a plan', async () => {
  const other = {uri: {scheme: 'file', fsPath: '/work space/package.json'}, getText: () => '{"name": "x"}'};
  const {commands, tasks} = fixture({active: {document: other}, selections: [[{fsPath: '/plans/demo.json'}]]});
  await commands.replay();
  assert.equal(tasks[0].execution.args[2], '/plans/demo.json');
});

test('with no folder open, recordings go to the videos folder without asking', async () => {
  const {commands, tasks} = fixture({folders: [], selections: [() => assert.fail('no folder dialog')]});
  await commands.record();
  // VS Code only starts tasks in the home folder when no folder is open, so the recorder is told where to save.
  assert.equal(tasks[0].execution.options.cwd, os.homedir());
  assert.equal(tasks[0].execution.options.env.STAND_IN_FOLDER, videos);
  const {defaultFolder} = require('../extension.cjs');
  assert.match(defaultFolder(), process.platform === 'darwin' ? /Movies[\\/]Stand-in$/ : /Videos[\\/]Stand-in$/);
});

test('a multi-folder workspace asks once which folder gets recordings, then remembers', async () => {
  const folders = [
    {name: 'First', uri: {scheme: 'file', fsPath: '/first'}},
    {name: 'Second', uri: {scheme: 'file', fsPath: '/second'}},
  ];
  const workspaceMemory = memento();
  const first = fixture({folders, workspaceMemory});
  await first.commands.record();
  assert.equal(first.tasks[0].execution.options.cwd, '/first');
  assert.equal(first.picks.length, 1);
  const second = fixture({folders, workspaceMemory});
  await second.commands.record();
  assert.equal(second.picks.length, 0);
  assert.equal(second.tasks[0].execution.options.cwd, '/first');
});

test("VS Code's own Node runs the recorder when it is new enough, so nothing needs installing", () => {
  const vscodeRuntime = recorderRuntime({versions: {node: '22.20.0', electron: '39.6.0'}, execPath: '/Applications/Code',
    nodeCheck: () => assert.fail('PATH not needed')});
  assert.deepEqual(vscodeRuntime, {command: '/Applications/Code', env: {ELECTRON_RUN_AS_NODE: '1'}});
  const remote = recorderRuntime({versions: {node: '22.22.0'}, execPath: '/server/node', nodeCheck: () => assert.fail()});
  assert.deepEqual(remote, {command: '/server/node', env: {}});
  assert.deepEqual(recorderRuntime({versions: {node: '20.18.0', electron: '33.0.0'}, nodeCheck: () => null}), {command: 'node', env: {}});
  assert.deepEqual(recorderRuntime({versions: {node: '20.18.0'}, nodeCheck: () => 'Install Node.js'}), {problem: 'Install Node.js'});
});

test('the recorder runs with the chosen runtime', async () => {
  const {commands, tasks} = fixture({runtime: () => ({command: '/Applications/Code', env: {ELECTRON_RUN_AS_NODE: '1'}})});
  await commands.record();
  assert.equal(tasks[0].execution.command, '/Applications/Code');
  assert.equal(tasks[0].execution.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(tasks[0].execution.options.env.STAND_IN_RESULT);
});

test('a missing or old Node.js is reported before anything starts', async () => {
  const {commands, tasks, errors, opened} = fixture({nodeProblem: 'Stand-in needs Node.js 22 or newer.',
    errorChoice: 'Download Node.js'});
  await commands.record();
  assert.equal(tasks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Node\.js 22/);
  assert.deepEqual(errors[0].items, ['Download Node.js']);
  assert.deepEqual(opened, ['https://nodejs.org/en/download']);
});

test('the Node.js check accepts the running version only when it is new enough', () => {
  const {checkNode} = require('../extension.cjs');
  const result = checkNode();
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 22) assert.equal(result, null);
  else assert.match(result, /Node\.js 22/);
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
  assert.equal(messages[0].message, 'Your video is ready: /work space/recordings/example.com-2026-11-21-14-05.mp4');
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
  assert.match(messages[0].message, /stopped early; the video so far is saved in \/r\/demo-replay-incomplete\.mp4\. Step 2 of 5 failed/);
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

test('a problem with a fix on the web gets a button for it', async () => {
  const {commands, errors, opened, finish} = fixture({errorChoice: 'Get Chrome'});
  await commands.record();
  await finish({ok: false, error: "Stand-in needs Google Chrome, which isn't installed.", link: 'https://www.google.com/chrome/'});
  assert.deepEqual(errors[0].items, ['Get Chrome']);
  assert.deepEqual(opened, ['https://www.google.com/chrome/']);
});
