import * as vscode from 'vscode';

import { FileStateAdapter } from '../../server/src/fileStateAdapter.js';
import { showActivityQuickPick } from './activityQuickPick.js';
import {
  COMMAND_EXPORT_DEFAULT_LAYOUT,
  COMMAND_NEW_AGENT,
  COMMAND_SHOW_ACTIVITY,
  COMMAND_SHOW_PANEL,
  CONFIG_KEY_AUTO_SHOW_PANEL,
  STATUS_BAR_ACTIVITY_ID,
  STATUS_BAR_ACTIVITY_NAME,
  STATUS_BAR_ACTIVITY_PRIORITY,
  STATUS_BAR_ACTIVITY_TEXT,
  STATUS_BAR_NEW_AGENT_ID,
  STATUS_BAR_NEW_AGENT_NAME,
  STATUS_BAR_NEW_AGENT_PRIORITY,
  STATUS_BAR_NEW_AGENT_TEXT,
  VIEW_ID,
} from './constants.js';
import { migrateVsCodeState } from './migrateVsCodeState.js';
import { PixelAgentsViewProvider } from './PixelAgentsViewProvider.js';

let providerInstance: PixelAgentsViewProvider | undefined;

/** A right-aligned status bar shortcut that runs `command`. */
function createStatusBarShortcut(
  id: string,
  name: string,
  text: string,
  command: string,
  priority: number,
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(id, vscode.StatusBarAlignment.Right, priority);
  item.name = name;
  item.text = text;
  item.tooltip = name;
  // Read out as the command it runs, not as the icon name plus the text.
  item.accessibilityInformation = { label: name };
  item.command = command;
  item.show();
  return item;
}

export function activate(context: vscode.ExtensionContext) {
  console.log(`[Pixel Agents] PIXEL_AGENTS_DEBUG=${process.env.PIXEL_AGENTS_DEBUG ?? 'not set'}`);

  // Shared file-backed state adapter (VS Code namespace in ~/.pixel-agents/config.json).
  const adapter = new FileStateAdapter({ namespace: 'vscode' });

  // One-time migration from legacy workspaceState/globalState. Idempotent; runs every
  // activate. Warns until all keys are cleared (e.g. if a disk error blocks writes).
  migrateVsCodeState(context, adapter);

  const provider = new PixelAgentsViewProvider(context, adapter);
  providerInstance = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
      provider.exportDefaultLayout();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_NEW_AGENT, () => provider.launchAgentFromCommand()),
    vscode.commands.registerCommand(COMMAND_SHOW_ACTIVITY, () => showActivityQuickPick(provider)),
    createStatusBarShortcut(
      STATUS_BAR_NEW_AGENT_ID,
      STATUS_BAR_NEW_AGENT_NAME,
      STATUS_BAR_NEW_AGENT_TEXT,
      COMMAND_NEW_AGENT,
      STATUS_BAR_NEW_AGENT_PRIORITY,
    ),
    createStatusBarShortcut(
      STATUS_BAR_ACTIVITY_ID,
      STATUS_BAR_ACTIVITY_NAME,
      STATUS_BAR_ACTIVITY_TEXT,
      COMMAND_SHOW_ACTIVITY,
      STATUS_BAR_ACTIVITY_PRIORITY,
    ),
  );

  // Auto-show panel: focus the Pixel Agents panel on startup if the user has
  // opted in via the pixel-agents.autoShowPanel setting.
  const config = vscode.workspace.getConfiguration();
  if (config.get<boolean>(CONFIG_KEY_AUTO_SHOW_PANEL, false)) {
    vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }
}

export function deactivate() {
  providerInstance?.dispose();
}
