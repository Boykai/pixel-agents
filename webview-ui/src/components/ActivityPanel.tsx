import { useEffect, useState } from 'react';

import type { ActivityState } from '../../../core/src/activityLabel.js';
import {
  ACTIVITY_PANEL_INDENT_PX,
  ACTIVITY_PANEL_REFRESH_MS,
  ACTIVITY_PANEL_ROW_PADDING_PX,
  TEAM_LEAD_COLOR,
} from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import type { ActivityRow } from '../office/activityRows.js';
import { buildActivityRows, followCharacter } from '../office/activityRows.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface ActivityPanelProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  onClose: () => void;
}

/** Status dot per state: pulsing while Active, amber while blocked on the user, green when Done. */
const DOT_CLASS: Record<ActivityState, string> = {
  active: 'bg-status-active pixel-pulse',
  permission: 'bg-status-permission',
  input: 'bg-status-permission',
  done: 'bg-status-success',
};

/**
 * The Activity panel: one row per Agent with its Activity label, its Sub-agents
 * and Teammates nested underneath. Clicking a row selects and follows the
 * Character and focuses its terminal, like clicking the Character itself.
 */
export function ActivityPanel({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  onClose,
}: ActivityPanelProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((n) => n + 1), ACTIVITY_PANEL_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, []);

  const rows = buildActivityRows({
    officeState,
    agents,
    agentTools,
    subagentTools,
    subagentCharacters,
  });

  const handleRowClick = (row: ActivityRow) => {
    followCharacter(officeState, row.id);
    transport.send({ type: 'focusAgent', id: row.focusId });
  };

  return (
    // z-44: above the Characters' floating labels (41-43), below the Intro bubble (45) and modals.
    <section
      aria-label="Activity"
      data-testid="activity-panel"
      className="absolute above-bottom-toolbar left-10 z-44 pixel-panel pixel-scrollbar w-320 max-w-[calc(100%-20px)] clear-of-bottom-toolbar overflow-y-auto pb-6"
    >
      <div className="flex items-center justify-between py-4 px-10 border-b border-border mb-4">
        <h2 className="m-0 text-lg leading-none font-normal text-accent-bright">Activity</h2>
        <Button
          variant="ghost"
          size="icon"
          title="Close activity"
          aria-label="Close activity"
          onClick={onClose}
        >
          x
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 py-6 px-14 text-text-muted">No active agents</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {rows.map((row) => {
            const isSub = row.kind === 'subagent';
            const isSelected = officeState.selectedAgentId === row.id;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  data-testid="activity-row"
                  data-agent-id={row.id}
                  data-kind={row.kind}
                  data-activity={row.activity}
                  title={`${row.label}: ${row.activity}`}
                  aria-current={isSelected || undefined}
                  onClick={() => handleRowClick(row)}
                  className={`flex w-full min-w-0 items-center gap-6 py-4 pr-10 text-left leading-tight text-text border-0 rounded-none cursor-pointer hover:bg-btn-hover ${isSelected ? 'bg-active-bg' : 'bg-transparent'} ${isSub ? 'text-sm italic' : 'text-base'}`}
                  style={{
                    paddingLeft:
                      ACTIVITY_PANEL_ROW_PADDING_PX + row.depth * ACTIVITY_PANEL_INDENT_PX,
                  }}
                >
                  <span aria-hidden="true" className={`w-6 h-6 shrink-0 ${DOT_CLASS[row.state]}`} />
                  {row.kind === 'lead' && (
                    <span
                      className="shrink-0 text-2xs font-bold"
                      style={{ color: TEAM_LEAD_COLOR }}
                    >
                      LEAD
                    </span>
                  )}
                  <span className={`min-w-0 truncate ${isSub ? 'text-text-muted' : ''}`}>
                    {row.label}
                  </span>
                  <span className="ml-auto min-w-0 max-w-[60%] pl-8 truncate text-right text-sm text-text-muted">
                    {row.activity}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
