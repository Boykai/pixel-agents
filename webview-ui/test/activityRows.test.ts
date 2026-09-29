/**
 * Unit tests for the Activity panel's row model (src/office/activityRows.ts):
 * which Characters get a row, how Sub-agents and Teammates nest, and what each
 * row says. The panel itself is a thin renderer over these rows; the e2e specs
 * (tests/standalone/activity-panel.spec.ts) cover what the user sees.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ActivityRowsInput } from '../src/office/activityRows.js';
import { buildActivityRows, followCharacter } from '../src/office/activityRows.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout, ToolActivity } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 12, rows = 9): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

function tool(toolId: string, status: string, extra: Partial<ToolActivity> = {}): ToolActivity {
  return { toolId, status, done: false, ...extra };
}

function input(os: OfficeState, overrides: Partial<ActivityRowsInput> = {}): ActivityRowsInput {
  return {
    officeState: os,
    agents: [...os.characters.keys()].filter((id) => id > 0),
    agentTools: {},
    subagentTools: {},
    subagentCharacters: [],
    ...overrides,
  };
}

/** Rows reduced to what the panel prints, one string per row. */
function lines(rows: ReturnType<typeof buildActivityRows>): string[] {
  return rows.map((row) => `${'  '.repeat(row.depth)}${row.label} | ${row.activity}`);
}

test('one row per Agent, in office order, with its Activity label', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo');
  os.addAgent(2, undefined, undefined, undefined, true, 'repo', undefined, 'Fix the CI');
  os.addAgent(3, undefined, undefined, undefined, true);
  os.addAgent(4, undefined, undefined, undefined, true, 'docs');
  os.addAgent(5, undefined, undefined, undefined, true, 'web');
  os.setAgentActive(3, false);
  os.showPermissionBubble(4);
  os.setAgentActive(5, false);
  os.showWaitingBubble(5, true);

  const rows = buildActivityRows(
    input(os, {
      agents: [1, 2, 3, 4, 5],
      agentTools: {
        1: [tool('t1', 'Reading foo.ts', { done: true }), tool('t2', 'Editing bar.ts')],
        2: [tool('t3', 'Reading foo.ts', { done: true })],
      },
    }),
  );

  assert.deepEqual(lines(rows), [
    'repo | Editing bar.ts',
    'Fix the CI | Thinking…',
    'Agent #3 | Idle',
    'docs | Needs approval',
    'web | Waiting for input',
  ]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ['active', 'active', 'done', 'permission', 'input'],
  );
  assert.ok(rows.every((row) => row.focusId === row.id && row.kind === 'agent'));
});

test('a row goes by the Agent’s Nickname, and falls back once the Nickname is cleared', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo', undefined, 'Fix the CI');
  const rows = () => lines(buildActivityRows(input(os)));

  os.setAgentMetadata(1, { nickname: 'Ada' });
  assert.deepEqual(rows(), ['Ada | Thinking…']);

  // '' is how agentMetadata clears a Nickname.
  os.setAgentMetadata(1, { nickname: '' });
  assert.deepEqual(rows(), ['Fix the CI | Thinking…']);
});

test('Sub-agents nest under their Agent and report their own tools', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo');
  os.addAgent(2, undefined, undefined, undefined, true, 'other');
  const research = os.addSubagent(1, 'spawn-a');
  const review = os.addSubagent(1, 'spawn-b');
  os.showPermissionBubble(review);

  const rows = buildActivityRows(
    input(os, {
      agents: [1, 2],
      agentTools: { 1: [tool('spawn-a', 'Subtask: Research'), tool('spawn-b', 'Subtask: Review')] },
      subagentTools: {
        1: { 'spawn-a': [tool('s1', 'Searching code')], 'spawn-b': [tool('s2', 'Running tests')] },
      },
      subagentCharacters: [
        { id: research, parentAgentId: 1, parentToolId: 'spawn-a', label: 'Research' },
        { id: review, parentAgentId: 1, parentToolId: 'spawn-b', label: 'Review' },
      ],
    }),
  );

  assert.deepEqual(lines(rows), [
    'repo | Subtask: Review',
    '  Research | Searching code',
    '  Review | Needs approval',
    'other | Thinking…',
  ]);
  const sub = rows[1];
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.id, research);
  assert.equal(sub.focusId, 1, "a Sub-agent row focuses its parent's terminal");
});

test('a Sub-agent between tools is thinking, and is named by its spawn when it has no label', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo');
  const named = os.addSubagent(1, 'spawn');
  const unnamed = os.addSubagent(1, 'bare');

  const rows = buildActivityRows(
    input(os, {
      agents: [1],
      agentTools: { 1: [tool('spawn', 'Subtask: Research'), tool('bare', 'Running agent')] },
      subagentTools: { 1: { spawn: [tool('s1', 'Reading a.ts', { done: true })] } },
      subagentCharacters: [
        { id: named, parentAgentId: 1, parentToolId: 'spawn', label: '' },
        { id: unnamed, parentAgentId: 1, parentToolId: 'bare', label: '' },
      ],
    }),
  );

  assert.deepEqual(lines(rows).slice(1), ['  Research | Thinking…', '  Sub-agent | Thinking…']);
});

test('Teammates nest under their Lead, after its Sub-agents', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo');
  os.addAgent(2, undefined, undefined, undefined, true, 'solo');
  os.addAgent(3, undefined, undefined, undefined, true, 'repo');
  os.addAgent(4, undefined, undefined, undefined, true, 'repo');
  os.setTeamInfo(1, 'team', undefined, true);
  os.setTeamInfo(3, 'team', 'researcher', false, 1);
  os.setTeamInfo(4, 'team', 'reviewer', false, 1);
  const sub = os.addSubagent(1, 'spawn');

  const rows = buildActivityRows(
    input(os, {
      agents: [1, 2, 3, 4],
      subagentCharacters: [{ id: sub, parentAgentId: 1, parentToolId: 'spawn', label: 'Explore' }],
    }),
  );

  assert.deepEqual(lines(rows), [
    'repo | Thinking…',
    '  Explore | Thinking…',
    '  researcher | Thinking…',
    '  reviewer | Thinking…',
    'solo | Thinking…',
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['lead', 'subagent', 'teammate', 'teammate', 'agent'],
  );
});

test('a Teammate whose Lead is not in the office is listed on its own', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(3, undefined, undefined, undefined, true, 'repo');
  os.setTeamInfo(3, 'team', 'researcher', false, 99);

  const rows = buildActivityRows(input(os, { agents: [3] }));

  assert.deepEqual(lines(rows), ['researcher | Thinking…']);
  assert.equal(rows[0].kind, 'teammate');
});

test('lead links that loop back on themselves still list every Agent once', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'a');
  os.addAgent(2, undefined, undefined, undefined, true, 'b');
  os.setTeamInfo(1, 'team', 'first', false, 2);
  os.setTeamInfo(2, 'team', 'second', false, 1);

  const rows = buildActivityRows(input(os, { agents: [1, 2] }));

  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2],
  );
});

test('hidden Agents (unknown observation) and their Sub-agents get no row', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'shown');
  os.addAgent(2, undefined, undefined, undefined, true, 'hidden');
  const sub = os.addSubagent(2, 'spawn');
  os.setAgentObservation(2, 'unknown');

  const rows = buildActivityRows(
    input(os, {
      agents: [1, 2, 7],
      subagentCharacters: [{ id: sub, parentAgentId: 2, parentToolId: 'spawn', label: 'X' }],
    }),
  );

  assert.deepEqual(lines(rows), ['shown | Thinking…']);
});

test('followCharacter selects the Character and points the camera at it', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'repo');
  os.addAgent(2, undefined, undefined, undefined, true, 'hidden');
  os.setAgentObservation(2, 'unknown');
  os.cameraFollowPetId = 'pet-1';

  assert.equal(followCharacter(os, 1), true);
  assert.equal(os.selectedAgentId, 1);
  assert.equal(os.cameraFollowId, 1);
  assert.equal(os.cameraFollowPetId, null, 'following an agent ends a pet follow');

  os.cameraFollowPetId = 'pet-1';
  assert.equal(followCharacter(os, 2), false, 'a hidden Character is not followed');
  assert.equal(followCharacter(os, 42), false, 'nor is an unknown id');
  assert.equal(os.selectedAgentId, 1);
  assert.equal(os.cameraFollowId, 1);
  assert.equal(os.cameraFollowPetId, 'pet-1', 'a refused follow leaves the pet follow alone');
});
