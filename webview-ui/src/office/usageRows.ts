import type { AgentUsage } from '../../../core/src/messages.js';
import type { OfficeState } from './engine/officeState.js';

/**
 * The Usage panel's rows: every Agent with recorded usage, in office order,
 * whose Character the office shows. A hidden Agent (unknown observation) has
 * no row, and adds nothing to the totals, until it is observed again, as on
 * the canvas and in the Activity panel.
 */
export function usageRowIds(
  agents: readonly number[],
  agentUsage: Readonly<Record<number, AgentUsage | undefined>>,
  officeState: Pick<OfficeState, 'isCharacterVisible'>,
): number[] {
  return agents.filter((id) => agentUsage[id] !== undefined && officeState.isCharacterVisible(id));
}
