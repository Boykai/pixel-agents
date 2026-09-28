import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeNickname } from '../../core/src/normalizeNickname.js';
import type { NicknameProfile } from '../../core/src/schemas.js';
import {
  findNicknameProfile,
  nicknameSessionKey,
  rememberNicknameProfile,
  rememberSessionNickname,
} from './nicknames.js';
import type { AgentState, PersistedAgent } from './types.js';

/**
 * CI / e2e diagnostics: when PIXEL_AGENTS_DEBUG_LOG points to a writable
 * path, every broadcast is appended there with a timestamp. The test fixture
 * attaches the resulting file to Allure so failures can be analyzed without
 * local repro. Zero cost when the env var is unset.
 */
const DEBUG_LOG_PATH = process.env['PIXEL_AGENTS_DEBUG_LOG'];

function debugLogBroadcast(message: Record<string, unknown>): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    const t = message.type as string;
    const id = message.id;
    const extras: string[] = [];
    if (id !== undefined) extras.push(`id=${id}`);
    if ('toolName' in message) extras.push(`toolName=${message.toolName}`);
    if ('status' in message) extras.push(`status=${message.status}`);
    if ('parentToolId' in message) extras.push(`parentToolId=${message.parentToolId}`);
    if ('toolId' in message) extras.push(`toolId=${message.toolId}`);
    appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} BCAST ${t} ${extras.join(' ')}\n`);
  } catch {
    /* never crash on diagnostic failure */
  }
}

/** Typed event map for AgentStateStore. */
export interface StoreEvents {
  agentAdded: (id: number, agent: AgentState) => void;
  agentRemoved: (id: number) => void;
  agentUpdated: (id: number, agent: AgentState, field: string) => void;
  broadcast: (message: Record<string, unknown>) => void;
}

/**
 * Centralized owner of the agents Map. Wraps a private Map<number, AgentState>
 * and exposes Map-compatible read/write methods. Emits typed events on
 * set()/delete() for reactive state changes.
 */
export class AgentStateStore {
  private readonly agents = new Map<number, AgentState>();
  private readonly emitter = new EventEmitter();
  readonly nextAgentId = { current: 1 };
  readonly nextTerminalIndex = { current: 1 };
  private adapter: StateAdapter | undefined;
  private activeProviders: readonly string[] | undefined;

  // ── Adapter ──────────────────────────────────────────────────

  setAdapter(adapter: StateAdapter): void {
    this.adapter = adapter;
    this.configureProviderScope();
  }

  setActiveProviders(providerIds: readonly string[]): void {
    this.activeProviders = [...providerIds];
    this.configureProviderScope();
  }

  private configureProviderScope(): void {
    if (!this.adapter || !this.activeProviders) return;
    this.adapter.setActiveProviders?.(this.activeProviders);
    // Hidden providers still own their persisted IDs and seats.
    for (const agent of this.adapter.loadAgents()) {
      this.nextAgentId.current = Math.max(this.nextAgentId.current, agent.id + 1);
    }
  }

  getAdapter(): StateAdapter | undefined {
    return this.adapter;
  }

  // ── Map-compatible read ──────────────────────────────────────

  get(id: number): AgentState | undefined {
    return this.agents.get(id);
  }

  has(id: number): boolean {
    return this.agents.has(id);
  }

  get size(): number {
    return this.agents.size;
  }

  keys(): MapIterator<number> {
    return this.agents.keys();
  }

  values(): MapIterator<AgentState> {
    return this.agents.values();
  }

  entries(): MapIterator<[number, AgentState]> {
    return this.agents.entries();
  }

  forEach(
    cb: (agent: AgentState, id: number, map: Map<number, AgentState>) => void,
    thisArg?: unknown,
  ): void {
    this.agents.forEach(cb, thisArg);
  }

  [Symbol.iterator](): MapIterator<[number, AgentState]> {
    return this.agents[Symbol.iterator]();
  }

  // ── Event subscription ───────────────────────────────────────

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Map-compatible write (emits events) ─────────────────────

  set(id: number, agent: AgentState): this {
    const isNew = !this.agents.has(id);
    this.agents.set(id, agent);
    if (isNew) {
      // Before agentAdded, so agentCreated already carries a remembered nickname.
      this.recordNickname(agent);
      this.emitter.emit('agentAdded', id, agent);
    }
    return this;
  }

  delete(id: number): boolean {
    const existed = this.agents.delete(id);
    if (existed) {
      this.emitter.emit('agentRemoved', id);
    }
    return existed;
  }

  clear(): void {
    this.agents.clear();
  }

  updateMetadata(id: number, metadata: Pick<AgentState, 'sessionName' | 'folderName'>): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    const changes: Pick<AgentState, 'sessionName' | 'folderName'> = {};
    for (const key of ['sessionName', 'folderName'] as const) {
      const value = metadata[key];
      if (value !== undefined && value !== agent[key]) {
        agent[key] = value;
        changes[key] = value;
      }
    }
    if (Object.keys(changes).length === 0) return;
    this.emitter.emit('agentUpdated', id, agent, 'metadata');
    this.broadcast({ type: 'agentMetadata', id, ...changes });
    this.persist();
  }

  // ── Nicknames + appearance ──────────────────────────────────

  /**
   * Rename an agent ('' clears). The nickname is remembered for the agent's session
   * (so re-adopting it restores the name) and takes the agent's current look and
   * saved seat as its profile (so a later agent launched under it looks the same).
   * Broadcasts the normalized result, even when unchanged, so every client converges.
   */
  setNickname(id: number, raw: unknown): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const nickname = normalizeNickname(raw);
    if ((agent.nickname ?? '') !== nickname) {
      if (nickname) agent.nickname = nickname;
      else delete agent.nickname;
      const adapter = this.adapter;
      if (adapter?.loadNicknameBook && adapter.saveNicknameBook) {
        const book = adapter.loadNicknameBook();
        const key = nicknameSessionKey(agent);
        let changed = key !== undefined && rememberSessionNickname(book, key, nickname);
        if (nickname) {
          changed =
            rememberNicknameProfile(book, {
              nickname,
              palette: agent.palette,
              hueShift: agent.hueShift,
              seatId: adapter.loadSeats()[String(id)]?.seatId,
            }) || changed;
        }
        if (changed) adapter.saveNicknameBook(book);
      }
      this.emitter.emit('agentUpdated', id, agent, 'nickname');
      this.persist();
    }
    this.broadcast({ type: 'agentMetadata', id, nickname });
    return true;
  }

  /**
   * Give an agent without a nickname the one remembered for its session, and return
   * the look and seat last used under its nickname (undefined when there is none).
   */
  recallNicknameProfile(agent: AgentState): NicknameProfile | undefined {
    const book = this.adapter?.loadNicknameBook?.();
    if (!book) return undefined;
    if (agent.nickname === undefined) {
      const key = nicknameSessionKey(agent);
      const remembered = key ? normalizeNickname(book.sessions[key]) : '';
      if (remembered) agent.nickname = remembered;
    }
    return agent.nickname ? findNicknameProfile(book, agent.nickname) : undefined;
  }

  /**
   * Re-record an agent's nickname after its session id changed (/clear, a teammate
   * moving to its own session), so re-adopting the new session still finds it. An
   * agent without one picks up the nickname remembered for the new session, and
   * every client hears about it.
   */
  rememberNickname(agent: AgentState): void {
    if (!this.recordNickname(agent)) return;
    this.broadcast({ type: 'agentMetadata', id: agent.id, nickname: agent.nickname ?? '' });
    this.persist();
  }

  /**
   * Record an agent's nickname under its CURRENT session identity (recalling it first
   * when the agent has none), and seed the nickname's profile from the agent's look
   * when there is none yet. Runs for every new agent. Returns whether it recalled.
   */
  private recordNickname(agent: AgentState): boolean {
    const adapter = this.adapter;
    if (!adapter?.loadNicknameBook || !adapter.saveNicknameBook) return false;
    const book = adapter.loadNicknameBook();
    const key = nicknameSessionKey(agent);
    let recalled = false;
    if (agent.nickname === undefined && key) {
      const remembered = normalizeNickname(book.sessions[key]);
      if (remembered) {
        agent.nickname = remembered;
        recalled = true;
      }
    }
    if (!agent.nickname) return false;
    let changed = key !== undefined && rememberSessionNickname(book, key, agent.nickname);
    if (!findNicknameProfile(book, agent.nickname)) {
      changed =
        rememberNicknameProfile(book, {
          nickname: agent.nickname,
          palette: agent.palette,
          hueShift: agent.hueShift,
        }) || changed;
    }
    if (changed) adapter.saveNicknameBook(book);
    return recalled;
  }

  /** Remember the look and seat each nicknamed agent has now, in one book write. */
  rememberNicknameLooks(looks: NicknameProfile[]): void {
    const adapter = this.adapter;
    if (looks.length === 0 || !adapter?.loadNicknameBook || !adapter.saveNicknameBook) return;
    const book = adapter.loadNicknameBook();
    let changed = false;
    for (const look of looks) changed = rememberNicknameProfile(book, look) || changed;
    if (changed) adapter.saveNicknameBook(book);
  }

  /**
   * Change an agent's appearance (its costume). Broadcasts `agentAppearance` so every
   * connected client updates live; the caller persists. Returns whether it changed.
   */
  setAppearance(id: number, palette: number, hueShift: number): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.palette === palette && (agent.hueShift ?? 0) === hueShift) return false;
    agent.palette = palette;
    agent.hueShift = hueShift;
    this.emitter.emit('agentUpdated', id, agent, 'appearance');
    this.broadcast({ type: 'agentAppearance', id, palette, hueShift });
    return true;
  }

  // ── Broadcast (replaces direct webview.postMessage in server/) ─

  broadcast(message: Record<string, unknown>): void {
    if (message.type === 'agentStatus' && typeof message.id === 'number') {
      const agent = this.agents.get(message.id);
      if (
        agent &&
        (message.status === 'active' ||
          message.status === 'waiting' ||
          message.status === 'unknown')
      ) {
        agent.awaitingInput = message.status === 'waiting' && message.awaitingInput === true;
        const observation = message.status === 'unknown' ? 'unknown' : 'known';
        if (agent.observation !== observation) {
          agent.observation = observation;
          this.emitter.emit('broadcast', { type: 'agentObservation', id: agent.id, observation });
        }
      }
    }
    debugLogBroadcast(message);
    this.emitter.emit('broadcast', message);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  dispose(): void {
    this.emitter.removeAllListeners();
  }

  // ── Persistence ─────────────────────────────────────────────

  persist(): void {
    if (!this.adapter) {
      return;
    }
    const persisted: PersistedAgent[] = [];
    for (const agent of this.agents.values()) {
      // Background-spawn children are derived state: the 1s scan re-materializes
      // them from sidecars after a restore. Persisting them would resurrect
      // immortal characters whose completion signal never comes.
      if (agent.spawnToolUseId) continue;
      persisted.push({
        id: agent.id,
        providerId: agent.providerId ?? 'claude',
        observation: agent.observation,
        sessionId: agent.sessionId,
        terminalName: agent.terminalRef?.name ?? '',
        isExternal: agent.isExternal || undefined,
        jsonlFile: agent.jsonlFile,
        projectDir: agent.projectDir,
        folderName: agent.folderName,
        sessionName: agent.sessionName,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
        backgroundAgentToolIds:
          agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        nickname: agent.nickname,
      });
    }
    this.adapter.saveAgents(persisted);
  }

  loadPersistedAgents(): PersistedAgent[] {
    return this.adapter?.loadAgents() ?? [];
  }
}
