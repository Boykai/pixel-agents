/**
 * Achievements in the webview: the gallery's rows and the popup queue. Pure
 * (no DOM, no transport), so both run under the Node test runner.
 *
 * Ported from hootbu/pixel-agents (d0843a9): the gallery's rows, counts and
 * progress bars, and the popup's show-then-fade timing. The fork showed one
 * popup at a time and let a second unlock replace the first; here unlocks queue.
 */

import type { AchievementDefinition } from '../../core/src/achievements.js';
import { ACHIEVEMENTS } from '../../core/src/achievements.js';
import type { AchievementProgress } from '../../core/src/messages.js';

/** One gallery row: the shared definition plus this machine's progress. */
export type AchievementRow = AchievementDefinition & {
  current: number;
  unlocked: boolean;
  unlockedAt?: number;
};

/** Every defined Achievement in definition order, with its progress. A row the
 *  server has not reported yet starts at zero; ids this build does not define
 *  (a newer server) are left out. */
export function achievementRows(progress: readonly AchievementProgress[]): AchievementRow[] {
  const byId = new Map(progress.map((entry) => [entry.id, entry]));
  return ACHIEVEMENTS.map((definition) => {
    const entry = byId.get(definition.id);
    const unlocked = entry?.unlocked === true;
    const reported = entry && Number.isFinite(entry.current) ? entry.current : 0;
    const row: AchievementRow = {
      ...definition,
      current: unlocked ? definition.target : Math.max(0, Math.min(definition.target, reported)),
      unlocked,
    };
    if (unlocked && entry?.unlockedAt !== undefined) row.unlockedAt = entry.unlockedAt;
    return row;
  });
}

export function unlockedCount(rows: readonly AchievementRow[]): number {
  return rows.filter((row) => row.unlocked).length;
}

/** How full a row's progress bar is, 0–100. */
export function progressPercent(row: AchievementRow): number {
  if (row.unlocked) return 100;
  return Math.max(0, Math.min(100, (row.current / row.target) * 100));
}

/** A count as the gallery prints it: 950, 12.5K, 1M. */
export function formatAchievementCount(n: number): string {
  const trim = (value: number) => String(Number(value.toFixed(1)));
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.floor(n));
}

/** `progress` with `id` unlocked at `unlockedAt`: the gallery reflects an
 *  unlock the moment it is announced, whether or not a popup shows it. */
export function applyUnlock(
  progress: readonly AchievementProgress[],
  id: string,
  unlockedAt: number,
): AchievementProgress[] {
  const target = ACHIEVEMENTS.find((definition) => definition.id === id)?.target;
  if (target === undefined) return [...progress];
  const unlocked: AchievementProgress = { id, current: target, unlocked: true, unlockedAt };
  const index = progress.findIndex((entry) => entry.id === id);
  if (index === -1) return [...progress, unlocked];
  if (progress[index].unlocked) return [...progress];
  const next = [...progress];
  next[index] = unlocked;
  return next;
}

/** The popup on screen: shown, or fading out before the next one. */
export interface AchievementPopupView {
  id: string;
  leaving: boolean;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AchievementPopupQueueOptions {
  /** How long each popup stays up before it starts to fade. */
  durationMs: number;
  /** How long the fade lasts, after which the next popup shows. */
  fadeMs: number;
  onChange: (popup: AchievementPopupView | null) => void;
  setTimer?: (run: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * Shows unlocks one at a time, in the order they arrive: each stays up for
 * `durationMs`, fades for `fadeMs`, and then the next one shows. An id already
 * showing or waiting is not queued twice.
 */
export class AchievementPopupQueue {
  private readonly waiting: string[] = [];
  private current: AchievementPopupView | null = null;
  private timer: TimerHandle | undefined;
  private readonly options: AchievementPopupQueueOptions;
  private readonly setTimer: (run: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(options: AchievementPopupQueueOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  get showing(): AchievementPopupView | null {
    return this.current;
  }

  push(id: string): void {
    if (this.current?.id === id || this.waiting.includes(id)) return;
    this.waiting.push(id);
    if (!this.current) this.showNext();
  }

  /** Drop what is showing and waiting (popups were turned off). */
  clear(): void {
    this.cancelTimer();
    this.waiting.length = 0;
    if (!this.current) return;
    this.current = null;
    this.options.onChange(null);
  }

  dispose(): void {
    this.cancelTimer();
    this.waiting.length = 0;
    this.current = null;
  }

  private showNext(): void {
    const id = this.waiting.shift();
    this.current = id === undefined ? null : { id, leaving: false };
    this.options.onChange(this.current);
    if (id === undefined) return;
    this.timer = this.setTimer(() => {
      this.current = { id, leaving: true };
      this.options.onChange(this.current);
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.showNext();
      }, this.options.fadeMs);
    }, this.options.durationMs);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}
