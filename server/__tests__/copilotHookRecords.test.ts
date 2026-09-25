import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  getCopilotActivity,
  hookToCopilotRecords,
  processCopilotRecord,
} from '../src/providers/hook/copilot/eventReducer.js';
import type { AgentState } from '../src/types.js';

describe('Copilot hooks share the transcript reducer', () => {
  let agent: AgentState;
  let store: AgentStateStore;
  let messages: Record<string, unknown>[];
  const waiting = new Map<number, ReturnType<typeof setTimeout>>();
  const permissions = new Map<number, ReturnType<typeof setTimeout>>();
  const hook = (raw: Record<string, unknown>): void => {
    for (const record of hookToCopilotRecords({ sessionId: 'session', ...raw })) {
      processCopilotRecord(1, record, agent, store, waiting, permissions, { source: 'hook' });
    }
  };
  const transcript = (type: string, data = {}, envelope = {}): void =>
    processCopilotRecord(1, { type, data, ...envelope }, agent, store, waiting, permissions);
  const start = (toolCallId: string): void =>
    hook({ hookType: 'preToolUse', toolCallId, toolName: 'view' });
  const end = (toolCallId: string): void => hook({ hookType: 'postToolUse', toolCallId });
  const permission = (extra = {}): void =>
    hook({ hookType: 'notification', notification_type: 'permission_prompt', ...extra });
  const stop = (extra = {}): void => hook({ hookType: 'agentStop', ...extra });

  beforeEach(() => {
    agent = {
      id: 1,
      sessionId: 'session',
      providerId: 'copilot',
      isExternal: true,
      projectDir: '',
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
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
    store = new AgentStateStore();
    store.set(1, agent);
    messages = [];
    store.on('broadcast', (message) => messages.push(message));
  });

  it('does not convert registration or unsupported lifecycle events into state transitions', () => {
    hook({ hookType: 'sessionStart' });
    hook({ hookType: 'sessionEnd' });
    hook({ hookType: 'notification', notification_type: 'unknown' });
    expect(store.has(1)).toBe(true);
    expect(messages).toEqual([]);
  });

  it('shares tool state and tombstones across hook/transcript observations', () => {
    start('read');
    transcript('tool.execution_start', {
      toolCallId: 'read',
      toolName: 'view',
      arguments: { path: 'file.ts' },
    });
    expect(agent.activeToolStatuses.get('read')).toBe('Reading file.ts');
    end('read');
    transcript('tool.execution_complete', { toolCallId: 'read' });
    expect(agent.activeToolIds.size).toBe(0);
    expect(messages.filter((message) => message.type === 'agentToolDone')).toHaveLength(1);
  });

  it('handles exact-ID batches without pairing an ID-less completion by name', () => {
    hook({
      hookType: 'preToolUse',
      toolCalls: [
        { toolCallId: 'a', toolName: 'view' },
        { toolCallId: 'b', toolName: 'view' },
      ],
    });
    hook({ hookType: 'postToolUse', toolName: 'view' });
    expect([...agent.activeToolIds]).toEqual(['a', 'b']);
    end('a');
    expect([...agent.activeToolIds]).toEqual(['b']);
  });

  it('settles failed tools and their matching prompts without clearing concurrent work', () => {
    start('failed');
    start('running');
    permission({ toolCallId: 'failed' });
    hook({ hookType: 'postToolUseFailure', toolName: 'view' });
    expect(agent.permissionSent).toBe(true);
    expect(agent.activeToolIds.size).toBe(2);
    hook({ hookType: 'postToolUseFailure', toolCallId: 'failed' });
    expect(agent.permissionSent).toBe(false);
    expect([...agent.activeToolIds]).toEqual(['running']);
    expect(messages.filter((message) => message.type === 'agentToolDone')).toEqual([
      { type: 'agentToolDone', id: 1, toolId: 'failed' },
    ]);
  });

  it('keeps anonymous permission across unrelated work and allows later real prompts', () => {
    permission();
    permission();
    start('unrelated');
    end('unrelated');
    hook({ hookType: 'userPromptSubmitted' });
    expect(agent.permissionSent).toBe(true);
    expect(messages.filter((message) => message.type === 'agentToolPermission')).toHaveLength(1);
    stop();
    expect(agent.permissionSent).toBe(false);
    expect(getCopilotActivity(agent)).toBe('done');
    permission();
    expect(agent.permissionSent).toBe(true);
    expect(messages.filter((message) => message.type === 'agentToolPermission')).toHaveLength(2);
  });

  it('resolves tool-correlated prompts only with that exact completion, even without a start', () => {
    permission({ toolCallId: 'permitted' });
    start('other');
    end('other');
    expect(agent.permissionSent).toBe(true);
    end('permitted');
    expect(agent.permissionSent).toBe(false);
  });

  it('resolves anonymous input on explicit submission, not unrelated tools', () => {
    hook({ hookType: 'notification', notification_type: 'elicitation_dialog' });
    expect(agent.awaitingInput).toBe(true);
    start('unrelated');
    end('unrelated');
    expect(agent.awaitingInput).toBe(true);
    hook({ hookType: 'userPromptSubmitted' });
    expect(agent.awaitingInput).toBe(false);
    expect(getCopilotActivity(agent)).toBe('active');
  });

  it('main stop preserves children and session-wide prompts until independent work completes', () => {
    transcript('tool.execution_start', { toolCallId: 'spawn', toolName: 'task' });
    transcript(
      'subagent.started',
      { toolCallId: 'spawn', executionMode: 'background' },
      { agentId: 'child' },
    );
    transcript('tool.execution_complete', { toolCallId: 'spawn' });
    permission();
    stop();
    expect(agent.backgroundAgentToolIds.has('spawn')).toBe(true);
    expect(agent.permissionSent).toBe(true);
    transcript('subagent.completed', { toolCallId: 'spawn' }, { agentId: 'child' });
    expect(agent.permissionSent).toBe(false);
    expect(getCopilotActivity(agent)).toBe('done');
  });

  it.each([
    ['ISO', (value: string) => value],
    ['numeric milliseconds', (value: string) => Date.parse(value)],
  ])('older %s stops cannot resolve newer prompt evidence', (_label, timestamp) => {
    permission({ timestamp: timestamp('2026-09-24T12:00:02Z') });
    stop({ timestamp: timestamp('2026-09-24T12:00:01Z') });
    expect(agent.permissionSent).toBe(true);
    expect(getCopilotActivity(agent)).toBe('permission');
    expect(messages).not.toContainEqual(expect.objectContaining({ status: 'waiting' }));
    stop({ timestamp: timestamp('2026-09-24T12:00:03Z') });
    expect(agent.permissionSent).toBe(false);
  });

  it.each([0, -8640000000000000, 8640000000000000])(
    'normalizes valid numeric timestamp %s',
    (timestamp) => {
      expect(
        hookToCopilotRecords({ sessionId: 'session', hookType: 'agentStop', timestamp })[0],
      ).toHaveProperty('timestamp', new Date(timestamp).toISOString());
    },
  );

  it.each([NaN, Infinity, -Infinity, -8640000000000001, 8640000000000001, 'invalid'])(
    'ignores invalid timestamp %s without throwing',
    (timestamp) => {
      expect(
        hookToCopilotRecords({ sessionId: 'session', hookType: 'agentStop', timestamp })[0],
      ).not.toHaveProperty('timestamp');
    },
  );

  it('keeps native tombstones distinct from reusable internal hook slots', () => {
    transcript('permission.requested', { requestId: 'native', permissionRequest: {} });
    transcript('permission.completed', { requestId: 'native' });
    transcript('permission.requested', { requestId: 'native', permissionRequest: {} });
    expect(agent.permissionSent).toBe(false);
    permission();
    expect(agent.permissionSent).toBe(true);
    stop();
    expect(agent.permissionSent).toBe(false);
  });

  it('deduplicates source event IDs after a hook-only request resolves', () => {
    permission({ eventId: 'request-event' });
    stop({ eventId: 'stop-event' });
    permission({ eventId: 'request-event' });
    expect(agent.permissionSent).toBe(false);
    permission({ eventId: 'new-request-event' });
    expect(agent.permissionSent).toBe(true);
  });

  it('does not clear an explicitly child-scoped prompt on a parent stop', () => {
    permission({ agentId: 'unmapped-child' });
    stop();
    expect(agent.permissionSent).toBe(true);
  });
});
