import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors transcriptParser.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    providerId: 'copilot',
    sessionId: 'lead-session',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/events.jsonl',
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
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function toolStartRecord(toolCallId: string, toolName: string, args: Record<string, unknown>) {
  return JSON.stringify({
    type: 'tool.execution_start',
    data: { toolCallId, toolName, arguments: args, turnId: 't1' },
  });
}

function toolCompleteRecord(toolCallId: string) {
  return JSON.stringify({
    type: 'tool.execution_complete',
    data: { toolCallId, success: true },
  });
}

function turnEndRecord() {
  return JSON.stringify({ type: 'assistant.turn_end', data: { turnId: 't1' } });
}

describe('transcriptParser: Copilot CLI records', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(copilotProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('tool.execution_start broadcasts agentToolStart and tracks the tool', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'view', { path: '/x/foo.ts' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.activeToolIds.has('call_1')).toBe(true);
    expect(agent.activeToolNames.get('call_1')).toBe('view');
    expect(agent.hadToolsInTurn).toBe(true);
    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start).toMatchObject({ toolId: 'call_1', toolName: 'view', status: 'Reading foo.ts' });
    expect(messages.some((m) => m.type === 'agentStatus' && m.status === 'active')).toBe(true);
  });

  it('preserves explicit permission across unrelated progress and billing records', () => {
    const records = [
      {
        type: 'permission.requested',
        data: { requestId: 'request-1', permissionRequest: { kind: 'shell' } },
      },
      { type: 'tool.execution_progress', data: { toolCallId: 'other-tool' } },
      { type: 'assistant.usage', data: { inputTokens: 1234, outputTokens: 100 } },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 1234, output_tokens: 100 },
          content: [],
        },
      },
    ];
    for (const record of records) {
      processTranscriptLine(1, JSON.stringify(record), agents, waitingTimers, permissionTimers);
    }
    expect(agent.permissionSent).toBe(true);
    expect(agent.contextTokens).toBe(0);
    expect(messages.some((message) => message.type === 'agentToolPermissionClear')).toBe(false);
    expect(messages.some((message) => message.type === 'agentContextUsage')).toBe(false);

    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'session.usage_info',
        data: { currentTokens: 400, tokenLimit: 1000 },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.contextTokens).toBe(400);
    expect(agent.maxContextTokens).toBe(1000);
    expect(agent.permissionSent).toBe(true);
  });

  it('tool.execution_complete clears the exact tool and broadcasts agentToolDone', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'edit', { path: '/x/bar.ts' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(1, toolCompleteRecord('call_1'), agents, waitingTimers, permissionTimers);
    expect(agent.activeToolIds.has('call_1')).toBe(false);
    expect(messages.some((m) => m.type === 'agentToolDone' && m.toolId === 'call_1')).toBe(true);
  });

  it('tool.execution_failed clears the tool the same as tool.execution_complete', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'powershell', { command: 'exit 1' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'tool.execution_failed', data: { toolCallId: 'call_1' } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.activeToolIds.has('call_1')).toBe(false);
  });

  it('an unanchored assistant.turn_end cannot establish aggregate completion', () => {
    processTranscriptLine(1, turnEndRecord(), agents, waitingTimers, permissionTimers);
    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(false);
    expect(agent.observation).toBe('unknown');
    expect(messages.some((m) => m.type === 'agentStatus' && m.status === 'waiting')).toBe(false);
  });

  it('assistant.turn_end cannot clear an outstanding uncorrelated tool', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'grep', {}),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(1, turnEndRecord(), agents, waitingTimers, permissionTimers);
    expect(agent.activeToolIds.has('call_1')).toBe(true);
    expect(messages.some((m) => m.type === 'agentToolsClear')).toBe(false);
  });

  it('a subagent tool (task) completing broadcasts subagentClear', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'task', { description: 'Explore' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(1, toolCompleteRecord('call_1'), agents, waitingTimers, permissionTimers);
    expect(messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'call_1')).toBe(
      true,
    );
  });

  it('known no-op record types (hook.start, session.start, etc.) do not throw or broadcast', () => {
    for (const type of [
      'hook.start',
      'hook.end',
      'user.message',
      'assistant.message',
      'session.start',
      'session.compaction_start',
      'session.compaction_complete',
    ]) {
      expect(() =>
        processTranscriptLine(
          1,
          JSON.stringify({ type, data: {} }),
          agents,
          waitingTimers,
          permissionTimers,
        ),
      ).not.toThrow();
    }
    expect(messages).toHaveLength(0);
  });

  it('assistant.turn_start marks the agent active (a new turn is genuinely busy, not idle)', () => {
    agent.isWaiting = true;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'assistant.turn_start', data: { turnId: 't2' } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.isWaiting).toBe(false);
    expect(messages).toContainEqual({ type: 'agentStatus', id: 1, status: 'active' });
  });

  it('an unrecognized record type is logged once via seenUnknownRecordTypes and does not throw', () => {
    expect(() =>
      processTranscriptLine(
        1,
        JSON.stringify({ type: 'something.brand.new', data: {} }),
        agents,
        waitingTimers,
        permissionTimers,
      ),
    ).not.toThrow();
    expect(agent.seenUnknownRecordTypes.has('something.brand.new')).toBe(true);
  });

  it('malformed JSON lines are ignored, not thrown', () => {
    expect(() =>
      processTranscriptLine(1, '{not valid json', agents, waitingTimers, permissionTimers),
    ).not.toThrow();
  });
});
