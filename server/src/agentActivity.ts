import type { AgentState } from './types.js';

/**
 * Agent activity: what an Agent actually did, reported once where its source is
 * parsed (hook events, transcript records, the Copilot reducer). Internal to the
 * server and never sent to clients.
 *
 * Features that count activity (Achievements) subscribe here and never to
 * `store.broadcast`. Broadcasts are replayed on every client connect, adoption
 * and turn end (`resendAgentActivity`), so counting them would count the same
 * work again and again.
 */
export type AgentActivity =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      /** The tool's own input, as the CLI wrote it. */
      input: unknown;
      /** Run by one of the agent's Sub-agents rather than the agent itself. */
      subagent?: boolean;
    }
  /** The user started an interaction (a prompt). */
  | { kind: 'interactionStart' }
  /** The agent finished its interaction and is Done: waiting for the user's next prompt. */
  | { kind: 'interactionEnd' }
  | { kind: 'toolFailure'; toolId: string; subagent?: boolean };

export type AgentActivityEvent = AgentActivity & {
  agentId: number;
  providerId: string;
  /** The agent's session directory, for resolving relative paths in tool input. */
  projectDir?: string;
  /** When the server observed it. */
  at: number;
  /** When the source says it happened (the record's own timestamp), if it says. */
  recordedAt?: number;
};

type Listener = (event: AgentActivityEvent) => void;

interface Liveness {
  /** The transcript the watermark belongs to. */
  file: string | undefined;
  /** Transcript bytes before this offset were written before tracking began. */
  liveFrom: number;
  /** The reader is processing records from before `liveFrom`. */
  replaying: boolean;
}

/** A record timestamp (ISO string or epoch ms) as epoch ms, if valid. */
export function recordTime(value: unknown): number | undefined {
  const ms =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The activity feed of one AgentStateStore, plus the liveness it needs: a
 * transcript is sometimes read from its start although it already holds history
 * (a resumed session, a teammate discovered late, a re-materialized Sub-agent
 * watch). Those records are replayed, not new, and must not be reported.
 *
 * Liveness is a byte watermark per agent, the notion Token usage already uses:
 * the file watcher marks where live data starts when it begins tracking a file
 * (`markLiveFrom`), and says where each record it parses ends (`reading`), so a
 * record is judged on its own bytes rather than on the chunk that carried it.
 * Hook events and timers are live by construction and use `live`.
 */
export class AgentActivityFeed {
  private readonly listeners = new Set<Listener>();
  private readonly liveness = new Map<number, Liveness>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tracking of the agent's transcript (re)starts: bytes before `liveFrom` are history. */
  markLiveFrom(agentId: number, liveFrom: number, file?: string): void {
    this.liveness.set(agentId, { file, liveFrom, replaying: false });
  }

  /** Where live data starts in `file`, once tracking of that file has begun. */
  liveFromIn(agentId: number, file: string): number | undefined {
    const entry = this.liveness.get(agentId);
    return entry && entry.file === file ? entry.liveFrom : undefined;
  }

  /** The transcript reader is about to parse the record whose bytes end at
   *  `recordEnd` (exclusive). A record complete before tracking began is history. */
  reading(agentId: number, recordEnd: number): void {
    const entry = this.liveness.get(agentId);
    if (entry) entry.replaying = recordEnd <= entry.liveFrom;
  }

  /** Whether the record being parsed for `agent` is replayed history. An agent
   *  without a transcript of its own (a Copilot teammate promoted from its
   *  lead's records) is fed from its lead's transcript and judged by its reader. */
  isReplaying(agent: AgentState): boolean {
    const entry =
      this.liveness.get(agent.id) ??
      (!agent.jsonlFile && agent.leadAgentId !== undefined
        ? this.liveness.get(agent.leadAgentId)
        : undefined);
    return entry?.replaying ?? false;
  }

  /** Report activity parsed from a transcript record. Dropped while replaying. */
  transcript(agent: AgentState, activity: AgentActivity, recordedAt?: unknown): void {
    if (this.isReplaying(agent)) return;
    this.emit(agent, activity, recordedAt);
  }

  /** Report activity from a source that is always live (hook events, timers). */
  live(agent: AgentState, activity: AgentActivity, recordedAt?: unknown): void {
    this.emit(agent, activity, recordedAt);
  }

  forget(agentId: number): void {
    this.liveness.delete(agentId);
  }

  /** Drop all liveness (the store was cleared). Subscribers stay. */
  clear(): void {
    this.liveness.clear();
  }

  dispose(): void {
    this.liveness.clear();
    this.listeners.clear();
  }

  private emit(agent: AgentState, activity: AgentActivity, recordedAt: unknown): void {
    if (this.listeners.size === 0) return;
    const event: AgentActivityEvent = {
      ...activity,
      agentId: agent.id,
      providerId: agent.providerId ?? 'claude',
      projectDir: agent.projectDir,
      at: this.now(),
    };
    const recorded = recordTime(recordedAt);
    if (recorded !== undefined) event.recordedAt = recorded;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[Pixel Agents] Agent activity listener failed:', error);
      }
    }
  }
}
