/**
 * Unit tests for Mood bubbles on OfficeState: the "Mood bubbles" setting gate,
 * which characters may show one, and the bubble's lifetime in the update loop
 * (paused while a permission prompt or Done checkmark covers it). The trigger
 * rules live in moodTracker.test.ts; e2e covers what is user-visible.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { MOOD_BUBBLE_DURATION_SEC, WAITING_BUBBLE_DURATION_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { MATRIX_EFFECT_DURATION, Mood, TileType } from '../src/office/types.js';

const STEP_SEC = 0.1;
/** Slack around a threshold, well above float drift from summing steps. */
const MARGIN_SEC = 0.25;

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

/** Run the update loop in game-loop-sized steps. */
function advance(os: OfficeState, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP_SEC); i++) os.update(STEP_SEC);
}

/** An office with agent 1 fully spawned in. */
function office(): OfficeState {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0);
  advance(os, MATRIX_EFFECT_DURATION + MARGIN_SEC);
  return os;
}

function moodOf(os: OfficeState, id = 1): Mood | null {
  return os.characters.get(id)?.moodType ?? null;
}

test('a shown Mood lasts MOOD_BUBBLE_DURATION_SEC, then clears itself', () => {
  const os = office();
  assert.equal(os.showMoodBubble(1, Mood.HAPPY), true);
  advance(os, MOOD_BUBBLE_DURATION_SEC - MARGIN_SEC);
  assert.equal(moodOf(os), Mood.HAPPY);
  advance(os, 2 * MARGIN_SEC);
  assert.equal(moodOf(os), null);
});

test('a newer Mood replaces the showing one and restarts the clock', () => {
  const os = office();
  os.showMoodBubble(1, Mood.STRESSED);
  advance(os, MOOD_BUBBLE_DURATION_SEC - MARGIN_SEC);
  os.showMoodBubble(1, Mood.ERROR);
  advance(os, MOOD_BUBBLE_DURATION_SEC - MARGIN_SEC);
  assert.equal(moodOf(os), Mood.ERROR);
});

test('a Done checkmark covers the Mood, which shows in full once it fades', () => {
  const os = office();
  os.showMoodBubble(1, Mood.HAPPY);
  os.showWaitingBubble(1);
  advance(os, WAITING_BUBBLE_DURATION_SEC + MARGIN_SEC);
  assert.equal(os.characters.get(1)?.bubbleType, null);
  advance(os, MOOD_BUBBLE_DURATION_SEC - 2 * MARGIN_SEC);
  assert.equal(moodOf(os), Mood.HAPPY);
  advance(os, 2 * MARGIN_SEC);
  assert.equal(moodOf(os), null);
});

test('a permission prompt covers the Mood until it is cleared', () => {
  const os = office();
  os.showMoodBubble(1, Mood.ERROR);
  os.showPermissionBubble(1);
  advance(os, MOOD_BUBBLE_DURATION_SEC * 2);
  assert.equal(moodOf(os), Mood.ERROR);
  os.clearPermissionBubble(1);
  advance(os, MOOD_BUBBLE_DURATION_SEC + MARGIN_SEC);
  assert.equal(moodOf(os), null);
});

test('"Waiting for input" draws no bubble, so it does not cover a Mood', () => {
  const os = office();
  os.showMoodBubble(1, Mood.STRESSED);
  os.showWaitingBubble(1, true);
  advance(os, MOOD_BUBBLE_DURATION_SEC + MARGIN_SEC);
  assert.equal(moodOf(os), null);
});

test('turning the setting off drops showing Moods and refuses new ones', () => {
  const os = office();
  os.showMoodBubble(1, Mood.HAPPY);
  os.setMoodBubblesEnabled(false);
  assert.equal(os.isMoodBubblesEnabled(), false);
  assert.equal(moodOf(os), null);
  assert.equal(os.showMoodBubble(1, Mood.ERROR), false);
  assert.equal(moodOf(os), null);

  os.setMoodBubblesEnabled(true);
  assert.equal(os.showMoodBubble(1, Mood.ERROR), true);
  assert.equal(moodOf(os), Mood.ERROR);
});

test('missing, hidden and despawning characters show no Mood', () => {
  const os = office();
  assert.equal(os.showMoodBubble(99, Mood.ERROR), false);

  os.setAgentObservation(1, 'unknown');
  assert.equal(os.showMoodBubble(1, Mood.ERROR), false);
  os.setAgentObservation(1, 'known');
  assert.equal(os.showMoodBubble(1, Mood.ERROR), true);

  os.removeAgent(1);
  assert.equal(os.showMoodBubble(1, Mood.HAPPY), false);
});

test('a Sub-agent shows its own Mood, found through its spawning tool', () => {
  const os = office();
  const subId = os.addSubagent(1, 'task-1');
  assert.equal(os.getSubagentId(1, 'task-1'), subId);
  assert.equal(os.showMoodBubble(subId, Mood.ERROR), true);
  assert.equal(moodOf(os, subId), Mood.ERROR);
  assert.equal(moodOf(os), null);
});
