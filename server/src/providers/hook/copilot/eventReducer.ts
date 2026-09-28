import type { AgentStateStore } from '../../../agentStateStore.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../../timerManager.js';
import type { AgentState } from '../../../types.js';
import { formatToolStatus } from './copilot.js';

// Payload evidence: github/copilot-sdk@075f027363fc3b1e904d09370763731c3ecd2d88,
// nodejs/src/generated/session-events.ts. This is a format reference, NOT an
// assertion that installed CLI/App versions emit its optional/ephemeral events.
const MAX_REMEMBERED_EVENTS = 4096;
const MAX_TRACKED_ENTRIES = 4096;
const HOOK_REQUEST_PREFIX = 'pixel-agents:copilot-hook';

export type CopilotActivity = 'active' | 'done' | 'input' | 'permission' | 'unknown';

export interface CopilotChild {
  parentToolId: string;
  agentId?: string;
  /** Only task arguments.name is a user-assigned name; agentName may be a type. */
  name?: string;
  background: boolean;
}

export interface CopilotRecordOptions {
  /** Hydrate state without historical status/tool/permission broadcasts. */
  replay?: boolean;
  source?: 'transcript' | 'hook' | 'bridge';
  /** Supplied only by a source with verified execution-generation identity. */
  generation?: string;
  onObservation?: (activity: CopilotActivity) => void;
  onChild?: (event: CopilotChild & { kind: 'started' | 'completed' }) => void;
  /** Return true only when a promoted Teammate consumed this activity record. */
  onChildRecord?: (child: CopilotChild, record: Record<string, unknown>) => boolean;
}

interface Tool {
  id: string;
  name: string;
  status: string;
  turnId?: string;
  parentToolId?: string;
  source?: CopilotRecordOptions['source'];
}

interface Request {
  requestId?: string;
  toolId?: string;
  parentToolId?: string;
  agentId?: string;
  hookOnly?: boolean;
  observedAt?: number;
}

interface CopilotState {
  activity: CopilotActivity;
  mainIdle: boolean;
  mainStopped: boolean;
  mainStopAt?: number;
  generation?: string;
  retiredGenerations: Set<string>;
  turnId?: string;
  retiredTurns: Set<string>;
  tools: Map<string, Tool>;
  children: Map<string, CopilotChild>;
  childTools: Map<string, string>;
  taskNames: Map<string, string>;
  spawnTools: Map<string, Tool>;
  permissions: Map<string, Request>;
  permissionChildren: Set<string>;
  inputs: Map<string, Request>;
  seen: Set<string>;
  completedTools: Set<string>;
  completedRequests: Set<string>;
  completedChildren: Set<string>;
  latestActivityAt?: number;
  latestContextAt?: number;
  latestTitleAt?: number;
  contextKnown: boolean;
  historyComplete: boolean;
}

const states = new WeakMap<AgentState, CopilotState>();

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toolKey(toolId: string, parentToolId?: string): string {
  return JSON.stringify([parentToolId ?? null, toolId]);
}

/**
 * Convert only bridge fields whose meaning is known. No prompts, results,
 * generated correlation IDs or permission decisions enter the reducer.
 */
export function hookToCopilotRecords(raw: unknown): Record<string, unknown>[] {
  const hook = objectValue(raw);
  if (!hook || !text(hook.sessionId)) return [];
  const numericTimestamp =
    typeof hook.timestamp === 'number' ? new Date(hook.timestamp) : undefined;
  const timestamp =
    typeof hook.timestamp === 'string' && Number.isFinite(Date.parse(hook.timestamp))
      ? { timestamp: hook.timestamp }
      : numericTimestamp && Number.isFinite(numericTimestamp.getTime())
        ? { timestamp: numericTimestamp.toISOString() }
        : {};
  const agentId = text(hook.agentId);
  const parentToolCallId = text(hook.parentToolCallId);
  const scope = agentId ? { agentId } : {};
  const parent = parentToolCallId ? { parentToolCallId } : {};
  const eventId = text(hook.eventId);
  const identity = eventId ? { id: eventId } : {};
  const hookType = text(hook.hookType);
  if (hookType === 'userPromptSubmitted' || hookType === 'agentStop') {
    return [
      { type: 'hook.start', data: { hookType, ...parent }, ...scope, ...timestamp, ...identity },
    ];
  }
  if (hookType === 'notification') {
    const notificationType = text(hook.notification_type) ?? text(hook.notificationType);
    const kind =
      notificationType === 'permission_prompt'
        ? 'permission'
        : notificationType === 'elicitation_dialog'
          ? 'input'
          : undefined;
    if (!kind) return [];
    const toolCallId = text(hook.toolCallId);
    const nativeRequestId = text(hook.requestId);
    // Internal reusable slot, explicitly NOT a fabricated native request ID.
    const requestId =
      nativeRequestId ??
      `${HOOK_REQUEST_PREFIX}:${JSON.stringify([kind, agentId ?? null, parentToolCallId ?? null, toolCallId ?? null])}`;
    return [
      {
        type: kind === 'permission' ? 'permission.requested' : 'user_input.requested',
        data: {
          requestId,
          ...parent,
          ...(!nativeRequestId ? { hookOnly: true } : {}),
          ...(toolCallId ? { toolCallId } : {}),
          ...(kind === 'permission' ? { permissionRequest: toolCallId ? { toolCallId } : {} } : {}),
        },
        ...scope,
        ...timestamp,
        ...identity,
      },
    ];
  }
  // Documented tool hooks have no call ID. Never pair by name/order or treat
  // an undocumented ID as correlation evidence; transcripts own tool activity.
  // sessionStart stays in runtime discovery; sessionEnd is never destruction.
  return [];
}

/** Singular compatibility seam: reject a batch rather than silently dropping calls. */
export function hookToCopilotRecord(raw: unknown): Record<string, unknown> | undefined {
  const records = hookToCopilotRecords(raw);
  return records.length === 1 ? records[0] : undefined;
}

function newState(generation?: string): CopilotState {
  return {
    activity: 'unknown',
    mainIdle: false,
    mainStopped: false,
    generation,
    retiredGenerations: new Set(),
    tools: new Map(),
    children: new Map(),
    childTools: new Map(),
    taskNames: new Map(),
    spawnTools: new Map(),
    permissions: new Map(),
    permissionChildren: new Set(),
    inputs: new Map(),
    seen: new Set(),
    completedTools: new Set(),
    completedRequests: new Set(),
    completedChildren: new Set(),
    contextKnown: false,
    historyComplete: true,
    retiredTurns: new Set(),
  };
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > MAX_REMEMBERED_EVENTS) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

type Emit = (message: Record<string, unknown>) => void;

function publishActivity(
  state: CopilotState,
  agent: AgentState,
  activity: CopilotActivity,
  emit: Emit,
  onObservation?: CopilotRecordOptions['onObservation'],
): void {
  const changed = state.activity !== activity;
  state.activity = activity;
  const previousObservation = agent.observation;
  agent.observation = activity === 'unknown' ? 'unknown' : 'known';
  agent.isWaiting = activity === 'done' || activity === 'input';
  agent.awaitingInput = activity === 'input';
  if (previousObservation !== agent.observation) {
    emit({ type: 'agentObservation', id: agent.id, observation: agent.observation });
  }
  if (!changed) return;
  onObservation?.(activity);
  if (activity === 'unknown') {
    emit({ type: 'agentStatus', id: agent.id, status: 'unknown' });
  } else {
    emit({
      type: 'agentStatus',
      id: agent.id,
      status: agent.isWaiting ? 'waiting' : 'active',
      ...(agent.isWaiting ? { awaitingInput: activity === 'input' } : {}),
    });
  }
}

function reconcileActivity(
  state: CopilotState,
  agent: AgentState,
  emit: Emit,
  onObservation?: CopilotRecordOptions['onObservation'],
): void {
  // A stopped main interaction plus no independent work is matching completion
  // evidence for root hook-only hints. It never resolves richer native requests.
  if (state.mainStopped && state.children.size === 0 && state.tools.size === 0) {
    for (const requests of [state.inputs, state.permissions]) {
      for (const [key, request] of requests) {
        if (
          request.hookOnly &&
          !request.parentToolId &&
          !request.agentId &&
          !(
            state.mainStopAt !== undefined &&
            request.observedAt !== undefined &&
            state.mainStopAt < request.observedAt
          )
        )
          requests.delete(key);
      }
    }
  }
  const permission = state.permissions.size > 0;
  if (agent.permissionSent !== permission) {
    agent.permissionSent = permission;
    emit({ type: permission ? 'agentToolPermission' : 'agentToolPermissionClear', id: agent.id });
  }
  const pendingChildren = new Set<string>();
  for (const request of state.permissions.values()) {
    if (request.parentToolId) pendingChildren.add(request.parentToolId);
  }
  if (permission) {
    for (const parentToolId of state.permissionChildren) {
      if (!pendingChildren.has(parentToolId)) {
        emit({ type: 'agentToolPermissionClear', id: agent.id, parentToolId });
      }
    }
    for (const parentToolId of pendingChildren) {
      if (!state.permissionChildren.has(parentToolId)) {
        emit({ type: 'subagentToolPermission', id: agent.id, parentToolId });
      }
    }
  }
  state.permissionChildren = pendingChildren;
  publishActivity(
    state,
    agent,
    permission
      ? 'permission'
      : state.inputs.size > 0
        ? 'input'
        : state.mainIdle && state.children.size === 0 && state.tools.size === 0
          ? state.historyComplete
            ? 'done'
            : 'unknown'
          : 'active',
    emit,
    onObservation,
  );
}

/** Pending requests follow the teammate that will receive their live completions. */
export function promoteCopilotChildRequests(
  lead: AgentState,
  teammate: AgentState,
  child: CopilotChild,
  emit: Emit,
): void {
  const state = states.get(lead);
  if (!state) return;
  const target = states.get(teammate) ?? newState();
  let transferred = false;
  for (const kind of ['permissions', 'inputs'] as const) {
    for (const [key, request] of state[kind]) {
      if (
        request.parentToolId !== child.parentToolId &&
        (!child.agentId || request.agentId !== child.agentId)
      )
        continue;
      const localKey = request.requestId
        ? `${kind === 'permissions' ? 'permission' : 'input'}:${toolKey(request.requestId)}`
        : `tool:${toolKey(request.toolId!)}`;
      target[kind].set(localKey, { ...request, parentToolId: undefined, agentId: undefined });
      state[kind].delete(key);
      transferred = true;
    }
  }
  if (!transferred) return;
  states.set(teammate, target);
  const unknown = lead.observation === 'unknown';
  const hadPermission = lead.permissionSent;
  reconcileActivity(target, teammate, () => {});
  reconcileActivity(state, lead, unknown ? () => {} : emit);
  if (unknown) {
    markCopilotObservationUnknown(lead);
    if (hadPermission && !lead.permissionSent)
      emit({ type: 'agentToolPermissionClear', id: lead.id });
  }
}

export function getCopilotActivity(agent: AgentState): CopilotActivity {
  return states.get(agent)?.activity ?? 'unknown';
}

/** Current state only: adapters can materialize children after silent recovery. */
export function getCopilotSnapshot(agent: AgentState): {
  activity: CopilotActivity;
  mainIdle: boolean;
  children: CopilotChild[];
  context?: { contextTokens: number; maxContextTokens: number };
} {
  const state = states.get(agent);
  return {
    activity: state?.activity ?? 'unknown',
    mainIdle: state?.mainIdle ?? false,
    children: [...(state?.children.values() ?? [])].map((child) => ({ ...child })),
    ...(state?.contextKnown
      ? {
          context: { contextTokens: agent.contextTokens, maxContextTokens: agent.maxContextTokens },
        }
      : {}),
  };
}

/** Recovery callers use this when the bounded suffix cannot establish preceding state. */
export function markCopilotObservationUnknown(agent: AgentState): void {
  const state = states.get(agent) ?? newState();
  state.activity = 'unknown';
  state.historyComplete = false;
  states.set(agent, state);
  agent.observation = 'unknown';
  agent.isWaiting = false;
  agent.awaitingInput = false;
}

/** Reset is explicit: neither transcript sessionEnd hooks nor quiet time is termination. */
export function resetCopilotObservation(agent: AgentState): void {
  states.delete(agent);
  agent.activeToolIds.clear();
  agent.activeToolStatuses.clear();
  agent.activeToolNames.clear();
  agent.activeSubagentToolIds.clear();
  agent.activeSubagentToolNames.clear();
  agent.backgroundAgentToolIds.clear();
  agent.teammateSpawnToolIds?.clear();
  agent.isWaiting = false;
  agent.awaitingInput = false;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  agent.observation = 'unknown';
  agent.contextTokens = 0;
  agent.maxContextTokens = 0;
}

/**
 * Observation-only reducer shared by transcript recovery and explicitly correlated
 * rich events. No timers infer permission, no source approves a request, and no
 * transcript record removes an agent. Event IDs deduplicate across sources;
 * per-tool/request tombstones also prevent completion-before-start resurrection.
 */
export function processCopilotRecord(
  agentId: number,
  record: Record<string, unknown>,
  agent: AgentState,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  options: CopilotRecordOptions = {},
): void {
  const type = text(record.type);
  const data = objectValue(record.data);
  if (!type || !data) return;
  const hookRequest = options.source === 'hook' && data.hookOnly === true;
  // App transcript agentStop is an observed interaction boundary, never session
  // termination. sessionEnd also occurs after interactions and is ignored.
  const hookType = type === 'hook.start' ? text(data.hookType) : undefined;
  if (
    type === 'hook.end' ||
    type === 'session.shutdown' ||
    (type === 'hook.start' && hookType !== 'agentStop' && hookType !== 'userPromptSubmitted')
  )
    return;

  let state = states.get(agent);
  if (state && options.generation !== undefined && state.generation !== options.generation) {
    if (state.retiredGenerations.has(options.generation)) return;
    const retired = new Set(state.retiredGenerations);
    if (state.generation !== undefined) remember(retired, state.generation);
    if (!options.replay) {
      for (const child of state.children.values()) {
        agents.broadcast({ type: 'subagentClear', id: agentId, parentToolId: child.parentToolId });
        options.onChild?.({ ...child, kind: 'completed' });
      }
      agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      agents.broadcast({ type: 'agentToolsClear', id: agentId });
    }
    resetCopilotObservation(agent);
    state = newState(options.generation);
    state.retiredGenerations = retired;
    states.set(agent, state);
  }
  if (!state) {
    state = newState(options.generation);
    states.set(agent, state);
  }
  const eventId = text(record.id);
  if (eventId && state.seen.has(eventId)) return;
  if (eventId) remember(state.seen, eventId);
  cancelPermissionTimer(agentId, permissionTimers);
  cancelWaitingTimer(agentId, waitingTimers);

  const emit = (message: Record<string, unknown>): void => {
    if (!options.replay) agents.broadcast(message);
  };
  const onObservation = options.replay ? undefined : options.onObservation;
  const publish = (activity: CopilotActivity): void =>
    publishActivity(state, agent, activity, emit, onObservation);
  const reconcile = (): void => reconcileActivity(state, agent, emit, onObservation);
  const clearTool = (key: string, isError = false): void => {
    const tool = state.tools.get(key);
    if (!tool) return;
    const toolId = tool.id;
    state.tools.delete(key);
    remember(state.completedTools, key);
    state.inputs.delete(`tool:${key}`);
    for (const requests of [state.inputs, state.permissions]) {
      for (const [requestId, request] of requests) {
        if (
          request.toolId === toolId &&
          request.parentToolId === tool.parentToolId &&
          (tool.parentToolId !== undefined || !request.agentId)
        ) {
          requests.delete(requestId);
          if (!request.hookOnly) remember(state.completedRequests, requestId);
        }
      }
    }
    // Only an observed failed completion carries the tool-failure signal; clears
    // on child end, idle or generation change say nothing about the outcome.
    const failure = isError ? { isError: true } : {};
    if (tool.parentToolId) {
      agent.activeSubagentToolIds.get(tool.parentToolId)?.delete(toolId);
      agent.activeSubagentToolNames.get(tool.parentToolId)?.delete(toolId);
      emit({
        type: 'subagentToolDone',
        id: agentId,
        parentToolId: tool.parentToolId,
        toolId,
        ...failure,
      });
    } else {
      if (!state.children.has(toolId)) {
        agent.activeToolIds.delete(toolId);
        agent.activeToolStatuses.delete(toolId);
        agent.activeToolNames.delete(toolId);
      }
      // Synchronous publication cannot clear a later turn via a delayed timer.
      emit({ type: 'agentToolDone', id: agentId, toolId, ...failure });
    }
  };
  const endChild = (parentToolId: string): void => {
    const child = state.children.get(parentToolId);
    if (!child) return;
    for (const [toolId, tool] of state.tools) {
      if (tool.parentToolId === parentToolId) clearTool(toolId);
    }
    state.children.delete(parentToolId);
    for (const requests of [state.inputs, state.permissions]) {
      for (const [requestId, request] of requests) {
        if (request.parentToolId === parentToolId) {
          requests.delete(requestId);
          if (!request.hookOnly) remember(state.completedRequests, requestId);
        }
      }
    }
    if (child.agentId) state.childTools.delete(child.agentId);
    agent.backgroundAgentToolIds.delete(parentToolId);
    if (!state.tools.has(toolKey(parentToolId))) {
      agent.activeToolIds.delete(parentToolId);
      agent.activeToolStatuses.delete(parentToolId);
      agent.activeToolNames.delete(parentToolId);
    }
    agent.activeSubagentToolIds.delete(parentToolId);
    agent.activeSubagentToolNames.delete(parentToolId);
    agent.teammateSpawnToolIds?.delete(parentToolId);
    emit({ type: 'subagentClear', id: agentId, parentToolId });
    if (!options.replay) options.onChild?.({ ...child, kind: 'completed' });
  };
  const rememberTask = (
    tool: Tool,
    args: Record<string, unknown> | undefined,
  ): string | undefined => {
    if (tool.parentToolId || (tool.name !== 'task' && tool.name !== 'agent')) return undefined;
    if (state.spawnTools.size < MAX_TRACKED_ENTRIES || state.spawnTools.has(tool.id)) {
      state.spawnTools.set(tool.id, tool);
    }
    const name = text(args?.name);
    if (name && (state.taskNames.size < MAX_TRACKED_ENTRIES || state.taskNames.has(tool.id))) {
      state.taskNames.set(tool.id, name);
      if (options.onChild) {
        agent.teammateSpawnToolIds ??= new Set();
        agent.teammateSpawnToolIds.add(tool.id);
      }
      const child = state.children.get(tool.id);
      if (child && child.name !== name) {
        child.name = name;
        if (!options.replay) options.onChild?.({ ...child, kind: 'started' });
      }
    }
    return name;
  };
  const childAgentId = text(record.agentId);
  const parentToolId =
    text(data.parentToolCallId) ?? (childAgentId ? state.childTools.get(childAgentId) : undefined);
  // Child model turns, context and idle must never alter the parent's state.
  const childRecord = childAgentId !== undefined || parentToolId !== undefined;
  const child = parentToolId ? state.children.get(parentToolId) : undefined;
  if (
    child?.name &&
    !options.replay &&
    !type.startsWith('subagent.') &&
    options.onChildRecord?.({ ...child }, record)
  )
    return;
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  if (!childRecord && Number.isFinite(timestamp) && type !== 'session.usage_info') {
    if (
      (type === 'session.idle' ||
        type === 'assistant.idle' ||
        type === 'assistant.turn_end' ||
        hookType === 'agentStop' ||
        type === 'session.task_complete') &&
      state.latestActivityAt !== undefined &&
      timestamp < state.latestActivityAt
    )
      return;
    if (
      type === 'assistant.turn_start' ||
      type === 'tool.execution_start' ||
      hookType === 'userPromptSubmitted'
    ) {
      state.latestActivityAt = Math.max(state.latestActivityAt ?? timestamp, timestamp);
    }
  }

  switch (type) {
    case 'hook.start':
      if (childRecord) return;
      if (hookType === 'userPromptSubmitted') {
        state.mainIdle = false;
        state.mainStopped = false;
        for (const [key, request] of state.inputs) {
          if (
            request.hookOnly &&
            !request.toolId &&
            !request.parentToolId &&
            !request.agentId &&
            !(
              Number.isFinite(timestamp) &&
              request.observedAt !== undefined &&
              timestamp < request.observedAt
            )
          )
            state.inputs.delete(key);
        }
        reconcile();
      } else if (hookType === 'agentStop') {
        state.mainIdle = true;
        state.mainStopped = true;
        state.mainStopAt = Number.isFinite(timestamp) ? timestamp : undefined;
        if (state.turnId) remember(state.retiredTurns, state.turnId);
        reconcile();
      }
      return;
    case 'tool.execution_start': {
      const toolId = text(data.toolCallId);
      const name = text(data.toolName);
      if (!toolId || !name) return;
      const key = toolKey(toolId, parentToolId);
      if (childRecord && !parentToolId) return;
      const args = objectValue(data.arguments);
      const source = options.source ?? 'transcript';
      const previous =
        state.tools.get(key) ?? (!parentToolId ? state.spawnTools.get(toolId) : undefined);
      if (previous?.source === 'hook' && source !== 'hook') {
        previous.name = name;
        previous.status = formatToolStatus(name, args);
        previous.source = source;
        previous.turnId = text(data.turnId);
        const taskName = rememberTask(previous, args);
        // Enrich hook-first labels without replaying activity notifications or
        // resurrecting completed tools. A live independent child keeps metadata.
        if (state.tools.has(key) || state.children.has(toolId)) {
          if (parentToolId) {
            agent.activeSubagentToolNames.get(parentToolId)?.set(toolId, name);
            emit({
              type: 'subagentToolStart',
              id: agentId,
              parentToolId,
              toolId,
              toolName: name,
              status: previous.status,
            });
          } else {
            agent.activeToolNames.set(toolId, name);
            agent.activeToolStatuses.set(toolId, previous.status);
            emit({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              toolName: name,
              status: previous.status,
              permissionActive: agent.permissionSent,
              ...(state.children.has(toolId) ? { runInBackground: true } : {}),
              ...(taskName && options.onChild ? { isTeammateSpawn: true } : {}),
            });
          }
        }
        return;
      }
      if (state.completedTools.has(key) || state.tools.has(key)) return;
      if (state.tools.size >= MAX_TRACKED_ENTRIES) {
        publish('unknown');
        return;
      }
      const tool = {
        id: toolId,
        name,
        status: formatToolStatus(name, args),
        parentToolId,
        turnId: text(data.turnId),
        source,
      };
      state.tools.set(key, tool);
      if (parentToolId) {
        let ids = agent.activeSubagentToolIds.get(parentToolId);
        if (!ids) agent.activeSubagentToolIds.set(parentToolId, (ids = new Set()));
        let names = agent.activeSubagentToolNames.get(parentToolId);
        if (!names) agent.activeSubagentToolNames.set(parentToolId, (names = new Map()));
        ids.add(toolId);
        names.set(toolId, name);
        emit({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId,
          toolName: name,
          status: tool.status,
        });
      } else {
        state.mainIdle = false;
        state.mainStopped = false;
        agent.hadToolsInTurn = true;
        agent.activeToolIds.add(toolId);
        agent.activeToolNames.set(toolId, name);
        agent.activeToolStatuses.set(toolId, tool.status);
        const taskName = rememberTask(tool, args);
        emit({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          toolName: name,
          status: tool.status,
          ...(taskName && options.onChild ? { isTeammateSpawn: true } : {}),
          permissionActive: agent.permissionSent,
        });
      }
      if (name === 'ask_user') state.inputs.set(`tool:${key}`, { toolId, parentToolId });
      reconcile();
      return;
    }
    case 'tool.execution_complete':
    case 'tool.execution_failed': {
      if (childRecord && !parentToolId) return;
      const toolId = text(data.toolCallId);
      if (!toolId) return;
      const key = toolKey(toolId, parentToolId);
      const tool = state.tools.get(key);
      const turnId = text(data.turnId);
      if (tool?.turnId && turnId && turnId !== tool.turnId) return;
      remember(state.completedTools, key);
      clearTool(key, type === 'tool.execution_failed' || data.success === false);
      for (const requests of [state.inputs, state.permissions]) {
        for (const [requestId, request] of requests) {
          if (
            request.toolId === toolId &&
            request.parentToolId === parentToolId &&
            (parentToolId !== undefined || request.agentId === childAgentId)
          ) {
            requests.delete(requestId);
            if (!request.hookOnly) remember(state.completedRequests, requestId);
          }
        }
      }
      // The task tool returning is not the child's completion (background mode).
      if (!state.children.has(toolId)) {
        if (tool?.name === 'task' || tool?.name === 'agent') {
          emit({ type: 'subagentClear', id: agentId, parentToolId: toolId });
        }
      }
      if (tool || agent.permissionSent || agent.awaitingInput) reconcile();
      return;
    }
    case 'tool.execution_progress':
    case 'tool.execution_partial_result':
      // Progress is not permission evidence and cannot resolve unrelated requests.
      return;
    case 'assistant.turn_start': {
      if (childRecord) return;
      const turnId = text(data.turnId);
      if (turnId && state.retiredTurns.has(turnId)) return;
      if (state.turnId && state.turnId !== turnId) remember(state.retiredTurns, state.turnId);
      state.turnId = turnId;
      state.mainIdle = false;
      state.mainStopped = false;
      reconcile();
      return;
    }
    case 'assistant.turn_end': {
      const turnId = text(data.turnId);
      if (
        childRecord ||
        (turnId && state.retiredTurns.has(turnId)) ||
        (state.turnId && turnId !== state.turnId)
      )
        return;
      // This ends one model-loop step, not necessarily the user's interaction.
      if (
        !state.tools.size &&
        !state.children.size &&
        !state.inputs.size &&
        !state.permissions.size
      ) {
        publish('unknown');
      }
      return;
    }
    case 'assistant.idle':
      if (childRecord) return;
      state.mainIdle = true;
      if (state.turnId) remember(state.retiredTurns, state.turnId);
      if (data.aborted === true) {
        publish('unknown');
        return;
      }
      reconcile();
      return;
    case 'session.idle':
      if (childRecord) return;
      for (const toolId of state.tools.keys()) clearTool(toolId);
      for (const childId of state.children.keys()) endChild(childId);
      state.inputs.clear();
      state.permissions.clear();
      state.taskNames.clear();
      for (const toolId of state.spawnTools.keys()) remember(state.completedChildren, toolId);
      state.spawnTools.clear();
      state.mainIdle = true;
      state.historyComplete = true;
      if (state.turnId) remember(state.retiredTurns, state.turnId);
      agent.hadToolsInTurn = false;
      if (data.aborted === true) {
        if (agent.permissionSent) {
          agent.permissionSent = false;
          emit({ type: 'agentToolPermissionClear', id: agentId });
        }
        state.permissionChildren.clear();
        publish('unknown');
        return;
      }
      reconcile();
      return;
    case 'session.task_complete':
      // Reviewer rejection/blocked is not completion; an accepted task still
      // must not erase separately tracked tools or child work.
      if (childRecord || data.success !== true) return;
      state.mainIdle = true;
      reconcile();
      return;
    case 'permission.requested':
    case 'user_input.requested': {
      const requestId = text(data.requestId);
      if (!requestId) return;
      const isPermission = type === 'permission.requested';
      const key = `${isPermission ? 'permission' : 'input'}:${toolKey(requestId, childAgentId ?? parentToolId)}`;
      if (state.completedRequests.has(key) && !hookRequest) return;
      if (isPermission && (data.resolvedByHook === true || !objectValue(data.permissionRequest)))
        return;
      const permission = objectValue(data.permissionRequest);
      const toolId = text(data.toolCallId) ?? text(permission?.toolCallId);
      if (toolId && state.completedTools.has(toolKey(toolId, parentToolId))) return;
      const request = {
        requestId,
        toolId,
        parentToolId,
        agentId: childAgentId,
        hookOnly: hookRequest,
        observedAt: Number.isFinite(timestamp) ? timestamp : undefined,
      };
      if (hookRequest && !childRecord) {
        if (
          state.mainStopAt !== undefined &&
          Number.isFinite(timestamp) &&
          timestamp < state.mainStopAt
        )
          return;
        state.mainStopped = false;
      }
      const requests = isPermission ? state.permissions : state.inputs;
      if (requests.size >= MAX_TRACKED_ENTRIES) {
        publish('unknown');
        return;
      }
      requests.set(key, request);
      reconcile();
      return;
    }
    case 'permission.completed':
    case 'user_input.completed': {
      const requestId = text(data.requestId);
      if (!requestId) return;
      const isPermission = type === 'permission.completed';
      const key = `${isPermission ? 'permission' : 'input'}:${toolKey(requestId, childAgentId ?? parentToolId)}`;
      const requests = isPermission ? state.permissions : state.inputs;
      const request = requests.get(key);
      if (!hookRequest) remember(state.completedRequests, key);
      requests.delete(key);
      if (!isPermission && request?.toolId) {
        state.inputs.delete(`tool:${toolKey(request.toolId, request.parentToolId)}`);
      }
      if (request) reconcile();
      return;
    }
    case 'subagent.started': {
      const toolId = text(data.toolCallId);
      if (!toolId || state.children.has(toolId) || state.completedChildren.has(toolId)) return;
      if (state.children.size >= MAX_TRACKED_ENTRIES) {
        publish('unknown');
        return;
      }
      const child: CopilotChild = {
        parentToolId: toolId,
        agentId: childAgentId,
        name: state.taskNames.get(toolId),
        background: data.executionMode === 'background',
      };
      state.children.set(toolId, child);
      if (childAgentId) state.childTools.set(childAgentId, toolId);
      agent.backgroundAgentToolIds.add(toolId);
      const spawn = state.spawnTools.get(toolId);
      if (spawn) {
        agent.activeToolIds.add(toolId);
        agent.activeToolNames.set(toolId, spawn.name);
        agent.activeToolStatuses.set(toolId, spawn.status);
        emit({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          toolName: spawn.name,
          status: spawn.status,
          runInBackground: true,
          ...(child.name && options.onChild ? { isTeammateSpawn: true } : {}),
        });
      }
      if (!options.replay) options.onChild?.({ ...child, kind: 'started' });
      reconcile();
      return;
    }
    case 'subagent.completed':
    case 'subagent.failed': {
      const toolId = text(data.toolCallId);
      if (!toolId) return;
      remember(state.completedChildren, toolId);
      const existed = state.children.has(toolId);
      endChild(toolId);
      state.taskNames.delete(toolId);
      state.spawnTools.delete(toolId);
      if (existed) reconcile();
      return;
    }
    case 'session.usage_info': {
      if (childRecord) return;
      const tokens = data.currentTokens;
      const limit = data.tokenLimit;
      if (
        typeof tokens !== 'number' ||
        !Number.isSafeInteger(tokens) ||
        tokens < 0 ||
        typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit <= 0
      )
        return;
      if (Number.isFinite(timestamp)) {
        if (state.latestContextAt !== undefined && timestamp < state.latestContextAt) return;
        state.latestContextAt = timestamp;
      }
      // Exact snapshots can shrink on compaction or model changes, including zero.
      agent.contextTokens = tokens;
      agent.maxContextTokens = limit;
      state.contextKnown = true;
      emit({
        type: 'agentContextUsage',
        id: agentId,
        contextTokens: tokens,
        maxContextTokens: limit,
      });
      return;
    }
    case 'session.title_changed': {
      if (childRecord || typeof data.title !== 'string') return;
      if (Number.isFinite(timestamp)) {
        if (state.latestTitleAt !== undefined && timestamp < state.latestTitleAt) return;
        state.latestTitleAt = timestamp;
      }
      if (options.replay) agent.sessionName = data.title;
      else agents.updateMetadata(agentId, { sessionName: data.title });
      return;
    }
    case 'abort':
    case 'session.resume':
      if (!childRecord) {
        state.historyComplete = false;
        publish('unknown');
      }
      return;
    case 'assistant.usage':
    case 'session.usage_checkpoint':
    case 'session.start':
    case 'user.message':
    case 'assistant.message':
    case 'session.compaction_start':
    case 'session.compaction_complete':
    case 'session.background_tasks_changed':
      return;
    default:
      if (agent.seenUnknownRecordTypes.size < MAX_REMEMBERED_EVENTS)
        agent.seenUnknownRecordTypes.add(type);
  }
}
