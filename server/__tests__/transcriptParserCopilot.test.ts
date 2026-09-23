import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import {
  processTranscriptLine,
  setHookProvider,
  setSessionEndCallback,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors transcriptParser.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
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

  it('tool.execution_complete clears the tool and (delayed) broadcasts agentToolDone', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'edit', { path: '/x/bar.ts' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(1, toolCompleteRecord('call_1'), agents, waitingTimers, permissionTimers);
    expect(agent.activeToolIds.has('call_1')).toBe(false);
    expect(messages.some((m) => m.type === 'agentToolDone')).toBe(false); // delayed
    vi.runAllTimers();
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

  it('assistant.turn_end clears tool state and broadcasts agentStatus waiting (unconditional, even text-only turns)', () => {
    processTranscriptLine(1, turnEndRecord(), agents, waitingTimers, permissionTimers);
    expect(agent.isWaiting).toBe(true);
    expect(agent.hadToolsInTurn).toBe(false);
    const status = messages.find((m) => m.type === 'agentStatus');
    expect(status).toMatchObject({ status: 'waiting', awaitingInput: false });
  });

  it('assistant.turn_end after tool use broadcasts agentToolsClear', () => {
    processTranscriptLine(
      1,
      toolStartRecord('call_1', 'grep', {}),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(1, turnEndRecord(), agents, waitingTimers, permissionTimers);
    expect(agent.activeToolIds.size).toBe(0);
    expect(messages.some((m) => m.type === 'agentToolsClear')).toBe(true);
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

  it('hook.start with hookType=sessionEnd invokes the sessionEnd callback with the reason', () => {
    const onSessionEnd = vi.fn();
    setSessionEndCallback(onSessionEnd);
    try {
      processTranscriptLine(
        1,
        JSON.stringify({
          type: 'hook.start',
          data: { hookType: 'sessionEnd', input: { reason: 'complete' } },
        }),
        agents,
        waitingTimers,
        permissionTimers,
      );
      expect(onSessionEnd).toHaveBeenCalledWith(1, 'complete');
    } finally {
      setSessionEndCallback(null);
    }
  });

  it('hook.start with a non-sessionEnd hookType does not invoke the sessionEnd callback', () => {
    const onSessionEnd = vi.fn();
    setSessionEndCallback(onSessionEnd);
    try {
      processTranscriptLine(
        1,
        JSON.stringify({ type: 'hook.start', data: { hookType: 'postToolUse' } }),
        agents,
        waitingTimers,
        permissionTimers,
      );
      expect(onSessionEnd).not.toHaveBeenCalled();
    } finally {
      setSessionEndCallback(null);
    }
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
