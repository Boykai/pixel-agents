/**
 * Provider abstraction for AI agent tools.
 *
 * Providers own source formats, session identity and evidence-based capabilities.
 * Runtime contexts isolate each provider's discovery, parser and lifecycle state.
 */

import type { TeamProvider } from './teamProvider.js';

export interface ObservationCapabilities {
  hooks?: boolean;
  discovery?: boolean;
  permissionRequests?: boolean;
  userInput?: boolean;
  contextUsage?: boolean;
  subagents?: boolean;
  teams?: boolean;
  sessionEnd?: boolean;
}

export interface SessionCandidate {
  transcriptPath: string;
  previousSize: number | undefined;
  size: number;
  mtimeMs: number;
  now: number;
}

/** Bounded recovery is observational: it must never replay notifications or hooks. */
export interface TranscriptSnapshot {
  observation: 'known' | 'unknown';
  status?: 'active' | 'waiting' | 'idle';
  contextTokens?: number;
  maxContextTokens?: number;
}

/** Missing source metadata must never be replaced with fabricated causal ordering. */
export interface NormalizedAgentEvent {
  sessionId: string;
  event: AgentEvent;
  source?: 'hook' | 'transcript' | 'bridge';
  eventId?: string;
  generation?: string;
  timestamp?: number;
}

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | { kind: 'turnStart' }
  /** Provider-owned evidence consumed without inferring a lifecycle transition. */
  | { kind: 'observation' }
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      /** True when the tool was spawned to run in the background (e.g. Claude's
       *  `run_in_background` on Agent/Task). Handlers use this to suppress ghost
       *  sub-agent characters for teammate spawns. */
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Claude's Notification(idle_prompt)) rather than simply finishing
       *  its response (Stop). Drives the "Waiting for input" vs "Done" label.
       *  Absent/false = the agent finished its turn (Done). */
      awaitingInput?: boolean;
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      /** 'idle' = subagent is idle and ready for more work; 'completed' = subagent
       *  reported its task done. Some providers emit only one; both route to the
       *  same handler but with different downstream cleanup. */
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      /** For external-session adoption: path to the session's transcript file
       *  (if the provider uses one). Undefined for providers without transcripts. */
      transcriptPath?: string;
      /** Working directory the session was started in. Used to match pending
       *  external sessions against known workspace folders. */
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

/** One Token usage observation read from a single transcript record. An
 *  omitted numeric field means "this record says nothing about it", never zero.
 *
 *  - `delta` adds to the agent's running totals. `messageId` makes a repeated
 *    record idempotent (Claude writes one record per content block, each
 *    repeating its message's usage). A delta carrying only `model` just names
 *    the model in use.
 *  - `total` is a cumulative whole-session snapshot and REPLACES every usage
 *    field; fields it omits become unknown.
 *
 *  A provider reports each numeric field one way, either as deltas or as totals. */
export interface TokenUsageSample {
  kind: 'delta' | 'total';
  messageId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Billing units the CLI itself reports (GitHub Copilot); may be fractional. */
  premiumRequests?: number;
  nanoAiu?: number;
}

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): NormalizedAgentEvent | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline titles the ask, the disclosure is its body
   *  (what is written, what data moves, how to undo; paragraphs split on blank lines). Required, not optional — a
   *  provider that installs anything must state its terms, and the gate ships these verbatim so no client copy can
   *  drift. */
  consentDisclosure(): { headline: string; disclosure: string };

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" character animation instead of "typing".
   *  The provider classifies tools as read-like or write-like; the webview renders
   *  the animation. Allows new providers to override without webview edits. */
  readonly readingTools: ReadonlySet<string>;
  /** Terminal name prefix used when launching this CLI. Used by the extension to
   *  match VS Code terminals to agents for heuristic adoption. */
  readonly terminalNamePrefix?: string;

  /** Context window, in tokens, for a model id this CLI reports in its
   *  transcripts. Transcripts state token usage but never the limit it counts
   *  against, so only the provider can say — and getting it wrong is visible:
   *  the office renders usage/window as a context gauge over every character.
   *  Return undefined for an unrecognized model; the runtime then keeps its
   *  previous estimate and widens it if a context ever exceeds it. */
  contextWindowForModel?(model: string | undefined): number | undefined;

  /** Token usage stated by one already-parsed transcript record, or undefined
   *  when the record states none. Report only what the CLI wrote — never an
   *  estimate. The runtime owns accumulation, dedupe, seeding and broadcast;
   *  the provider owns only the record shape. Unset = no Token usage. */
  extractTokenUsage?(record: unknown): TokenUsageSample | undefined;

  // ── Optional file fallback (heuristic mode) ──

  readonly capabilities?: ObservationCapabilities;
  /** Session identity need not be the transcript's basename. */
  resolveSessionId?(transcriptPath: string): string | undefined;
  /** Expected transcript location. Reject session IDs that cannot safely form a path. */
  getSessionFile?(sessionId: string, cwd: string): string | undefined;
  /** Authoritative workspace identity for a provider's session directory, when available. */
  getSessionCwd?(projectDir: string): string | undefined;
  /** Enumeration is not evidence of liveness. Called with the last scan's size. */
  isSessionCandidate?(candidate: SessionCandidate): boolean;
  /** Complete is false when the bounded tail omits earlier records. */
  recoverTranscript?(lines: readonly string[], complete: boolean): TranscriptSnapshot;

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started
   *  (across all workspaces). Used by global session discovery / "Watch All
   *  Sessions". Each returned dir contains subdirs whose entries are session
   *  transcript files. Undefined = this provider doesn't support global scan. */
  getAllSessionRoots?(): string[];
  /** Resolve a per-workspace session directory (as returned within
   *  getAllSessionRoots()'s roots) to a human-readable label for the office UI
   *  (the "folder name" shown under an external agent's sprite). Only needed
   *  when the directory name itself isn't already meaningful — e.g. Claude's
   *  project dirs are the workspace path with separators replaced by `-`, so
   *  its basename already decodes to a readable name and this can stay
   *  unset; Copilot's session dirs are opaque UUIDs, so it implements this by
   *  reading the session's own cwd. Undefined = fall back to decoding the
   *  directory's basename (folderNameFromProjectDir). */
  resolveSessionFolderName?(dirPath: string): string | undefined;
  /** Resolve a per-workspace session directory to a human-readable session
   *  title, shown as a second label distinct from the folder/project name.
   *  Providers whose CLI has no concept of a named session (Claude: each
   *  session IS the project, no separate title) leave this unset. Copilot
   *  implements this by reading the session's own task description / user-
   *  given name. Undefined = no session-title label is shown. */
  resolveSessionName?(dirPath: string): string | undefined;
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Exact transcript path for a newly allocated session, before its directory exists. */
  expectedTranscriptPath?(sessionId: string, cwd: string): string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider
