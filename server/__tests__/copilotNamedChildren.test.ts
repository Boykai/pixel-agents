import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';

type RecordEvent = Record<string, unknown>;
const task = (toolCallId: string, name?: string): RecordEvent => ({
  type: 'tool.execution_start',
  data: { toolCallId, toolName: 'task', arguments: { name, description: 'Inspect project' } },
});
const start = (toolCallId: string, agentId: string, background = true): RecordEvent => ({
  type: 'subagent.started',
  agentId,
  data: {
    toolCallId,
    executionMode: background ? 'background' : 'foreground',
    agentName: 'explore',
  },
});
const completeTool = (toolCallId: string): RecordEvent => ({
  type: 'tool.execution_complete',
  data: { toolCallId, success: true },
});

describe('Copilot named background teammates', () => {
  let root: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    root = path.resolve(`.copilot-children-${randomUUID()}`);
    fs.mkdirSync(root);
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function office(records: Array<RecordEvent | string> = []) {
    const sessionId = randomUUID();
    const directory = path.join(root, sessionId);
    fs.mkdirSync(directory);
    const file = path.join(directory, 'events.jsonl');
    fs.writeFileSync(
      file,
      records
        .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)) + '\n')
        .join(''),
    );
    let saved: PersistedAgent[] = [
      {
        id: 1,
        providerId: 'copilot',
        sessionId,
        terminalName: '',
        isExternal: true,
        projectDir: directory,
        jsonlFile: file,
        folderName: 'workspace',
        sessionName: 'parent title',
      },
    ];
    const adapter: StateAdapter = {
      loadAgents: () => saved,
      saveAgents: (agents) => {
        saved = agents;
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, fallback: T) => fallback,
      setSetting: () => {},
    };
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    const runtime = new AgentRuntime(store, copilotProvider);
    runtimes.push(runtime);
    const messages: RecordEvent[] = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime.restoreExternalAgents();
    const lead = store.get(1)!;
    const emit = (...events: RecordEvent[]) => {
      fs.appendFileSync(file, events.map((event) => JSON.stringify(event) + '\n').join(''));
      runtime
        .getFileWatcher('copilot')
        .readNewLines(lead.id, store, runtime.waitingTimers, runtime.permissionTimers);
    };
    return {
      runtime,
      store,
      lead,
      emit,
      messages,
      file,
      persisted: () => saved,
      children: () => [...store.values()].filter((agent) => agent.leadAgentId === lead.id),
    };
  }

  it('promotes explicit named background lifetime, routes activity, and completes without unregistering the lead', () => {
    const o = office();
    o.emit(task('spawn', 'researcher'));
    expect(o.children()).toHaveLength(0);
    o.emit(start('spawn', 'child'));
    const child = o.children()[0];
    expect(child).toMatchObject({
      agentName: 'researcher',
      providerId: 'copilot',
      sessionId: o.lead.sessionId,
      folderName: 'workspace',
      sessionName: 'parent title',
      spawnToolUseId: 'spawn',
      hooksOnly: true,
      jsonlFile: '',
    });
    expect(o.lead.isTeamLead).toBe(true);
    expect(o.persisted().map((agent) => agent.id)).toEqual([o.lead.id]);
    expect(o.messages).toContainEqual({
      type: 'subagentClear',
      id: o.lead.id,
      parentToolId: 'spawn',
    });

    o.emit(
      completeTool('spawn'),
      {
        type: 'tool.execution_start',
        agentId: 'child',
        data: { toolCallId: 'reading', toolName: 'view', arguments: { path: 'README.md' } },
      },
      { type: 'hook.start', data: { hookType: 'agentStop' } },
    );
    expect(child.activeToolNames.get('reading')).toBe('view');
    expect(o.lead.activeToolIds.has('reading')).toBe(false);
    expect(o.lead.isWaiting).toBe(false);
    expect(o.children()).toHaveLength(1);
    o.emit(
      {
        type: 'tool.execution_complete',
        data: { parentToolCallId: 'spawn', toolCallId: 'reading', success: true },
      },
      { type: 'hook.start', agentId: 'child', data: { hookType: 'agentStop' } },
    );
    expect(child.activeToolIds.size).toBe(0);
    expect(child.isWaiting).toBe(true);
    expect(o.lead.isWaiting).toBe(false);
    o.emit({ type: 'subagent.completed', data: { toolCallId: 'spawn' } });
    expect(o.children()).toHaveLength(0);
    expect(o.lead.isWaiting).toBe(true);
    expect(o.lead.isTeamLead).toBeUndefined();
    const consume = vi.fn(() => true);
    o.runtime.setHookEventConsumer('copilot', consume);
    o.runtime.handleHookEvent('copilot', {
      hookType: 'userPromptSubmitted',
      sessionId: o.lead.sessionId,
    });
    expect(consume).toHaveBeenCalledWith(expect.anything(), o.lead, expect.anything());
  });

  it('automatically consumes batched exact-ID hooks and enriches them from the transcript', () => {
    const o = office();
    o.runtime.handleHookEvent('copilot', {
      hookType: 'preToolUse',
      sessionId: o.lead.sessionId,
      toolCalls: [
        { toolCallId: 'a', toolName: 'view' },
        { toolCallId: 'b', toolName: 'powershell' },
      ],
    });
    expect([...o.lead.activeToolIds].sort()).toEqual(['a', 'b']);
    expect(o.lead.currentHookToolId).toBeUndefined();
    o.emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'a', toolName: 'view', arguments: { path: 'enriched.ts' } },
    });
    expect(o.lead.activeToolStatuses.get('a')).toBe('Reading enriched.ts');
    o.runtime.handleHookEvent('copilot', {
      hookType: 'postToolUse',
      sessionId: o.lead.sessionId,
      toolCallId: 'a',
      toolName: 'view',
    });
    o.emit(completeTool('a'), {
      type: 'tool.execution_start',
      data: { toolCallId: 'a', toolName: 'view', arguments: { path: 'stale.ts' } },
    });
    expect(o.lead.activeToolIds.has('a')).toBe(false);
    expect(o.lead.activeToolIds.has('b')).toBe(true);
    expect(
      o.messages.filter((message) => message.type === 'agentToolDone' && message.toolId === 'a'),
    ).toHaveLength(1);
  });

  it('uses the shared child callbacks for hooks and retains hook source during child enrichment', () => {
    const o = office();
    o.emit(task('spawn', 'hook-child'), start('spawn', 'child'), completeTool('spawn'));
    const child = o.children()[0];
    o.runtime.handleHookEvent('copilot', {
      hookType: 'preToolUse',
      sessionId: o.lead.sessionId,
      agentId: 'child',
      toolCallId: 'child-tool',
      toolName: 'view',
    });
    expect(child.activeToolNames.get('child-tool')).toBe('view');
    o.emit({
      type: 'tool.execution_start',
      agentId: 'child',
      data: {
        toolCallId: 'child-tool',
        toolName: 'view',
        arguments: { path: 'child-enriched.ts' },
      },
    });
    expect(child.activeToolStatuses.get('child-tool')).toBe('Reading child-enriched.ts');
    o.runtime.handleHookEvent('copilot', {
      hookType: 'agentStop',
      sessionId: o.lead.sessionId,
    });
    expect(o.children()).toHaveLength(1);
    expect(child.activeToolIds.has('child-tool')).toBe(true);
    expect(o.lead.isWaiting).toBe(false);
    o.emit({ type: 'subagent.completed', data: { toolCallId: 'spawn' } });
    expect(o.children()).toHaveLength(0);
    expect(o.lead.isWaiting).toBe(true);
  });

  it('consumes missing-ID and unknown hooks without generic guesses and restarts user turns', () => {
    const o = office();
    o.runtime.handleHookEvent('copilot', {
      hookType: 'sessionStart',
      sessionId: o.lead.sessionId,
    });
    expect(o.lead.hookDelivered).toBe(true);
    o.runtime.handleHookEvent('copilot', {
      hookType: 'preToolUse',
      sessionId: o.lead.sessionId,
      toolName: 'powershell',
    });
    o.runtime.handleHookEvent('copilot', {
      hookType: 'notification',
      sessionId: o.lead.sessionId,
      notification_type: 'unknown-kind',
    });
    expect(o.lead.activeToolIds.size).toBe(0);
    expect(o.lead.permissionSent).toBe(false);
    expect(o.runtime.permissionTimers.size).toBe(0);
    o.runtime.handleHookEvent('copilot', {
      hookType: 'agentStop',
      sessionId: o.lead.sessionId,
    });
    expect(o.lead.isWaiting).toBe(true);
    o.runtime.handleHookEvent('copilot', {
      hookType: 'userPromptSubmitted',
      sessionId: o.lead.sessionId,
    });
    expect(o.lead.isWaiting).toBe(false);
    expect(o.lead.observation).toBe('known');
  });

  it('keeps unnamed and foreground children as Subtasks, without interpreting agentName as a name', () => {
    const o = office();
    o.emit(
      task('unnamed'),
      start('unnamed', 'internal-type-only'),
      task('foreground', 'named-but-foreground'),
      start('foreground', 'foreground-id', false),
    );
    expect(o.children()).toHaveLength(0);
    expect(o.lead.teammateSpawnToolIds?.size ?? 0).toBe(0);
    o.emit({
      type: 'tool.execution_start',
      agentId: 'internal-type-only',
      data: { toolCallId: 'tool', toolName: 'view', arguments: { path: 'a.ts' } },
    });
    expect(o.messages).toContainEqual(
      expect.objectContaining({
        type: 'subagentToolStart',
        id: o.lead.id,
        parentToolId: 'unnamed',
        toolName: 'view',
      }),
    );
  });

  it('scopes colliding child tool and permission IDs to their separate teammate states', () => {
    const o = office();
    o.emit(task('a', 'alpha'), start('a', 'child-a'), task('b', 'beta'), start('b', 'child-b'));
    for (const parentToolCallId of ['a', 'b']) {
      o.emit(
        {
          type: 'tool.execution_start',
          data: { parentToolCallId, toolCallId: 'same', toolName: 'powershell' },
        },
        {
          type: 'permission.requested',
          data: {
            parentToolCallId,
            requestId: 'same-request',
            permissionRequest: { kind: 'shell', toolCallId: 'same' },
          },
        },
      );
    }
    const [a, b] = o.children();
    expect(a.permissionSent).toBe(true);
    expect(b.permissionSent).toBe(true);
    o.emit({
      type: 'tool.execution_complete',
      data: { parentToolCallId: 'a', toolCallId: 'same', success: true },
    });
    expect(a.activeToolIds.size).toBe(0);
    expect(a.permissionSent).toBe(false);
    expect(b.activeToolIds.has('same')).toBe(true);
    expect(b.permissionSent).toBe(true);
    o.runtime.removeAgent(o.lead.id);
    expect(o.store.size).toBe(0);
  });

  it('reconstructs derived children silently from bounded recovery and never persists them', () => {
    const o = office([
      task('spawn', 'restored'),
      start('spawn', 'restored-child'),
      completeTool('spawn'),
      {
        type: 'tool.execution_start',
        agentId: 'restored-child',
        data: { toolCallId: 'live-child-tool', toolName: 'view', arguments: { path: 'file.ts' } },
      },
      { type: 'hook.start', data: { hookType: 'agentStop' } },
    ]);
    const child = o.children()[0];
    expect(child?.agentName).toBe('restored');
    expect(child.activeToolNames.get('live-child-tool')).toBe('view');
    expect(
      o.messages
        .filter((message) => message.type === 'agentStatus')
        .every((message) => message.replay === true),
    ).toBe(true);
    expect(o.persisted()).toHaveLength(1);
    o.emit(
      {
        type: 'tool.execution_complete',
        agentId: 'restored-child',
        data: { toolCallId: 'live-child-tool', success: true },
      },
      { type: 'subagent.completed', data: { toolCallId: 'spawn' } },
    );
    expect(o.children()).toHaveLength(0);
    expect(o.store.get(o.lead.id)).toBe(o.lead);
  });

  it('keeps callbacks scoped across independent runtimes', () => {
    const a = office();
    const b = office();
    a.emit(task('same-spawn', 'first'), start('same-spawn', 'same-child'));
    b.emit(task('same-spawn', 'second'), start('same-spawn', 'same-child'));
    expect(a.children()[0].agentName).toBe('first');
    expect(b.children()[0].agentName).toBe('second');
    b.runtime.dispose();
    a.emit({
      type: 'tool.execution_start',
      agentId: 'same-child',
      data: { toolCallId: 'still-live', toolName: 'view' },
    });
    expect(a.children()[0].activeToolIds.has('still-live')).toBe(true);
    expect(b.store.size).toBe(0);
  });

  it('does not present recovered child activity as known across a malformed history gap', () => {
    const o = office([
      task('spawn', 'uncertain'),
      start('spawn', 'child'),
      {
        type: 'tool.execution_start',
        agentId: 'child',
        data: { toolCallId: 'uncertain-tool', toolName: 'view' },
      },
      'incomplete-json-record',
    ]);
    expect(o.lead.observation).toBe('unknown');
    expect(o.children().every((child) => child.observation === 'unknown')).toBe(true);
  });

  it('keeps a dismissed teammate hidden without dismissing the shared lead session', () => {
    const o = office();
    o.emit(task('spawn', 'dismissed'), start('spawn', 'child'));
    const child = o.children()[0];
    o.runtime.dismissAgent(child.id);
    o.runtime.removeAgent(child.id);
    const messageCount = o.messages.length;
    o.emit(
      {
        type: 'tool.execution_start',
        agentId: 'child',
        data: { toolCallId: 'hidden-tool', toolName: 'view' },
      },
      { type: 'assistant.turn_start', data: { turnId: 'next-main-step' } },
    );
    expect(o.children()).toHaveLength(0);
    expect(
      o.messages
        .slice(messageCount)
        .some(
          (message) => message.type === 'subagentToolStart' && message.parentToolId === 'spawn',
        ),
    ).toBe(false);
    expect(o.runtime.getDismissalTracker('copilot').isDismissed(o.lead.jsonlFile)).toBe(false);
    expect(o.store.get(o.lead.id)).toBe(o.lead);
  });

  it('replaces stale teammate activity when recovery reuses the same spawn identity', () => {
    const o = office();
    o.emit(task('spawn', 'recovered'), start('spawn', 'child'), {
      type: 'tool.execution_start',
      agentId: 'child',
      data: { toolCallId: 'old-tool', toolName: 'view', arguments: { path: 'no-longer-live.ts' } },
    });
    const original = o.children()[0];
    expect(original.activeToolIds.has('old-tool')).toBe(true);
    fs.writeFileSync(
      o.file,
      [task('spawn', 'recovered'), start('spawn', 'child')]
        .map((record) => JSON.stringify(record) + '\n')
        .join(''),
    );
    o.runtime
      .getFileWatcher('copilot')
      .readNewLines(o.lead.id, o.store, o.runtime.waitingTimers, o.runtime.permissionTimers);
    expect(o.children()).toHaveLength(1);
    expect(o.children()[0]).not.toBe(original);
    expect(o.children()[0].activeToolIds.size).toBe(0);
    expect(o.children()[0].observation).toBe('unknown');
  });

  it('promotes late task-name enrichment and removes children when the transcript is replaced', () => {
    const o = office();
    o.emit(start('late', 'child'), task('late', 'late-name'));
    expect(o.children()[0]?.agentName).toBe('late-name');
    fs.writeFileSync(o.file, JSON.stringify({ type: 'session.idle', data: {} }) + '\n');
    o.runtime
      .getFileWatcher('copilot')
      .readNewLines(o.lead.id, o.store, o.runtime.waitingTimers, o.runtime.permissionTimers);
    expect(o.children()).toHaveLength(0);
    expect(o.lead.isTeamLead).toBeUndefined();
  });
});
