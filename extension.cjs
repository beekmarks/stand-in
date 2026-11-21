'use strict';

const path = require('node:path');
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

  async function run(args, cwd, name) {
    const definition = {type: 'stand-in', action: name};
    const task = new vscode.Task(definition, vscode.TaskScope.Global, name, 'Stand-in',
      new vscode.ProcessExecution('node', [recorder, ...args], {cwd}));
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true};
    await vscode.tasks.executeTask(task);
  }

  return {
    async record() {
      const url = await vscode.window.showInputBox({
        title: 'Record a website',
        prompt: 'Enter the website address. Sign in before recording if needed.',
        placeHolder: 'https://example.com',
        ignoreFocusOut: true,
        validateInput(value) {
          try {
            const parsed = new URL(value);
            if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return null;
          } catch {}
          return 'Enter a complete http or https address without embedded credentials.';
        },
      });
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

module.exports = {activate, createCommands, checkNode};
