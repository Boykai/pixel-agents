/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { ITerminalAdapter } from '../../core/src/terminalAdapter.js';
import { resendAgentActivity } from './agentActivityResend.js';
import { migrateAgentIdentity } from './agentMigration.js';
import type { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, EXTERNAL_SCAN_INTERVAL_MS } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import type { FileWatcherContext, FolderNameResolver } from './fileWatcher.js';
import { createFileWatcherContext } from './fileWatcher.js';
import type { HookEventConsumer } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import type { CopilotChild, CopilotRecordOptions } from './providers/hook/copilot/eventReducer.js';
import {
  getCopilotSnapshot,
  hookToCopilotRecords,
  processCopilotRecord,
  promoteCopilotChildRequests,
} from './providers/hook/copilot/eventReducer.js';
import { SessionRouter } from './sessionRouter.js';
import { SubagentWatch } from './subagentWatch.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { TranscriptParserContext } from './transcriptParser.js';
import { createTranscriptParser } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

interface ProviderContext {
  provider: HookProvider;
  watcher: FileWatcherContext;
  handler: HookEventHandler;
  subagents: SubagentWatch;
  knownFiles: PathSet;
  dismissals: DismissalTracker;
  projectTimer: { current: ReturnType<typeof setInterval> | null };
  externalTimer: ReturnType<typeof setInterval> | null;
  staleTimer: ReturnType<typeof setInterval> | null;
  hooksEnabled: { current: boolean };
  parser: TranscriptParserContext;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private workspacePaths: readonly string[] = [];

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  get subagentWatch(): SubagentWatch {
    return this.primaryContext.subagents;
  }
  private readonly contexts = new Map<string, ProviderContext>();
  private get primaryContext(): ProviderContext {
    return this.contexts.values().next().value!;
  }
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};
  private readonly reconcilingChildren = new Set<number>();
  private readonly resetChildren = new Set<number>();
  private readonly dismissedCopilotChildren = new WeakMap<AgentState, Set<string>>();
  private readonly reconcileRecoveredChildren = (message: Record<string, unknown>): void => {
    if (message.type === 'agentToolsClear' && typeof message.id === 'number') {
      if (this.store.get(message.id)?.providerId === 'copilot') this.resetChildren.add(message.id);
      return;
    }
    if (
      typeof message.id === 'number' &&
      (message.type === 'agentObservation' || message.type === 'agentStatus')
    )
      this.reconcileCopilotChildren(message.id);
  };

  constructor(
    private readonly store: AgentStateStore,
    providers: HookProvider | readonly HookProvider[],
  ) {
    for (const provider of Array.isArray(providers) ? providers : [providers as HookProvider]) {
      if (this.contexts.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
      this.initializeProvider(provider);
    }
    if (!this.contexts.size) throw new Error('At least one provider is required');
    this.store.setActiveProviders([...this.contexts.keys()]);
    this.store.on('broadcast', this.reconcileRecoveredChildren);
  }

  private initializeProvider(provider: HookProvider): void {
    const parser = createTranscriptParser();
    const watcher = createFileWatcherContext(parser);
    const {
      setHookProvider,
      setBackgroundAgentDetectedCallback,
      setBackgroundAgentCompletedCallback,
      setTeamSwitchCallback,
    } = parser;
    const {
      setDismissalTracker,
      setSubagentWatch,
      setTeamProvider,
      setAgentRemovalCallback,
      setTeammateRemovalCallback,
      setTeammateRegisterCallback,
      scanForBackgroundAgentFiles,
      scanForTeammateFiles,
      isTrackedProjectDir,
      adoptExternalSessionFromHook,
      reassignAgentToFile,
    } = watcher;
    const first = this.contexts.size === 0;
    const context: ProviderContext = {
      provider,
      watcher,
      parser,
      handler: new HookEventHandler(
        this.store,
        this.waitingTimers,
        this.permissionTimers,
        provider,
        new SessionRouter(provider.id),
        this.watchAllSessions,
        parser.notifyBackgroundAgentCompleted,
      ),
      subagents: new SubagentWatch(this.store, watcher),
      knownFiles: first ? this.knownJsonlFiles : new PathSet(),
      dismissals: first ? this.dismissalTracker : new DismissalTracker(),
      projectTimer: first ? this.projectScanTimer : { current: null },
      externalTimer: null,
      staleTimer: null,
      hooksEnabled: first ? this.hooksEnabled : { current: true },
    };
    this.contexts.set(provider.id, context);
    setDismissalTracker(context.dismissals);
    setHookProvider(provider);
    watcher.setHookProvider(provider);
    if (provider.id === 'copilot') {
      parser.setCopilotRecordOptions(
        (id, record) => this.getCopilotRecordOptions(id, record),
        (id) => this.reconcileCopilotChildren(id),
      );
      context.handler.setEventConsumer((normalized, agent, raw) => {
        if (normalized.event.kind === 'sessionStart') return false;
        for (const record of hookToCopilotRecords(raw)) {
          processCopilotRecord(
            agent.id,
            record,
            agent,
            this.store,
            this.waitingTimers,
            this.permissionTimers,
            this.getCopilotRecordOptions(agent.id, record, { source: 'hook' }),
          );
        }
        this.reconcileCopilotChildren(agent.id);
        return true;
      });
    }
    setSubagentWatch(context.subagents);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) =>
      this.registerAgent(sessionId, agentId, provider.id),
    );
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      context.subagents.removeBySpawn(leadId, toolUseId);
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    // Wire hook lifecycle callbacks to shared agent operations
    context.handler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (
                (lead.providerId ?? 'claude') !== provider.id ||
                lead.teamName !== teamMeta.teamName ||
                lead.leadAgentId !== undefined
              )
                continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        const workspaceMatches = this.workspacePaths.some((workspace) =>
          pathsMatch(workspace, cwd),
        );
        if (
          !isTrackedProjectDir(projectDir) &&
          !workspaceMatches &&
          !this.watchAllSessions.current
        ) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          context.knownFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id, provider.id),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          context.knownFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId, provider.id);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id, provider.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        context.dismissals.clearDismissal(transcriptPath);
        context.dismissals.clearSeededMtime(transcriptPath);
        context.knownFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        this.handleSessionEndCleanup(agentId);
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  getProvider(id: string): HookProvider | undefined {
    return this.contexts.get(id)?.provider;
  }
  getProviders(): HookProvider[] {
    return [...this.contexts.values()].map((c) => c.provider);
  }
  get providers(): readonly HookProvider[] {
    return this.getProviders();
  }
  setHookEventConsumer(providerId: string, consumer: HookEventConsumer): void {
    this.contextFor(providerId).handler.setEventConsumer(consumer);
  }
  setHooksEnabled(providerId: string, enabled: boolean): void {
    this.contextFor(providerId).hooksEnabled.current = enabled;
  }
  dismissAgent(id: number): void {
    const agent = this.store.get(id);
    if (
      agent?.providerId === 'copilot' &&
      agent.spawnToolUseId &&
      agent.leadAgentId !== undefined
    ) {
      const lead = this.store.get(agent.leadAgentId);
      if (lead) {
        let dismissed = this.dismissedCopilotChildren.get(lead);
        if (!dismissed) this.dismissedCopilotChildren.set(lead, (dismissed = new Set()));
        dismissed.add(agent.spawnToolUseId);
      }
    }
    if (agent?.jsonlFile) this.contextFor(agent.providerId).dismissals.dismiss(agent.jsonlFile);
  }

  getFileWatcher(providerId?: string): FileWatcherContext {
    return this.contextFor(providerId).watcher;
  }
  getKnownJsonlFiles(providerId?: string): Set<string> {
    return this.contextFor(providerId).knownFiles;
  }
  getDismissalTracker(providerId?: string): DismissalTracker {
    return this.contextFor(providerId).dismissals;
  }

  setTerminalAdapter(adapter: ITerminalAdapter): void {
    for (const context of this.contexts.values()) context.watcher.setTerminalAdapter(adapter);
  }

  setFolderNameResolver(resolver: FolderNameResolver): void {
    for (const context of this.contexts.values()) context.watcher.setFolderNameResolver(resolver);
  }

  private contextFor(providerId?: string): ProviderContext {
    const context = providerId ? this.contexts.get(providerId) : this.primaryContext;
    if (!context) throw new Error(`Unregistered provider: ${providerId}`);
    return context;
  }

  /** SessionEnd cleanup for hook-driven providers (Claude's SessionEnd hook,
   *  reason=exit/logout). Despawns the agent instead of leaving a finished
   *  session sitting in the office.
   *
   *  NOTE: file-fallback providers (Copilot) do NOT have an equivalent path --
   *  Copilot's transcript "hook.start"/hookType:"sessionEnd" record looked
   *  like a terminal signal but isn't: it fires at the end of every
   *  turn/task, including many times over a single still-running session.
   *  Wiring it here despawned live, busy sessions. Copilot-adopted agents
   *  rely solely on the stale-file check (fileWatcher's
   *  startStaleExternalAgentCheck), which only despawns once the JSONL file
   *  is actually deleted from disk. */
  private handleSessionEndCleanup(agentId: number): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    const context = this.contextFor(agent.providerId);
    context.dismissals.clearSeededMtime(agent.jsonlFile);
    context.dismissals.dismiss(agent.jsonlFile);
    // Covers real team leads AND leads of background teammates (which
    // have children but no teamName). No-op when childless.
    this.removeTeammates(agentId);
    // Unnamed background spawns die with their lead's session too.
    context.subagents.removeByLead(agentId);
    if (agent.isExternal) {
      this.unregisterAgent(agent.sessionId, agent.providerId);
      this.removeAgent(agentId);
    }
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.contexts.get(providerId)?.handler.handleEvent(providerId, event);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number, providerId?: string): void {
    const agent = this.store.get(agentId);
    const context = this.contextFor(providerId ?? agent?.providerId);
    if (agent) agent.providerId = context.provider.id;
    context.handler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string, providerId?: string): void {
    this.contextFor(providerId).handler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.resetChildren.delete(id);
    if (agent.providerId === 'copilot' && !agent.spawnToolUseId) this.removeTeammates(id);
    if (!agent.spawnToolUseId) this.unregisterAgent(agent.sessionId, agent.providerId);
    this.contextFor(agent.providerId).subagents.removeByLead(id);

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Options shared by transcript parsing and a host's hook-to-record consumer. */
  getCopilotRecordOptions(
    leadId: number,
    record: Record<string, unknown>,
    observationOptions: Pick<CopilotRecordOptions, 'source' | 'generation'> = {},
  ): CopilotRecordOptions {
    const lead = this.store.get(leadId);
    if (lead?.providerId !== 'copilot') return {};
    const data =
      record.data && typeof record.data === 'object'
        ? (record.data as Record<string, unknown>)
        : {};
    const background =
      (record.type === 'subagent.started' && data.executionMode === 'background') ||
      getCopilotSnapshot(lead).children.some(
        (child) => child.background && child.parentToolId === data.toolCallId,
      );
    return {
      ...observationOptions,
      // A task name alone cannot suppress the Subtask: wait for background
      // lifetime evidence, including late enrichment of an already-started child.
      ...(background
        ? {
            onChild: (child: CopilotChild & { kind: 'started' | 'completed' }) => {
              if (!child.background || !child.name) return;
              if (child.kind === 'started') this.ensureCopilotTeammate(lead, child, false);
              else {
                const teammate = this.findCopilotTeammate(leadId, child.parentToolId);
                if (teammate) this.removeTeammate(teammate.id, 'copilot-child-complete');
              }
            },
          }
        : {}),
      onChildRecord: (child, childRecord) => {
        if (!child.background || !child.name) return false;
        if (this.dismissedCopilotChildren.get(lead)?.has(child.parentToolId)) return true;
        const teammate = this.ensureCopilotTeammate(lead, child, false);
        const data = childRecord.data;
        if (!teammate || !data || typeof data !== 'object' || Array.isArray(data)) return false;
        const localData: Record<string, unknown> = { ...data };
        const localRecord: Record<string, unknown> = { ...childRecord, data: localData };
        delete localRecord.agentId;
        delete localData.parentToolCallId;
        processCopilotRecord(
          teammate.id,
          localRecord,
          teammate,
          this.store,
          this.waitingTimers,
          this.permissionTimers,
          observationOptions,
        );
        return true;
      },
    };
  }

  private findCopilotTeammate(leadId: number, toolId: string): AgentState | undefined {
    return [...this.store.values()].find(
      (agent) =>
        agent.providerId === 'copilot' &&
        agent.leadAgentId === leadId &&
        agent.spawnToolUseId === toolId,
    );
  }

  private ensureCopilotTeammate(
    lead: AgentState,
    child: CopilotChild,
    replay: boolean,
  ): AgentState | undefined {
    if (!child.background || !child.name || this.store.get(lead.id) !== lead) return;
    if (this.dismissedCopilotChildren.get(lead)?.has(child.parentToolId)) return;
    const existing = this.findCopilotTeammate(lead.id, child.parentToolId);
    if (existing) return existing;
    const teammate: AgentState = {
      id: this.store.nextAgentId.current++,
      providerId: lead.providerId,
      sessionId: lead.sessionId,
      isExternal: lead.isExternal,
      projectDir: lead.projectDir,
      folderName: lead.folderName,
      sessionName: lead.sessionName,
      jsonlFile: '',
      hooksOnly: true,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: lead.lastDataAt,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: lead.hookDelivered,
      contextTokens: 0,
      maxContextTokens: 0,
      observation: replay ? 'unknown' : 'known',
      agentName: child.name,
      leadAgentId: lead.id,
      spawnToolUseId: child.parentToolId,
    };
    assignPaletteIfNeeded(teammate, this.store);
    this.store.set(teammate.id, teammate);
    lead.isTeamLead = true;
    lead.teammateSpawnToolIds ??= new Set();
    lead.teammateSpawnToolIds.add(child.parentToolId);
    this.store.broadcast({ type: 'agentTeamInfo', id: lead.id, isTeamLead: true });
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: teammate.id,
      agentName: child.name,
      leadAgentId: lead.id,
    });
    this.store.broadcast({ type: 'subagentClear', id: lead.id, parentToolId: child.parentToolId });
    // Hydrate current tool identities and move pending requests to their new
    // owner; never replay historical child completions.
    for (const toolId of lead.activeSubagentToolIds.get(child.parentToolId) ?? []) {
      const toolName = lead.activeSubagentToolNames.get(child.parentToolId)?.get(toolId);
      if (!toolName) continue;
      processCopilotRecord(
        teammate.id,
        { type: 'tool.execution_start', data: { toolCallId: toolId, toolName } },
        teammate,
        this.store,
        this.waitingTimers,
        this.permissionTimers,
        { replay: true },
      );
    }
    promoteCopilotChildRequests(lead, teammate, child, (message) =>
      this.store.broadcast({ ...message, ...(replay ? { replay: true } : {}) }),
    );
    if (replay && lead.observation === 'unknown') teammate.observation = 'unknown';
    resendAgentActivity((message) => this.store.broadcast(message), this.store, teammate.id);
    if (!replay) this.store.persist();
    return teammate;
  }

  private reconcileCopilotChildren(leadId: number): void {
    const lead = this.store.get(leadId);
    if (
      lead?.providerId !== 'copilot' ||
      lead.spawnToolUseId ||
      this.reconcilingChildren.has(leadId)
    )
      return;
    this.reconcilingChildren.add(leadId);
    try {
      const children = getCopilotSnapshot(lead).children.filter(
        (child) => child.name && child.background,
      );
      const reset = this.resetChildren.delete(leadId);
      if (reset) this.dismissedCopilotChildren.delete(lead);
      for (const agent of [...this.store.values()]) {
        if (
          agent.providerId === 'copilot' &&
          agent.leadAgentId === leadId &&
          agent.spawnToolUseId &&
          (reset || !children.some((child) => child.parentToolId === agent.spawnToolUseId))
        ) {
          this.removeTeammate(agent.id, 'copilot-child-reconcile');
        }
      }
      for (const child of children) this.ensureCopilotTeammate(lead, child, true);
      const dismissed = this.dismissedCopilotChildren.get(lead);
      if (dismissed) {
        for (const toolId of dismissed) {
          if (!children.some((child) => child.parentToolId === toolId)) dismissed.delete(toolId);
        }
      }
      if (!lead.teamName) this.demoteLeadIfTeamEmpty(leadId, false);
    } finally {
      this.reconcilingChildren.delete(leadId);
    }
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    if (agent.jsonlFile) this.contextFor(agent.providerId).dismissals.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId, agent.providerId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number, persist = true): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    if (persist) this.store.persist();
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        if (agent.jsonlFile) this.contextFor(agent.providerId).dismissals.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId, agent.providerId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(
    projectDir: string,
    onAgentCreated?: (agent: AgentState) => void,
    providerId?: string,
  ): void {
    const context = this.contextFor(providerId);
    context.watcher.ensureProjectScan(
      projectDir,
      context.knownFiles,
      context.projectTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ??
        ((agent) => this.registerAgent(agent.sessionId, agent.id, context.provider.id)),
      context.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string, providerId?: string): void {
    const context = this.contextFor(providerId);
    if (context.externalTimer) return;

    context.externalTimer = context.watcher.startExternalSessionScanning(
      projectDir,
      context.knownFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      context.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    for (const context of this.contexts.values()) {
      if (context.staleTimer) continue;
      context.staleTimer = context.watcher.startStaleExternalAgentCheck(
        this.store,
        context.knownFiles,
        context.hooksEnabled,
      );
    }
  }

  /** Re-enumerate roots, including providers with no session directories at startup. */
  startDiscovery(workspacePaths: readonly string[]): void {
    this.workspacePaths = [...workspacePaths];
    const scan = () => {
      for (const context of this.contexts.values()) {
        const directories: string[] = [];
        for (const workspace of this.workspacePaths) {
          for (const dir of context.provider.getSessionDirs?.(workspace) ?? []) {
            directories.push(dir);
          }
        }
        context.watcher.beginDiscovery(directories);
        for (const dir of directories) {
          if (!context.watcher.isTrackedProjectDir(dir)) {
            this.startProjectScan(dir, undefined, context.provider.id);
          }
        }
        context.watcher.retainProjectDirs(directories);
        this.startExternalScanning('', context.provider.id);
      }
    };
    scan();
    if (!this.discoveryTimer) this.discoveryTimer = setInterval(scan, EXTERNAL_SCAN_INTERVAL_MS);
    this.startStaleCheck();
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents().map(migrateAgentIdentity);
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      const context = p.providerId ? this.contexts.get(p.providerId) : undefined;
      if (!context) continue;
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      if (this.store.has(p.id)) {
        context.knownFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        providerId: context.provider.id,
        observation: context.provider.recoverTranscript ? 'unknown' : 'known',
        sessionId:
          context.provider.resolveSessionId?.(p.jsonlFile) ??
          p.sessionId ??
          path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        hooksOnly: !p.jsonlFile,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches.
        backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: context.provider.resolveSessionFolderName?.(p.projectDir) ?? p.folderName,
        sessionName: p.sessionName,
        hookDelivered: false,
        contextTokens: 0,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
      };

      if (!agent.hooksOnly) {
        context.watcher.recoverAgent(agent, this.store, this.waitingTimers, this.permissionTimers);
      }
      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      context.knownFiles.add(p.jsonlFile);

      try {
        if (!agent.hooksOnly)
          context.watcher.startFileWatching(
            p.id,
            p.jsonlFile,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
          );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);
      resendAgentActivity((message) => this.store.broadcast(message), this.store, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.store.off('broadcast', this.reconcileRecoveredChildren);
    this.resetChildren.clear();
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    for (const context of this.contexts.values()) {
      context.handler.dispose();
      context.subagents.dispose();
      context.parser.dispose();
      if (context.projectTimer.current) clearInterval(context.projectTimer.current);
      context.projectTimer.current = null;
      if (context.externalTimer) clearInterval(context.externalTimer);
      if (context.staleTimer) clearInterval(context.staleTimer);
      context.externalTimer = null;
      context.staleTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      if (this.contexts.has(this.store.get(id)?.providerId ?? 'claude')) this.removeAgent(id);
    }
  }
}
