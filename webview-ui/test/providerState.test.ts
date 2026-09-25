import assert from 'node:assert/strict';

import { test } from 'vitest';

import { applyAgentStatus, clearPermissionBubbles } from '../src/office/engine/agentStatus.js';
import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { reconcileAgentMetadata } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  isReadingToolName,
  isSubagentToolName,
  setProviderCapabilities,
} from '../src/office/toolUtils.js';
import { CharacterState } from '../src/office/types.js';

test('tool classifications stay provider-scoped regardless of arrival order', () => {
  setProviderCapabilities({
    providerId: 'claude',
    readingTools: ['Read'],
    subagentToolNames: ['Task'],
  });
  setProviderCapabilities({
    providerId: 'copilot',
    readingTools: ['view'],
    subagentToolNames: ['task'],
  });
  assert.equal(isReadingToolName('Read', 'claude'), true);
  assert.equal(isReadingToolName('Read', 'copilot'), false);
  assert.equal(isReadingToolName('view', 'copilot'), true);
  assert.equal(isSubagentToolName('Task', 'copilot'), false);
  assert.equal(isSubagentToolName('task', 'claude'), false);
  assert.equal(isSubagentToolName('task', 'copilot'), true);
  assert.equal(isReadingToolName('view', 'unrecognized'), false);
  assert.equal(isReadingToolName('Read'), true, 'legacy snapshots keep Claude taxonomy');
});

test('unknown observation hides the character without inventing a done state', () => {
  const office = new OfficeState();
  const character = createCharacter(1, 2, null, null, 90);
  office.characters.set(1, character);
  const subId = office.addSubagent(1, 'tool');
  character.path = [{ col: 2, row: 1 }];
  character.state = CharacterState.WALK;
  office.selectedAgentId = subId;
  office.cameraFollowId = subId;
  office.hoveredAgentId = 1;
  assert.equal(applyAgentStatus(office, 1, 'unknown'), false);
  const before = { ...character };
  updateCharacter(character, 100, [], new Map(), [], new Set());
  assert.deepEqual(character, before);
  assert.equal(character.isActive, true, 'the last observed active state is preserved');
  assert.equal(character.bubbleType, null);
  assert.equal(office.characters.has(1), true, 'the agent remains tracked');
  assert.equal(office.isCharacterVisible(1), false);
  assert.equal(office.isCharacterVisible(subId), false);
  assert.deepEqual(office.getCharacters(), []);
  assert.equal(office.getCharacterAt(character.x, character.y - 1), null);
  assert.equal(office.selectedAgentId, null);
  assert.equal(office.hoveredAgentId, null);
  assert.equal(office.cameraFollowId, null);
  office.setAgentMetadata(1, { providerId: 'copilot', sessionName: 'Renamed task' });
  assert.equal(character.sessionName, 'Renamed task');
  assert.equal(character.palette, 2);
  assert.equal(character.hueShift, 90);
  applyAgentStatus(office, 1, 'active');
  assert.equal(office.isCharacterVisible(1), true);
  assert.equal(office.isCharacterVisible(subId), true);
  assert.equal(office.getCharacters().length, 2);
  assert.equal(office.getCharacterAt(character.x, character.y - 1), 1);
});

test('snapshot observations hide restored agents until they become known', () => {
  const office = new OfficeState();
  office.characters.set(1, createCharacter(1, 0, null, null));
  office.characters.set(2, createCharacter(2, 1, null, null));
  office.setAgentMetadata(1, { observation: 'unknown' });
  assert.deepEqual(
    office.getCharacters().map((ch) => ch.id),
    [2],
  );
  office.setAgentObservation(1, 'known');
  assert.deepEqual(
    office.getCharacters().map((ch) => ch.id),
    [1, 2],
  );
});

test('recovery and repeated status messages never replay done notifications', () => {
  const office = new OfficeState();
  const character = createCharacter(1, 0, null, null);
  office.characters.set(1, character);
  assert.equal(applyAgentStatus(office, 1, 'waiting', false, true), false);
  assert.equal(character.bubbleType, null);
  assert.equal(applyAgentStatus(office, 1, 'waiting'), false);
  assert.equal(character.bubbleType, null);
  applyAgentStatus(office, 1, 'active');
  assert.equal(applyAgentStatus(office, 1, 'waiting'), true);
  character.bubbleType = null;
  assert.equal(applyAgentStatus(office, 1, 'waiting'), false);
});

test('waiting for input stays stationary after the speech bubble fades', () => {
  const office = new OfficeState();
  const character = createCharacter(1, 0, null, null);
  office.characters.set(1, character);
  applyAgentStatus(office, 1, 'waiting', true, true);
  assert.equal(character.bubbleType, null, 'recovery does not replay input bubbles');
  assert.equal(character.waitingAwaitingInput, true);
  updateCharacter(character, 100, [], new Map(), [], new Set());
  assert.equal(character.state, CharacterState.TYPE);
  applyAgentStatus(office, 1, 'active');
  assert.equal(character.waitingAwaitingInput, false);
});

test('a child permission resolution preserves other pending requests', () => {
  const office = new OfficeState();
  office.characters.set(1, createCharacter(1, 0, null, null));
  const first = office.addSubagent(1, 'first-task');
  const second = office.addSubagent(1, 'second-task');
  office.showPermissionBubble(1);
  office.showPermissionBubble(first);
  office.showPermissionBubble(second);
  clearPermissionBubbles(office, 1, 'first-task');
  assert.equal(office.characters.get(first)?.bubbleType, null);
  assert.equal(office.characters.get(second)?.bubbleType, 'permission');
  assert.equal(office.characters.get(1)?.bubbleType, 'permission');
  clearPermissionBubbles(office, 1);
  assert.equal(office.characters.get(second)?.bubbleType, null);
  assert.equal(office.characters.get(1)?.bubbleType, null);
});

test('live metadata renames preserve character identity and update buffered snapshots', () => {
  const office = new OfficeState();
  const character = createCharacter(1, 2, null, null, 90);
  office.characters.set(1, character);
  office.selectedAgentId = 1;
  const pending = [{ id: 2, sessionName: 'Before', folderName: 'Workspace' }];
  reconcileAgentMetadata(office, pending, 1, { sessionName: 'Live rename' });
  reconcileAgentMetadata(office, pending, 2, { sessionName: 'Buffered rename' });
  assert.equal(office.characters.get(1), character);
  assert.equal(character.sessionName, 'Live rename');
  assert.equal(character.palette, 2);
  assert.equal(character.hueShift, 90);
  assert.equal(office.selectedAgentId, 1);
  assert.deepEqual(pending, [{ id: 2, sessionName: 'Buffered rename', folderName: 'Workspace' }]);
  assert.equal(office.characters.has(2), false);
});
