import type { ActivityState } from '../../../core/src/activityLabel.js';
import {
  agentDisplayName,
  describeAgentActivity,
  subtaskLabel,
} from '../../../core/src/activityLabel.js';
import type { OfficeState } from './engine/officeState.js';
import type { ToolActivity } from './types.js';

export type ActivityRowKind = 'agent' | 'lead' | 'teammate' | 'subagent';

/** A Sub-agent Character as the message layer tracks it (SubagentCharacter). */
interface ActivitySubagent {
  readonly id: number;
  readonly parentAgentId: number;
  readonly parentToolId: string;
  readonly label: string;
}

/** One line of the Activity panel. */
export interface ActivityRow {
  /** Character id: positive for Agents, negative for Sub-agents. */
  readonly id: number;
  /** The Agent a click focuses: the row's own Agent, or a Sub-agent's parent. */
  readonly focusId: number;
  /** Nesting level: Sub-agents and Teammates sit one level under their Agent or Lead. */
  readonly depth: number;
  readonly kind: ActivityRowKind;
  readonly label: string;
  readonly activity: string;
  readonly state: ActivityState;
}

export interface ActivityRowsInput {
  readonly officeState: Pick<OfficeState, 'characters' | 'isCharacterVisible'>;
  /** Agent ids in the order the office learned about them. */
  readonly agents: readonly number[];
  readonly agentTools: Readonly<Record<number, readonly ToolActivity[]>>;
  readonly subagentTools: Readonly<
    Record<number, Readonly<Record<string, readonly ToolActivity[]>>>
  >;
  readonly subagentCharacters: readonly ActivitySubagent[];
}

/**
 * The Activity panel's rows: every visible Agent in office order, each followed
 * by its Sub-agents and then its Teammates (nested under their Lead). Hidden
 * Agents (unknown observation) and their Sub-agents are left out, like on the
 * canvas.
 */
export function buildActivityRows(input: ActivityRowsInput): ActivityRow[] {
  const { officeState } = input;
  const present = input.agents.filter(
    (id) => officeState.characters.has(id) && officeState.isCharacterVisible(id),
  );
  const presentIds = new Set(present);
  const teammatesByLead = new Map<number, number[]>();
  const roots: number[] = [];
  for (const id of present) {
    const leadId = officeState.characters.get(id)?.leadAgentId;
    if (leadId !== undefined && leadId !== id && presentIds.has(leadId)) {
      const teammates = teammatesByLead.get(leadId) ?? [];
      teammates.push(id);
      teammatesByLead.set(leadId, teammates);
    } else {
      roots.push(id);
    }
  }

  const rows: ActivityRow[] = [];
  const emitted = new Set<number>();
  const emit = (id: number, depth: number): void => {
    if (emitted.has(id)) return;
    emitted.add(id);
    rows.push(agentRow(input, id, depth));
    for (const sub of input.subagentCharacters) {
      if (sub.parentAgentId !== id) continue;
      const row = subagentRow(input, sub, depth + 1);
      if (row) rows.push(row);
    }
    for (const teammateId of teammatesByLead.get(id) ?? []) emit(teammateId, depth + 1);
  };
  for (const id of roots) emit(id, 0);
  // Lead links that loop back on themselves leave no root; list those Agents flat.
  for (const id of present) emit(id, 0);
  return rows;
}

function agentRow(input: ActivityRowsInput, id: number, depth: number): ActivityRow {
  const ch = input.officeState.characters.get(id);
  const activity = describeAgentActivity({
    tools: input.agentTools[id],
    isActive: ch?.isActive ?? false,
    needsApproval: ch?.bubbleType === 'permission',
    waitingForInput: ch?.waitingAwaitingInput === true,
  });
  return {
    id,
    focusId: id,
    depth,
    kind: ch?.isTeamLead ? 'lead' : ch?.leadAgentId !== undefined ? 'teammate' : 'agent',
    label: agentDisplayName(ch) || `Agent #${id}`,
    activity: activity.label,
    state: activity.state,
  };
}

function subagentRow(
  input: ActivityRowsInput,
  sub: ActivitySubagent,
  depth: number,
): ActivityRow | null {
  const ch = input.officeState.characters.get(sub.id);
  if (!ch || !input.officeState.isCharacterVisible(sub.id)) return null;
  // A Sub-agent exists only while its spawn runs, so between tools it is thinking.
  const activity = describeAgentActivity({
    tools: input.subagentTools[sub.parentAgentId]?.[sub.parentToolId],
    isActive: true,
    needsApproval: ch.bubbleType === 'permission',
  });
  // Sub-agents created by their first tool (not by the spawn) have no label of
  // their own; the spawn's "Subtask: …" status still names them.
  const spawn = input.agentTools[sub.parentAgentId]?.find(
    (tool) => tool.toolId === sub.parentToolId,
  );
  return {
    id: sub.id,
    focusId: sub.parentAgentId,
    depth,
    kind: 'subagent',
    label: sub.label || subtaskLabel(spawn?.status) || 'Sub-agent',
    activity: activity.label,
    state: activity.state,
  };
}

/**
 * Select a Character and point the camera at it, the way clicking it on the
 * canvas does. Returns false (and changes nothing) when the Character isn't shown.
 */
export function followCharacter(officeState: OfficeState, id: number): boolean {
  if (!officeState.isCharacterVisible(id)) return false;
  officeState.selectedAgentId = id;
  officeState.cameraFollowId = id;
  // Following an agent and following a pet are mutually exclusive.
  officeState.cameraFollowPetId = null;
  return true;
}
