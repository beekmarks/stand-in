'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

// Returns null when a supported Node.js (24.11+) is on the PATH, otherwise a message for the person.
function checkNode() {
  const result = spawnSync('node', ['--version'], {encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32'});
  const match = /v(\d+)\.(\d+)/.exec(result.stdout ?? '');
  if (result.error || !match)
    return 'Stand-in needs Node.js 24.11 or newer, and VS Code could not find Node.js. Install it, then fully quit and reopen VS Code.';
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < 24 || (major === 24 && minor < 11))
    return `Stand-in needs Node.js 24.11 or newer, but VS Code found ${result.stdout.trim()}. Install a newer version, then fully quit and reopen VS Code.`;
  return null;
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

function createCommands(vscode, extensionPath, {nodeCheck = checkNode} = {}) {
  const recorder = path.join(extensionPath, 'tools', 'recorder', 'record.mjs');

  async function outputFolder() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1 && folders[0].uri.scheme === 'file') return folders[0].uri.fsPath;
    if (folders.length > 1) {
      const local = folders.filter(folder => folder.uri.scheme === 'file');
      if (local.length) {
        const selected = await vscode.window.showQuickPick(local.map(folder => ({
          label: folder.name, description: folder.uri.fsPath, folder,
        })), {placeHolder: 'Choose where to save your recording'});
        return selected?.folder.uri.fsPath;
      }
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: 'Save recordings here',
    });
    return selected?.[0]?.fsPath;
  }

  async function nodeReady() {
    const problem = nodeCheck();
    if (!problem) return true;
    const choice = await vscode.window.showErrorMessage(problem, 'Download Node.js');
    if (choice === 'Download Node.js') await vscode.env.openExternal(vscode.Uri.parse(NODE_DOWNLOAD));
    return false;
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
      const choice = await vscode.window.showInformationMessage(`Your video is ready: ${path.basename(result.video)}`,
        'Open Video', 'Show in Folder', ...(result.plan ? ['Open Replay Plan'] : []));
      return open(choice);
    }
    if (result.video) {
      const choice = await vscode.window.showWarningMessage(
        `The replay stopped early; the video so far is saved. ${String(result.error ?? '').split('\n')[0]}`,
        'Open Video', ...(result.plan ? ['Open Replay Plan'] : []));
      return open(choice);
    }
    if (result.error) await vscode.window.showErrorMessage(`Stand-in: ${String(result.error).split('\n')[0]} See the terminal for details.`);
  }

  async function run(args, cwd, name) {
    const id = crypto.randomUUID();
    const definition = {type: 'stand-in', action: name, run: id};
    const resultFile = path.join(os.tmpdir(), `stand-in-result-${id}.json`);
    const task = new vscode.Task(definition, vscode.TaskScope.Global, name, 'Stand-in',
      new vscode.ProcessExecution('node', [recorder, ...args], {cwd, env: {STAND_IN_RESULT: resultFile}}));
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
      const typed = await vscode.window.showInputBox({
        title: 'Record a website',
        prompt: 'Enter the website address. Chrome opens it; press Ctrl+Shift+9 in the page to start and stop.',
        placeHolder: 'example.com',
        ignoreFocusOut: true,
        validateInput(value) {
          return websiteAddress(value) ? null
            : 'Enter a website address, such as example.com or https://example.com, without a user name or password in it.';
        },
      });
      const url = websiteAddress(typed);
      if (!url) return;
      if (!(await nodeReady())) return;
      const cwd = await outputFolder();
      if (!cwd) return;
      await run([url], cwd, 'Record website');
    },
    async replay() {
      const active = vscode.window.activeTextEditor?.document.uri;
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: {'Demo plans': ['json']}, openLabel: 'Choose replay plan',
        ...(active?.scheme === 'file' && active.fsPath.endsWith('.json') ? {defaultUri: active} : {}),
      });
      if (!selected?.[0]) return;
      if (!(await nodeReady())) return;
      const cwd = await outputFolder();
      if (!cwd) return;
      await run(['replay', selected[0].fsPath], cwd, 'Replay plan');
    },
  };
}

function activate(context) {
  const vscode = require('vscode');
  const commands = createCommands(vscode, context.extensionPath);
  for (const [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`standIn.${name}`, async () => {
      try { await handler(); }
      catch (error) { vscode.window.showErrorMessage(`Stand-in: ${error.message}`); }
    }));
  }
}

module.exports = {activate, createCommands, checkNode, websiteAddress};
