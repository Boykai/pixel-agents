/**
 * Unit tests for the webview side of Achievements — the pure module behind the
 * popup queue and the gallery rows (src/achievements.ts).
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md): the
 * queue is a timing rule (each popup stays up 4 s, fades for 0.3 s, then the
 * next shows) that e2e could only observe by waiting it out, and the row
 * helpers clamp server input a browser never sends malformed.
 * `e2e/tests/standalone/achievements.spec.ts` covers what IS user-visible: an
 * unlock pops once, the gallery lists it, and the setting turns popups off.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { ACHIEVEMENTS } from '../../core/src/achievements.js';
import type { AchievementPopupView } from '../src/achievements.js';
import {
  AchievementPopupQueue,
  achievementRows,
  applyUnlock,
  formatAchievementCount,
  progressPercent,
  unlockedCount,
} from '../src/achievements.js';

const DURATION_MS = 4_000;
const FADE_MS = 300;

/** A hand-cranked clock for the queue's timers. */
class FakeTimers {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  setTimer = (run: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, run });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= until && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = timer.at;
      timer.run();
    }
    this.now = until;
  }
}

function queue(): {
  queue: AchievementPopupQueue;
  timers: FakeTimers;
  seen: Array<AchievementPopupView | null>;
} {
  const timers = new FakeTimers();
  const seen: Array<AchievementPopupView | null> = [];
  return {
    queue: new AchievementPopupQueue({
      durationMs: DURATION_MS,
      fadeMs: FADE_MS,
      onChange: (popup) => seen.push(popup),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
    timers,
    seen,
  };
}

// ── Popup queue ─────────────────────────────────────────────────

test('a popup shows, fades after its duration, and is gone after the fade', () => {
  const { queue: q, timers, seen } = queue();
  q.push('first_agent');
  assert.deepEqual(q.showing, { id: 'first_agent', leaving: false });

  timers.advance(DURATION_MS - 1);
  assert.deepEqual(q.showing, { id: 'first_agent', leaving: false });
  timers.advance(1);
  assert.deepEqual(q.showing, { id: 'first_agent', leaving: true });

  timers.advance(FADE_MS);
  assert.equal(q.showing, null);
  assert.deepEqual(seen, [
    { id: 'first_agent', leaving: false },
    { id: 'first_agent', leaving: true },
    null,
  ]);
  assert.equal(timers.pending, 0);
});

test('unlocks that arrive together show one at a time, in order', () => {
  const { queue: q, timers, seen } = queue();
  q.push('first_agent');
  q.push('team_player');
  q.push('night_owl');
  assert.equal(q.showing?.id, 'first_agent');

  timers.advance(DURATION_MS + FADE_MS);
  assert.deepEqual(q.showing, { id: 'team_player', leaving: false });
  timers.advance(DURATION_MS + FADE_MS);
  assert.deepEqual(q.showing, { id: 'night_owl', leaving: false });
  timers.advance(DURATION_MS + FADE_MS);
  assert.equal(q.showing, null);

  const shown = seen.filter((popup) => popup && !popup.leaving).map((popup) => popup!.id);
  assert.deepEqual(shown, ['first_agent', 'team_player', 'night_owl']);
});

test('an id already showing or waiting is not queued twice', () => {
  const { queue: q, timers, seen } = queue();
  q.push('first_agent');
  q.push('first_agent');
  q.push('marathon');
  q.push('marathon');

  timers.advance(3 * (DURATION_MS + FADE_MS));
  const shown = seen.filter((popup) => popup && !popup.leaving).map((popup) => popup!.id);
  assert.deepEqual(shown, ['first_agent', 'marathon']);
});

test('an unlock arriving during a fade waits for it, then shows', () => {
  const { queue: q, timers } = queue();
  q.push('first_agent');
  timers.advance(DURATION_MS + FADE_MS / 2);
  assert.deepEqual(q.showing, { id: 'first_agent', leaving: true });

  q.push('decorator');
  assert.deepEqual(q.showing, { id: 'first_agent', leaving: true });
  timers.advance(FADE_MS / 2);
  assert.deepEqual(q.showing, { id: 'decorator', leaving: false });
});

test('clear drops the popup showing and those waiting', () => {
  const { queue: q, timers, seen } = queue();
  q.push('first_agent');
  q.push('team_player');
  q.clear();
  assert.equal(q.showing, null);
  assert.equal(seen.at(-1), null);
  assert.equal(timers.pending, 0);

  timers.advance(10 * DURATION_MS);
  assert.equal(q.showing, null);

  // The queue still works afterwards (popups turned back on).
  q.push('architect');
  assert.deepEqual(q.showing, { id: 'architect', leaving: false });
});

test('dispose cancels the timers without reporting a change', () => {
  const { queue: q, timers, seen } = queue();
  q.push('first_agent');
  const reported = seen.length;
  q.dispose();
  assert.equal(timers.pending, 0);
  timers.advance(DURATION_MS + FADE_MS);
  assert.equal(seen.length, reported);
});

// ── Gallery rows ────────────────────────────────────────────────

test('rows follow the definitions, start at zero, and skip unknown ids', () => {
  const rows = achievementRows([
    { id: 'marathon', current: 42, unlocked: false },
    { id: 'from_a_newer_server', current: 3, unlocked: true, unlockedAt: 1 },
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ACHIEVEMENTS.map((definition) => definition.id),
  );
  assert.equal(rows.find((row) => row.id === 'marathon')?.current, 42);
  assert.equal(rows.find((row) => row.id === 'first_agent')?.current, 0);
  assert.equal(unlockedCount(rows), 0);
});

test('rows clamp progress to the target, and an unlocked row is full', () => {
  const rows = achievementRows([
    { id: 'architect', current: 500, unlocked: false },
    { id: 'night_owl', current: -3, unlocked: false },
    { id: 'first_agent', current: 0, unlocked: true, unlockedAt: 1234 },
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get('architect')?.current, 50);
  assert.equal(byId.get('night_owl')?.current, 0);
  assert.equal(byId.get('first_agent')?.current, 1);
  assert.equal(byId.get('first_agent')?.unlockedAt, 1234);
  assert.equal(progressPercent(byId.get('first_agent')!), 100);
  assert.equal(unlockedCount(rows), 1);
});

test('progressPercent is the share of the target', () => {
  const [row] = achievementRows([{ id: 'marathon', current: 25, unlocked: false }]).filter(
    (candidate) => candidate.id === 'marathon',
  );
  assert.equal(progressPercent(row), 25);
});

test('counts print compactly', () => {
  assert.equal(formatAchievementCount(0), '0');
  assert.equal(formatAchievementCount(950), '950');
  assert.equal(formatAchievementCount(1_000), '1K');
  assert.equal(formatAchievementCount(12_540), '12.5K');
  assert.equal(formatAchievementCount(420_000), '420K');
  assert.equal(formatAchievementCount(1_000_000), '1M');
  assert.equal(formatAchievementCount(1_250_000), '1.3M');
});

test('applyUnlock marks the Achievement unlocked at its target, once', () => {
  const before = [{ id: 'first_agent', current: 0, unlocked: false }];
  const after = applyUnlock(before, 'first_agent', 99);
  assert.deepEqual(after, [{ id: 'first_agent', current: 1, unlocked: true, unlockedAt: 99 }]);
  assert.equal(before[0].unlocked, false, 'the input is not mutated');

  // A repeat keeps the first unlock time; an absent row is added.
  assert.deepEqual(applyUnlock(after, 'first_agent', 500), after);
  const added = applyUnlock([], 'decorator', 7);
  assert.deepEqual(added, [{ id: 'decorator', current: 20, unlocked: true, unlockedAt: 7 }]);

  // An id this build does not define changes nothing.
  assert.deepEqual(applyUnlock(after, 'from_a_newer_server', 1), after);
});
