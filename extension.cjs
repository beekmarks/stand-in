'use strict';

const path = require('node:path');

function createCommands(vscode, extensionPath) {
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

module.exports = {activate, createCommands};
