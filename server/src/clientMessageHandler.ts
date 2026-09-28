import type { HookProvider } from '../../core/src/provider.js';
import { parseZoom } from '../../core/src/zoom.js';
import { resendAgentActivity } from './agentActivityResend.js';
import { applySavedSeats } from './agentAppearance.js';
import { buildAgentDiagnostics } from './agentDiagnostics.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import {
  getHooksConsent,
  getHooksEnabled,
  readConfig,
  setHooksEnabled,
  writeConfig,
} from './configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import { getPaletteCount } from './paletteAssigner.js';
import type { ConsentEffects } from './providers/hook/consentExecutor.js';
import { applyConsentChoice } from './providers/hook/consentExecutor.js';
import { hooksConsentRequest } from './providers/hook/consentGate.js';
import { claudeProvider } from './providers/index.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (
  providerId: string,
  enabled: boolean,
) => Promise<void> | void;

/**
 * Reload server-side assets after an external-asset-directory change and
 * re-broadcast the updated sprites to the requesting client. Provided by cli.ts,
 * which owns the dist root needed to re-run the loaders.
 */
export type ReloadAssetsSideEffect = (send: WsSend) => Promise<void> | void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  pets: LoadedPetSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  carpetTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  cache: AssetCache | null;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Reload assets after an external-asset-directory change. Needs the dist root, known only to cli.ts. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /**
   * Whether this client may send messages that reach OUTSIDE `~/.pixel-agents/`
   * — today only `setHooksEnabled`, which grants machine-wide consent to modify
   * `~/.claude/settings.json`. Decided per-connection by the transport
   * (httpServer's standaloneTokenValid, or the embedded Bearer token); defaults
   * to false so a caller that forgets to pass it gets the safe answer.
   */
  privileged?: boolean;
  /** Providers this process tracks and may configure; otherwise use the runtime's set. */
  activeProviders?: HookProvider[];
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
const KEY_SHOW_AREAS = 'pixel-agents.showAreas';
const KEY_ZOOM = 'pixel-agents.zoom';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'closeAgent': {
      // Standalone agents are always external (no terminal), so mirror the VS
      // Code external-agent branch: dismiss the file (so the external scanner
      // doesn't re-adopt it) then remove. removeAgent fires the agentRemoved
      // store event, which httpServer maps to an agentClosed broadcast.
      const id = msg.id as number;
      const agent = store.get(id);
      if (agent && runtime) {
        runtime.dismissAgent(id);
        runtime.removeAgent(id);
      }
      break;
    }

    case 'requestDiagnostics':
      // Point-to-point reply to the requesting socket (NOT a broadcast).
      send({ type: 'agentDiagnostics', agents: buildAgentDiagnostics(store) });
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        // Persists the seats, syncs palette/hueShift back to AgentState (so
        // existingAgents stays consistent across reconnects), and rebroadcasts
        // an appearance change to the other clients. The palette ceiling is
        // dynamic: external asset directories can add char_N.png beyond the
        // bundled 6, so read the count from the asset cache.
        applySavedSeats(
          store,
          msg.seats,
          cache?.characters?.characters.length ?? getPaletteCount(),
        );
      }
      break;

    case 'setAgentNickname':
      if (typeof msg.id === 'number') {
        store.setNickname(msg.id, msg.nickname);
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    case 'setGhostHeadlessAgents':
      adapter?.setSetting(KEY_GHOST_HEADLESS_AGENTS, msg.enabled);
      break;

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      if (typeof msg.enabled !== 'boolean') {
        console.warn('[Pixel Agents] Ignoring invalid hooks preference');
        break;
      }
      const enabled = msg.enabled;
      // The provider id is echoed by the client, never originated: an unknown
      // id names nothing to install into, so it is dropped like a junk choice.
      const provider = (ctx.activeProviders ?? runtime?.getProviders() ?? [claudeProvider]).find(
        (p) => p.id === msg.providerId,
      );
      if (!provider) {
        console.warn('[Pixel Agents] Ignoring hooks preference for a disabled provider');
        break;
      }
      if (!ctx.privileged) {
        // No server token on this connection: the toggle would grant durable
        // consent to modify a settings file on THIS machine, and only the
        // operator — who was handed the tokened URL — gets to decide that.
        // Answer with the truth so the checkbox still shows reality instead of
        // silently appearing to have worked.
        console.warn(
          '[Pixel Agents] Ignoring setHooksEnabled from an untokened client — installing hooks needs approval from this machine (open the tokened URL the CLI printed).',
        );
        void reportHooksStatus(ctx, send, provider);
        break;
      }
      void applyHooksPreference(ctx, send, provider, enabled);
      break;
    }

    case 'hooksConsentResponse': {
      // Privilege: the request is only ever sent to tokened connections, so a
      // response from an untokened one is a crafted message — ignored, same
      // reasoning as setHooksEnabled above.
      if (!ctx.privileged) {
        console.warn(
          '[Pixel Agents] Ignoring hooksConsentResponse from an untokened client — installing hooks needs approval from this machine (open the tokened URL the CLI printed).',
        );
        break;
      }
      // Fail-closed on the provider exactly like on the choice: an id naming
      // no registered provider writes nothing.
      const provider = (ctx.activeProviders ?? runtime?.getProviders() ?? [claudeProvider]).find(
        (p) => p.id === msg.providerId,
      );
      if (!provider) {
        console.warn('[Pixel Agents] Ignoring consent for a disabled provider');
        break;
      }
      void applyConsentChoice(
        provider.id,
        msg.choice,
        standaloneConsentEffects(ctx, send, provider),
      );
      break;
    }

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) break;
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'saveAreaMappings': {
      const rawMappings = msg.mappings;
      if (!rawMappings || typeof rawMappings !== 'object') {
        break;
      }
      const cfg = readConfig();
      cfg.standalone.areaMappings = rawMappings as Record<string, string[]>;
      writeConfig(cfg);
      break;
    }

    case 'setShowAreas': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_SHOW_AREAS, enabled);
      break;
    }

    case 'setZoom': {
      // Integer-only, clamped: a fractional or garbage zoom would break pixel-perfect rendering on restore.
      const zoom = parseZoom(msg.zoom);
      if (zoom !== undefined) adapter?.setSetting(KEY_ZOOM, zoom);
      break;
    }

    default:
      // focusAgent, exportLayout, importLayout
      // require IDE-specific handling (not yet implemented for standalone)
      break;
  }
}

/**
 * Run the install/uninstall side effect, then persist the provider's preference — only after it settled and only when
 * the on-disk result agrees. Writing it first strands the user when an uninstall fails: entries keep firing while the
 * persisted hooks-off makes the next startup skip the gate entirely. Shared by the Settings toggle and the consent
 * dialog's Install (both are grants). Never rejects — it is fire-and-forget and bound by the ConsentEffects contract,
 * so failures are reported to Settings as well as the console.
 */
async function applyHooksPreference(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
  enabled: boolean,
): Promise<void> {
  let error: string | undefined;
  try {
    await ctx.onSetHooksEnabled?.(provider.id, enabled);
    const installed = await provider.areHooksInstalled();
    if (installed === enabled) {
      setHooksEnabled(provider.id, enabled);
      ctx.runtime?.setHooksEnabled(provider.id, enabled);
    } else {
      error = `Hooks could not be ${enabled ? 'installed' : 'removed'}. Check the server log and retry.`;
    }
    // Always report the ACTUAL install state — the toggle expresses intent,
    // not outcome (the installer refuses to touch an unparseable file).
    send({ type: 'hooksStatus', providerId: provider.id, installed, ...(error ? { error } : {}) });
  } catch (err) {
    console.error('[Pixel Agents] Applying the hooks preference failed:', err);
    error =
      err instanceof Error ? err.message : 'Hook operation failed. Check the server log and retry.';
    await reportHooksStatus(ctx, send, provider, error);
  }
}

async function reportHooksStatus(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
  error?: string,
): Promise<void> {
  let installed = false;
  try {
    installed = await provider.areHooksInstalled();
  } catch (err) {
    console.error(`[Pixel Agents] Hook status check failed for ${provider.id}:`, err);
    error ??= 'Could not check hook installation. Check the server log and retry.';
  }
  send({
    type: 'hooksStatus',
    providerId: provider.id,
    installed,
    canManage: ctx.privileged === true,
    ...(error ? { error } : {}),
  });
}

/**
 * This surface's half of carrying out a consent answer for one provider. The choice→action rule and the write order
 * live in the shared consent modules; only these effects are standalone-specific (console, socket), each bound to the
 * one provider being answered.
 */
function standaloneConsentEffects(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
): ConsentEffects {
  return {
    setHooksEnabled: (enabled) => applyHooksPreference(ctx, send, provider, enabled),
    uninstallHooks: async () => {
      // The same side effect the toggle runs, minus the preference write. The
      // catch keeps the never-reject contract true by construction — the host
      // callback's own contract is unstated.
      try {
        await ctx.onSetHooksEnabled?.(provider.id, false);
      } catch (err) {
        console.error('[Pixel Agents] Hook uninstall failed:', err);
      }
    },
    areHooksInstalled: () => provider.areHooksInstalled(),
    syncHooksPreferenceOff: () => {
      ctx.runtime?.setHooksEnabled(provider.id, false);
    },
    reportHooksStatus: async () => {
      try {
        send({
          type: 'hooksStatus',
          providerId: provider.id,
          installed: await provider.areHooksInstalled(),
        });
      } catch {
        // Never let a status broadcast mask the error already surfaced.
      }
    },
  };
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  for (const provider of ctx.activeProviders ?? runtime?.getProviders() ?? [claudeProvider]) {
    send({
      type: 'providerCapabilities',
      providerId: provider.id,
      displayName: provider.displayName,
      consentDisclosure: provider.consentDisclosure(),
      capabilities: provider.capabilities,
      readingTools: [...provider.readingTools],
      subagentToolNames: [...provider.subagentToolNames],
    });
  }

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.pets) {
      send({
        type: 'petSpritesLoaded',
        pets: cache.pets.pets,
        petNames: cache.pets.manifests.map((m) => m.name),
      });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.carpetTiles) {
      send({ type: 'carpetTilesLoaded', sets: cache.carpetTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout is sent AFTER existingAgents — see step 7 below. The webview
  // buffers agents from existingAgents and only materializes them on the next
  // layoutLoaded (useExtensionMessages.ts: "Buffer agents — they'll be added
  // in layoutLoaded"), so layout-first would leave a client that connects
  // after agent creation with no characters.

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  // Retain the primary-provider preference for older clients.
  const primaryProvider = ctx.activeProviders?.[0] ?? runtime?.getProviders()[0] ?? claudeProvider;
  const hooksEnabled = getHooksEnabled(primaryProvider.id);
  const showAreas = adapter?.getSetting(KEY_SHOW_AREAS, false) ?? false;
  // Optional: omitted until the user zooms, so the client keeps its devicePixelRatio default.
  const zoom = parseZoom(adapter?.getSetting<unknown>(KEY_ZOOM, undefined));
  send({
    type: 'settingsLoaded',
    launchProvider: primaryProvider.id,
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    ghostHeadlessAgents: adapter?.getSetting(KEY_GHOST_HEADLESS_AGENTS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
    showAreas,
    ...(zoom !== undefined ? { zoom } : {}),
  });

  // 4a. Actual install state, distinct from the hooksEnabled preference —
  // hooksEnabled defaults true while first-run consent is still pending. The
  // provider checks are async, so these land as follow-ups right after the
  // synchronous handshake; the webview's default (not installed) is the safe
  // assumption until each arrives. One status + at most one ask PER PROVIDER
  // this process actually tracks (ctx.activeProviders when scoped; otherwise
  // every registered provider, matching the VS Code adapter's long-standing
  // behavior).
  for (const provider of ctx.activeProviders ?? runtime?.getProviders() ?? [claudeProvider]) {
    // One provider's unreadable settings file must degrade to
    // installed=false (matching the executor's fail-closed read: no choice
    // ever uninstalls on a guess) rather than surface as an unhandled
    // rejection that can take the process down — and must never block the
    // other providers' statuses.
    void provider
      .areHooksInstalled()
      .catch((err: unknown) => {
        console.error(`[Pixel Agents] hooks status check failed for provider ${provider.id}:`, err);
        return false;
      })
      .then((installed) => {
        send({
          type: 'hooksStatus',
          providerId: provider.id,
          installed,
          canManage: ctx.privileged === true,
        });
        // 4a-bis. First-run consent, asked in the app: this connect is the moment the user can be asked, so the ask
        // rides the handshake and consentGate owns every condition (VS Code calls the same function). The record is
        // re-read here rather than taken from startup — another tab may have answered while this one loaded.
        // Dismissing sends nothing, so the ask returns on the next connect: fail-closed, never nagging in-session.
        const request = hooksConsentRequest(
          {
            installed,
            hooksEnabled: getHooksEnabled(provider.id),
            consentAnswered: getHooksConsent(provider.id) !== 'unanswered',
            privileged: ctx.privileged === true,
          },
          provider,
        );
        if (request) send({ ...request }); // spread: WsSend takes an index-signature shape
      });
  }

  // 4b. Folder→Area mappings (must arrive before existingAgents so the
  // webview seat-preference logic has the dict when characters are created).
  send({
    type: 'areaMappingsLoaded',
    mappings: cfg.standalone.areaMappings ?? {},
  });

  // Sync runtime refs with the persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    for (const provider of ctx.activeProviders ?? runtime.getProviders()) {
      runtime.setHooksEnabled(provider.id, getHooksEnabled(provider.id));
    }
  }

  // 5. Restore persisted external agents (standalone only; VS Code handles its own restore)
  runtime?.restoreExternalAgents();

  // 6. Existing agents (either just restored, or from VS Code adapter if present)
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const sessionNames: Record<number, string> = {};
  const nicknames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const providerIds: Record<number, string> = {};
  const observations: Record<number, string> = {};
  const persistedSeats = adapter?.loadSeats() ?? {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    providerIds[id] = agent.providerId ?? 'claude';
    observations[id] = agent.observation ?? 'known';
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.sessionName) {
      sessionNames[id] = agent.sessionName;
    }
    if (agent.nickname) {
      nicknames[id] = agent.nickname;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
    const persisted = persistedSeats[String(id)];
    agentMeta[id] = {
      palette: agent.palette,
      hueShift: agent.hueShift,
      // Never seated yet: offer the seat last used under its nickname.
      seatId: persisted?.seatId ?? agent.preferredSeatId,
    };
  }
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    sessionNames,
    nicknames,
    externalAgents,
    providerIds,
    observations,
  });

  // 7. Layout last (see step 3): flushes the webview's buffered existingAgents
  // into characters once seats are rebuilt.
  const savedLayout = readLayoutFromFile();
  send({
    type: 'layoutLoaded',
    layout: savedLayout ?? cache?.defaultLayout ?? null,
    defaultLayout: cache?.defaultLayout ?? null,
  });

  // 8. Agent state, AFTER layoutLoaded -- the characters they target only
  // exist once the layout flush creates them. Without this a reconnecting
  // client shows bare characters until each agent takes another turn.
  resendAgentActivity(send, store);
}
