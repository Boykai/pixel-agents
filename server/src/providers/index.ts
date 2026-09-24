/**
 * Provider registry: re-exports all bundled providers.
 *
 * Adding a new CLI provider:
 *   1. Create `server/src/providers/hook/<cli>/<cli>.ts` implementing HookProvider.
 *      (File-based and stream-based provider types will land when the first such
 *       provider ships.)
 *   2. Add an export line below.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { HookProvider } from '../../../core/src/provider.js';
import { claudeProvider } from './hook/claude/claude.js';
import { copyHookScript } from './hook/claude/claudeHookInstaller.js';
import { copilotProvider } from './hook/copilot/copilot.js';
import { copyHookScript as copyCopilotHookScript } from './hook/copilot/copilotHookInstaller.js';

export { claudeProvider };
export { copilotProvider };
export { copyHookScript };

export function copyProviderHookScript(provider: HookProvider, packageRoot: string): boolean {
  if (provider.id === 'claude') return copyHookScript(packageRoot);
  if (provider.id === 'copilot') return copyCopilotHookScript(packageRoot);
  console.error(`[Pixel Agents] No bundled hook script for provider "${provider.id}"`);
  return false;
}

/** Every bundled hook provider, in registration order. The consent gate loops
 *  over this at the webviewReady handshake (one ask per provider that needs
 *  one) and `hooksConsentResponse` resolves its provider id against it. */
export const hookProviders: readonly HookProvider[] = [claudeProvider, copilotProvider];

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}

/** Explicit selection, never silently substituting another provider. */
export function resolveProviders(selection: string): HookProvider[] {
  const ids =
    selection === 'all' ? hookProviders.map((provider) => provider.id) : selection.split(',');
  const providers: HookProvider[] = [];
  for (const id of new Set(ids.map((value) => value.trim()))) {
    const provider = hookProviderById(id);
    if (!provider) throw new Error(`Unknown provider "${id}". Choose claude, copilot, or all.`);
    providers.push(provider);
  }
  return providers;
}
