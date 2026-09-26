import * as vscode from 'vscode';

import type { HookProvider } from '../../core/src/provider.js';
import { claudeProvider, hookProviderById } from '../../server/src/providers/index.js';
import { CONFIG_KEY_LAUNCH_PROVIDER, CONFIG_KEY_PROVIDERS } from './constants.js';

export function enabledProviders(): HookProvider[] {
  const ids = vscode.workspace.getConfiguration().get<string[]>(CONFIG_KEY_PROVIDERS, ['claude']);
  return [...new Set(ids)].flatMap((id) => {
    const provider = hookProviderById(id);
    return provider ? [provider] : [];
  });
}

export function launchProvider(
  providers: readonly HookProvider[],
  requested?: unknown,
): HookProvider | undefined {
  const id =
    requested ??
    vscode.workspace.getConfiguration().get<string>(CONFIG_KEY_LAUNCH_PROVIDER, claudeProvider.id);
  return providers.find((provider) => provider.id === id);
}
