import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import type { CopilotRecordOptions } from '../src/providers/hook/copilot/eventReducer.js';
import {
  getCopilotActivity,
  getCopilotSnapshot,
  hookToCopilotRecord,
  hookToCopilotRecords,
  markCopilotObservationUnknown,
  processCopilotRecord,
} from '../src/providers/hook/copilot/eventReducer.js';
import type { AgentState } from '../src/types.js';

function copilotTestAgent(): AgentState {
  return {
    id: 1,
    providerId: 'copilot',
    sessionId: 'test-session',
    isExternal: true,
    projectDir: '',
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolNames: new Map(),
    activeToolStatuses: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 0,
  };
}

describe('Copilot evidence-based observation', () => {
  let agent: AgentState;
  let store: AgentStateStore;
  let messages: Record<string, unknown>[];
  let waiting: Map<number, ReturnType<typeof setTimeout>>;
  let permissions: Map<number, ReturnType<typeof setTimeout>>;
  const event = (
    type: string,
    data: Record<string, unknown> = {},
    envelope: Record<string, unknown> = {},
    options: CopilotRecordOptions = {},
  ): void =>
    processCopilotRecord(
      1,
      { type, data, ...envelope },
      agent,
      store,
      waiting,
      permissions,
      options,
    );
  const start = (id: string, name = 'powershell', args = {}): void =>
    event('tool.execution_start', {
      toolCallId: id,
      toolName: name,
      arguments: args,
      turnId: 'turn',
    });

  beforeEach(() => {
    vi.useFakeTimers();
    agent = copilotTestAgent();
    store = new AgentStateStore();
    store.set(1, agent);
    messages = [];
    store.on('broadcast', (message) => messages.push(message));
    waiting = new Map();
    permissions = new Map();
  });
  afterEach(() => vi.useRealTimers());

  it('never infers a permission request from a silent long-running tool', () => {
    start('shell');
    vi.advanceTimersByTime(600_000);
    expect(getCopilotActivity(agent)).toBe('active');
    expect(permissions.size).toBe(0);
    expect(agent.permissionSent).toBe(false);
  });

  it('model turn end preserves tools and cannot certify whole-task completion', () => {
    start('shell');
    event('assistant.turn_end', { turnId: 'turn' });
    expect(agent.activeToolIds.has('shell')).toBe(true);
    event('tool.execution_complete', { toolCallId: 'shell' });
    event('assistant.turn_end', { turnId: 'turn' });
    expect(getCopilotActivity(agent)).toBe('unknown');
    event('session.idle');
    expect(getCopilotActivity(agent)).toBe('done');
  });

  it('never removes or changes an agent for repeated transcript sessionEnd hooks', () => {
    start('shell');
    for (let index = 0; index < 8; index++) {
      event('hook.start', { hookType: 'sessionEnd' });
      event('hook.end', { hookType: 'sessionEnd' });
    }
    event('session.shutdown', { shutdownType: 'routine' });
    expect(store.has(1)).toBe(true);
    expect(getCopilotActivity(agent)).toBe('active');
    expect(agent.activeToolIds.has('shell')).toBe(true);
  });

  it('observed App agentStop completes an interaction without ending the session', () => {
    event('hook.start', { hookType: 'userPromptSubmitted', input: { sessionId: 'test-session' } });
    for (let index = 0; index < 3; index++) {
      event('assistant.turn_start', { turnId: `step-${index}` });
      event('assistant.message', {});
      event('assistant.turn_end', { turnId: `step-${index}` });
      expect(getCopilotActivity(agent)).not.toBe('done');
    }
    event('hook.start', {
      hookType: 'agentStop',
      input: { stopReason: 'end_turn', stop_hook_active: false },
    });
    event('hook.end', { hookType: 'agentStop' });
    event('hook.start', { hookType: 'sessionEnd' });
    expect(getCopilotActivity(agent)).toBe('done');
    expect(store.has(1)).toBe(true);
    event('hook.start', { hookType: 'userPromptSubmitted', input: { sessionId: 'test-session' } });
    expect(getCopilotActivity(agent)).toBe('active');
  });

  it('parent agentStop preserves background lifetime and child agentStop never idles the parent', () => {
    start('spawn', 'task');
    event(
      'subagent.started',
      { toolCallId: 'spawn', executionMode: 'background' },
      { agentId: 'child' },
    );
    event('tool.execution_complete', { toolCallId: 'spawn' });
    event('hook.start', { hookType: 'agentStop', parentToolCallId: 'spawn' }, { agentId: 'child' });
    expect(getCopilotActivity(agent)).toBe('active');
    event('hook.start', { hookType: 'agentStop' });
    expect(agent.backgroundAgentToolIds.has('spawn')).toBe(true);
    expect(getCopilotActivity(agent)).toBe('active');
    event('subagent.completed', { toolCallId: 'spawn' }, { agentId: 'child' });
    expect(getCopilotActivity(agent)).toBe('done');
  });

  it('ask_user and request completion track input separately from done', () => {
    start('question', 'ask_user', { question: 'Which?' });
    expect(getCopilotActivity(agent)).toBe('input');
    event('user_input.requested', {
      requestId: 'request',
      toolCallId: 'question',
      question: 'Which?',
    });
    event('user_input.completed', { requestId: 'request' });
    expect(getCopilotActivity(agent)).toBe('active');
    expect(messages).toContainEqual({
      type: 'agentStatus',
      id: 1,
      status: 'waiting',
      awaitingInput: true,
    });
    event('tool.execution_complete', { toolCallId: 'question' });
    expect(getCopilotActivity(agent)).toBe('active');
  });

  it('concurrent requests survive unrelated activity and resolve by exact request ID', () => {
    start('shell');
    event('permission.requested', { requestId: 'p1', permissionRequest: { toolCallId: 'shell' } });
    event('permission.requested', { requestId: 'p2', permissionRequest: { toolCallId: 'other' } });
    start('other', 'view');
    event('tool.execution_progress', { toolCallId: 'other' });
    event('permission.completed', { requestId: 'p1' });
    expect(agent.permissionSent).toBe(true);
    event('permission.completed', { requestId: 'p2' });
    expect(agent.permissionSent).toBe(false);
    expect(getCopilotActivity(agent)).toBe('active');
    expect(messages.filter((m) => m.type === 'agentToolPermission')).toHaveLength(1);
    expect(messages.filter((m) => m.type === 'agentToolPermissionClear')).toHaveLength(1);
  });

  it('hook-resolved permission requests require no user attention', () => {
    event('permission.requested', {
      requestId: 'p',
      permissionRequest: {},
      resolvedByHook: true,
    });
    expect(agent.permissionSent).toBe(false);
    expect(messages).toEqual([]);
  });

  it('clears only a resolved child prompt while preserving sibling and aggregate parent waits', () => {
    for (const child of ['a', 'b']) {
      start(`spawn-${child}`, 'task');
      event('subagent.started', { toolCallId: `spawn-${child}` }, { agentId: child });
      event(
        'permission.requested',
        { requestId: 'same-scoped-id', permissionRequest: {} },
        { agentId: child },
      );
    }
    event('permission.requested', { requestId: 'second', permissionRequest: {} }, { agentId: 'a' });
    event('permission.completed', { requestId: 'same-scoped-id' }, { agentId: 'a' });
    expect(messages.filter((message) => message.type === 'agentToolPermissionClear')).toEqual([]);
    event('permission.completed', { requestId: 'second' }, { agentId: 'a' });
    expect(agent.permissionSent).toBe(true);
    expect(messages.filter((message) => message.type === 'agentToolPermissionClear')).toEqual([
      { type: 'agentToolPermissionClear', id: 1, parentToolId: 'spawn-a' },
    ]);
    expect(messages.filter((message) => message.type === 'subagentToolPermission')).toEqual([
      { type: 'subagentToolPermission', id: 1, parentToolId: 'spawn-a' },
      { type: 'subagentToolPermission', id: 1, parentToolId: 'spawn-b' },
    ]);
    event('permission.completed', { requestId: 'same-scoped-id' }, { agentId: 'b' });
    expect(agent.permissionSent).toBe(false);
    expect(messages.at(-2)).toEqual({ type: 'agentToolPermissionClear', id: 1 });
    expect(messages.filter((message) => message.type === 'agentToolPermission')).toHaveLength(1);
  });

  it('deduplicates sources and out-of-order request/tool completion', () => {
    event('assistant.turn_start', { turnId: 'turn' }, { id: 'same' }, { source: 'hook' });
    event('assistant.turn_start', { turnId: 'turn' }, { id: 'same' }, { source: 'transcript' });
    expect(messages.filter((message) => message.type === 'agentStatus')).toHaveLength(1);
    expect(messages.filter((message) => message.type === 'agentObservation')).toHaveLength(1);
    event('tool.execution_complete', { toolCallId: 'old' });
    start('old');
    event('permission.completed', { requestId: 'old' });
    event('permission.requested', { requestId: 'old', permissionRequest: {} });
    expect(agent.activeToolIds.size).toBe(0);
    expect(agent.permissionSent).toBe(false);
  });

  it('publishes completion synchronously with no timer that can clear a later generation', () => {
    start('old');
    event('tool.execution_complete', { toolCallId: 'old' });
    expect(messages.filter((m) => m.type === 'agentToolDone')).toHaveLength(1);
    event(
      'tool.execution_start',
      { toolCallId: 'old', toolName: 'view' },
      {},
      { generation: 'new' },
    );
    vi.runAllTimers();
    expect(agent.activeToolIds.has('old')).toBe(true);
    expect(messages.filter((m) => m.type === 'agentToolDone')).toHaveLength(1);
  });

  it('converts lifecycle boundaries but ignores even undocumented exact-ID tool hooks', () => {
    const sessionId = 'session';
    expect(
      hookToCopilotRecord({
        hookType: 'agentStop',
        sessionId,
        timestamp: '2026-09-24T12:00:00Z',
        initialPrompt: 'not forwarded',
      }),
    ).toEqual({
      type: 'hook.start',
      data: { hookType: 'agentStop' },
      timestamp: '2026-09-24T12:00:00Z',
    });
    expect(hookToCopilotRecords({ hookType: 'sessionEnd', sessionId })).toEqual([]);
    expect(hookToCopilotRecords({ hookType: 'postToolUse', sessionId, toolName: 'view' })).toEqual(
      [],
    );
    expect(
      hookToCopilotRecords({
        hookType: 'notification',
        sessionId,
        notification_type: 'permission_prompt',
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'permission.requested',
        data: expect.objectContaining({ hookOnly: true, permissionRequest: {} }),
      }),
    ]);
    expect(
      hookToCopilotRecords({
        hookType: 'preToolUse',
        sessionId,
        toolCalls: [{ id: 'unverified-alias', name: 'view' }],
      }),
    ).toEqual([]);
    const batch = {
      hookType: 'preToolUse',
      sessionId,
      toolCalls: [
        { toolCallId: 'a', toolName: 'view', arguments: { path: 'not forwarded' } },
        { toolCallId: 'b', toolName: 'powershell' },
      ],
    };
    expect(hookToCopilotRecords(batch)).toEqual([]);
    expect(hookToCopilotRecord(batch)).toBeUndefined();
    expect(
      hookToCopilotRecord({
        hookType: 'agentStop',
        sessionId,
        agentId: 'child',
        parentToolCallId: 'spawn',
      }),
    ).toEqual({
      type: 'hook.start',
      agentId: 'child',
      data: { hookType: 'agentStop', parentToolCallId: 'spawn' },
    });
  });

  it('deduplicates repeated transcript tools without losing activity labels', () => {
    event('tool.execution_start', {
      toolCallId: 'read',
      toolName: 'view',
      arguments: { path: 'foo.ts' },
      turnId: 't',
    });
    event(
      'tool.execution_start',
      {
        toolCallId: 'read',
        toolName: 'view',
        arguments: { path: 'foo.ts' },
        turnId: 't',
      },
      {},
      { source: 'transcript' },
    );
    expect(agent.activeToolIds.size).toBe(1);
    expect(agent.activeToolStatuses.get('read')).toBe('Reading foo.ts');
    expect(messages.filter((message) => message.type === 'agentStatus')).toHaveLength(1);
    event('tool.execution_complete', { toolCallId: 'read' });
    event(
      'tool.execution_start',
      { toolCallId: 'read', toolName: 'view' },
      {},
      { source: 'transcript' },
    );
    expect(agent.activeToolIds.size).toBe(0);
  });

  it('retains a real transcript task name after its spawning tool completes', () => {
    event(
      'tool.execution_start',
      { toolCallId: 'spawn', toolName: 'task', arguments: { name: 'Analyst' } },
      {},
      { source: 'transcript' },
    );
    event('tool.execution_complete', { toolCallId: 'spawn' });
    event(
      'tool.execution_start',
      {
        toolCallId: 'spawn',
        toolName: 'task',
        arguments: { name: 'Analyst' },
      },
      {},
      { source: 'transcript' },
    );
    expect(agent.activeToolIds.size).toBe(0);
    event(
      'subagent.started',
      { toolCallId: 'spawn', executionMode: 'background' },
      { agentId: 'child' },
    );
    expect(getCopilotSnapshot(agent).children[0].name).toBe('Analyst');
    expect(agent.backgroundAgentToolIds.has('spawn')).toBe(true);
  });

  it('does not return to a retired generation when delayed events arrive', () => {
    event('assistant.turn_start', { turnId: 'old' }, {}, { generation: 'old' });
    event(
      'tool.execution_start',
      { toolCallId: 'current', toolName: 'view' },
      {},
      { generation: 'current' },
    );
    event('session.idle', {}, {}, { generation: 'old' });
    expect(agent.activeToolIds.has('current')).toBe(true);
    expect(getCopilotActivity(agent)).toBe('active');
  });

  it('tool completion resolves only requests explicitly correlated to that tool', () => {
    start('q1', 'ask_user');
    start('q2', 'ask_user');
    event('user_input.requested', { requestId: 'r1', toolCallId: 'q1' });
    event('user_input.requested', { requestId: 'r2', toolCallId: 'q2' });
    event('tool.execution_complete', { toolCallId: 'q1' });
    expect(getCopilotActivity(agent)).toBe('input');
    event('tool.execution_complete', { toolCallId: 'q2' });
    expect(getCopilotActivity(agent)).toBe('active');
  });

  it('keeps background children after spawn returns and parent idle, routing child tools explicitly', () => {
    start('spawn', 'task', { description: 'Research' });
    event(
      'subagent.started',
      {
        toolCallId: 'spawn',
        agentName: 'explore',
        executionMode: 'background',
      },
      { agentId: 'child' },
    );
    event('tool.execution_complete', { toolCallId: 'spawn' });
    event('assistant.idle');
    event(
      'tool.execution_start',
      { toolCallId: 'child-tool', toolName: 'view' },
      { agentId: 'child' },
    );
    event('assistant.turn_end', { turnId: 'child-turn' }, { agentId: 'child' });
    expect(agent.backgroundAgentToolIds.has('spawn')).toBe(true);
    expect(agent.activeToolNames.get('spawn')).toBe('task');
    expect(agent.activeSubagentToolIds.get('spawn')?.has('child-tool')).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'subagentToolStart',
        parentToolId: 'spawn',
        toolId: 'child-tool',
        toolName: 'view',
      }),
    );
    expect(messages.filter((m) => m.type === 'subagentClear')).toHaveLength(0);
    event('subagent.completed', { toolCallId: 'spawn' }, { agentId: 'child' });
    expect(agent.backgroundAgentToolIds.size).toBe(0);
    expect(getCopilotActivity(agent)).toBe('done');
  });

  it('keeps same-named tool IDs isolated between root and child scopes', () => {
    start('same', 'powershell');
    event('tool.execution_start', {
      toolCallId: 'same',
      toolName: 'view',
      parentToolCallId: 'spawn',
    });
    event('tool.execution_complete', { toolCallId: 'same', parentToolCallId: 'spawn' });
    expect(agent.activeToolIds.has('same')).toBe(true);
    expect(agent.activeSubagentToolIds.get('spawn')?.size).toBe(0);
    event('tool.execution_complete', { toolCallId: 'same' });
    expect(agent.activeToolIds.size).toBe(0);
  });

  it('an uncorrelated child completion never clears a root tool with the same ID', () => {
    start('same');
    event('tool.execution_complete', { toolCallId: 'same' }, { agentId: 'unmapped' });
    expect(agent.activeToolIds.has('same')).toBe(true);
  });

  it('late child starts cannot resurrect an explicitly completed child', () => {
    event('subagent.completed', { toolCallId: 'spawn' });
    event('subagent.started', { toolCallId: 'spawn' });
    expect(agent.backgroundAgentToolIds.size).toBe(0);
    expect(getCopilotActivity(agent)).toBe('unknown');
  });

  it('idle retires known tools and model turns without duplicate completion notifications', () => {
    event('assistant.turn_start', { turnId: 'turn' });
    start('work');
    event('session.idle');
    start('work');
    event('assistant.turn_end', { turnId: 'turn' });
    event('session.idle');
    expect(getCopilotActivity(agent)).toBe('done');
    expect(agent.activeToolIds.size).toBe(0);
    expect(
      messages.filter((message) => message.type === 'agentStatus' && message.status === 'waiting'),
    ).toHaveLength(1);
  });

  it('never treats a built-in agent type/display name as a user-assigned name', () => {
    const onChild = vi.fn();
    start('unnamed', 'task');
    event(
      'subagent.started',
      { toolCallId: 'unnamed', agentName: 'explore', agentDisplayName: 'Explorer' },
      {},
      { onChild },
    );
    start('named', 'task', { name: 'Analyst' });
    event('tool.execution_complete', { toolCallId: 'named' });
    event(
      'subagent.started',
      { toolCallId: 'named', agentName: 'general-purpose' },
      {},
      { onChild },
    );
    expect(onChild.mock.calls[0][0].name).toBeUndefined();
    expect(onChild.mock.calls[1][0].name).toBe('Analyst');
  });

  it('exposes exact recovered child identity and context availability without synthetic context guesses', () => {
    expect(getCopilotSnapshot(agent).context).toBeUndefined();
    start('spawn', 'task', { name: 'Analyst' });
    event(
      'subagent.started',
      { toolCallId: 'spawn', executionMode: 'background' },
      { agentId: 'child' },
    );
    const snapshot = getCopilotSnapshot(agent);
    expect(snapshot.children).toEqual([
      {
        parentToolId: 'spawn',
        name: 'Analyst',
        agentId: 'child',
        background: true,
      },
    ]);
    snapshot.children[0].name = 'Mutated';
    expect(getCopilotSnapshot(agent).children[0].name).toBe('Analyst');
    event('session.usage_info', { currentTokens: 0, tokenLimit: 100 });
    expect(getCopilotSnapshot(agent).context).toEqual({ contextTokens: 0, maxContextTokens: 100 });
  });

  it('lets runtime route a named Teammate without creating a duplicate sub-agent', () => {
    start('spawn', 'task', { name: 'Analyst' });
    event('subagent.started', { toolCallId: 'spawn' }, { agentId: 'child' });
    const onChildRecord = vi.fn(() => true);
    event(
      'tool.execution_start',
      { toolCallId: 'read', toolName: 'view' },
      { agentId: 'child' },
      { onChildRecord },
    );
    expect(onChildRecord).toHaveBeenCalledOnce();
    expect(onChildRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Analyst', parentToolId: 'spawn' }),
      expect.objectContaining({ type: 'tool.execution_start' }),
    );
    expect(messages.some((message) => message.type === 'subagentToolStart')).toBe(false);
    expect(agent.backgroundAgentToolIds.has('spawn')).toBe(true);
  });

  it('uses exact context snapshots, never cumulative billing or child context', () => {
    event('session.usage_info', { currentTokens: 800_000, tokenLimit: 1_000_000 });
    event('assistant.usage', { inputTokens: 100, outputTokens: 200 });
    event('session.usage_info', { currentTokens: 50, tokenLimit: 100 }, { agentId: 'child' });
    expect(agent.contextTokens).toBe(800_000);
    event('session.usage_info', { currentTokens: 0, tokenLimit: 200_000 });
    expect(agent.contextTokens).toBe(0);
    expect(agent.maxContextTokens).toBe(200_000);
    event('session.usage_info', { currentTokens: -1, tokenLimit: 0 });
    event('session.usage_info', { currentTokens: Infinity, tokenLimit: 100 });
    expect(agent.contextTokens).toBe(0);
  });

  it('does not invent context occupancy from observed App spend-only checkpoints', () => {
    event('session.usage_checkpoint', {
      totalNanoAiu: 1000,
      totalPremiumRequests: 2,
      modelCacheState: {},
      promptCacheBreakState: {},
    });
    expect(getCopilotSnapshot(agent).context).toBeUndefined();
    expect(agent.contextTokens).toBe(0);
    expect(messages).toEqual([]);
  });

  it('updates live titles through metadata without replacing the agent or accepting stale/child titles', () => {
    const persist = vi.spyOn(store, 'persist');
    event(
      'session.title_changed',
      { title: 'Investigation' },
      { timestamp: '2026-09-24T12:00:02Z' },
    );
    event('session.title_changed', { title: 'Investigation' });
    event('session.title_changed', { title: 'Old title' }, { timestamp: '2026-09-24T12:00:01Z' });
    event('session.title_changed', { title: 'Child title' }, { agentId: 'child' });
    expect(agent.sessionName).toBe('Investigation');
    expect(store.get(1)).toBe(agent);
    expect(messages).toEqual([{ type: 'agentMetadata', id: 1, sessionName: 'Investigation' }]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('hydrates recovered titles silently without historical persistence or broadcasts', () => {
    const persist = vi.spyOn(store, 'persist');
    event('session.title_changed', { title: 'Recovered title' }, {}, { replay: true });
    expect(agent.sessionName).toBe('Recovered title');
    expect(messages).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects timestamped stale idle/context records without reordering independent tool completions', () => {
    event('assistant.turn_start', { turnId: 'new' }, { timestamp: '2026-09-24T12:00:01Z' });
    event('session.idle', {}, { timestamp: '2026-09-24T12:00:00Z' });
    expect(getCopilotActivity(agent)).toBe('active');
    event(
      'session.usage_info',
      { currentTokens: 10, tokenLimit: 100 },
      { timestamp: '2026-09-24T12:00:01Z' },
    );
    event(
      'session.usage_info',
      { currentTokens: 80, tokenLimit: 100 },
      { timestamp: '2026-09-24T12:00:00Z' },
    );
    expect(agent.contextTokens).toBe(10);
  });

  it('quietly hydrates all state during replay and deduplicates the live overlap', () => {
    const record = {
      type: 'tool.execution_start',
      id: 'overlap',
      data: { toolCallId: 't', toolName: 'ask_user' },
    };
    processCopilotRecord(1, record, agent, store, waiting, permissions, { replay: true });
    expect(getCopilotActivity(agent)).toBe('input');
    expect(messages).toEqual([]);
    processCopilotRecord(1, record, agent, store, waiting, permissions);
    expect(messages).toEqual([]);
  });

  it('insufficient recovery history remains unknown on main-only idle until aggregate idle', () => {
    markCopilotObservationUnknown(agent);
    event('assistant.idle');
    expect(getCopilotActivity(agent)).toBe('unknown');
    event('session.idle');
    expect(getCopilotActivity(agent)).toBe('done');
  });

  it('failed task validation is not a done notification', () => {
    start('work');
    event('session.task_complete', { success: false, outcome: 'blocked' });
    expect(getCopilotActivity(agent)).toBe('active');
    expect(agent.activeToolIds.has('work')).toBe(true);
  });

  it('aborted idle does not play a successful-completion notification', () => {
    start('work');
    event('permission.requested', { requestId: 'p', permissionRequest: { toolCallId: 'work' } });
    event('session.idle', { aborted: true });
    expect(getCopilotActivity(agent)).toBe('unknown');
    expect(agent.activeToolIds.size).toBe(0);
    expect(agent.permissionSent).toBe(false);
    expect(
      messages.some((message) => message.type === 'agentStatus' && message.status === 'waiting'),
    ).toBe(false);
  });

  describe('tool-failure signal', () => {
    const dones = (type: 'agentToolDone' | 'subagentToolDone') =>
      messages.filter((message) => message.type === type);

    it('flags a completion that reports success: false', () => {
      start('shell');
      event('tool.execution_complete', { toolCallId: 'shell', success: false });
      expect(dones('agentToolDone')).toEqual([
        { type: 'agentToolDone', id: 1, toolId: 'shell', isError: true },
      ]);
    });

    it('flags a tool.execution_failed record', () => {
      start('shell');
      event('tool.execution_failed', { toolCallId: 'shell' });
      expect(dones('agentToolDone')).toEqual([
        { type: 'agentToolDone', id: 1, toolId: 'shell', isError: true },
      ]);
    });

    it('omits isError for a successful or outcome-less completion', () => {
      start('ok');
      start('silent');
      event('tool.execution_complete', { toolCallId: 'ok', success: true });
      event('tool.execution_complete', { toolCallId: 'silent' });
      expect(dones('agentToolDone')).toEqual([
        { type: 'agentToolDone', id: 1, toolId: 'ok' },
        { type: 'agentToolDone', id: 1, toolId: 'silent' },
      ]);
    });

    it("flags a Sub-agent's failed tool on subagentToolDone only", () => {
      start('spawn', 'task', { description: 'Research' });
      event(
        'subagent.started',
        { toolCallId: 'spawn', agentName: 'explore', executionMode: 'background' },
        { agentId: 'child' },
      );
      event(
        'tool.execution_start',
        { toolCallId: 'child-tool', toolName: 'powershell' },
        { agentId: 'child' },
      );
      event(
        'tool.execution_complete',
        { toolCallId: 'child-tool', success: false },
        { agentId: 'child' },
      );
      expect(dones('subagentToolDone')).toEqual([
        {
          type: 'subagentToolDone',
          id: 1,
          parentToolId: 'spawn',
          toolId: 'child-tool',
          isError: true,
        },
      ]);
      expect(dones('agentToolDone')).toEqual([]);
    });

    it('never reports a failure for tools retired by idle', () => {
      start('work');
      event('session.idle');
      expect(dones('agentToolDone')).toEqual([{ type: 'agentToolDone', id: 1, toolId: 'work' }]);
    });

    it('never broadcasts a failure while replaying history', () => {
      event(
        'tool.execution_start',
        { toolCallId: 'old', toolName: 'powershell' },
        {},
        { replay: true },
      );
      event('tool.execution_complete', { toolCallId: 'old', success: false }, {}, { replay: true });
      expect(messages).toEqual([]);
    });
  });

  it('malformed and unfamiliar records never create false state', () => {
    for (const data of [null, [], 'invalid', 42]) {
      processCopilotRecord(
        1,
        { type: 'tool.execution_start', data },
        agent,
        store,
        waiting,
        permissions,
      );
    }
    event('tool.execution_start', { toolCallId: 1, toolName: 'view' });
    event('permission.requested', { requestId: 'x' });
    event('not.yet.supported');
    expect(getCopilotActivity(agent)).toBe('unknown');
    expect(messages).toEqual([]);
  });
});
