import type { OfficeState } from './officeState.js';

export function clearPermissionBubbles(
  office: OfficeState,
  id: number,
  parentToolId?: string,
): void {
  if (parentToolId !== undefined) {
    const subId = office.getSubagentId(id, parentToolId);
    if (subId !== null) office.clearPermissionBubble(subId);
    return;
  }
  office.clearPermissionBubble(id);
  for (const [subId, meta] of office.subagentMeta) {
    if (meta.parentAgentId === id) office.clearPermissionBubble(subId);
  }
}

/** Recovery changes the displayed state, never replays historical notifications. */
export function applyAgentStatus(
  office: OfficeState,
  id: number,
  status: string,
  awaitingInput = false,
  replay = false,
): boolean {
  const character = office.characters.get(id);
  if (!character) return false;
  if (status === 'unknown') {
    office.setAgentObservation(id, 'unknown');
    return false;
  }
  const previous = character.activityStatus;
  const next = status === 'active' ? 'active' : awaitingInput ? 'input' : 'done';
  character.activityStatus = next;
  office.setAgentActive(id, status === 'active');
  if (status === 'active' && character.bubbleType === 'waiting') {
    character.bubbleType = null;
    character.bubbleTimer = 0;
  }
  if (status !== 'waiting') return false;
  character.waitingAwaitingInput = awaitingInput;
  if (!replay && previous !== next) office.showWaitingBubble(id, awaitingInput);
  return !replay && previous !== next;
}
