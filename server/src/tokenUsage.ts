import { StringDecoder } from 'node:string_decoder';

import * as fs from 'fs';

import type { TokenUsageSample } from '../../core/src/provider.js';
import {
  TOKEN_USAGE_BROADCAST_INTERVAL_MS,
  TOKEN_USAGE_DEDUPE_WINDOW,
  TOKEN_USAGE_SEED_CHUNK_BYTES,
  TOKEN_USAGE_SEED_MAX_BYTES,
  TOKEN_USAGE_SEED_TAIL_BYTES,
  TRANSCRIPT_MAX_LINE_CHARS,
} from './constants.js';

/**
 * Token usage: what each agent's session has consumed, as its CLI recorded it.
 *
 * Not Context usage (contextUsage.ts). That one is a snapshot of how full the
 * window is right now, so it drops on compaction. Token usage is a running total
 * that only grows until /clear starts a new session.
 *
 * Providers own the parsing (`HookProvider.extractTokenUsage`). This tracker
 * only does arithmetic on what they report: nothing is estimated or priced.
 * It works with two kinds of sample:
 * - `delta` samples add up. They are deduped per message id, because Claude
 *   writes one record per content block and each record repeats the usage.
 * - `total` samples are cumulative, so each one replaces the previous totals.
 */

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'premiumRequests',
  'nanoAiu',
] as const;

type UsageField = (typeof USAGE_FIELDS)[number];
type UsageAmounts = Partial<Record<UsageField, number>>;

/** New usage an agent just reported. It never includes history read at seeding. */
export interface LiveTokenUsage {
  id: number;
  model?: string;
  /** Positive increments only. */
  delta: UsageAmounts;
}

/** What a transcript held before the point where live reading starts. */
export interface TokenUsageHistory {
  /** Applied in order, without notifying live listeners. */
  samples: TokenUsageSample[];
  /** Samples that come before `samples`. Only their model and message ids are
   *  used; their amounts are not added to the totals. */
  primers: TokenUsageSample[];
  /** True when `samples` cover the whole prefix, so the totals are whole-session. */
  complete: boolean;
}

interface UsageEntry {
  /** What the panel shows. */
  totals: UsageAmounts;
  /** Last known cumulative value per field. Live increments of `total`
   *  samples are measured against it. */
  observed: UsageAmounts;
  model?: string;
  /** History could not be read, so the totals only count what was seen live. */
  sinceTracked: boolean;
  /** No usage precedes the live point, so a first total is new usage in full.
   *  Any history — seeded or replayed — makes a field's baseline unknown until
   *  a total reports it: cumulative counters are reported only now and then. */
  baselineZero: boolean;
  sawTotal: boolean;
  /** Per message id, the largest amount seen for each field. */
  seen: Map<string, UsageAmounts>;
  file?: string;
  /** Records read from bytes before this offset are replayed history. */
  liveFrom: number;
  replaying: boolean;
  lastSent: string;
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

type Extract = (record: unknown) => TokenUsageSample | undefined;

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function emptyMessage(id: number): string {
  return JSON.stringify({ type: 'agentUsage', id });
}

function sameAmounts(a: UsageAmounts, b: UsageAmounts): boolean {
  return USAGE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Per-agent Token usage totals. The owning AgentStateStore passes in its
 * broadcast. Every change goes out as an `agentUsage` message, throttled per
 * agent to one per TOKEN_USAGE_BROADCAST_INTERVAL_MS.
 */
export class TokenUsageTracker {
  private readonly entries = new Map<number, UsageEntry>();
  private readonly listeners = new Set<(usage: LiveTokenUsage) => void>();
  private readonly send: (message: Record<string, unknown>) => void;
  private readonly intervalMs: number;

  constructor(
    send: (message: Record<string, unknown>) => void,
    intervalMs: number = TOKEN_USAGE_BROADCAST_INTERVAL_MS,
  ) {
    this.send = send;
    this.intervalMs = intervalMs;
  }

  /** Whether this agent's totals are already counting `file`. */
  isTracking(id: number, file: string): boolean {
    return this.entries.get(id)?.file === file;
  }

  /**
   * Start counting `file` from scratch. `history` is what the transcript held
   * before live reading starts; it is applied without notifying live
   * listeners. Records the live reader takes from bytes before `liveFrom`
   * count toward the totals but are not reported as new usage.
   */
  seed(
    id: number,
    file: string | undefined,
    history: TokenUsageHistory = { samples: [], primers: [], complete: true },
    liveFrom = 0,
  ): void {
    const entry = this.restart(id);
    entry.file = file;
    entry.liveFrom = liveFrom;
    entry.baselineZero = history.complete && history.samples.length === 0;
    for (const primer of history.primers) this.prime(entry, primer);
    for (const sample of history.samples) this.apply(id, entry, sample, false);
    entry.sinceTracked = !history.complete && !entry.sawTotal;
    this.schedule(id, entry);
  }

  /** /clear: a new session starts, so its totals start at zero again. */
  reset(id: number): void {
    this.seed(id, undefined);
  }

  /** The live reader is about to process records that start at `offset`. */
  readingFrom(id: number, offset: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.replaying = offset < entry.liveFrom;
  }

  /** A sample from a record the live reader just processed. */
  observe(id: number, sample: TokenUsageSample): void {
    const entry = this.entries.get(id) ?? this.restart(id);
    const live = !entry.replaying;
    const changed = this.apply(id, entry, sample, live);
    if (!live) entry.baselineZero = false;
    if (changed) this.schedule(id, entry);
  }

  /** The agent's current totals as an `agentUsage` message, if it has any. */
  snapshot(id: number): Record<string, unknown> | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const message = this.message(id, entry);
    return Object.keys(message).length > 2 ? message : undefined;
  }

  /**
   * Subscribe to new usage as it is observed. History that is seeded or
   * replayed is never reported. When the baseline is unclear the listener gets
   * less than was used, never more. Returns an unsubscribe function.
   */
  onLiveUsage(listener: (usage: LiveTokenUsage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  remove(id: number): void {
    const entry = this.entries.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  clear(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
  }

  dispose(): void {
    this.clear();
    this.listeners.clear();
  }

  /** A fresh entry that keeps the throttle state, so a reset is sent like any other change. */
  private restart(id: number): UsageEntry {
    const previous = this.entries.get(id);
    const entry: UsageEntry = {
      totals: {},
      observed: {},
      sinceTracked: false,
      baselineZero: false,
      sawTotal: false,
      seen: new Map(),
      liveFrom: 0,
      replaying: false,
      lastSent: previous?.lastSent ?? emptyMessage(id),
      lastSentAt: previous?.lastSentAt ?? Number.NEGATIVE_INFINITY,
      timer: previous?.timer,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private prime(entry: UsageEntry, sample: TokenUsageSample): void {
    if (sample.model) entry.model = sample.model;
    if (sample.kind !== 'delta' || sample.messageId === undefined) return;
    const seen = entry.seen.get(sample.messageId) ?? {};
    for (const field of USAGE_FIELDS) {
      const value = amount(sample[field]);
      if (value !== undefined) seen[field] = Math.max(seen[field] ?? 0, value);
    }
    this.remember(entry, sample.messageId, seen);
  }

  /** Adds `sample` to the totals. Returns whether the message would change. */
  private apply(id: number, entry: UsageEntry, sample: TokenUsageSample, live: boolean): boolean {
    let changed = false;
    const delta: UsageAmounts = {};
    if (sample.model && sample.model !== entry.model) {
      entry.model = sample.model;
      changed = true;
    }
    if (sample.kind === 'total') {
      const totals: UsageAmounts = {};
      for (const field of USAGE_FIELDS) {
        const value = amount(sample[field]);
        if (value === undefined) continue;
        totals[field] = value;
        const base = entry.observed[field] ?? (entry.baselineZero ? 0 : undefined);
        if (base !== undefined && value > base) delta[field] = value - base;
        entry.observed[field] = value;
      }
      if (!sameAmounts(entry.totals, totals)) {
        entry.totals = totals;
        changed = true;
      }
      if (entry.sinceTracked) {
        entry.sinceTracked = false;
        changed = true;
      }
      entry.sawTotal = true;
    } else {
      const previous =
        sample.messageId !== undefined ? entry.seen.get(sample.messageId) : undefined;
      const seen: UsageAmounts = previous ?? {};
      for (const field of USAGE_FIELDS) {
        const value = amount(sample[field]);
        if (value === undefined) continue;
        const before = previous?.[field];
        // A repeated message adds only what grew since its last record.
        const growth = before === undefined ? value : value - before;
        if (before === undefined || value > before) seen[field] = value;
        if (entry.totals[field] === undefined) {
          entry.totals[field] = 0;
          changed = true;
        }
        if (growth > 0) {
          entry.totals[field] = (entry.totals[field] ?? 0) + growth;
          delta[field] = growth;
          changed = true;
        }
        // Keep the cumulative baseline in step only where one is known.
        if (entry.observed[field] !== undefined || entry.baselineZero) {
          entry.observed[field] = entry.totals[field];
        }
      }
      if (sample.messageId !== undefined && !previous) {
        this.remember(entry, sample.messageId, seen);
      }
    }
    if (live && Object.keys(delta).length > 0) this.emit({ id, model: entry.model, delta });
    return changed;
  }

  private remember(entry: UsageEntry, messageId: string, seen: UsageAmounts): void {
    entry.seen.set(messageId, seen);
    if (entry.seen.size > TOKEN_USAGE_DEDUPE_WINDOW) {
      const oldest = entry.seen.keys().next().value;
      if (oldest !== undefined) entry.seen.delete(oldest);
    }
  }

  private emit(usage: LiveTokenUsage): void {
    for (const listener of this.listeners) {
      try {
        listener(usage);
      } catch (error) {
        console.error('[Pixel Agents] Token usage listener failed:', error);
      }
    }
  }

  private schedule(id: number, entry: UsageEntry): void {
    if (entry.timer) return; // the pending trailing send reads the latest totals
    const wait = entry.lastSentAt + this.intervalMs - Date.now();
    if (wait <= 0) {
      this.flush(id, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      const current = this.entries.get(id);
      if (!current) return;
      current.timer = undefined;
      this.flush(id, current);
    }, wait);
    entry.timer.unref?.();
  }

  private flush(id: number, entry: UsageEntry): void {
    const message = this.message(id, entry);
    const json = JSON.stringify(message);
    if (json === entry.lastSent) return;
    entry.lastSent = json;
    entry.lastSentAt = Date.now();
    this.send(message);
  }

  private message(id: number, entry: UsageEntry): Record<string, unknown> {
    const message: Record<string, unknown> = { type: 'agentUsage', id };
    if (entry.model) message.model = entry.model;
    for (const field of USAGE_FIELDS) {
      if (entry.totals[field] !== undefined) message[field] = entry.totals[field];
    }
    if (entry.sinceTracked) message.sinceTracked = true;
    return message;
  }
}

/**
 * Read the samples in the complete lines of `file` that come before `end`,
 * which is where the live reader resumes. Any unterminated remainder belongs
 * to the live reader. Cost is bounded:
 * 1. Read the last TOKEN_USAGE_SEED_TAIL_BYTES. A cumulative (`total`) sample
 *    there is enough, so nothing earlier is needed.
 * 2. Otherwise replay the whole prefix once, up to TOKEN_USAGE_SEED_MAX_BYTES.
 * 3. Past that, give up on history: the totals count "since tracked".
 */
export function readTokenUsageHistory(
  file: string,
  end: number,
  extract: Extract,
): TokenUsageHistory {
  if (end <= 0) return { samples: [], primers: [], complete: true };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, end - TOKEN_USAGE_SEED_TAIL_BYTES);
    const tail = readSamples(fd, start, end, extract);
    if (start === 0) return { samples: tail, primers: [], complete: true };
    const firstTotal = tail.findIndex((sample) => sample.kind === 'total');
    if (firstTotal >= 0) {
      return {
        samples: tail.slice(firstTotal),
        primers: tail.slice(0, firstTotal),
        complete: false,
      };
    }
    if (end <= TOKEN_USAGE_SEED_MAX_BYTES) {
      return { samples: readSamples(fd, 0, end, extract), primers: [], complete: true };
    }
    return { samples: [], primers: tail, complete: false };
  } catch {
    return { samples: [], primers: [], complete: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Samples from the complete lines inside [start, end), read in chunks. */
function readSamples(fd: number, start: number, end: number, extract: Extract): TokenUsageSample[] {
  const samples: TokenUsageSample[] = [];
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(Math.min(TOKEN_USAGE_SEED_CHUNK_BYTES, end - start + 1));
  // Start one byte early. If that byte is a newline, `start` begins a line;
  // otherwise the first fragment is the end of a line that began earlier.
  let position = Math.max(0, start - 1);
  let skipping = start > 0;
  let carry = '';
  while (position < end) {
    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
    if (read <= 0) break;
    position += read;
    const lines = (carry + decoder.write(buffer.subarray(0, read))).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (skipping) {
        skipping = false;
        continue;
      }
      if (!line.trim() || line.length > TRANSCRIPT_MAX_LINE_CHARS) continue;
      try {
        const sample = extract(JSON.parse(line));
        if (sample) samples.push(sample);
      } catch {
        /* malformed lines carry no usage */
      }
    }
    if (carry.length > TRANSCRIPT_MAX_LINE_CHARS) {
      carry = '';
      skipping = true;
    }
  }
  return samples;
}
