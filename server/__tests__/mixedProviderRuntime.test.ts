import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { migrateAgentIdentity } from '../src/agentMigration.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
} from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { recoverCopilotTranscript } from '../src/providers/hook/copilot/recovery.js';

describe('provider-scoped runtime and bounded discovery', () => {
  let root: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    root = path.resolve(`.runtime-test-${randomUUID()}`);
    fs.mkdirSync(root);
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runtime(providers: HookProvider | HookProvider[]) {
    const store = new AgentStateStore();
    const instance = new AgentRuntime(store, providers);
    runtimes.push(instance);
    return { instance, store };
  }

  function session(dirName: string, records: unknown[] = []): string {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r) + '\n').join(''));
    return file;
  }

  function append(file: string, record: unknown) {
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  }

  function copilot(directories: () => string[]): HookProvider {
    return {
      ...claudeProvider,
      id: 'copilot',
      team: undefined,
      getSessionDirs: directories,
      getAllSessionRoots: () => [],
      sessionFilePattern: 'events.jsonl',
      recoverTranscript: recoverCopilotTranscript,
      resolveSessionId: (file) => path.basename(path.dirname(file)),
      isSessionCandidate: ({ size, previousSize }) =>
        previousSize !== undefined && size > previousSize,
    };
  }

  function adopt(instance: AgentRuntime, providerId: string, sessionId: string, cwd = root) {
    instance.watchAllSessions.current = true;
    instance.handleHookEvent(providerId, {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd,
    });
    instance.handleHookEvent(providerId, { hook_event_name: 'Stop', session_id: sessionId });
  }

  it('routes colliding session IDs in a mixed office only to their provider', () => {
    const other = { ...claudeProvider, id: 'other', team: undefined };
    const { instance, store } = runtime([claudeProvider, other]);
    expect(instance.providers).toEqual([claudeProvider, other]);
    expect(instance.getKnownJsonlFiles('claude')).toBe(instance.knownJsonlFiles);
    expect(instance.getKnownJsonlFiles('other')).not.toBe(instance.knownJsonlFiles);
    expect(instance.getDismissalTracker('claude')).toBe(instance.dismissalTracker);
    expect(instance.getDismissalTracker('other')).not.toBe(instance.dismissalTracker);
    adopt(instance, 'claude', 'same');
    adopt(instance, 'other', 'same');
    expect(store.size).toBe(2);
    const agents = [...store.values()];
    const claude = agents.find((a) => a.providerId === 'claude')!;
    const second = agents.find((a) => a.providerId === 'other')!;
    expect(claude.sessionId).toBe(second.sessionId);
    instance.handleHookEvent('other', {
      hook_event_name: 'PreToolUse',
      session_id: 'same',
      tool_name: 'Read',
      tool_input: {},
    });
    expect(second.isWaiting).toBe(false);
    expect(claude.isWaiting).toBe(true);
    instance.handleHookEvent('not-selected', {
      hook_event_name: 'SessionEnd',
      session_id: 'same',
      reason: 'exit',
    });
    expect(store.size).toBe(2);
    instance.handleHookEvent('other', {
      hook_event_name: 'SessionEnd',
      session_id: 'same',
      reason: 'exit',
    });
    expect(store.size).toBe(1);
    expect(store.get(claude.id)).toBe(claude);
  });

  it('keeps parser ownership after another runtime initializes and disposes', () => {
    const first = runtime(claudeProvider);
    const second = runtime({ ...claudeProvider, id: 'other', team: undefined });
    adopt(first.instance, 'claude', 'a');
    adopt(second.instance, 'other', 'b');
    second.instance.dispose();
    first.instance.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'a',
      tool_name: 'Bash',
    });
    expect([...first.store.values()][0].isWaiting).toBe(false);
    expect(second.store.size).toBe(0);
  });

  it('keeps actual transcript formatting scoped across concurrent runtime instances', () => {
    const a = runtime({ ...claudeProvider, formatToolStatus: () => 'first-provider' });
    const b = runtime({
      ...claudeProvider,
      id: 'other',
      team: undefined,
      formatToolStatus: () => 'second-provider',
    });
    const files = [session('format-a'), session('format-b')];
    for (const [index, item] of [a, b].entries()) {
      item.instance.watchAllSessions.current = true;
      const providerId = index === 0 ? 'claude' : 'other';
      item.instance
        .getFileWatcher(providerId)
        .adoptExternalSessionFromHook(
          `session-${index}`,
          files[index],
          root,
          new Set(),
          item.store.nextAgentId,
          item.store,
          item.instance.fileWatchers,
          item.instance.pollingTimers,
          item.instance.waitingTimers,
          item.instance.permissionTimers,
          () => {},
        );
      append(files[index], {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'shared-tool', name: 'Read', input: {} }] },
      });
    }
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect([...a.store.values()][0].activeToolStatuses.get('shared-tool')).toBe('first-provider');
    expect([...b.store.values()][0].activeToolStatuses.get('shared-tool')).toBe('second-provider');
    b.instance.dispose();
    append(files[0], {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'after-disposal', name: 'Read', input: {} }] },
    });
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect([...a.store.values()][0].activeToolStatuses.get('after-disposal')).toBe(
      'first-provider',
    );
  });

  it('discovers all newly appearing workspace directories without importing saved history', () => {
    let dirs: string[] = [];
    const { instance, store } = runtime(copilot(() => dirs));
    instance.startDiscovery([root]);
    const files = [
      session('one', [{ type: 'assistant.turn_end', data: {} }]),
      session('two', [{ type: 'assistant.turn_end', data: {} }]),
    ];
    dirs = files.map((f) => path.dirname(f));
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS * 2);
    expect(store.size).toBe(0);
    for (const file of files)
      append(file, {
        type: 'tool.execution_start',
        data: { toolCallId: 'same-tool', toolName: 'view', arguments: {} },
      });
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    expect([...store.values()].map((a) => a.sessionId).sort()).toEqual(['one', 'two']);
    for (const agent of store.values()) {
      expect(agent.providerId).toBe('copilot');
      expect(agent.activeToolIds.has('same-tool')).toBe(true);
    }
    append(files[0], { type: 'tool.execution_complete', data: { toolCallId: 'same-tool' } });
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect(
      [...store.values()].find((a) => a.sessionId === 'two')?.activeToolIds.has('same-tool'),
    ).toBe(true);
  });

  it('adopts a new active first batch after empty boot without requiring another write', () => {
    let dirs: string[] = [];
    const sessionRoot = path.join(root, 'new-session-state');
    const provider = { ...copilot(() => dirs), getAllSessionRoots: () => [sessionRoot] };
    const { instance, store } = runtime(provider);
    expect(fs.existsSync(sessionRoot)).toBe(false);
    instance.startDiscovery([root]);
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    const file = session(path.join('new-session-state', 'one-batch'), [
      { type: 'session.start', data: {} },
      {
        type: 'tool.execution_start',
        data: { toolCallId: 'long-tool', toolName: 'view', arguments: { path: 'first.ts' } },
      },
    ]);
    dirs = [path.dirname(file)];
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS * 2);
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.sessionId).toBe('one-batch');
    expect(agent.activeToolStatuses.get('long-tool')).toBe('Reading first.ts');
  });

  it('baselines existing global history before a later workspace or Watch All scope includes it', () => {
    const history = session('saved-history', [
      { type: 'tool.execution_start', data: { toolCallId: 'historic', toolName: 'view' } },
    ]);
    let dirs: string[] = [];
    const provider = { ...copilot(() => dirs), getAllSessionRoots: () => [root] };
    const { instance, store } = runtime(provider);
    instance.startDiscovery([root]);
    dirs = [path.dirname(history)];
    instance.watchAllSessions.current = true;
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS * 2);
    expect(store.size).toBe(0);
    append(history, {
      type: 'tool.execution_start',
      data: { toolCallId: 'new-activity', toolName: 'view' },
    });
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    expect(store.size).toBe(1);
  });

  it('retains all workspace directories without re-registering later roots each discovery tick', () => {
    const first = session('first-workspace');
    const second = session('second-workspace');
    const provider = {
      ...copilot(() => []),
      getSessionDirs: (workspace: string) => [path.dirname(workspace === 'first' ? first : second)],
    };
    const { instance, store } = runtime(provider);
    const startScan = vi.spyOn(instance, 'startProjectScan');
    instance.startDiscovery(['first', 'second']);
    expect(startScan).toHaveBeenCalledTimes(2);
    for (const file of [first, second]) {
      append(file, {
        type: 'tool.execution_start',
        data: { toolCallId: 'active', toolName: 'view' },
      });
    }
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS * 3);
    expect(startScan).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(2);
  });

  it('restores bounded state before announcement without replaying history notifications', () => {
    const file = session('saved', [
      { type: 'assistant.turn_start', data: {} },
      { type: 'tool.execution_start', data: { toolCallId: 'live', toolName: 'view' } },
    ]);
    const { instance, store } = runtime(copilot(() => []));
    const saved: PersistedAgent = {
      id: 7,
      providerId: 'copilot',
      sessionId: 'events',
      terminalName: '',
      isExternal: true,
      jsonlFile: file,
      projectDir: path.dirname(file),
      palette: 4,
    };
    store.setAdapter({
      loadAgents: () => [saved],
      saveAgents: vi.fn(),
      loadSeats: () => ({}),
      saveSeats: vi.fn(),
      getSetting: (_key, value) => value,
      setSetting: vi.fn(),
    });
    const announced = vi.fn((_id, agent) => {
      expect(agent.sessionId).toBe('saved');
      expect(agent.activeToolIds.has('live')).toBe(true);
    });
    const broadcasts = vi.fn();
    store.on('agentAdded', announced);
    store.on('broadcast', broadcasts);
    instance.restoreExternalAgents();
    expect(announced).toHaveBeenCalledOnce();
    expect(
      broadcasts.mock.calls
        .filter(([m]) => m.type === 'agentStatus')
        .every(([m]) => m.replay === true),
    ).toBe(true);
    expect(store.get(7)?.palette).toBe(4);
    expect(store.get(7)?.fileOffset).toBe(fs.statSync(file).size);
  });

  it('retains unknown state when bounded recovery has no authoritative activity', () => {
    const file = session('quiet', [{ type: 'hook.start', data: { hookType: 'sessionEnd' } }]);
    const { instance, store } = runtime(copilot(() => []));
    instance.watchAllSessions.current = true;
    instance.handleHookEvent('copilot', {
      hook_event_name: 'SessionStart',
      session_id: 'quiet',
      transcript_path: file,
      cwd: root,
    });
    // Direct watcher adoption lets the test isolate recovery from a live Stop confirmation.
    instance
      .getFileWatcher('copilot')
      .adoptExternalSessionFromHook(
        'quiet',
        file,
        root,
        new Set(),
        store.nextAgentId,
        store,
        instance.fileWatchers,
        instance.pollingTimers,
        instance.waitingTimers,
        instance.permissionTimers,
        () => {},
      );
    expect([...store.values()][0].observation).toBe('unknown');
    expect([...store.values()][0].isWaiting).toBe(false);
  });

  it('repairs Copilot events identities repeatably without changing visual assignments', () => {
    const id = randomUUID();
    const old: PersistedAgent = {
      id: 3,
      sessionId: 'events',
      terminalName: '',
      palette: 4,
      hueShift: 45,
      jsonlFile: path.join(root, 'session-state', id, 'events.jsonl'),
      projectDir: root,
    };
    const migrated = migrateAgentIdentity(old);
    expect(migrated).toEqual({ ...old, providerId: 'copilot', sessionId: id });
    expect(migrateAgentIdentity(migrated)).toEqual(migrated);
    expect(
      migrateAgentIdentity({ ...old, jsonlFile: path.join(root, 'events.jsonl') }),
    ).toMatchObject({ observation: 'unknown', sessionId: 'events' });
  });

  it('keeps global scope opt-in and adopts tiny files only after observed growth', () => {
    const file = session('global-only', [{ type: 'session.start', data: {} }]);
    const provider = { ...copilot(() => []), getAllSessionRoots: () => [root] };
    const { instance, store } = runtime(provider);
    instance.startDiscovery([]);
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    expect(store.size).toBe(0);
    instance.watchAllSessions.current = true;
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    expect(store.size).toBe(0);
    append(file, { type: 'assistant.turn_start', data: {} });
    vi.advanceTimersByTime(EXTERNAL_SCAN_INTERVAL_MS);
    expect(store.size).toBe(1);
    expect([...store.values()][0].sessionId).toBe('global-only');
  });

  it('retains a persisted session as unknown while its transcript is temporarily unavailable', () => {
    const { instance, store } = runtime(copilot(() => []));
    const saved: PersistedAgent = {
      id: 9,
      providerId: 'copilot',
      sessionId: 'unavailable',
      terminalName: '',
      isExternal: true,
      jsonlFile: path.join(root, 'unavailable', 'events.jsonl'),
      projectDir: root,
      palette: 2,
    };
    store.setAdapter({
      loadAgents: () => [saved],
      saveAgents: vi.fn(),
      loadSeats: () => ({}),
      saveSeats: vi.fn(),
      getSetting: (_key, value) => value,
      setSetting: vi.fn(),
    });
    instance.restoreExternalAgents();
    expect(store.get(9)).toMatchObject({
      observation: 'unknown',
      palette: 2,
      sessionId: 'unavailable',
    });
  });

  it('hands already-routed events to only the selected provider reducer', () => {
    const { instance, store } = runtime([claudeProvider, { ...claudeProvider, id: 'other' }]);
    adopt(instance, 'claude', 'same');
    adopt(instance, 'other', 'same');
    const consume = vi.fn(() => true);
    instance.setHookEventConsumer('other', consume);
    instance.handleHookEvent('other', {
      hook_event_name: 'PreToolUse',
      session_id: 'same',
      tool_name: 'Read',
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(consume.mock.calls[0]).toBeDefined();
    // The generic Claude-style handler must not run after the provider consumed it.
    expect([...store.values()].find((agent) => agent.providerId === 'other')?.isWaiting).toBe(true);
    instance.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'same',
      tool_name: 'Read',
    });
    expect(consume).toHaveBeenCalledOnce();
  });

  it('uses provider path and cwd seams before the first discovery scan', () => {
    const file = session('resolved');
    const getSessionFile = vi.fn((id: string) => (id === 'resolved' ? file : undefined));
    const provider: HookProvider = {
      ...claudeProvider,
      id: 'path-provider',
      team: undefined,
      getSessionDirs: () => [],
      getSessionFile,
      getSessionCwd: (dir) => (dir === path.dirname(file) ? root : undefined),
    };
    const { instance, store } = runtime(provider);
    instance.startDiscovery([root]);
    instance.handleHookEvent(provider.id, {
      hook_event_name: 'SessionStart',
      session_id: 'resolved',
    });
    instance.handleHookEvent(provider.id, { hook_event_name: 'Stop', session_id: 'resolved' });
    expect(getSessionFile).toHaveBeenCalledWith('resolved', '');
    expect(store.size).toBe(1);
    expect([...store.values()][0]).toMatchObject({
      providerId: provider.id,
      sessionId: 'resolved',
      jsonlFile: file,
    });
  });

  it('starts a user turn without destroying outstanding background work', () => {
    const provider: HookProvider = {
      ...claudeProvider,
      normalizeHookEvent: (raw) =>
        raw.hookType === 'userPromptSubmitted' && typeof raw.sessionId === 'string'
          ? { sessionId: raw.sessionId, event: { kind: 'turnStart' } }
          : claudeProvider.normalizeHookEvent(raw),
    };
    const { instance, store } = runtime(provider);
    adopt(instance, 'claude', 'turn-start');
    const agent = [...store.values()][0];
    agent.activeToolIds.add('background');
    agent.backgroundAgentToolIds.add('background');
    agent.awaitingInput = true;
    instance.waitingTimers.set(
      agent.id,
      setTimeout(() => {
        agent.isWaiting = true;
      }, 1),
    );
    instance.handleHookEvent('claude', {
      hookType: 'userPromptSubmitted',
      sessionId: 'turn-start',
    });
    vi.advanceTimersByTime(1);
    expect(agent.isWaiting).toBe(false);
    expect(agent.awaitingInput).toBe(false);
    expect(agent.activeToolIds.has('background')).toBe(true);
    expect(agent.backgroundAgentToolIds.has('background')).toBe(true);
    expect(instance.waitingTimers.has(agent.id)).toBe(false);
  });

  it('tails split UTF-8 records and recovers safely after file truncation', () => {
    const file = session('split');
    const { instance, store } = runtime(copilot(() => []));
    const watcher = instance.getFileWatcher('copilot');
    watcher.adoptExternalSessionFromHook(
      'split',
      file,
      root,
      new Set(),
      store.nextAgentId,
      store,
      instance.fileWatchers,
      instance.pollingTimers,
      instance.waitingTimers,
      instance.permissionTimers,
      () => {},
    );
    const record = Buffer.from(
      JSON.stringify({
        type: 'tool.execution_start',
        data: {
          toolCallId: 'unicode',
          toolName: 'view',
          arguments: { path: '📄.ts' },
        },
      }) + '\n',
    );
    const cut = record.indexOf(Buffer.from('📄')) + 1;
    fs.appendFileSync(file, record.subarray(0, cut));
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    const agent = [...store.values()][0];
    expect(agent.activeToolIds.size).toBe(0);
    fs.appendFileSync(file, record.subarray(cut));
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect(agent.activeToolStatuses.get('unicode')).toContain('📄.ts');
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant.turn_start', data: {} }) + '\n');
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect(agent.activeToolIds.size).toBe(0);
    expect(agent.fileOffset).toBe(fs.statSync(file).size);
    append(file, { type: 'tool.execution_start', data: { toolCallId: 'new', toolName: 'view' } });
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect(agent.activeToolIds.has('new')).toBe(true);
  });

  it('confirms file absence across checks even with hooks enabled', () => {
    const file = session('missing');
    const { instance, store } = runtime(copilot(() => []));
    instance
      .getFileWatcher()
      .adoptExternalSessionFromHook(
        'missing',
        file,
        root,
        new Set(),
        store.nextAgentId,
        store,
        instance.fileWatchers,
        instance.pollingTimers,
        instance.waitingTimers,
        instance.permissionTimers,
        () => {},
      );
    instance.startStaleCheck();
    fs.unlinkSync(file);
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(store.size).toBe(1);
    expect([...store.values()][0].observation).toBe('unknown');
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);
    expect(store.size).toBe(0);
  });
});
