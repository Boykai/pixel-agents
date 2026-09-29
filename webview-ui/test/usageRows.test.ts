/**
 * Unit tests for the Usage panel's row selection (src/office/usageRows.ts):
 * which Agents get a row. The panel renders these rows and sums its totals over
 * them; the e2e specs (tests/standalone/usage.spec.ts) cover what the user sees.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { AgentUsage } from '../../core/src/messages.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import { usageRowIds } from '../src/office/usageRows.js';

function floorLayout(cols = 12, rows = 9): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

function usage(id: number, premiumRequests: number): AgentUsage {
  return { type: 'agentUsage', id, premiumRequests };
}

test('one row per Agent with usage, in office order', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'alpha');
  os.addAgent(2, undefined, undefined, undefined, true, 'beta');
  os.addAgent(3, undefined, undefined, undefined, true, 'gamma');

  assert.deepEqual(usageRowIds([3, 1, 2], { 1: usage(1, 1), 3: usage(3, 2) }, os), [3, 1]);
  assert.deepEqual(usageRowIds([1, 2, 3], {}, os), []);
});

test('a hidden Agent (unknown observation) gets no row until it is observed again', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'shown');
  os.addAgent(2, undefined, undefined, undefined, true, 'adopted');
  // A Copilot App session adopted from a long transcript recovers as unknown:
  // the office hides its Character, so the panel doesn't list its usage either.
  os.setAgentObservation(2, 'unknown');
  const agentUsage = { 1: usage(1, 1), 2: usage(2, 10) };

  assert.deepEqual(usageRowIds([1, 2], agentUsage, os), [1]);

  os.setAgentObservation(2, 'known');
  assert.deepEqual(usageRowIds([1, 2], agentUsage, os), [1, 2]);
});

test('usage for an Agent without a Character gets no row', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, undefined, undefined, undefined, true, 'alpha');

  assert.deepEqual(usageRowIds([1, 7], { 1: usage(1, 1), 7: usage(7, 3) }, os), [1]);
});
