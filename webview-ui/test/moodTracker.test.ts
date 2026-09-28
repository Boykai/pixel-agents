/**
 * Unit tests for the Mood tracker — the pure module that turns the ServerMessage
 * stream into transient Mood triggers (happy / error / stressed), plus the two
 * Character helpers that time a shown Mood bubble.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md): the
 * tracker is a DOMAIN MODEL with timing rules (a 2 s burst window, a 30 s
 * long-running clock that pauses behind a permission prompt) that e2e could
 * only observe by waiting out real minutes. `e2e/tests/standalone/mood.spec.ts`
 * covers what IS user-visible: a failed tool shows the error Mood, and the
 * setting turns Moods off.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type {
  AgentStatus,
  AgentToolStart,
  ServerMessage,
  SubagentToolStart,
} from '../../core/src/messages.js';
import {
  MOOD_STRESSED_RAPID_COUNT,
  MOOD_STRESSED_RAPID_THRESHOLD_MS,
  MOOD_STRESSED_TOOL_DURATION_MS,
} from '../src/constants.js';
import type { MoodTrigger } from '../src/office/engine/moodTracker.js';
import {
  advanceMoodBubble,
  isMoodBubbleCovered,
  MoodTracker,
} from '../src/office/engine/moodTracker.js';
import { Mood } from '../src/office/types.js';

const AGENT = 1;
const WAITING_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

function tracker(): MoodTracker {
  return new MoodTracker({
    isWaitingTool: (msg: AgentToolStart | SubagentToolStart) =>
      WAITING_TOOLS.has(msg.toolName ?? ''),
  });
}

function start(toolId: string, extra: Partial<AgentToolStart> = {}): AgentToolStart {
  return {
    type: 'agentToolStart',
    id: AGENT,
    toolId,
    status: 'Running: npm test',
    toolName: 'Bash',
    ...extra,
  };
}

function done(toolId: string, isError = false): ServerMessage {
  return { type: 'agentToolDone', id: AGENT, toolId, ...(isError ? { isError: true } : {}) };
}

function status(value: AgentStatus['status'], extra: Partial<AgentStatus> = {}): AgentStatus {
  return { type: 'agentStatus', id: AGENT, status: value, ...extra };
}

function subStart(parentToolId: string, toolId: string, toolName = 'Read'): SubagentToolStart {
  return {
    type: 'subagentToolStart',
    id: AGENT,
    parentToolId,
    toolId,
    status: `Reading ${toolId}`,
    toolName,
  };
}

function subDone(parentToolId: string, toolId: string, isError = false): ServerMessage {
  return {
    type: 'subagentToolDone',
    id: AGENT,
    parentToolId,
    toolId,
    ...(isError ? { isError: true } : {}),
  };
}

/** Feed messages at `now` (ms) and collect every trigger they produce. */
function feed(t: MoodTracker, now: number, ...messages: ServerMessage[]): MoodTrigger[] {
  return messages.flatMap((msg) => t.handleMessage(msg, now));
}

/** A Bash tool started at t=0; the agent is visibly working. */
function runningTool(): MoodTracker {
  const t = tracker();
  feed(t, 0, { type: 'agentCreated', id: AGENT }, status('active'), start('bash-1'));
  return t;
}

const LONG = MOOD_STRESSED_TOOL_DURATION_MS;

// ── error ─────────────────────────────────────────────────────

test('a failed tool triggers the error Mood; a successful one does not', () => {
  const t = tracker();
  assert.deepEqual(feed(t, 0, start('ok'), done('ok')), []);
  assert.deepEqual(feed(t, 10, start('bad'), done('bad', true)), [{ id: AGENT, mood: Mood.ERROR }]);
});

test('a failed Sub-agent tool triggers the error Mood on that Sub-agent', () => {
  const t = tracker();
  feed(t, 0, start('task-1', { toolName: 'Task', status: 'Subtask: explore' }));
  feed(t, 10, subStart('task-1', 'read-1'));
  assert.deepEqual(feed(t, 20, subDone('task-1', 'read-1', true)), [
    { id: AGENT, parentToolId: 'task-1', mood: Mood.ERROR },
  ]);
});

// ── happy ─────────────────────────────────────────────────────

test('a turn that used tools and ended Done without failures is happy', () => {
  const t = tracker();
  feed(t, 0, status('active'), start('bash-1'), done('bash-1'), { type: 'agentToolsClear', id: 1 });
  assert.deepEqual(feed(t, 100, status('waiting')), [{ id: AGENT, mood: Mood.HAPPY }]);
  // Once per turn: a repeated Done is not a second interaction.
  assert.deepEqual(feed(t, 200, status('waiting')), []);
});

test('no happy Mood after a failed tool, a failed Sub-agent tool, or a tool-less turn', () => {
  const failed = tracker();
  feed(failed, 0, start('bash-1'), done('bash-1', true), start('bash-2'), done('bash-2'));
  assert.deepEqual(feed(failed, 100, status('waiting')), []);

  const subFailed = tracker();
  feed(subFailed, 0, start('task-1', { toolName: 'Task' }), subStart('task-1', 'read-1'));
  feed(subFailed, 10, subDone('task-1', 'read-1', true), done('task-1'));
  assert.deepEqual(feed(subFailed, 100, status('waiting')), []);

  const talkOnly = tracker();
  feed(talkOnly, 0, status('active'));
  assert.deepEqual(feed(talkOnly, 100, status('waiting')), []);
});

test('failures are counted per turn: the next clean turn is happy again', () => {
  const t = tracker();
  feed(t, 0, start('bad'), done('bad', true), status('waiting'));
  feed(t, 1000, status('active'), start('good'), done('good'));
  assert.deepEqual(feed(t, 2000, status('waiting')), [{ id: AGENT, mood: Mood.HAPPY }]);
});

test('waiting for input is not the end of the interaction', () => {
  const t = tracker();
  feed(t, 0, start('ask', { toolName: 'AskUserQuestion' }));
  assert.deepEqual(feed(t, 10, status('waiting', { awaitingInput: true })), []);
  // The turn continues after the answer and completes normally.
  feed(t, 5000, status('active'), done('ask'));
  assert.deepEqual(feed(t, 6000, status('waiting')), [{ id: AGENT, mood: Mood.HAPPY }]);
});

test('a reconnect snapshot never triggers happy', () => {
  const t = tracker();
  feed(t, 0, start('bash-1', { replay: true }));
  assert.deepEqual(feed(t, 10, status('waiting', { replay: true })), []);

  // A replayed running tool alone does not make the live turn "a turn with tools".
  const replayOnly = tracker();
  feed(replayOnly, 0, start('bash-1', { replay: true }), done('bash-1'));
  assert.deepEqual(feed(replayOnly, 10, status('waiting')), []);
});

test("a background spawn's turn-end re-send is not a fresh tool", () => {
  const t = tracker();
  const spawn = start('agent-1', { toolName: 'Agent', runInBackground: true });
  feed(t, 0, status('active'), spawn, { type: 'agentToolsClear', id: AGENT }, spawn);
  assert.deepEqual(feed(t, 10, status('waiting')), [{ id: AGENT, mood: Mood.HAPPY }]);
  // Next prompt: the server clears and re-sends the still-running spawn.
  feed(t, 1000, status('active'), { type: 'agentToolsClear', id: AGENT }, spawn);
  assert.deepEqual(feed(t, 2000, status('waiting')), []);
});

// ── stressed: rapid-fire ─────────────────────────────────────

test('rapid tool starts inside the burst window trigger stressed once', () => {
  const t = tracker();
  const step = Math.floor(MOOD_STRESSED_RAPID_THRESHOLD_MS / MOOD_STRESSED_RAPID_COUNT);
  const triggers: MoodTrigger[] = [];
  for (let i = 0; i < MOOD_STRESSED_RAPID_COUNT; i++) {
    triggers.push(...feed(t, i * step, start(`t${i}`), done(`t${i}`)));
  }
  assert.deepEqual(triggers, [{ id: AGENT, mood: Mood.STRESSED }]);
  // The window restarts after a burst: one more start is not another burst.
  assert.deepEqual(feed(t, MOOD_STRESSED_RAPID_COUNT * step, start('next')), []);
});

test('tool starts spread wider than the burst window are calm', () => {
  const t = tracker();
  const triggers: MoodTrigger[] = [];
  for (let i = 0; i < MOOD_STRESSED_RAPID_COUNT * 2; i++) {
    triggers.push(...feed(t, i * MOOD_STRESSED_RAPID_THRESHOLD_MS, start(`t${i}`), done(`t${i}`)));
  }
  assert.deepEqual(triggers, []);
});

test('replayed and duplicate starts do not count toward a burst', () => {
  const t = tracker();
  const triggers = feed(
    t,
    0,
    ...Array.from({ length: MOOD_STRESSED_RAPID_COUNT }, (_, i) =>
      start(`r${i}`, { replay: true }),
    ),
    start('dup'),
    start('dup'),
    start('dup'),
  );
  assert.deepEqual(triggers, []);
});

test('a Sub-agent bursting through tools is stressed on its own character', () => {
  const t = tracker();
  feed(t, 0, start('task-1', { toolName: 'Task' }));
  const triggers = feed(
    t,
    10,
    ...Array.from({ length: MOOD_STRESSED_RAPID_COUNT }, (_, i) => subStart('task-1', `s${i}`)),
  );
  assert.deepEqual(triggers, [{ id: AGENT, parentToolId: 'task-1', mood: Mood.STRESSED }]);
});

// ── stressed: long-running tool ──────────────────────────────

test('a tool running past the threshold triggers stressed once', () => {
  const t = runningTool();
  assert.deepEqual(t.tick(LONG - 1), []);
  assert.deepEqual(t.tick(LONG), [{ id: AGENT, mood: Mood.STRESSED }]);
  assert.deepEqual(t.tick(LONG * 3), []);
});

test('several overdue tools stress their character once per tick', () => {
  const t = runningTool();
  feed(t, 0, start('bash-2'));
  assert.deepEqual(t.tick(LONG), [{ id: AGENT, mood: Mood.STRESSED }]);
});

test('a finished tool stops its clock', () => {
  const t = runningTool();
  feed(t, LONG - 1, done('bash-1'));
  assert.deepEqual(t.tick(LONG * 2), []);
});

test('a permission prompt pauses the clock; approval restarts it', () => {
  const t = runningTool();
  feed(t, 1000, { type: 'agentToolPermission', id: AGENT });
  assert.deepEqual(t.tick(LONG * 2), []);
  feed(t, LONG * 2, { type: 'agentToolPermissionClear', id: AGENT });
  assert.deepEqual(t.tick(LONG * 3 - 1), []);
  assert.deepEqual(t.tick(LONG * 3), [{ id: AGENT, mood: Mood.STRESSED }]);
});

test('a question to the user and an unknown observation pause the clock', () => {
  const asking = runningTool();
  feed(asking, 1000, status('waiting', { awaitingInput: true }));
  assert.deepEqual(asking.tick(LONG * 2), []);
  feed(asking, LONG * 2, status('active'));
  assert.deepEqual(asking.tick(LONG * 3), [{ id: AGENT, mood: Mood.STRESSED }]);

  const unseen = runningTool();
  feed(unseen, 1000, { type: 'agentObservation', id: AGENT, observation: 'unknown' });
  assert.deepEqual(unseen.tick(LONG * 2), []);
  feed(unseen, LONG * 2, { type: 'agentObservation', id: AGENT, observation: 'known' });
  assert.deepEqual(unseen.tick(LONG * 3), [{ id: AGENT, mood: Mood.STRESSED }]);
});

test('a replayed permission for an unseen agent does not reveal or block it', () => {
  const t = runningTool();
  feed(t, 0, status('unknown'), { type: 'agentToolPermission', id: AGENT, replay: true });
  feed(t, 10, { type: 'agentObservation', id: AGENT, observation: 'known' });
  assert.deepEqual(t.tick(LONG + 10), [{ id: AGENT, mood: Mood.STRESSED }]);
});

test('tools that legitimately wait never run long', () => {
  const t = tracker();
  feed(
    t,
    0,
    start('task-1', { toolName: 'Task' }),
    start('ask-1', { toolName: 'AskUserQuestion' }),
  );
  assert.deepEqual(t.tick(LONG * 2), []);

  // Background and Teammate spawns are excluded by their protocol flags alone.
  const bare = new MoodTracker();
  feed(
    bare,
    0,
    start('bg-1', { runInBackground: true }),
    start('mate-1', { isTeammateSpawn: true }),
  );
  assert.deepEqual(bare.tick(LONG * 2), []);
  feed(bare, LONG * 2, start('bash-1'));
  assert.deepEqual(bare.tick(LONG * 3), [{ id: AGENT, mood: Mood.STRESSED }]);
});

test("a Sub-agent's long-running tool stresses the Sub-agent, even after the lead's turn ended", () => {
  const t = tracker();
  feed(t, 0, start('agent-1', { toolName: 'Agent', runInBackground: true }));
  feed(t, 10, subStart('agent-1', 'read-1'), { type: 'agentToolsClear', id: AGENT });
  feed(t, 20, status('waiting'));
  assert.deepEqual(t.tick(LONG + 10), [
    { id: AGENT, parentToolId: 'agent-1', mood: Mood.STRESSED },
  ]);
});

test("a Sub-agent's permission prompt pauses only that Sub-agent's clock", () => {
  const t = tracker();
  feed(
    t,
    0,
    start('task-1', { toolName: 'Task' }),
    subStart('task-1', 'bash-9', 'Bash'),
    start('bash-1'),
  );
  feed(t, 10, { type: 'subagentToolPermission', id: AGENT, parentToolId: 'task-1' });
  assert.deepEqual(t.tick(LONG * 2), [{ id: AGENT, mood: Mood.STRESSED }]);
  feed(t, LONG * 2, { type: 'agentToolPermissionClear', id: AGENT, parentToolId: 'task-1' });
  assert.deepEqual(t.tick(LONG * 3), [{ id: AGENT, parentToolId: 'task-1', mood: Mood.STRESSED }]);
});

// ── clearing ─────────────────────────────────────────────────

test('a turn-end clear drops foreground clocks but keeps background Sub-agents', () => {
  const t = tracker();
  feed(
    t,
    0,
    start('bash-1'),
    start('task-1', { toolName: 'Task' }),
    start('agent-1', { toolName: 'Agent', runInBackground: true }),
    subStart('task-1', 'fg-read'),
    subStart('agent-1', 'bg-read'),
  );
  feed(t, 10, { type: 'agentToolsClear', id: AGENT });
  assert.deepEqual(t.tick(LONG + 10), [
    { id: AGENT, parentToolId: 'agent-1', mood: Mood.STRESSED },
  ]);
});

test('subagentClear and agentClosed forget their characters', () => {
  const t = tracker();
  feed(t, 0, start('task-1', { toolName: 'Task' }), subStart('task-1', 'read-1'), start('bash-1'));
  feed(t, 10, { type: 'subagentClear', id: AGENT, parentToolId: 'task-1' });
  assert.deepEqual(t.tick(LONG + 10), [{ id: AGENT, mood: Mood.STRESSED }]);

  const closed = runningTool();
  feed(closed, 10, { type: 'agentClosed', id: AGENT });
  assert.deepEqual(closed.tick(LONG * 2), []);
});

// ── bubble timing helpers ────────────────────────────────────

test('a Mood bubble counts down and clears itself', () => {
  const ch = {
    moodType: Mood.HAPPY as Mood | null,
    moodTimer: 1,
    bubbleType: null as 'permission' | 'waiting' | null,
    waitingAwaitingInput: false,
  };
  advanceMoodBubble(ch, 0.4);
  assert.equal(ch.moodType, Mood.HAPPY);
  assert.ok(Math.abs(ch.moodTimer - 0.6) < 1e-9);
  advanceMoodBubble(ch, 0.6);
  assert.equal(ch.moodType, null);
  assert.equal(ch.moodTimer, 0);
});

test('permission prompts and Done checkmarks cover a Mood bubble and pause it', () => {
  const ch = {
    moodType: Mood.ERROR as Mood | null,
    moodTimer: 1,
    bubbleType: 'permission' as 'permission' | 'waiting' | null,
    waitingAwaitingInput: false,
  };
  assert.equal(isMoodBubbleCovered(ch), true);
  advanceMoodBubble(ch, 5);
  assert.equal(ch.moodType, Mood.ERROR);

  ch.bubbleType = 'waiting';
  assert.equal(isMoodBubbleCovered(ch), true);
  advanceMoodBubble(ch, 5);
  assert.equal(ch.moodType, Mood.ERROR);

  // "Waiting for input" draws no bubble, so it covers nothing.
  ch.waitingAwaitingInput = true;
  assert.equal(isMoodBubbleCovered(ch), false);
  advanceMoodBubble(ch, 5);
  assert.equal(ch.moodType, null);
});
