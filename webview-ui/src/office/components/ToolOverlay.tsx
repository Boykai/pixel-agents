import { useEffect, useState } from 'react';

import {
  ACTIVITY_LABEL,
  agentDisplayName,
  describeAgentActivity,
} from '../../../../core/src/activityLabel.js';
import { AGENT_NICKNAME_MAX_LENGTH } from '../../../../core/src/constants.js';
import { normalizeNickname } from '../../../../core/src/normalizeNickname.js';
import { normalizeProjectName } from '../../../../core/src/normalizeProjectName.js';
import { Button } from '../../components/ui/Button.js';
import {
  AGENT_DETAILS_HIDE_DELAY_MS,
  AGENT_LABEL_EDGE_INSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { providerDisplayName } from '../toolUtils.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
  /** Rename an agent; '' clears its nickname. */
  onRenameAgent?: (id: number, nickname: string) => void;
  /** Open the Costume panel for an agent. */
  onOpenCostume?: (id: number) => void;
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
  onRenameAgent,
  onOpenCostume,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  const [pointerId, setPointerId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [recentHoverId, setRecentHoverId] = useState<number | null>(null);
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  const hoverTarget = pointerId ?? hoveredId;
  const detailId =
    [focusedId, hoverTarget, recentHoverId, selectedId].find(
      (id) => id !== null && officeState.isCharacterVisible(id),
    ) ?? null;

  useEffect(() => {
    if (hoverTarget !== null) {
      setRecentHoverId(hoverTarget);
      setDismissedId(null);
      return;
    }
    const timeout = window.setTimeout(() => setRecentHoverId(null), AGENT_DETAILS_HIDE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [hoverTarget]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDismissedId(detailId);
        setFocusedId(null);
        setPointerId(null);
        setRecentHoverId(null);
      }
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [detailId]);

  // Details moving to another agent (or closing) abandons an unfinished rename.
  const inspectedId = detailId !== dismissedId ? detailId : null;
  useEffect(() => {
    if (renamingId !== null && inspectedId !== renamingId) setRenamingId(null);
  }, [renamingId, inspectedId]);

  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  const overlays = allIds.flatMap((id) => {
    const ch = officeState.characters.get(id);
    if (!ch || !officeState.isCharacterVisible(id)) return [];

    const isSelected = selectedId === id;
    const isHovered = hoveredId === id;
    const isInspected = detailId === id && dismissedId !== id;
    const isSub = ch.isSubagent;

    // Position above character
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const screenX = project.toScreenX(ch.x);
    const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

    const subCharacter = isSub ? subagentCharacters.find((entry) => entry.id === id) : undefined;
    const parentCharacter = subCharacter
      ? officeState.characters.get(subCharacter.parentAgentId)
      : ch.leadAgentId !== undefined
        ? officeState.characters.get(ch.leadAgentId)
        : undefined;
    const projectName =
      normalizeProjectName(ch.folderName || parentCharacter?.folderName) || 'No project';

    // Get activity text
    const subHasPermission = isSub && ch.bubbleType === 'permission';
    let activityText: string;
    if (ch.waitingAwaitingInput) {
      // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
      // shows only the checkmark and falls through to the normal idle text.
      activityText = ACTIVITY_LABEL.waitingForInput;
    } else if (isSub) {
      if (subHasPermission) {
        activityText = ACTIVITY_LABEL.needsApproval;
      } else {
        const sub = subagentCharacters.find((s) => s.id === id);
        const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
        const activeRow =
          (isSelected || isInspected) && rows
            ? [...rows].reverse().find((t) => !t.done)
            : undefined;
        activityText = activeRow?.status ?? (sub?.label || 'Subtask');
      }
    } else {
      // Sticky: mid-turn, keep the last finished tool's status on the label.
      activityText = describeAgentActivity(
        {
          tools: agentTools[id],
          isActive: ch.isActive,
          needsApproval: ch.bubbleType === 'permission',
        },
        { sticky: true },
      ).label;
    }

    // Determine dot color
    const tools = agentTools[id];
    const hasPermission =
      ch.bubbleType === 'permission' || tools?.some((t) => t.permissionWait && !t.done);
    const hasActiveTools = tools?.some((t) => !t.done);
    const isActive = ch.isActive;
    const hasWaiting = ch.bubbleType === 'waiting' || ch.waitingAwaitingInput;

    let dotColor: string | null = null;
    if (hasPermission || hasWaiting) {
      dotColor = 'var(--color-status-permission)';
    } else if (isActive && hasActiveTools) {
      dotColor = 'var(--color-status-active)';
    }

    // Team info
    const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;

    // Context gauge. Every agent gets one — lead, teammate, adopted,
    // headless — as soon as it has taken a turn. Sub-agents never do: they
    // have no session of their own, so contextTokens stays 0.
    const contextRatio = ch.contextTokens / ch.maxContextTokens;
    const showContextGauge = !isSub && ch.contextTokens > 0 && ch.maxContextTokens > 0;

    return [
      {
        id,
        ch,
        isSelected,
        isHovered,
        isInspected,
        isSub,
        projectName,
        screenX,
        screenY,
        activityText,
        teamRoleLabel,
        dotColor,
        showContextGauge,
        contextRatio,
      },
    ];
  });
  const detail = overlays.find((overlay) => overlay.isInspected);
  const sub = detail?.isSub
    ? subagentCharacters.find((entry) => entry.id === detail.id)
    : undefined;
  const parent = sub ? officeState.characters.get(sub.parentAgentId) : undefined;
  const identity = agentDisplayName(detail?.ch) || (detail?.isSub ? 'Sub-agent' : 'Agent');
  // A nickname takes the heading; the name it displaced stays as secondary text.
  const displacedName = detail?.ch.nickname
    ? detail.ch.agentName || detail.ch.sessionName
    : undefined;
  const canRename = !!detail && !detail.isSub && !!onRenameAgent;
  const isRenaming = canRename && renamingId === detail.id;

  const startRename = (id: number, current: string) => {
    setRenameDraft(current);
    setRenamingId(id);
  };
  const commitRename = () => {
    if (renamingId === null) return;
    const id = renamingId;
    setRenamingId(null);
    const current = officeState.characters.get(id)?.nickname ?? '';
    if (normalizeNickname(renameDraft) !== current) onRenameAgent?.(id, renameDraft);
  };

  return (
    <>
      {overlays.map(
        ({
          id,
          ch,
          isSelected,
          isHovered,
          isInspected,
          isSub,
          projectName,
          screenX,
          screenY,
          activityText,
          teamRoleLabel,
          dotColor,
          showContextGauge,
          contextRatio,
        }) => {
          if (!alwaysShowOverlay && !isSelected && !isHovered && !isInspected) return null;
          return (
            <div
              key={id}
              className="absolute flex flex-col items-center"
              style={{
                left: Math.max(0, Math.min(screenX, el.clientWidth)),
                top: Math.max(AGENT_LABEL_EDGE_INSET_PX, Math.min(screenY, el.clientHeight)),
                transform:
                  screenX < el.clientWidth / 2 ? 'translateY(-100%)' : 'translate(-100%, -100%)',
                maxWidth: '100%',
                zIndex: isSelected ? 42 : 41,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
              data-activity={activityText}
            >
              <div className="agent-label pixel-panel">
                <button
                  type="button"
                  className="agent-label-inspect"
                  aria-label={`Inspect ${projectName}: ${ch.nickname || ch.agentName || ch.sessionName || (isSub ? 'sub-agent' : 'agent')}`}
                  aria-expanded={isInspected}
                  aria-controls={isInspected ? 'agent-details' : undefined}
                  onMouseEnter={() => setPointerId(id)}
                  onMouseLeave={() => setPointerId(null)}
                  onFocus={() => {
                    setFocusedId(id);
                    setDismissedId(null);
                  }}
                  onBlur={() => setFocusedId(null)}
                  onClick={() => {
                    setFocusedId(id);
                    setDismissedId(null);
                  }}
                >
                  {dotColor && (
                    <span className="w-6 h-6 shrink-0" style={{ background: dotColor }} />
                  )}
                  <span className="flex flex-col gap-0 overflow-hidden whitespace-nowrap">
                    {teamRoleLabel && (
                      <span
                        className="overflow-hidden text-ellipsis block leading-none"
                        style={{
                          fontSize: '16px',
                          color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                          fontWeight: ch.isTeamLead ? 'bold' : undefined,
                        }}
                      >
                        {teamRoleLabel}
                      </span>
                    )}
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        fontStyle: isSub ? 'italic' : undefined,
                      }}
                    >
                      {ch.nickname || projectName}
                    </span>
                    {ch.nickname && (
                      <span className="overflow-hidden text-ellipsis block leading-none text-2xs text-text-muted">
                        {projectName}
                      </span>
                    )}
                  </span>
                </button>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          );
        },
      )}
      {detail && (
        <section
          id="agent-details"
          aria-label="Agent details"
          tabIndex={0}
          className="agent-details pixel-panel pixel-scrollbar"
          data-testid="agent-details"
          data-agent-id={detail.id}
          onMouseEnter={() => setPointerId(detail.id)}
          onMouseLeave={() => setPointerId(null)}
          onFocusCapture={() => setFocusedId(detail.id)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
          }}
        >
          <div className="flex items-start justify-between gap-12">
            {isRenaming ? (
              <input
                type="text"
                aria-label="Nickname"
                placeholder="Nickname"
                value={renameDraft}
                maxLength={AGENT_NICKNAME_MAX_LENGTH}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  // Typing must not reach the editor shortcuts or the details' Escape.
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    setRenamingId(null);
                  }
                }}
                className="flex-1 min-w-0 text-sm py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
              />
            ) : (
              <div className="min-w-0">
                <h2 className="text-base leading-tight m-0 min-w-0 wrap-anywhere">{identity}</h2>
                {displacedName && (
                  <p className="m-0 mt-2 text-xs leading-tight text-text-muted wrap-anywhere">
                    {displacedName}
                  </p>
                )}
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              title="Hide agent details"
              aria-label="Hide agent details"
              onClick={() => {
                setDismissedId(detail.id);
                setFocusedId(null);
                setPointerId(null);
                setRecentHoverId(null);
              }}
            >
              ×
            </Button>
          </div>
          <p className="agent-details-activity">{detail.activityText}</p>
          <dl className="agent-details-facts">
            {(detail.ch.folderName || parent?.folderName) && (
              <>
                <dt>Project</dt>
                <dd>{detail.projectName}</dd>
              </>
            )}
            {(detail.ch.sessionName || parent?.sessionName) && (
              <>
                <dt>Session</dt>
                <dd>{detail.ch.sessionName || parent?.sessionName}</dd>
              </>
            )}
            <dt>Role</dt>
            <dd>
              {detail.isSub
                ? 'Sub-agent'
                : detail.ch.isTeamLead
                  ? 'Lead'
                  : detail.ch.agentName
                    ? 'Teammate'
                    : 'Agent'}
            </dd>
            {sub && (
              <>
                <dt>Task</dt>
                <dd>{sub.label}</dd>
              </>
            )}
            {parent && (
              <>
                <dt>Parent</dt>
                <dd>{agentDisplayName(parent) || 'Agent'}</dd>
              </>
            )}
            {detail.ch.providerId && (
              <>
                <dt>Source</dt>
                <dd>{providerDisplayName(detail.ch.providerId)}</dd>
              </>
            )}
            {detail.showContextGauge && (
              <>
                <dt>Context</dt>
                <dd>
                  {Math.round(detail.contextRatio * 100)}% used (
                  {(detail.ch.contextTokens / 1000).toFixed(0)}k of{' '}
                  {(detail.ch.maxContextTokens / 1000).toFixed(0)}k tokens)
                </dd>
              </>
            )}
          </dl>
          {!detail.isSub && (canRename || onOpenCostume) && (
            <div className="flex gap-4 mt-12">
              {canRename && !isRenaming && (
                <Button
                  size="sm"
                  title="Give this agent a nickname"
                  onClick={() => startRename(detail.id, detail.ch.nickname ?? '')}
                >
                  Rename
                </Button>
              )}
              {onOpenCostume && (
                <Button
                  size="sm"
                  title="Change this agent's costume"
                  onClick={() => onOpenCostume(detail.id)}
                >
                  Costume
                </Button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
