import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import { parseZoom } from '../../core/src/zoom.js';
import { applySavedSeats } from '../../server/src/agentAppearance.js';
import { buildAgentDiagnostics } from '../../server/src/agentDiagnostics.js';
import { AgentRuntime } from '../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import type {
  LoadedAssets,
  LoadedCharacterSprites,
  LoadedPetSprites,
} from '../../server/src/assetLoader.js';
import {
  loadCarpetTiles,
  loadDefaultLayout,
  loadFloorTiles,
  loadWallTiles,
  sendAssetsToWebview,
  sendCarpetTilesToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendPetSpritesToWebview,
  sendWallTilesToWebview,
} from '../../server/src/assetLoader.js';
import { loadAllCharacters, loadAllFurniture, loadAllPets } from '../../server/src/assetReload.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
  setHooksEnabled as persistHooksEnabled,
  writeConfig,
} from '../../server/src/configPersistence.js';
import type { LayoutWatcher } from '../../server/src/layoutPersistence.js';
import {
  readLayoutFromFile,
  watchLayoutFile,
  writeLayoutToFile,
} from '../../server/src/layoutPersistence.js';
import { PathSet } from '../../server/src/pathKey.js';
import type { ConsentEffects } from '../../server/src/providers/hook/consentExecutor.js';
import { applyConsentChoice } from '../../server/src/providers/hook/consentExecutor.js';
import { hooksConsentRequest } from '../../server/src/providers/hook/consentGate.js';
import { copyProviderHookScript } from '../../server/src/providers/index.js';
import { PixelAgentsServer } from '../../server/src/server.js';
import {
  getProjectDirPath,
  launchNewTerminal,
  restoreAgents,
  sendCurrentAgentStatuses,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import {
  CONFIG_KEY_AUTO_SHOW_PANEL,
  CONFIG_KEY_AUTO_SPAWN_AGENT,
  GLOBAL_KEY_ACHIEVEMENT_POPUPS,
  GLOBAL_KEY_ALWAYS_SHOW_LABELS,
  GLOBAL_KEY_GHOST_HEADLESS_AGENTS,
  GLOBAL_KEY_HOOKS_INFO_SHOWN,
  GLOBAL_KEY_LAST_SEEN_VERSION,
  GLOBAL_KEY_MOOD_BUBBLES,
  GLOBAL_KEY_SHOW_AREAS,
  GLOBAL_KEY_SOUND_ENABLED,
  GLOBAL_KEY_WATCH_ALL_SESSIONS,
  GLOBAL_KEY_ZOOM,
  LAYOUT_REVISION_KEY,
} from './constants.js';
import { enabledProviders, launchProvider } from './providerSelection.js';
import { VscodeTerminalAdapter } from './vscodeTerminalAdapter.js';

/** Cap on the pending-broadcast queue. If we exceed this, something has gone
 *  wrong (webviewReady never arriving) — log and drop the oldest. */
const MAX_PENDING_BROADCASTS = 1_000;

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
  store = new AgentStateStore();
  webviewView: vscode.WebviewView | undefined;

  // Webview iframe takes ~hundreds of ms to load the React app and attach
  // message handlers. Broadcasts that fire in this window are otherwise lost
  // (webview.postMessage delivers to a window without an active listener).
  // Buffer them here and flush on `webviewReady`. Without this, on slow CI
  // runners hook events that arrive during iframe init (mock-claude scenarios
  // start writing within ~3 s of agent spawn) silently never reach the UI.
  private isWebviewReady = false;
  private pendingBroadcasts: Array<Record<string, unknown>> = [];

  // Shared agent lifecycle core (timer Maps, scanners, hook handler, dismissal tracker)
  private runtime: AgentRuntime;
  private readonly providers = enabledProviders();

  // Global session scanning dismissal tracking
  private globalDismissedFiles = new Map<string, string>();

  // Bundled default layout (loaded from assets/default-layout.json)
  defaultLayout: Record<string, unknown> | null = null;

  // Root path of bundled assets (set once on first load)
  private assetsRoot: string | null = null;

  // Cross-window layout sync
  layoutWatcher: LayoutWatcher | null = null;

  // Pixel Agents Server (hook event reception)
  private pixelAgentsServer: PixelAgentsServer | null = null;
  private adapter: StateAdapter;

  // Auto-spawn guard: ensures the startup spawn fires at most once per VS Code
  // session, even though webviewReady fires on every panel focus.
  private autoSpawnAttempted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    adapter: StateAdapter,
  ) {
    this.adapter = adapter;
    this.store.setAdapter(this.adapter);
    this.store.on('agentAdded', (id, agent) => {
      this.sendOrBuffer({
        type: 'agentCreated',
        id,
        providerId: agent.providerId,
        observation: agent.observation,
        sessionName: agent.sessionName,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        nickname: agent.nickname,
        seatId: agent.preferredSeatId,
      });
    });
    this.store.on('agentRemoved', (id) => {
      this.sendOrBuffer({ type: 'agentClosed', id });
    });
    this.store.on('broadcast', (message) => {
      this.sendOrBuffer(message);
    });

    this.runtime = new AgentRuntime(this.store, this.providers, {
      achievements: { namespace: 'vscode' },
    });
    this.runtime.setTerminalAdapter(new VscodeTerminalAdapter());

    // Map an external agent's cwd/projectDir to its WorkspaceFolder.name — the
    // identity areaMappings is keyed on — so in-area seat placement works. Multi-root only.
    this.runtime.setFolderNameResolver(({ cwd, projectDir }) => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length <= 1) return undefined;
      // Prefer a real cwd: most specific containing folder wins (nested folders).
      if (cwd) {
        const owning = folders
          .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
          .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
        if (owning) return owning.name;
      }
      // External sessions expose only the hashed projectDir. Match a folder's own hash,
      // allowing a `<hash>-<subpath>` prefix so subdirectory sessions still resolve.
      if (projectDir) {
        const target = path.basename(projectDir);
        const owning = folders
          .flatMap((f) =>
            this.providers.flatMap((provider) =>
              (provider.getSessionDirs?.(f.uri.fsPath) ?? []).map((dir) => ({
                f,
                hash: path.basename(dir),
              })),
            ),
          )
          .filter(
            ({ hash }) => hash.length > 0 && (target === hash || target.startsWith(`${hash}-`)),
          )
          .sort((a, b) => b.hash.length - a.hash.length)[0];
        if (owning) return owning.f.name;
      }
      return undefined;
    });

    this.initServer();
  }

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  /** Post a message to the webview, or buffer it if the iframe isn't ready
   *  yet. Drops silently when no view exists at all (matches prior behavior).
   *  Flushed by the `webviewReady` handler in resolveWebviewView. */
  private sendOrBuffer(message: Record<string, unknown>): void {
    const wv = this.webview;
    if (!wv) return;
    if (this.isWebviewReady) {
      wv.postMessage(message);
      return;
    }
    if (this.pendingBroadcasts.length >= MAX_PENDING_BROADCASTS) {
      console.warn(
        `[Pixel Agents] Webview buffer overflow (${MAX_PENDING_BROADCASTS}). webviewReady never arrived — dropping oldest message.`,
      );
      this.pendingBroadcasts.shift();
    }
    this.pendingBroadcasts.push(message);
  }

  private initServer(): void {
    this.pixelAgentsServer = new PixelAgentsServer();
    this.pixelAgentsServer.onHookEvent((providerId, event) => {
      this.runtime.handleHookEvent(providerId, event);
    });

    this.pixelAgentsServer
      .start({ store: this.store, embedded: true })
      .then((config) => {
        // Server always starts regardless of hooks-enabled state.
        // It's the foundation for WebSocket transport and health monitoring.
        // Only each provider's hook installation/script-copy is gated by its toggle.
        for (const provider of this.providers) {
          this.runtime.setHooksEnabled(provider.id, getHooksEnabled(provider.id));
          if (getHooksEnabled(provider.id)) {
            void this.installHooksIfConsented(provider, config.port, config.token).catch(
              (error: unknown) => {
                console.error(`[Pixel Agents] ${provider.displayName} hooks setup failed:`, error);
              },
            );
          }
        }
        console.log(`[Pixel Agents] Server: ready on port ${config.port}`);
      })
      .catch((e) => {
        console.error(`[Pixel Agents] Failed to start server: ${e}`);
      });
  }

  /** Copy the hook script, THEN install the settings.json entries, surfacing
   *  every failure instead of swallowing it.
   *
   *  Script first, deliberately: an entry whose command points at a script that
   *  is not on disk makes the CLI spawn a dead `node` for every event, so a
   *  failed copy must abort the install rather than run alongside it. And
   *  `hooksStatus: true` is sent ONLY after both steps succeeded — it reports
   *  actual install state, never intent (core/asyncapi.yaml). */
  private async installHooksAndScript(
    provider: HookProvider,
    port: number | undefined,
    token: string | undefined,
  ): Promise<void> {
    if (!copyProviderHookScript(provider, this.context.extensionPath)) {
      vscode.window.showErrorMessage(
        'Pixel Agents: could not install the hook script — hooks not installed.',
      );
      await this.reportHooksStatus(provider);
      return;
    }
    try {
      await provider.installHooks(
        port !== undefined ? `http://127.0.0.1:${port}` : '',
        token ?? '',
      );
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Pixel Agents: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.reportHooksStatus(provider);
      return;
    }
    // No success report here: both callers already produce a truthful hooksStatus (setHooksEnabled re-derives, the
    // startup path rides the webviewReady handshake). A second optimistic send is a duplicate the Intro's seq-driven
    // verdict could misread.
  }

  /**
   * The ordinary Settings-toggle path (the consent gate is separate, below).
   *
   * The preference is persisted only AFTER the install/uninstall settled, and
   * only when the resulting on-disk state agrees with what was asked. Writing
   * it first is how a user gets stranded: a failed uninstall leaves the entries
   * on disk and still firing, while a persisted hooks-off makes the next
   * activation skip the consent/install path entirely — never asked again, and
   * the checkbox reads "off" so clicking it would install rather than remove.
   */
  private async setHooksEnabled(provider: HookProvider, enabled: boolean): Promise<void> {
    if (enabled) {
      // An explicit Settings toggle IS the consent to modify the provider's
      // settings file.
      grantHooksConsent(provider.id);
      const serverConfig = this.pixelAgentsServer?.getConfig();
      await this.installHooksAndScript(provider, serverConfig?.port, serverConfig?.token);
    } else {
      try {
        await provider.uninstallHooks();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Pixel Agents: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Re-derive rather than trust the call: installHooksAndScript already
    // swallows its own failures into an error message, and either way the file
    // on disk is the only authority for what is actually firing.
    let installed: boolean;
    try {
      installed = await provider.areHooksInstalled();
    } catch {
      return; // the failure was already surfaced; do not also persist on a guess
    }
    if (installed === enabled) {
      persistHooksEnabled(provider.id, enabled);
      this.runtime.setHooksEnabled(provider.id, enabled);
      console.log(`[Pixel Agents] Hooks ${enabled ? 'enabled' : 'disabled'} by user`);
    }
    // Report the truth either way: on failure the entries are still on disk and
    // still firing, and a checkbox stuck "off" over live hooks offers no retry.
    this.sendOrBuffer({ type: 'hooksStatus', providerId: provider.id, installed });
  }

  /** Broadcast the ACTUAL install state, re-derived from the provider's settings file. Every failure path calls it so
   *  the Settings checkbox — which renders install state, not the preference — self-corrects. Standalone gets it for
   *  free (it re-derives after every toggle); VS Code has no equivalent seam, so failure paths report explicitly. */
  private async reportHooksStatus(provider: HookProvider): Promise<void> {
    try {
      this.sendOrBuffer({
        type: 'hooksStatus',
        providerId: provider.id,
        installed: await provider.areHooksInstalled(),
      });
    } catch {
      // Never let a status broadcast mask the error already surfaced.
    }
  }

  /** First-run consent gate: never touch the provider's settings until the
   *  user has approved it once (persisted in config.json, shared with the
   *  standalone CLI).
   *
   *  The dialog itself lives in the WEBVIEW, not in a native modal: the
   *  webviewReady handler sends a `hooksConsentRequest` and the app renders
   *  the same consent modal the standalone browser shows, so both surfaces
   *  ask on identical terms with one rendering. This method therefore only
   *  handles the two populations that are NOT asked:
   *
   *  - Consent already recorded → install straight away.
   *  - Our hooks ALREADY present but no recorded consent — a pre-consent
   *    version installed them silently — consent is granted here and the
   *    install runs with no prompt at all. That install is the 14 -> 12
   *    migration, and it only ever REDUCES scope: it drops UserPromptSubmit
   *    and TaskCreated, the two events that forwarded prompt text and were
   *    consumed by nothing. Nothing this user already had is expanded, so the
   *    friction of a prompt buys them nothing they do not already have.
   *    (This is deliberately NOT the general rule: consent for a fresh
   *    install is still asked for, in full, in the app.)
   *
   *  The fresh-install population gets nothing here — the ask happens when
   *  the office is opened, which also means hooks are not installed until the
   *  panel is first viewed. Fail-closed by construction: no answer, no write. */
  private async installHooksIfConsented(
    provider: HookProvider,
    port: number,
    token: string,
  ): Promise<void> {
    if (getHooksConsent(provider.id) !== 'granted') {
      if (provider.id !== 'claude' || !(await provider.areHooksInstalled())) {
        return; // fresh install — the webview consent dialog owns this ask
      }
      // Only legacy Claude installs have a verified, scope-reducing silent migration.
      grantHooksConsent(provider.id);
    }
    await this.installHooksAndScript(provider, port, token);
    // Truthful success report for THIS path: a webviewReady handshake that
    // raced the install read the pre-install state, and installHooksAndScript
    // itself no longer sends an optimistic status (its other caller,
    // setHooksEnabled, re-derives on its own).
    await this.reportHooksStatus(provider);
  }

  /** This surface's half of carrying out a consent answer for one provider. The choice→action rule and the write
   *  order live in the shared consent modules, so the surfaces cannot drift on what counts as approval or on what a
   *  revised answer undoes; only these effects are VS Code-specific. */
  private consentEffects(provider: HookProvider): ConsentEffects {
    return {
      setHooksEnabled: (enabled) => this.setHooksEnabled(provider, enabled),
      uninstallHooks: async () => {
        try {
          await provider.uninstallHooks();
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Pixel Agents: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      areHooksInstalled: () => provider.areHooksInstalled(),
      syncHooksPreferenceOff: () => {
        // Durable writes are the executor's own atomic recordHooksDecline;
        // this only mirrors the provider's live runtime preference.
        this.runtime.setHooksEnabled(provider.id, false);
      },
      reportHooksStatus: () => this.reportHooksStatus(provider),
    };
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    // Fresh iframe; any prior buffer is for the destroyed iframe and obsolete
    // (the `webviewReady` handler resends current state via restoreAgents +
    // sendCurrentAgentStatuses + asset loaders).
    this.isWebviewReady = false;
    this.pendingBroadcasts = [];
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'launchAgent') {
        const provider = launchProvider(this.providers, message.providerId);
        if (!provider) {
          void vscode.window.showWarningMessage(
            'Pixel Agents: the selected launch provider is not enabled.',
          );
          return;
        }
        try {
          await launchNewTerminal(
            this.runtime,
            provider,
            this.store,
            message.folderPath as string | undefined,
            message.bypassPermissions as boolean | undefined,
            undefined,
            message.nickname,
          );
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Pixel Agents: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (message.type === 'focusAgent') {
        const agent = this.store.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.show();
          } else if (agent.leadAgentId !== undefined) {
            // Teammate (tmux): focus the lead's terminal instead
            const lead = this.store.get(agent.leadAgentId);
            if (lead?.terminalRef) {
              lead.terminalRef.show();
            }
          }
        }
      } else if (message.type === 'closeAgent') {
        const agent = this.store.get(message.id);
        if (agent) {
          if (agent.terminalRef) {
            agent.terminalRef.dispose();
          } else {
            // External agent -- remove from tracking and dismiss the file
            // so the external scanner doesn't re-adopt it
            this.runtime.dismissAgent(agent.id);
            this.runtime.removeAgent(message.id);
          }
        }
      } else if (message.type === 'saveAgentSeats') {
        // Store seat assignments in a separate key (never touched by persistAgents)
        console.log(`[Pixel Agents] State: saveAgentSeats:`, JSON.stringify(message.seats));
        // Shared with standalone: also applies (and rebroadcasts) a costume change.
        applySavedSeats(this.store, message.seats);
      } else if (message.type === 'setAgentNickname') {
        if (typeof message.id === 'number') {
          this.store.setNickname(message.id, message.nickname);
        }
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        // The user's own editing: new furniture in it was placed (Achievements).
        // An imported file's furniture was not.
        writeLayoutToFile(
          message.layout as Record<string, unknown>,
          message.imported === true ? 'replace' : 'edit',
        );
      } else if (message.type === 'setSoundEnabled') {
        this.adapter.setSetting(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'setLastSeenVersion') {
        this.adapter.setSetting(GLOBAL_KEY_LAST_SEEN_VERSION, message.version as string);
      } else if (message.type === 'setAlwaysShowLabels') {
        this.adapter.setSetting(GLOBAL_KEY_ALWAYS_SHOW_LABELS, message.enabled);
      } else if (message.type === 'setGhostHeadlessAgents') {
        this.adapter.setSetting(GLOBAL_KEY_GHOST_HEADLESS_AGENTS, message.enabled);
      } else if (message.type === 'setMoodBubbles') {
        this.adapter.setSetting(GLOBAL_KEY_MOOD_BUBBLES, message.enabled);
      } else if (message.type === 'setAchievementPopups') {
        this.adapter.setSetting(GLOBAL_KEY_ACHIEVEMENT_POPUPS, message.enabled === true);
      } else if (message.type === 'requestAchievements') {
        this.webview?.postMessage({
          type: 'achievementsLoaded',
          achievements: this.runtime.achievements?.snapshot() ?? [],
        });
      } else if (message.type === 'setHooksEnabled') {
        // The provider id is echoed by the webview, never originated; an
        // unknown id names nothing to install into, so it is dropped like a
        // junk consent choice.
        const provider = this.providers.find((p) => p.id === message.providerId);
        if (provider) void this.setHooksEnabled(provider, message.enabled as boolean);
      } else if (message.type === 'hooksConsentResponse') {
        const provider = this.providers.find((p) => p.id === message.providerId);
        if (provider) {
          void applyConsentChoice(provider.id, message.choice, this.consentEffects(provider));
        }
      } else if (message.type === 'setHooksInfoShown') {
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_INFO_SHOWN, true);
      } else if (message.type === 'setShowAreas') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_SHOW_AREAS, enabled);
      } else if (message.type === 'setZoom') {
        // Same rule as the standalone handler: integers only, clamped to the shared bounds.
        const zoom = parseZoom(message.zoom);
        if (zoom !== undefined) this.adapter.setSetting(GLOBAL_KEY_ZOOM, zoom);
      } else if (message.type === 'saveAreaMappings') {
        const mappings = message.mappings as Record<string, string[]>;
        const cfg = readConfig();
        cfg.vscode.areaMappings = mappings;
        writeConfig(cfg);
      } else if (message.type === 'setWatchAllSessions') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_WATCH_ALL_SESSIONS, enabled);
        this.runtime.watchAllSessions.current = enabled;
        if (enabled) {
          // Clear only toggle-specific dismissals so global agents can be re-adopted
          for (const [file, providerId] of this.globalDismissedFiles) {
            this.runtime.getFileWatcher(providerId).getDismissalTracker()?.clearDismissal(file);
          }
          this.globalDismissedFiles.clear();
        } else {
          // Remove all external agents not from the current workspace folders.
          // PathSet: an agent adopted via hooks carries Claude's spelling of the
          // project dir, which differs from VS Code's by drive-letter case on Windows.
          const workspaceDirs = new PathSet();
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            for (const provider of this.providers) {
              for (const dir of provider.getSessionDirs?.(folder.uri.fsPath) ?? [])
                workspaceDirs.add(dir);
            }
          }
          const toRemove: number[] = [];
          for (const [id, agent] of this.store) {
            if (agent.isExternal && !workspaceDirs.has(agent.projectDir)) {
              toRemove.push(id);
            }
          }
          for (const id of toRemove) {
            const agent = this.store.get(id);
            if (agent) {
              this.runtime.dismissAgent(id);
              this.globalDismissedFiles.set(agent.jsonlFile, agent.providerId ?? 'claude');
              this.runtime.getKnownJsonlFiles(agent.providerId).delete(agent.jsonlFile);
            }
            this.runtime.removeAgent(id);
          }
        }
      } else if (message.type === 'webviewReady') {
        // Flush any messages buffered while the iframe was loading. Mark
        // ready BEFORE flush so re-entrant broadcasts (triggered by handlers
        // below) go directly. Order is preserved: buffered first, new second.
        this.isWebviewReady = true;
        const buffered = this.pendingBroadcasts;
        this.pendingBroadcasts = [];
        for (const msg of buffered) {
          this.webview?.postMessage(msg);
        }
        // Provider capabilities: tool taxonomy for webview animation + subagent rendering.
        // Sent once before restoreAgents so characters render with correct animations
        // from the first frame.
        for (const provider of this.providers) {
          this.webview?.postMessage({
            type: 'providerCapabilities',
            providerId: provider.id,
            displayName: provider.displayName,
            readingTools: [...provider.readingTools],
            subagentToolNames: [...provider.subagentToolNames],
            permissionExemptTools: [...provider.permissionExemptTools],
            capabilities: provider.capabilities,
            consentDisclosure: provider.consentDisclosure(),
          });
        }

        // Settings + folder→Area mappings MUST be dispatched BEFORE restoreAgents
        // and the auto-spawn path. Both paths emit `agentCreated` postMessages via
        // AgentStateStore events; the webview's handler routes each agent through
        // OfficeState.findFreeSeat(folderName), which depends on `areaMappings`.
        // If we restore agents first, Stage-1 (in-Area) is silently skipped for
        // restored / auto-spawned agents and their preferred Area placement is lost.
        const soundEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        const lastSeenVersion = this.adapter.getSetting<string>(GLOBAL_KEY_LAST_SEEN_VERSION, '');
        const extensionVersion =
          (this.context.extension.packageJSON as { version?: string }).version ?? '';
        const watchAllSessions = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_WATCH_ALL_SESSIONS,
          false,
        );
        const alwaysShowLabels = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_ALWAYS_SHOW_LABELS,
          false,
        );
        const ghostHeadlessAgents = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_GHOST_HEADLESS_AGENTS,
          false,
        );
        this.runtime.watchAllSessions.current = watchAllSessions;
        // Kept for legacy clients; new Settings rows use per-provider install state.
        const hooksEnabled = this.providers.some((provider) => getHooksEnabled(provider.id));
        const hooksInfoShown = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_INFO_SHOWN, false);
        const showAreas = this.adapter.getSetting<boolean>(GLOBAL_KEY_SHOW_AREAS, false);
        // Omitted until the user zooms, so the webview keeps its devicePixelRatio default.
        const zoom = parseZoom(this.adapter.getSetting<unknown>(GLOBAL_KEY_ZOOM, undefined));
        const moodBubbles = this.adapter.getSetting<boolean>(GLOBAL_KEY_MOOD_BUBBLES, true);
        const achievementPopups = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_ACHIEVEMENT_POPUPS,
          true,
        );
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          ghostHeadlessAgents,
          hooksEnabled,
          hooksInfoShown,
          launchProvider: launchProvider(this.providers)?.id,
          externalAssetDirectories: config.externalAssetDirectories,
          showAreas,
          ...(zoom !== undefined ? { zoom } : {}),
          moodBubbles,
          achievementPopups,
        });
        // Achievement progress, so the gallery opens on current numbers.
        this.webview?.postMessage({
          type: 'achievementsLoaded',
          achievements: this.runtime.achievements?.snapshot() ?? [],
        });

        // One status + at most one consent ask PER PROVIDER. Install state is distinct from the hooksEnabled
        // preference, which defaults true while consent is pending. Opening the office is the moment the user can be
        // asked, so the ask rides this handshake; consentGate owns every condition (standalone calls the same
        // function). Dismissing sends nothing and re-asks next handshake; either durable answer closes the gate for
        // good. An embedded webview is privileged by construction — our own iframe, reached through no socket.
        for (const provider of this.providers) {
          // One provider's unreadable settings file degrades to installed=false (the executor's fail-closed read: no
          // choice uninstalls on a guess) rather than aborting the handshake before restored agents are sent, or
          // blocking the other providers' statuses.
          const installed = await provider.areHooksInstalled().catch((err: unknown) => {
            console.error(
              `[Pixel Agents] hooks status check failed for provider ${provider.id}:`,
              err,
            );
            return false;
          });
          this.webview?.postMessage({
            type: 'hooksStatus',
            providerId: provider.id,
            installed,
          });
          const consentRequest = hooksConsentRequest(
            {
              installed,
              hooksEnabled: getHooksEnabled(provider.id),
              consentAnswered: getHooksConsent(provider.id) !== 'unanswered',
              privileged: true,
            },
            provider,
          );
          if (consentRequest) this.webview?.postMessage(consentRequest);
        }

        // Folder→Area mappings (must arrive before any agentCreated/existingAgents
        // so OfficeState.findFreeSeat has the dict when characters are placed).
        this.webview?.postMessage({
          type: 'areaMappingsLoaded',
          mappings: config.vscode.areaMappings ?? {},
        });

        restoreAgents(this.adapter, this.runtime, this.store);

        // Auto-spawn: launch one agent on first webviewReady if the setting is
        // enabled and no agents are currently running.
        if (
          !this.autoSpawnAttempted &&
          vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY_AUTO_SPAWN_AGENT, false) &&
          this.store.size === 0
        ) {
          this.autoSpawnAttempted = true;
          console.log('[Pixel Agents] Auto-spawning agent on startup');
          // When the user also opted into autoShowPanel, skip terminal.show()
          // so the panel view stays on Pixel Agents. The terminal still runs;
          // clicking the character focuses it via the focusAgent handler.
          const autoShowPanel = vscode.workspace
            .getConfiguration()
            .get<boolean>(CONFIG_KEY_AUTO_SHOW_PANEL, false);
          const provider = launchProvider(this.providers);
          if (provider) {
            try {
              await launchNewTerminal(
                this.runtime,
                provider,
                this.store,
                undefined,
                undefined,
                autoShowPanel,
              );
            } catch (error) {
              void vscode.window.showErrorMessage(
                `Pixel Agents: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } else {
          // Mark as attempted even when skipping, so subsequent panel focuses
          // (which retrigger webviewReady) never auto-spawn unexpectedly.
          this.autoSpawnAttempted = true;
        }

        // Send workspace folders to webview (only when multi-root)
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
          });
        }

        // Ensure project scan runs even with no restored agents (to adopt external terminals)
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        console.log(`[Pixel Agents] Debug: Platform: ${process.platform}, arch: ${process.arch}`);
        console.log('[Extension] workspaceRoot:', workspaceRoot);
        this.runtime.startDiscovery(
          wsFolders?.map((folder) => folder.uri.fsPath) ?? [os.homedir()],
        );

        this.runtime.startStaleCheck();

        // Load furniture assets BEFORE sending layout
        (async () => {
          try {
            console.log('[Extension] Loading furniture assets...');
            const extensionPath = this.extensionUri.fsPath;
            console.log('[Extension] extensionPath:', extensionPath);

            // Check bundled location first: extensionPath/dist/assets/
            const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
            let assetsRoot: string | null = null;
            if (fs.existsSync(bundledAssetsDir)) {
              console.log('[Extension] Found bundled assets at dist/');
              assetsRoot = path.join(extensionPath, 'dist');
            } else if (workspaceRoot) {
              // Fall back to workspace root (development or external assets)
              console.log('[Extension] Trying workspace for assets...');
              assetsRoot = workspaceRoot;
            }

            if (!assetsRoot) {
              console.log('[Extension] ⚠️  No assets directory found');
              if (this.webview) {
                sendLayout(this.webview, this.defaultLayout);
                // Send agent statuses AFTER layoutLoaded so characters exist when messages arrive
                sendCurrentAgentStatuses(this.store, this.webview);
                this.startLayoutWatcher();
              }
              return;
            }

            console.log('[Extension] Using assetsRoot:', assetsRoot);
            this.assetsRoot = assetsRoot;

            // Load bundled default layout
            this.defaultLayout = loadDefaultLayout(assetsRoot);
            // Resetting the office to the default places none of its furniture.
            if (this.defaultLayout) this.runtime.achievements?.seedLayout(this.defaultLayout);

            // Load character sprites (bundled + external)
            const charSprites = await this.loadAllCharacterSprites();
            if (charSprites && this.webview) {
              console.log(
                `[Extension] ${charSprites.characters.length} character sprites loaded, sending to webview`,
              );
              sendCharacterSpritesToWebview(this.webview, charSprites);
            }

            // Load pet sprites (bundled + external)
            const petSprites = await this.loadAllPetSprites();
            if (petSprites && this.webview) {
              console.log(
                `[Extension] ${petSprites.pets.length} pet sprites loaded, sending to webview`,
              );
              sendPetSpritesToWebview(this.webview, petSprites);
            }

            // Load floor tiles
            const floorTiles = await loadFloorTiles(assetsRoot);
            if (floorTiles && this.webview) {
              console.log('[Extension] Floor tiles loaded, sending to webview');
              sendFloorTilesToWebview(this.webview, floorTiles);
            }

            // Load wall tiles
            const wallTiles = await loadWallTiles(assetsRoot);
            if (wallTiles && this.webview) {
              console.log('[Extension] Wall tiles loaded, sending to webview');
              sendWallTilesToWebview(this.webview, wallTiles);
            }

            // Load carpet tiles (auto-tile sprite sets, 3 demo variants by default)
            const carpetTiles = await loadCarpetTiles(assetsRoot);
            if (carpetTiles && this.webview) {
              console.log('[Extension] Carpet tiles loaded, sending to webview');
              sendCarpetTilesToWebview(this.webview, carpetTiles);
            }

            const assets = await this.loadAllFurnitureAssets();
            if (assets && this.webview) {
              console.log('[Extension] ✅ Assets loaded, sending to webview');
              sendAssetsToWebview(this.webview, assets);
            }
          } catch (err) {
            console.error('[Extension] ❌ Error loading assets:', err);
          }
          // Always send saved layout (or null for default)
          if (this.webview) {
            console.log('[Extension] Sending saved layout');
            sendLayout(this.webview, this.defaultLayout);
            // Send agent statuses AFTER layoutLoaded so characters exist when messages arrive
            sendCurrentAgentStatuses(this.store, this.webview);
            this.startLayoutWatcher();
          }
        })();
        sendExistingAgents(this.store, this.adapter, this.webview);
      } else if (message.type === 'requestDiagnostics') {
        // Send connection diagnostics for all agents to the Debug View
        this.webview?.postMessage({
          type: 'agentDiagnostics',
          agents: buildAgentDiagnostics(this.store),
        });
      } else if (message.type === 'openSessionsFolder') {
        const provider = launchProvider(this.providers) ?? this.providers[0];
        try {
          const projectDir = getProjectDirPath(undefined, provider);
          if (fs.existsSync(projectDir)) {
            void vscode.env.openExternal(vscode.Uri.file(projectDir));
          }
        } catch {
          void vscode.window.showInformationMessage(
            'Pixel Agents: no session folder is available yet for this provider.',
          );
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
        }
      } else if (message.type === 'addExternalAssetDirectory') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Asset Directory',
        });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = readConfig();
        if (!cfg.externalAssetDirectories.includes(newPath)) {
          cfg.externalAssetDirectories.push(newPath);
          writeConfig(cfg);
        }
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'removeExternalAssetDirectory') {
        const cfg = readConfig();
        cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter(
          (d) => d !== (message.path as string),
        );
        writeConfig(cfg);
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) return;
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      this.runtime.activeAgentId.current = null;
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === terminal) {
          this.runtime.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === closed) {
          if (this.runtime.activeAgentId.current === id) {
            this.runtime.activeAgentId.current = null;
          }
          // If this is a team lead, remove its teammates
          if (agent.isTeamLead) {
            this.runtime.removeTeammates(id);
          }
          // Dismiss JSONL so external scanner doesn't re-adopt it
          this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
          this.runtime.unregisterAgent(agent.sessionId, agent.providerId);
          this.runtime.removeAgent(id);
        }
      }
    });
  }

  /** Export current saved layout as a versioned default-layout-{N}.json (dev utility) */
  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    // Find the next revision number
    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    const json = JSON.stringify(layout, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    vscode.window.showInformationMessage(
      `Pixel Agents: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private async loadAllFurnitureAssets(): Promise<LoadedAssets | null> {
    if (!this.assetsRoot) return null;
    return loadAllFurniture(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllCharacterSprites(): Promise<LoadedCharacterSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllCharacters(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllPetSprites(): Promise<LoadedPetSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllPets(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async reloadAndSendFurniture(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const assets = await this.loadAllFurnitureAssets();
      if (assets) {
        sendAssetsToWebview(this.webview, assets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading furniture assets:', err);
    }
  }

  private async reloadAndSendCharacters(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const chars = await this.loadAllCharacterSprites();
      if (chars) {
        sendCharacterSpritesToWebview(this.webview, chars);
      }
    } catch (err) {
      console.error('[Extension] Error reloading character sprites:', err);
    }
  }

  private async reloadAndSendPets(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const pets = await this.loadAllPetSprites();
      if (pets) {
        sendPetSpritesToWebview(this.webview, pets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading pet sprites:', err);
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Pixel Agents] External layout change — pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  dispose() {
    this.pixelAgentsServer?.stop();
    this.pixelAgentsServer = null;
    this.runtime.dispose();
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    this.store.dispose();
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const fileUri = vscode.Uri.joinPath(distPath, filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}
