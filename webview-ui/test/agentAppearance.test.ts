/**
 * Unit tests for the Appearance (UI: Costume) and Nickname halves of the
 * OfficeState domain model, plus their reconciliation with restore snapshots.
 *
 * Like greeter.test.ts and existingAgents.test.ts, these cover domain
 * invariants e2e cannot observe directly: that every Sub-agent of an Agent
 * wears its costume (including ones spawned later), that a Sub-agent can't be
 * dressed or named on its own, and that a buffered agent picks up changes made
 * before the layout finished loading. The user-visible flows (rename, costume
 * reaching a second client) are covered by the nickname e2e specs.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ExistingAgentsOffice, PendingAgent } from '../src/office/engine/existingAgents.js';
import {
  reconcileAgentAppearance,
  reconcileAgentMetadata,
  reconcileExistingAgents,
} from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

/** All-floor layout, no furniture — no catalog needed, every tile walkable. */
function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

function look(os: OfficeState, id: number): { palette?: number; hueShift?: number } {
  const ch = os.characters.get(id);
  return { palette: ch?.palette, hueShift: ch?.hueShift };
}

// ── Appearance ─────────────────────────────────────────────────

test('a costume change dresses the agent and every one of its sub-agents', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 1, 0, undefined, true);
  const sub = os.addSubagent(1, 'tool-a');
  const otherSub = os.addSubagent(2, 'tool-b');

  assert.equal(os.setAgentAppearance(1, 3, 45), true);

  assert.deepEqual(look(os, 1), { palette: 3, hueShift: 45 });
  assert.deepEqual(look(os, sub), { palette: 3, hueShift: 45 });
  assert.deepEqual(look(os, otherSub), { palette: 1, hueShift: 0 }, "another agent's sub-agent");
  // A sub-agent spawned afterwards starts in the new costume.
  assert.deepEqual(look(os, os.addSubagent(1, 'tool-c')), { palette: 3, hueShift: 45 });
});

test('an unchanged costume, an unknown id, or a sub-agent id changes nothing', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 2, 30, undefined, true);
  const sub = os.addSubagent(1, 'tool-a');

  assert.equal(os.setAgentAppearance(1, 2, 30), false);
  assert.equal(os.setAgentAppearance(99, 4, 0), false);
  assert.equal(os.setAgentAppearance(sub, 4, 0), false);
  assert.deepEqual(look(os, sub), { palette: 2, hueShift: 30 });
});

// ── Nickname ───────────────────────────────────────────────────

test('a nickname is set, replaced and cleared with an empty string', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true, undefined, undefined, 'Session title');

  os.setAgentMetadata(1, { nickname: 'Ada' });
  assert.equal(os.characters.get(1)?.nickname, 'Ada');
  os.setAgentMetadata(1, { sessionName: 'New title' });
  assert.equal(os.characters.get(1)?.nickname, 'Ada', 'other metadata leaves it alone');
  os.setAgentMetadata(1, { nickname: 'Grace' });
  assert.equal(os.characters.get(1)?.nickname, 'Grace');
  os.setAgentMetadata(1, { nickname: '' });
  assert.equal(os.characters.get(1)?.nickname, undefined);
  assert.equal(os.characters.get(1)?.sessionName, 'New title');
});

test('a sub-agent never carries a nickname of its own', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  const sub = os.addSubagent(1, 'tool-a');

  os.setAgentMetadata(sub, { nickname: 'Ada' });

  assert.equal(os.characters.get(sub)?.nickname, undefined);
});

// ── Reconciliation with buffered (pre-layout) agents ──────────

function recordingOffice(existing: number[] = []) {
  const ids = new Set(existing);
  const appearance: Array<[number, number, number]> = [];
  const metadata: Array<{ id: number; nickname?: string }> = [];
  const office: ExistingAgentsOffice = {
    characters: { has: (id) => ids.has(id) },
    addAgent: (id) => {
      ids.add(id);
    },
    setHeadless: () => {},
    setAgentMetadata: (id, value) => metadata.push({ id, nickname: value.nickname }),
    setAgentAppearance: (id, palette, hueShift) => {
      appearance.push([id, palette, hueShift]);
      return true;
    },
  };
  return { office, appearance, metadata };
}

test('a costume or rename that arrives before the layout lands on the buffered agent', () => {
  const { office } = recordingOffice();
  const pending: PendingAgent[] = [];
  reconcileExistingAgents(office, [5], { 5: { palette: 1, hueShift: 0 } }, {}, false, pending);

  reconcileAgentAppearance(office, pending, 5, 4, 90);
  reconcileAgentMetadata(office, pending, 5, { nickname: 'Ada' });

  assert.equal(pending[0].palette, 4);
  assert.equal(pending[0].hueShift, 90);
  assert.equal(pending[0].nickname, 'Ada');
});

test('a snapshot with nicknames is authoritative; one without leaves nicknames alone', () => {
  const pending: PendingAgent[] = [];
  const { office } = recordingOffice();
  reconcileExistingAgents(office, [5, 6], {}, {}, false, pending, {}, {}, {}, {}, { 5: 'Ada' });
  reconcileExistingAgents(office, [7], {}, {}, false, pending);

  assert.deepEqual(
    pending.map((agent) => [agent.id, agent.nickname]),
    [
      [5, 'Ada'],
      [6, ''],
      [7, undefined],
    ],
  );
});

test('a reconnect re-dresses and renames a character that already exists', () => {
  const { office, appearance, metadata } = recordingOffice([5]);

  reconcileExistingAgents(
    office,
    [5],
    { 5: { palette: 2, hueShift: 15 } },
    {},
    true,
    [],
    {},
    {},
    {},
    {},
    { 5: 'Ada' },
  );

  assert.deepEqual(appearance, [[5, 2, 15]]);
  assert.deepEqual(metadata, [{ id: 5, nickname: 'Ada' }]);
});
