#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import { MAX_PORT, MIN_PORT } from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import {
  claudeProvider,
  copyProviderHookScript,
  hookProviderById,
  resolveProviders,
} from './providers/index.js';
import { PixelAgentsServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
  /** Provider selection: one id, comma-separated ids, or all (default: claude). */
  provider: string;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '127.0.0.1', provider: claudeProvider.id };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--provider' || argv[i] === '--providers') {
      const selection = argv[i + 1];
      if (!selection || selection.startsWith('-')) {
        throw new CliArgsError(`Missing value for ${argv[i]}: choose claude, copilot, or all.`);
      }
      try {
        resolveProviders(selection);
      } catch (error) {
        throw new CliArgsError(error instanceof Error ? error.message : String(error));
      }
      args.provider = selection;
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --provider <ids>      Track "claude", "copilot", comma-separated ids, or "all"
                       (default: claude; --providers is an alias)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest to privileged (tokened) connections during the
// webviewReady handshake (clientMessageHandler.ts), and the browser renders
// the dialog — the same UX the VS Code webview shows. The CLI itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the bundled hook script into ~/.pixel-agents/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event, which is strictly
 * worse than no hooks at all.
 */
function copyHookScriptOrReport(
  packageRoot: string,
  provider: HookProvider,
  context = '',
): boolean {
  if (copyProviderHookScript(provider, packageRoot)) return true;
  console.error(
    `[Pixel Agents] ${provider.displayName}: Hooks NOT installed${context}: hook script missing.`,
  );
  return false;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  const selectedProviders = resolveProviders(args.provider);
  console.log(
    `[Pixel Agents] Tracking providers: ${selectedProviders.map((provider) => provider.displayName).join(', ')}`,
  );

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new PixelAgentsServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, selectedProviders, {
      achievements: { namespace: 'standalone' },
    });
    // Resetting the office to the bundled default places none of its furniture.
    if (assetCache.defaultLayout) runtime.achievements?.seedLayout(assetCache.defaultLayout);

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall the named provider's
    // hooks when the user toggles in the UI (or answers the consent ask).
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
      if (!currentConfig) throw new Error('The hook server is not ready. Retry from Settings.');
      const provider = hookProviderById(providerId);
      if (!provider || !selectedProviders.includes(provider)) {
        throw new Error(`Provider "${providerId}" is not enabled.`);
      }
      if (enabled) {
        grantHooksConsent(provider.id);
        if (!copyHookScriptOrReport(packageRoot, provider, ' (user toggle)')) {
          throw new Error('Could not copy the hook script. Check the server log and retry.');
        }
        await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
        console.log('[Pixel Agents] Hooks installed (user toggle)');
      } else {
        await provider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Pixel Agents] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
      activeProviders: selectedProviders,
    });
    currentConfig = { port: config.port, token: config.token };

    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    for (const selectedProvider of selectedProviders) {
      const hooksEnabled = getHooksEnabled(selectedProvider.id);
      runtime.setHooksEnabled(selectedProvider.id, hooksEnabled);
      if (hooksEnabled) {
        let consent = getHooksConsent(selectedProvider.id) === 'granted';
        if (
          !consent &&
          selectedProvider.id === claudeProvider.id &&
          (await selectedProvider.areHooksInstalled())
        ) {
          // Our hooks are already installed and already firing — a pre-consent
          // version put them there. Grant and continue with NO prompt: the
          // install below is the 14 -> 12 migration, and it only ever REDUCES
          // scope (it drops UserPromptSubmit and TaskCreated, the two events that
          // forwarded prompt text and were consumed by nothing). Asking would buy
          // this user no protection they do not already have, so they are not
          // asked. A fresh install still is, in full — in the browser UI, when a
          // tokened client connects (clientMessageHandler's webviewReady).
          grantHooksConsent(selectedProvider.id);
          consent = true;
        }
        if (!consent) {
          console.log(
            `[Pixel Agents] ${selectedProvider.displayName} needs one-time approval for hooks. Open the URL below to review and approve installation.`,
          );
        } else if (copyHookScriptOrReport(packageRoot, selectedProvider)) {
          try {
            await selectedProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
            console.log('[Pixel Agents] Hooks installed');
          } catch (err) {
            console.error(`[Pixel Agents] ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        // Without this line, a persisted hooks-off makes startup skip the entire
        // consent/install flow with zero output — indistinguishable from a bug.
        console.log(
          '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
        );
      }
    }

    const cwd = process.cwd();
    runtime.startDiscovery([cwd]);

    // The URL the operator opens has to be REACHABLE (a wildcard bind address
    // is a bind target, not an address you can browse to — `--host 0.0.0.0`
    // used to print a dead `http://0.0.0.0:PORT`) and has to carry the token,
    // which is what makes the session it loads privileged enough to approve a
    // hook install (see standaloneTokenValid in httpServer.ts). Under `--host
    // 0.0.0.0` the office stays readable from the LAN at this machine's own
    // address; only the consent-bearing toggle needs the token.
    const displayHost =
      args.host === '0.0.0.0' || args.host === '::' || args.host === '' ? '127.0.0.1' : args.host;
    console.log(
      `\n  Pixel Agents server running at http://${displayHost}:${config.port}/?token=${config.token}\n`,
    );

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
