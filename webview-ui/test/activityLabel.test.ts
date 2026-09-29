/**
 * Unit tests for the shared Activity label helper (core/src/activityLabel.ts).
 * Every surface that says what an Agent is doing (the Character's floating
 * label, the Activity panel, the VS Code Activity Quick Pick) goes through it,
 * so its precedence is pinned here once.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  ACTIVITY_LABEL,
  agentDisplayName,
  describeAgentActivity,
  subtaskLabel,
} from '../../core/src/activityLabel.js';

const read = { status: 'Reading foo.ts' };
const edit = { status: 'Editing bar.ts' };

test('the newest running tool wins over older ones and over finished ones', () => {
  assert.deepEqual(
    describeAgentActivity({ tools: [read, { ...edit, done: true }], isActive: true }),
    { label: 'Reading foo.ts', state: 'active' },
  );
  assert.deepEqual(describeAgentActivity({ tools: [read, edit], isActive: true }), {
    label: 'Editing bar.ts',
    state: 'active',
  });
});

test('an Active Agent with no running tool is thinking', () => {
  assert.deepEqual(describeAgentActivity({ isActive: true }), {
    label: ACTIVITY_LABEL.thinking,
    state: 'active',
  });
  assert.deepEqual(describeAgentActivity({ tools: [{ ...read, done: true }], isActive: true }), {
    label: ACTIVITY_LABEL.thinking,
    state: 'active',
  });
});

test('sticky mode keeps the last finished tool, or Active, while the turn runs', () => {
  assert.deepEqual(
    describeAgentActivity({ tools: [{ ...read, done: true }], isActive: true }, { sticky: true }),
    { label: 'Reading foo.ts', state: 'active' },
  );
  assert.deepEqual(describeAgentActivity({ isActive: true }, { sticky: true }), {
    label: ACTIVITY_LABEL.active,
    state: 'active',
  });
});

test('a finished turn reads Idle, in both modes', () => {
  const finished = { tools: [{ ...read, done: true }], isActive: false };
  assert.deepEqual(describeAgentActivity(finished), { label: ACTIVITY_LABEL.done, state: 'done' });
  assert.deepEqual(describeAgentActivity(finished, { sticky: true }), {
    label: 'Idle',
    state: 'done',
  });
});

test('a tool still running after the turn ended keeps showing (background spawns)', () => {
  assert.deepEqual(
    describeAgentActivity({ tools: [{ status: 'Subtask: Research' }], isActive: false }),
    { label: 'Subtask: Research', state: 'active' },
  );
});

test('a permission request outranks any running tool', () => {
  assert.deepEqual(describeAgentActivity({ tools: [read], isActive: true, needsApproval: true }), {
    label: ACTIVITY_LABEL.needsApproval,
    state: 'permission',
  });
  assert.deepEqual(
    describeAgentActivity({ tools: [{ ...read, permissionWait: true }], isActive: true }),
    { label: 'Needs approval', state: 'permission' },
  );
});

test('waiting for input outranks everything else', () => {
  assert.deepEqual(
    describeAgentActivity({
      tools: [read],
      isActive: false,
      needsApproval: true,
      waitingForInput: true,
    }),
    { label: ACTIVITY_LABEL.waitingForInput, state: 'input' },
  );
});

test('an Agent is named by its Nickname, then Teammate name, then session title, then folder', () => {
  assert.equal(
    agentDisplayName({
      nickname: 'Ada',
      agentName: 'researcher',
      sessionName: 'Fix CI',
      folderName: 'repo',
    }),
    'Ada',
  );
  // A cleared ('') Nickname falls through to the next name.
  assert.equal(agentDisplayName({ nickname: '', agentName: 'researcher' }), 'researcher');
  assert.equal(
    agentDisplayName({ agentName: 'researcher', sessionName: 'Fix CI', folderName: 'repo' }),
    'researcher',
  );
  assert.equal(agentDisplayName({ sessionName: 'Fix CI', folderName: 'repo' }), 'Fix CI');
  assert.equal(agentDisplayName({ folderName: 'repo' }), 'repo');
  assert.equal(agentDisplayName({ nickname: '', agentName: '', sessionName: '' }), undefined);
  assert.equal(agentDisplayName(undefined), undefined);
});

test("a spawn's Subtask status names its Sub-agent", () => {
  assert.equal(subtaskLabel('Subtask: Research the API'), 'Research the API');
  assert.equal(subtaskLabel('Subtask:'), '');
  assert.equal(subtaskLabel('Reading foo.ts'), '');
  assert.equal(subtaskLabel(undefined), '');
});
