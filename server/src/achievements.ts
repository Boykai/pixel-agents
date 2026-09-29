/**
 * Achievements: milestones counted from what Agents actually do, recorded
 * machine-wide in ~/.pixel-agents/achievements.json.
 *
 * Ported from hootbu/pixel-agents' achievementManager (d0843a9): the same
 * definitions (core/src/achievements.ts), progress clamped to the target, and
 * each unlock announced once. The counting is rebuilt for this architecture:
 *
 *  - Sources are the store's activity feed (agentActivity.ts: reported once,
 *    where each source is parsed, never from replayed history), `agentAdded`,
 *    live Token usage, and the layouts this process writes. Never broadcasts,
 *    which are replayed on every client connect.
 *  - Every server process on the machine (VS Code windows, the standalone CLI)
 *    shares the file and may watch the same session, so each write re-reads and
 *    merges, and the same work is not counted twice across processes.
 *    Set-like progress (edited files, placed furniture) keeps distinct keys.
 *    Plain counters keep one slot per surface, and progress is the largest
 *    slot: two surfaces watching one session count the same turns.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AchievementDefinition, AchievementId } from '../../core/src/achievements.js';
import { ACHIEVEMENTS } from '../../core/src/achievements.js';
import type { AchievementProgress, AchievementUnlocked } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentActivityEvent } from './agentActivity.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  ACHIEVEMENT_CWD_CACHE_MAX_ENTRIES,
  ACHIEVEMENT_NIGHT_OWL_HOUR,
  ACHIEVEMENTS_FILE_NAME,
  ACHIEVEMENTS_FILE_VERSION,
  ACHIEVEMENTS_SAVE_DEBOUNCE_MS,
  LAYOUT_FILE_DIR,
} from './constants.js';
import type { LayoutChangeOrigin } from './layoutPersistence.js';
import { onLayoutChange, readLayoutFromFile } from './layoutPersistence.js';
import { toPathKey } from './pathKey.js';
import type { LiveTokenUsage } from './tokenUsage.js';

/**
 * How an Achievement's progress is kept, and so how two writers merge:
 *  - counter: a count per surface slot; progress is the largest slot.
 *  - max: the highest value seen.
 *  - set: distinct keys, at most `target` of them.
 */
type ProgressKind = 'counter' | 'max' | 'set';

const PROGRESS_KIND: Record<AchievementId, ProgressKind> = {
  first_agent: 'max',
  team_player: 'max',
  token_millionaire: 'counter',
  night_owl: 'counter',
  bug_squasher: 'counter',
  architect: 'set',
  marathon: 'counter',
  decorator: 'set',
};

/** One Achievement as the file records it. */
interface StoredAchievement {
  unlocked?: boolean;
  /** Epoch ms. The earliest unlock wins a merge. */
  unlockedAt?: number;
  /** counter: the count of each surface slot. */
  slots?: Record<string, number>;
  /** max: the highest value seen. */
  max?: number;
  /** set: the distinct keys counted, in the order first recorded. */
  keys?: string[];
}

type StoredAchievements = Partial<Record<AchievementId, StoredAchievement>>;

interface StoredFile {
  achievements: StoredAchievements;
  /** Records of ids this build does not define, written back untouched. */
  unknown: Map<string, unknown>;
}

export interface AchievementTrackerOptions {
  /** This process's surface (`vscode` or `standalone`): the counter slot it writes. */
  namespace: string;
  /** Defaults to ~/.pixel-agents/achievements.json. */
  filePath?: string;
  /** Clock for unlock times. Activity times come from the store's clock. */
  now?: () => number;
  saveDelayMs?: number;
  /** The layout on disk when tracking starts, whose furniture is not new.
   *  Defaults to reading ~/.pixel-agents/layout.json. */
  readLayout?: () => Record<string, unknown> | null;
}

/** Where the Marathon latch of one agent stands. */
interface InteractionLatch {
  /** An interaction is in progress, started at `openedAt`. */
  open: boolean;
  openedAt: number;
  /** The last counted interaction ended here: starts at or before it belong to it. */
  closedAt: number;
  /** An end seen while no interaction was open. A start at or before it that
   *  arrives late (a transcript record read after the Stop hook of its turn)
   *  belongs to an interaction that has already ended. */
  unmatchedEndAt?: number;
}

const CORRUPT_SUFFIX = '.corrupt-';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

/** Keyed by names read from the file, so it must have no prototype. */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function definitionOf(id: AchievementId): AchievementDefinition {
  return ACHIEVEMENTS.find((definition) => definition.id === id)!;
}

/** A stored record, read leniently: invalid fields are dropped, values clamped. */
function parseStoredAchievement(value: unknown, target: number): StoredAchievement {
  const record: StoredAchievement = {};
  if (!isRecord(value)) return record;
  if (value.unlocked === true) {
    record.unlocked = true;
    if (isCount(value.unlockedAt) && value.unlockedAt > 0) record.unlockedAt = value.unlockedAt;
  }
  if (isRecord(value.slots)) {
    const slots = emptyRecord<number>();
    for (const [slot, count] of Object.entries(value.slots)) {
      if (isCount(count)) slots[slot] = Math.min(count, target);
    }
    if (Object.keys(slots).length) record.slots = slots;
  }
  if (isCount(value.max)) record.max = Math.min(value.max, target);
  if (Array.isArray(value.keys)) {
    const keys = [
      ...new Set(value.keys.filter((key): key is string => typeof key === 'string' && !!key)),
    ];
    if (keys.length) record.keys = keys.slice(0, target);
  }
  return record;
}

/** Two views of one Achievement merged: every field only ever grows. */
function mergeStoredAchievement(
  a: StoredAchievement | undefined,
  b: StoredAchievement | undefined,
  target: number,
): StoredAchievement {
  const merged: StoredAchievement = {};
  if (a?.unlocked || b?.unlocked) {
    merged.unlocked = true;
    const times = [a?.unlocked ? a.unlockedAt : undefined, b?.unlocked ? b.unlockedAt : undefined];
    const known = times.filter((time): time is number => time !== undefined);
    if (known.length) merged.unlockedAt = Math.min(...known);
  }
  if (a?.slots || b?.slots) {
    const slots = emptyRecord<number>();
    for (const source of [a?.slots, b?.slots]) {
      for (const [slot, count] of Object.entries(source ?? {})) {
        slots[slot] = Math.min(target, Math.max(slots[slot] ?? 0, count));
      }
    }
    merged.slots = slots;
  }
  if (a?.max !== undefined || b?.max !== undefined) {
    merged.max = Math.min(target, Math.max(a?.max ?? 0, b?.max ?? 0));
  }
  if (a?.keys || b?.keys) {
    merged.keys = [...new Set([...(a?.keys ?? []), ...(b?.keys ?? [])])].slice(0, target);
  }
  return merged;
}

function mergeAll(a: StoredAchievements, b: StoredAchievements): StoredAchievements {
  const merged: StoredAchievements = {};
  for (const definition of ACHIEVEMENTS) {
    const left = a[definition.id];
    const right = b[definition.id];
    if (left || right) {
      merged[definition.id] = mergeStoredAchievement(left, right, definition.target);
    }
  }
  return merged;
}

function progressValue(definition: AchievementDefinition, record: StoredAchievement): number {
  switch (PROGRESS_KIND[definition.id]) {
    case 'counter':
      return Math.max(0, ...Object.values(record.slots ?? {}));
    case 'max':
      return record.max ?? 0;
    case 'set':
      return record.keys?.length ?? 0;
  }
}

function toProgress(
  definition: AchievementDefinition,
  record: StoredAchievement | undefined,
): AchievementProgress {
  const unlocked = record?.unlocked === true;
  const progress: AchievementProgress = {
    id: definition.id,
    current: unlocked
      ? definition.target
      : Math.min(definition.target, Math.floor(record ? progressValue(definition, record) : 0)),
    unlocked,
  };
  if (unlocked && record?.unlockedAt !== undefined) progress.unlockedAt = record.unlockedAt;
  return progress;
}

function serialize(achievements: StoredAchievements, unknown: Map<string, unknown>): string {
  const records = emptyRecord<unknown>();
  for (const [id, value] of unknown) records[id] = value;
  for (const definition of ACHIEVEMENTS) {
    const record = achievements[definition.id];
    if (record && Object.keys(record).length) records[definition.id] = record;
  }
  const file = { version: ACHIEVEMENTS_FILE_VERSION, achievements: records };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function furnitureUids(layout: Record<string, unknown>): string[] {
  if (!Array.isArray(layout.furniture)) return [];
  const uids: string[] = [];
  for (const item of layout.furniture) {
    if (isRecord(item) && typeof item.uid === 'string' && item.uid) uids.push(item.uid);
  }
  return uids;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Counts Achievements for one server process and records them in the shared
 * file. Opt-in (AgentRuntime creates one only when a surface asks for it), so
 * tests and embedders never write to the real home directory by accident.
 * Never throws into the runtime: failures are logged and counting goes on.
 */
export class AchievementTracker {
  private readonly namespace: string;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly saveDelayMs: number;
  /** Progress as last read from, or written to, the file. */
  private recorded: StoredAchievements = {};
  /** Records of ids this build does not define, as last read from the file. */
  private recordedUnknown = new Map<string, unknown>();
  /** Counted here and not written yet. */
  private readonly pendingCounts = new Map<AchievementId, number>();
  private readonly pendingMax = new Map<AchievementId, number>();
  private readonly pendingKeys = new Map<AchievementId, Set<string>>();
  /** A counter's largest slot when this process first read the file. Its own
   *  slot continues from there, so a surface used after another carries on
   *  from the total instead of starting over. */
  private readonly startedFrom = new Map<AchievementId, number>();
  private startCaptured = false;
  /** Counters whose own slot this process has written. */
  private readonly slotWritten = new Set<AchievementId>();
  private readonly latches = new Map<number, InteractionLatch>();
  /** Furniture this process did not see the user place: the layout on disk
   *  at start, the bundled default, imports, other windows' layouts. */
  private readonly knownFurniture = new Set<string>();
  private readonly sessionCwds = new Map<string, string | undefined>();
  private readonly unsubscribers: Array<() => void> = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readFailing = false;
  private writeFailing = false;
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    private readonly providerOf: (providerId: string) => HookProvider | undefined,
    options: AchievementTrackerOptions,
  ) {
    this.namespace = options.namespace;
    this.filePath =
      options.filePath ?? path.join(os.homedir(), LAYOUT_FILE_DIR, ACHIEVEMENTS_FILE_NAME);
    this.now = options.now ?? Date.now;
    this.saveDelayMs = options.saveDelayMs ?? ACHIEVEMENTS_SAVE_DEBOUNCE_MS;

    this.guard('read progress', () => {
      const file = this.read();
      if (!file) return;
      this.recorded = this.merged(file);
      this.recordedUnknown = this.mergedUnknown(file);
    });
    this.guard('read the layout', () => {
      const layout = (options.readLayout ?? readLayoutFromFile)();
      if (layout) this.seedLayout(layout);
    });

    this.unsubscribers.push(
      store.activity.subscribe(this.onActivity),
      store.tokenUsage.onLiveUsage(this.onLiveUsage),
      onLayoutChange(this.onLayoutChange),
    );
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
    this.unsubscribers.push(() => {
      store.off('agentAdded', this.onAgentAdded);
      store.off('agentRemoved', this.onAgentRemoved);
    });
    if (store.size > 0) this.onAgentAdded();
  }

  /** Every Achievement's progress, including what other processes recorded
   *  (the gallery is global). Writes what is pending first. */
  snapshot(): AchievementProgress[] {
    this.guard('save progress', () => this.flush());
    const view = this.guard('read progress', () => this.withPending(this.recorded)) ?? {};
    return ACHIEVEMENTS.map((definition) => toProgress(definition, view[definition.id]));
  }

  /** The furniture of `layout` was not placed by the user's editing: the
   *  bundled default, which a reset restores without placing anything, or a
   *  layout sent to a client, which can only save back what it was given. */
  seedLayout(layout: Record<string, unknown>): void {
    this.onLayoutChange(layout, 'replace');
  }

  /**
   * Merge what is pending into the file, unlock what reached its target, and
   * announce each new unlock once. Also run again after every write: another
   * process may have replaced the file between this one's read and rename, and
   * the next merge restores whatever that dropped.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const file = this.read();
    if (!file) {
      this.scheduleSave();
      return;
    }
    const next = this.withPending(this.merged(file));
    // None of them is pending here, so they are kept as soon as they are read.
    this.recordedUnknown = this.mergedUnknown(file);
    const unlockedAt = this.now();
    const unlocked: AchievementUnlocked[] = [];
    for (const definition of ACHIEVEMENTS) {
      const record = next[definition.id];
      if (record && !record.unlocked && progressValue(definition, record) >= definition.target) {
        record.unlocked = true;
        record.unlockedAt = unlockedAt;
        unlocked.push({ type: 'achievementUnlocked', id: definition.id, unlockedAt });
      }
    }
    const text = serialize(next, this.recordedUnknown);
    // Against this build's own reading of the file, not its raw text: a file
    // another build wrote holds nothing new just because it is spelled
    // differently, and rewriting it would have the two builds take turns.
    const changed = text !== serialize(file.achievements, file.unknown);
    if (changed && !this.write(text)) {
      this.scheduleSave();
      return;
    }
    for (const id of this.pendingCounts.keys()) this.slotWritten.add(id);
    this.pendingCounts.clear();
    this.pendingMax.clear();
    this.pendingKeys.clear();
    this.recorded = next;
    for (const message of unlocked) this.store.broadcast({ ...message });
    if (changed) this.scheduleSave();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.guard('save progress', () => this.flush());
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.latches.clear();
  }

  // ── Sources ───────────────────────────────────────────────────

  private readonly onActivity = (event: AgentActivityEvent): void => {
    this.guard('count activity', () => {
      switch (event.kind) {
        case 'toolStart':
          if (new Date(event.at).getHours() === ACHIEVEMENT_NIGHT_OWL_HOUR) {
            this.count('night_owl', 1);
          }
          // A Sub-agent's tool can run while its lead is Done.
          if (!event.subagent) this.interactionStarted(event);
          this.guard('count edited files', () => this.countEditedFiles(event));
          return;
        case 'interactionStart':
          this.interactionStarted(event);
          return;
        case 'interactionEnd':
          this.interactionEnded(event);
          return;
        case 'toolFailure':
          this.count('bug_squasher', 1);
          return;
      }
    });
  };

  private readonly onAgentAdded = (): void => {
    this.guard('count agents', () => {
      this.raise('first_agent', 1);
      this.raise('team_player', this.store.size);
    });
  };

  private readonly onAgentRemoved = (id: number): void => {
    this.latches.delete(id);
  };

  private readonly onLiveUsage = ({ delta }: LiveTokenUsage): void => {
    this.guard('count tokens', () => {
      const tokens =
        (delta.inputTokens ?? 0) +
        (delta.outputTokens ?? 0) +
        (delta.cacheCreationInputTokens ?? 0) +
        (delta.cacheReadInputTokens ?? 0);
      this.count('token_millionaire', tokens);
    });
  };

  private readonly onLayoutChange = (
    layout: Record<string, unknown>,
    origin: LayoutChangeOrigin,
  ): void => {
    this.guard('count furniture', () => {
      const uids = furnitureUids(layout);
      if (origin === 'edit') {
        this.addKeys(
          'decorator',
          uids.filter((uid) => !this.knownFurniture.has(uid)),
        );
      }
      for (const uid of uids) this.knownFurniture.add(uid);
    });
  };

  // ── Marathon: one count per completed interaction ─────────────

  /**
   * Several sources report the end of the same interaction (a Stop hook, the
   * transcript's turn_duration, the text-idle timer, the Copilot reducer's
   * settle), each at its own moment. Each agent keeps a latch: a start opens
   * it, and the first end after that closes it and counts. Times are the
   * record's own when the source states one, so a transcript record read late
   * still lands in the interaction it belongs to.
   */
  private interactionStarted(event: AgentActivityEvent): void {
    const at = event.recordedAt ?? event.at;
    const latch = this.latch(event.agentId);
    if (latch.open || at <= latch.closedAt) return;
    if (latch.unmatchedEndAt !== undefined && at <= latch.unmatchedEndAt) {
      latch.closedAt = latch.unmatchedEndAt;
      latch.unmatchedEndAt = undefined;
      this.count('marathon', 1);
      return;
    }
    latch.open = true;
    latch.openedAt = at;
    latch.unmatchedEndAt = undefined;
  }

  private interactionEnded(event: AgentActivityEvent): void {
    const at = event.recordedAt ?? event.at;
    const latch = this.latch(event.agentId);
    if (latch.open) {
      // An end from before this interaction began is a late report of the previous one.
      if (at < latch.openedAt) return;
      latch.open = false;
      latch.closedAt = at;
      this.count('marathon', 1);
      return;
    }
    if (at <= latch.closedAt) return;
    latch.unmatchedEndAt = Math.max(latch.unmatchedEndAt ?? at, at);
  }

  private latch(agentId: number): InteractionLatch {
    let latch = this.latches.get(agentId);
    if (!latch) {
      latch = { open: false, openedAt: 0, closedAt: -Infinity };
      this.latches.set(agentId, latch);
    }
    return latch;
  }

  // ── Architect: distinct edited files ──────────────────────────

  private countEditedFiles(event: Extract<AgentActivityEvent, { kind: 'toolStart' }>): void {
    if (this.isUnlocked('architect')) return;
    const provider = this.providerOf(event.providerId);
    const paths = provider?.editedFilePaths?.(event.toolName, event.input) ?? [];
    const keys: string[] = [];
    for (const filePath of paths) {
      const key = this.fileKey(filePath, provider, event.projectDir);
      if (key) keys.push(sha256(key));
    }
    this.addKeys('architect', keys);
  }

  /** One key per file, however its path was spelled. A relative path resolves
   *  against the session's working directory when the provider knows it, and
   *  is otherwise qualified by the session's directory. */
  private fileKey(
    filePath: string,
    provider: HookProvider | undefined,
    projectDir: string | undefined,
  ): string | undefined {
    const trimmed = filePath.trim();
    if (!trimmed) return undefined;
    if (path.isAbsolute(trimmed)) return toPathKey(trimmed);
    const cwd = projectDir ? this.sessionCwd(provider, projectDir) : undefined;
    if (cwd && path.isAbsolute(cwd)) return toPathKey(path.resolve(cwd, trimmed));
    const relative = path.posix.normalize(trimmed.replace(/\\/g, '/'));
    return `relative:${projectDir ? toPathKey(projectDir) : ''}|${relative}`;
  }

  private sessionCwd(provider: HookProvider | undefined, projectDir: string): string | undefined {
    const cacheKey = `${provider?.id ?? ''}|${projectDir}`;
    if (this.sessionCwds.has(cacheKey)) return this.sessionCwds.get(cacheKey);
    const cwd = provider?.getSessionCwd?.(projectDir);
    if (this.sessionCwds.size >= ACHIEVEMENT_CWD_CACHE_MAX_ENTRIES) this.sessionCwds.clear();
    this.sessionCwds.set(cacheKey, cwd);
    return cwd;
  }

  // ── Progress ──────────────────────────────────────────────────

  private count(id: AchievementId, amount: number): void {
    if (!(amount > 0) || this.isUnlocked(id)) return;
    this.pendingCounts.set(id, (this.pendingCounts.get(id) ?? 0) + amount);
    this.changed(id);
  }

  private raise(id: AchievementId, value: number): void {
    if (this.isUnlocked(id)) return;
    const current = this.withPending(this.recorded)[id];
    if (current && value <= progressValue(definitionOf(id), current)) return;
    this.pendingMax.set(id, Math.max(this.pendingMax.get(id) ?? 0, value));
    this.changed(id);
  }

  private addKeys(id: AchievementId, keys: readonly string[]): void {
    if (!keys.length || this.isUnlocked(id)) return;
    const { target } = definitionOf(id);
    const pending = this.pendingKeys.get(id) ?? new Set<string>();
    const known = new Set([...(this.recorded[id]?.keys ?? []), ...pending]);
    let added = false;
    for (const key of keys) {
      // Stop storing new keys once the target is reached.
      if (known.size >= target) break;
      if (known.has(key)) continue;
      known.add(key);
      pending.add(key);
      added = true;
    }
    if (!added) return;
    this.pendingKeys.set(id, pending);
    this.changed(id);
  }

  /** Save soon, or right away when this may have reached the target, so an
   *  unlock is written and announced promptly. */
  private changed(id: AchievementId): void {
    const record = this.withPending(this.recorded)[id];
    const reached = !!record && progressValue(definitionOf(id), record) >= definitionOf(id).target;
    if (reached && !this.readFailing && !this.writeFailing) this.flush();
    else this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.guard('save progress', () => this.flush());
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  private isUnlocked(id: AchievementId): boolean {
    return this.recorded[id]?.unlocked === true;
  }

  /** The file merged with what this process last knew, so nothing it recorded
   *  is lost if another process dropped it (or the file was deleted). */
  private merged(file: StoredFile): StoredAchievements {
    if (!this.startCaptured) {
      this.startCaptured = true;
      for (const definition of ACHIEVEMENTS) {
        if (PROGRESS_KIND[definition.id] !== 'counter') continue;
        const record = file.achievements[definition.id];
        this.startedFrom.set(definition.id, record ? progressValue(definition, record) : 0);
      }
    }
    return mergeAll(file.achievements, this.recorded);
  }

  /** The file's records of ids this build does not define, plus those it read
   *  before and another process has since dropped (a newer build's, lost to a
   *  writer that read the file before they existed). This build cannot merge
   *  what it does not define, so a record the file still holds is kept as is. */
  private mergedUnknown(file: StoredFile): Map<string, unknown> {
    const unknown = new Map(file.unknown);
    for (const [id, record] of this.recordedUnknown) {
      if (!unknown.has(id)) unknown.set(id, record);
    }
    return unknown;
  }

  /** `base` plus what this process counted and has not written yet. */
  private withPending(base: StoredAchievements): StoredAchievements {
    const next = mergeAll(base, {});
    for (const [id, amount] of this.pendingCounts) {
      const { target } = definitionOf(id);
      const record = (next[id] ??= {});
      const slots = record.slots ?? emptyRecord<number>();
      const own = slots[this.namespace] ?? 0;
      const from = this.slotWritten.has(id) ? own : Math.max(own, this.startedFrom.get(id) ?? 0);
      slots[this.namespace] = Math.min(target, from + amount);
      record.slots = slots;
    }
    for (const [id, value] of this.pendingMax) {
      const { target } = definitionOf(id);
      const record = (next[id] ??= {});
      record.max = Math.min(target, Math.max(record.max ?? 0, value));
    }
    for (const [id, keys] of this.pendingKeys) {
      const { target } = definitionOf(id);
      const record = (next[id] ??= {});
      record.keys = [...new Set([...(record.keys ?? []), ...keys])].slice(0, target);
    }
    return next;
  }

  // ── File ──────────────────────────────────────────────────────

  /** The file's progress, or undefined when it cannot be read right now. A
   *  missing file is empty. An unreadable one is moved aside and replaced. */
  private read(): StoredFile | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
      this.readFailing = false;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.readFailing = false;
        return { achievements: {}, unknown: new Map() };
      }
      if (!this.readFailing) console.error('[Pixel Agents] Failed to read achievements:', error);
      this.readFailing = true;
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.startFresh();
    }
    const records = isRecord(parsed) ? (parsed.achievements ?? {}) : undefined;
    if (!isRecord(records)) return this.startFresh();
    const file: StoredFile = { achievements: {}, unknown: new Map() };
    for (const [id, value] of Object.entries(records)) {
      const definition = ACHIEVEMENTS.find((candidate) => candidate.id === id);
      if (definition) {
        file.achievements[definition.id] = parseStoredAchievement(value, definition.target);
      } else {
        file.unknown.set(id, value);
      }
    }
    return file;
  }

  private startFresh(): StoredFile {
    const backup = `${this.filePath}${CORRUPT_SUFFIX}${this.now()}`;
    try {
      fs.renameSync(this.filePath, backup);
      console.warn(
        `[Pixel Agents] Achievements file was unreadable; moved it to ${backup} and started fresh`,
      );
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        console.error('[Pixel Agents] Failed to move the unreadable achievements file:', error);
      }
    }
    return { achievements: {}, unknown: new Map() };
  }

  private write(text: string): boolean {
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, text, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
      this.writeFailing = false;
      return true;
    } catch (error) {
      if (!this.writeFailing) console.error('[Pixel Agents] Failed to save achievements:', error);
      this.writeFailing = true;
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* the next write replaces it */
      }
      return false;
    }
  }

  private guard<T>(what: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      console.error(`[Pixel Agents] Achievements failed to ${what}:`, error);
      return undefined;
    }
  }
}
