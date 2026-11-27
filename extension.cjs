'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const NODE_DOWNLOAD = 'https://nodejs.org/en/download';
const MIN_NODE = 22;

// Returns null when a supported Node.js is on the PATH, otherwise a message for the person.
function checkNode() {
  const result = spawnSync('node', ['--version'], {encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32'});
  const match = /v(\d+)\./.exec(result.stdout ?? '');
  if (result.error || !match)
    return `Stand-in needs Node.js ${MIN_NODE} or newer, and VS Code could not find it. Install it, then fully quit and reopen VS Code.`;
  if (Number(match[1]) < MIN_NODE)
    return `Stand-in needs Node.js ${MIN_NODE} or newer, but VS Code found ${result.stdout.trim()}. Install a newer version, then fully quit and reopen VS Code.`;
  return null;
}

// How to run the recorder. VS Code runs on Node itself; when that Node is new enough, use it, so there is
// nothing to install. Otherwise fall back to `node` on the PATH.
function recorderRuntime({versions = process.versions, execPath = process.execPath, nodeCheck = checkNode} = {}) {
  if (Number(String(versions.node).split('.')[0]) >= MIN_NODE)
    return {command: execPath, env: versions.electron ? {ELECTRON_RUN_AS_NODE: '1'} : {}};
  const problem = nodeCheck();
  return problem ? {problem} : {command: 'node', env: {}};
}

// Where videos go when VS Code has no folder open: the usual place for videos, so nothing needs asking.
function defaultFolder() {
  return path.join(os.homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'Stand-in');
}

// A replay plan open in the editor: a JSON file with a URL and steps.
function isPlan(document) {
  if (document?.uri?.scheme !== 'file' || !document.uri.fsPath.toLowerCase().endsWith('.json')) return false;
  try { const plan = JSON.parse(document.getText()); return typeof plan?.url === 'string' && Array.isArray(plan.steps); }
  catch { return false; }
}

// People type "wikipedia.org"; add https:// for them. Returns null when it isn't a usable website address.
function websiteAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  try {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text);
    const parsed = new URL(hasScheme ? text : `${local ? 'http' : 'https'}://${text}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    // Without a scheme, "hello" is more likely a typo than a server name.
    if (!hasScheme && !parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
    return parsed.href;
  } catch { return null; }
}

function createCommands(vscode, extensionPath, {runtime = () => recorderRuntime(), memory, workspaceMemory,
  videosFolder = defaultFolder} = {}) {
  const recorder = path.join(extensionPath, 'tools', 'recorder', 'record.mjs');
  const remember = (store, key, value) => store?.update(key, value);

  // Where recordings go, without asking when it's clear: the open folder, or the usual videos folder.
  // With several folders open, ask once per workspace and remember.
  async function outputFolder() {
    const local = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
    if (local.length === 1) return local[0].uri.fsPath;
    if (local.length > 1) {
      const chosen = workspaceMemory?.get('standIn.folder');
      if (local.some(folder => folder.uri.fsPath === chosen)) return chosen;
      const selected = await vscode.window.showQuickPick(local.map(folder => ({
        label: folder.name, description: folder.uri.fsPath, folder,
      })), {placeHolder: 'Choose where to save your recordings (Stand-in remembers this)'});
      if (selected) await remember(workspaceMemory, 'standIn.folder', selected.folder.uri.fsPath);
      return selected?.folder.uri.fsPath;
    }
    const folder = videosFolder();
    fs.mkdirSync(folder, {recursive: true});
    return folder;
  }

  async function runtimeReady() {
    const chosen = runtime();
    if (!chosen.problem) return chosen;
    const choice = await vscode.window.showErrorMessage(chosen.problem, 'Download Node.js');
    if (choice === 'Download Node.js') await vscode.env.openExternal(vscode.Uri.parse(NODE_DOWNLOAD));
    return null;
  }

  // When the recorder finishes, it writes what it saved to a small file; offer to open the video from there.
  async function announce(resultFile) {
    let result;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { return; }
    finally { fs.rm(resultFile, {force: true}, () => {}); }
    const open = async (choice) => {
      if (choice === 'Open Video') await vscode.env.openExternal(vscode.Uri.file(result.video));
      else if (choice === 'Show in Folder') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.video));
      else if (choice === 'Open Replay Plan') await vscode.window.showTextDocument(vscode.Uri.file(result.plan));
    };
    if (result.ok && result.video) {
      // The full path, so it's clear where the video went.
      const choice = await vscode.window.showInformationMessage(`Your video is ready: ${result.video}`,
        'Open Video', 'Show in Folder', ...(result.plan ? ['Open Replay Plan'] : []));
      return open(choice);
    }
    if (result.video) {
      const choice = await vscode.window.showWarningMessage(
        `The replay stopped early; the video so far is saved in ${result.video}. ${String(result.error ?? '').split('\n')[0]}`,
        'Open Video', ...(result.plan ? ['Open Replay Plan'] : []));
      return open(choice);
    }
    if (result.error) {
      const fix = result.link ? (/google\.com\/chrome/.test(result.link) ? 'Get Chrome' : 'Open Link') : null;
      const choice = await vscode.window.showErrorMessage(`Stand-in: ${String(result.error).split('\n')[0]}` +
        (fix ? '' : ' See the terminal for details.'), ...(fix ? [fix] : []));
      if (choice && result.link) await vscode.env.openExternal(vscode.Uri.parse(result.link));
    }
  }

  // `folder` is where the video and plan are saved. With no folder open in VS Code, a task must start in the
  // home folder (VS Code refuses any other), so the recorder is told the folder separately and moves there.
  async function run(args, folder, name, {command, env}) {
    const id = crypto.randomUUID();
    const definition = {type: 'stand-in', action: name, run: id};
    const resultFile = path.join(os.tmpdir(), `stand-in-result-${id}.json`);
    const cwd = vscode.workspace.workspaceFolders?.length ? folder : os.homedir();
    const task = new vscode.Task(definition, vscode.TaskScope.Global, name, 'Stand-in',
      new vscode.ProcessExecution(command, [recorder, ...args],
        {cwd, env: {...env, STAND_IN_FOLDER: folder, STAND_IN_RESULT: resultFile}}));
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true};
    const listener = vscode.tasks.onDidEndTaskProcess?.(event => {
      if (event.execution?.task?.definition?.run !== id) return;
      listener.dispose();
      announce(resultFile).catch(error => vscode.window.showErrorMessage(`Stand-in: ${error.message}`));
    });
    try { await vscode.tasks.executeTask(task); }
    catch (error) { listener?.dispose(); throw error; }
  }

  return {
    async record() {
      const last = memory?.get('standIn.lastSite');
      const typed = await vscode.window.showInputBox({
        title: 'Record a website',
        prompt: 'Enter the website address. Chrome opens it; press Shift twice, quickly, in the page to start and stop.',
        placeHolder: 'example.com',
        ...(last ? {value: last} : {}),
        ignoreFocusOut: true,
        validateInput(value) {
          return websiteAddress(value) ? null
            : 'Enter a website address, such as example.com or https://example.com, without a user name or password in it.';
        },
      });
      const url = websiteAddress(typed);
      if (!url) return;
      await remember(memory, 'standIn.lastSite', typed.trim());
      const chosen = await runtimeReady();
      if (!chosen) return;
      const cwd = await outputFolder();
      if (!cwd) return;
      await run([url], cwd, 'Record website', chosen);
    },
    async replay() {
      // The plan open in the editor replays straight away; otherwise choose one.
      const open = vscode.window.activeTextEditor?.document;
      let planPath = isPlan(open) ? open.uri.fsPath : null;
      if (!planPath) {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
          filters: {'Demo plans': ['json']}, openLabel: 'Choose replay plan',
          ...(open?.uri?.scheme === 'file' && open.uri.fsPath.endsWith('.json') ? {defaultUri: open.uri} : {}),
        });
        planPath = selected?.[0]?.fsPath;
      }
      if (!planPath) return;
      if (open && isPlan(open) && open.isDirty) await open.save();
      const chosen = await runtimeReady();
      if (!chosen) return;
      // Replays go next to the recording they came from: demos/x.json → recordings/ beside demos/.
      const cwd = path.basename(path.dirname(planPath)) === 'demos' ? path.dirname(path.dirname(planPath)) : await outputFolder();
      if (!cwd) return;
      await run(['replay', planPath], cwd, 'Replay plan', chosen);
    },
  };
}

function activate(context) {
  const vscode = require('vscode');
  const commands = createCommands(vscode, context.extensionPath,
    {memory: context.globalState, workspaceMemory: context.workspaceState});
  for (const [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`standIn.${name}`, async () => {
      try { await handler(); }
      catch (error) { vscode.window.showErrorMessage(`Stand-in: ${error.message}`); }
    }));
  }
}

module.exports = {activate, createCommands, checkNode, defaultFolder, recorderRuntime, websiteAddress};
