/**
 * The VS Code Activity Quick Pick's rows, built from the server's AgentStateStore
 * and the activity it broadcasts.
 *
 * Pure (no `vscode` at runtime) so the server test runner can pin it. The rows
 * mirror the webview Activity panel: every shown Agent, its Sub-agents one level
 * down, and its Teammates nested under it as their Lead, each with an Activity
 * label from the shared precedence in core/src/activityLabel.ts.
 */
import type { ActivityState, ActivityTool, AgentActivity } from '../../core/src/activityLabel.js';
import {
  agentDisplayName,
  describeAgentActivity,
  subtaskLabel,
} from '../../core/src/activityLabel.js';
import type { HookProvider } from '../../core/src/provider.js';
import { resendAgentActivity } from '../../server/src/agentActivityResend.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import { hasPromotedBackgroundAgent } from '../../server/src/teamUtils.js';
import type { AgentState } from '../../server/src/types.js';
import {
  ACTIVITY_QUICK_PICK_DETAIL_SEPARATOR,
  ACTIVITY_QUICK_PICK_INDENT,
  ACTIVITY_QUICK_PICK_NESTED_ICON,
  ACTIVITY_QUICK_PICK_STATE_ICONS,
} from './constants.js';

interface ToolActivity {
  readonly status: string;
  done: boolean;
}

interface SpawnActivity {
  /** Sub-tools in start order; finished ones stay, marked done (as in the webview). */
  readonly tools: Map<string, ToolActivity>;
  needsApproval: boolean;
}

/** Record a tool start once; a re-sent start never revives a finished tool (as in the webview). */
function startTool(tools: Map<string, ToolActivity>, toolId: string, status: unknown): void {
  if (!tools.has(toolId)) tools.set(toolId, { status: String(status ?? ''), done: false });
}

/**
 * The tool activity the office shows, per Agent: its own tools, and each of its
 * spawns' Sub-agent tools.
 *
 * AgentState can't give the rows this. It keeps an Agent's tools as its
 * transcript records them, while with hooks the office shows the hook events'
 * tools, which start and end sooner and need no transcript record at all. And
 * it records Sub-agent tools by name only, without the status text a row shows
 * ("Reading foo.ts"). So this replays the store's broadcast stream the same way
 * the webview's message handler does.
 */
export class ActivityTracker {
  /** Each Agent's own tools in start order; finished ones stay, marked done, until its turn ends. */
  private readonly tools = new Map<number, Map<string, ToolActivity>>();
  private readonly spawns = new Map<number, Map<string, SpawnActivity>>();

  /** @param backgroundSpawns an Agent's live background spawn tool ids, which survive its turn end. */
  constructor(
    private readonly backgroundSpawns: (agentId: number) => ReadonlySet<string> | undefined,
  ) {}

  observe(message: Record<string, unknown>): void {
    const { id, parentToolId, toolId } = message;
    if (typeof id !== 'number') return;
    const spawnId = typeof parentToolId === 'string' ? parentToolId : undefined;
    switch (message.type) {
      case 'agentToolStart': {
        if (typeof toolId !== 'string') return;
        let tools = this.tools.get(id);
        if (!tools) this.tools.set(id, (tools = new Map()));
        startTool(tools, toolId, message.status);
        return;
      }
      case 'agentToolDone': {
        if (typeof toolId !== 'string') return;
        const tool = this.tools.get(id)?.get(toolId);
        if (tool) tool.done = true;
        return;
      }
      case 'subagentToolStart': {
        if (spawnId === undefined || typeof toolId !== 'string') return;
        startTool(this.spawn(id, spawnId).tools, toolId, message.status);
        return;
      }
      case 'subagentToolDone': {
        if (spawnId === undefined || typeof toolId !== 'string') return;
        const tool = this.spawns.get(id)?.get(spawnId)?.tools.get(toolId);
        if (tool) tool.done = true;
        return;
      }
      case 'subagentToolPermission':
        if (spawnId !== undefined) this.spawn(id, spawnId).needsApproval = true;
        return;
      case 'agentToolPermissionClear': {
        const spawns = this.spawns.get(id);
        if (!spawns) return;
        if (spawnId !== undefined) {
          const spawn = spawns.get(spawnId);
          if (spawn) spawn.needsApproval = false;
          return;
        }
        for (const spawn of spawns.values()) spawn.needsApproval = false;
        return;
      }
      case 'subagentClear':
        if (spawnId !== undefined) this.dropSpawn(id, spawnId);
        return;
      case 'agentToolsClear': {
        this.tools.delete(id);
        // The parent's turn ended: only background spawns outlive it.
        const spawns = this.spawns.get(id);
        if (!spawns) return;
        const background = this.backgroundSpawns(id);
        for (const key of [...spawns.keys()]) {
          if (!background?.has(key)) spawns.delete(key);
        }
        if (spawns.size === 0) this.spawns.delete(id);
        return;
      }
    }
  }

  /** Drop everything known about an Agent that left the office. */
  forget(agentId: number): void {
    this.tools.delete(agentId);
    this.spawns.delete(agentId);
  }

  /**
   * Take in the activity of the Agents restore just added. Restore fills in
   * their tools without broadcasting them; the office gets them in the replay
   * it's sent once its layout loads, and this takes in that same replay. Never
   * pass Agents that were already in the store: their replay is stale, since it
   * re-sends the transcript's tool ids, which hooks mode ends without a broadcast.
   */
  hydrateRestored(store: AgentStateStore, agentIds: readonly number[]): void {
    for (const id of agentIds) resendAgentActivity((message) => this.observe(message), store, id);
  }

  /** An Agent's own tools in start order, as its Character shows them. */
  agentTools(agentId: number): ActivityTool[] {
    return [...(this.tools.get(agentId)?.values() ?? [])];
  }

  /** Has this spawn reported any Sub-agent activity? */
  hasSubagentActivity(agentId: number, spawnToolId: string): boolean {
    return this.spawns.get(agentId)?.has(spawnToolId) === true;
  }

  describeSubagent(agentId: number, spawnToolId: string): AgentActivity {
    const spawn = this.spawns.get(agentId)?.get(spawnToolId);
    // A Sub-agent exists only while its spawn runs, so between tools it is thinking.
    return describeAgentActivity({
      tools: spawn ? [...spawn.tools.values()] : undefined,
      isActive: true,
      needsApproval: spawn?.needsApproval,
    });
  }

  private spawn(agentId: number, spawnToolId: string): SpawnActivity {
    let spawns = this.spawns.get(agentId);
    if (!spawns) this.spawns.set(agentId, (spawns = new Map()));
    let spawn = spawns.get(spawnToolId);
    if (!spawn) spawns.set(spawnToolId, (spawn = { tools: new Map(), needsApproval: false }));
    return spawn;
  }

  private dropSpawn(agentId: number, spawnToolId: string): void {
    const spawns = this.spawns.get(agentId);
    if (!spawns) return;
    spawns.delete(spawnToolId);
    if (spawns.size === 0) this.spawns.delete(agentId);
  }
}

export type ActivityQuickPickRowKind = 'agent' | 'lead' | 'teammate' | 'subagent';

/** One line of the Activity Quick Pick. */
export interface ActivityQuickPickRow {
  /** Stable across refreshes, so the highlighted row survives a rebuild. */
  readonly key: string;
  /** The Agent that accepting the row shows: its own, or a Sub-agent's parent. */
  readonly agentId: number;
  /** Nesting level: Sub-agents and Teammates sit one level under their Agent or Lead. */
  readonly depth: number;
  readonly kind: ActivityQuickPickRowKind;
  readonly name: string;
  readonly activity: string;
  readonly state: ActivityState;
  /** Secondary line: role, provider, and where the Agent runs. */
  readonly detail: string;
}

/** What the rows need from each enabled provider. */
export type ActivityProviderInfo = Pick<HookProvider, 'id' | 'displayName' | 'subagentToolNames'>;

/**
 * Every shown Agent in the order the store learned about it, each followed by
 * its Sub-agents and then its Teammates. Agents whose state is unknown are left
 * out, as the office hides their Characters.
 */
export function buildActivityQuickPickRows(
  store: AgentStateStore,
  activity: ActivityTracker,
  providers: readonly ActivityProviderInfo[],
): ActivityQuickPickRow[] {
  const shown = [...store.values()].filter((agent) => agent.observation !== 'unknown');
  const shownIds = new Set(shown.map((agent) => agent.id));
  const teammatesByLead = new Map<number, AgentState[]>();
  const roots: AgentState[] = [];
  for (const agent of shown) {
    const leadId = agent.leadAgentId;
    if (leadId !== undefined && leadId !== agent.id && shownIds.has(leadId)) {
      const teammates = teammatesByLead.get(leadId) ?? [];
      teammates.push(agent);
      teammatesByLead.set(leadId, teammates);
    } else {
      roots.push(agent);
    }
  }

  const rows: ActivityQuickPickRow[] = [];
  const emitted = new Set<number>();
  const emit = (agent: AgentState, depth: number): void => {
    if (emitted.has(agent.id)) return;
    emitted.add(agent.id);
    const provider = providers.find((p) => p.id === (agent.providerId ?? 'claude'));
    rows.push(agentRow(agent, depth, provider, activity));
    rows.push(...subagentRows(agent, depth + 1, provider, store, activity));
    for (const teammate of teammatesByLead.get(agent.id) ?? []) emit(teammate, depth + 1);
  };
  for (const agent of roots) emit(agent, 0);
  // Lead links that loop back on themselves leave no root; each loop starts at its first Agent.
  for (const agent of shown) emit(agent, 0);
  return rows;
}

function agentName(agent: AgentState): string {
  return agentDisplayName(agent) || `Agent #${agent.id}`;
}

function agentRow(
  agent: AgentState,
  depth: number,
  provider: ActivityProviderInfo | undefined,
  tracker: ActivityTracker,
): ActivityQuickPickRow {
  const activity = describeAgentActivity({
    tools: tracker.agentTools(agent.id),
    isActive: !agent.isWaiting,
    needsApproval: agent.permissionSent,
    waitingForInput: agent.isWaiting && agent.awaitingInput === true,
  });
  const kind: ActivityQuickPickRowKind = agent.isTeamLead
    ? 'lead'
    : agent.leadAgentId !== undefined
      ? 'teammate'
      : 'agent';
  const role = kind === 'lead' ? 'Lead' : kind === 'teammate' ? 'Teammate' : undefined;
  // A Teammate without a terminal runs inside its Lead's session, so it isn't headless.
  const where = agent.terminalRef?.name ?? (kind === 'teammate' ? undefined : 'Headless');
  return {
    key: `agent:${agent.id}`,
    agentId: agent.id,
    depth,
    kind,
    name: agentName(agent),
    activity: activity.label,
    state: activity.state,
    detail: [role, provider?.displayName ?? agent.providerId, where]
      .filter((part): part is string => !!part)
      .join(ACTIVITY_QUICK_PICK_DETAIL_SEPARATOR),
  };
}

/**
 * One row per running spawn tool that the office shows as a Sub-agent. Named
 * spawns are Teammates with rows of their own. A teamed Lead's background spawn
 * becomes a Sub-agent only once it reports its own tools, as in the office.
 */
function subagentRows(
  agent: AgentState,
  depth: number,
  provider: ActivityProviderInfo | undefined,
  store: AgentStateStore,
  tracker: ActivityTracker,
): ActivityQuickPickRow[] {
  if (!provider) return [];
  const rows: ActivityQuickPickRow[] = [];
  for (const [toolId, toolName] of agent.activeToolNames) {
    if (!provider.subagentToolNames.has(toolName)) continue;
    if (agent.teammateSpawnToolIds?.has(toolId)) continue;
    if (hasPromotedBackgroundAgent(agent.id, toolId, store)) continue;
    if (
      agent.teamName &&
      agent.backgroundAgentToolIds.has(toolId) &&
      !tracker.hasSubagentActivity(agent.id, toolId)
    ) {
      continue;
    }
    const activity = tracker.describeSubagent(agent.id, toolId);
    rows.push({
      key: `subagent:${agent.id}:${toolId}`,
      agentId: agent.id,
      depth,
      kind: 'subagent',
      name: subtaskLabel(agent.activeToolStatuses.get(toolId)) || 'Sub-agent',
      activity: activity.label,
      state: activity.state,
      detail: `Sub-agent of ${agentName(agent)}`,
    });
  }
  return rows;
}

/** A Quick Pick line that isn't an Agent. */
export type ActivityQuickPickNotice = 'openOffice' | 'empty';

/**
 * The line to add after the rows, if any. Agent restore and session discovery
 * start with the office's first load in a window, so until then only Agents
 * launched from the shortcuts are known: offer to open the office instead of
 * claiming there are no other Agents.
 */
export function activityQuickPickNotice(
  rowCount: number,
  discoveryStarted: boolean,
): ActivityQuickPickNotice | undefined {
  if (!discoveryStarted) return 'openOffice';
  return rowCount === 0 ? 'empty' : undefined;
}

/** The Quick Pick item text for a row: indented label with a state icon, activity, detail. */
export function activityQuickPickItem(row: ActivityQuickPickRow): {
  label: string;
  description: string;
  detail: string;
} {
  const nested = row.depth > 0 ? `${ACTIVITY_QUICK_PICK_NESTED_ICON} ` : '';
  return {
    label: `${ACTIVITY_QUICK_PICK_INDENT.repeat(row.depth)}${nested}${ACTIVITY_QUICK_PICK_STATE_ICONS[row.state]} ${row.name}`,
    description: row.activity,
    detail: row.detail,
  };
}
