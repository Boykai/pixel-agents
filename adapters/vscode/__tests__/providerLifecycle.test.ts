import { afterEach, describe, expect, it, vi } from 'vitest';

const { terminal, createTerminal, existsSync } = vi.hoisted(() => {
  const terminal = { name: 'Provider #1', show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() };
  return { terminal, createTerminal: vi.fn(() => terminal), existsSync: vi.fn(() => false) };
});
vi.mock('vscode', () => ({
  window: { createTerminal, terminals: [terminal] },
  workspace: { workspaceFolders: [] },
}));
vi.mock('fs', () => ({ existsSync }));

import type { StateAdapter } from '../../../core/src/adapter.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentRuntime } from '../../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../../server/src/agentStateStore.js';
import type { AgentState } from '../../../server/src/types.js';
import { launchNewTerminal, restoreAgents, sendExistingAgents } from '../agentManager.js';

const provider = {
  id: 'test-provider',
  displayName: 'Test Provider',
  terminalNamePrefix: 'Test Terminal',
  getSessionDirs: () => ['C:\\sessions'],
  resolveSessionId: () => 'real-session',
  expectedTranscriptPath: (sessionId: string) => `C:\\sessions\\${sessionId}\\events.jsonl`,
  buildLaunchCommand: () => ({ command: 'test-cli', args: ['--new'], env: { TEST_PROVIDER: '1' } }),
} as unknown as HookProvider;

function setup() {
  const knownFiles = new Set<string>();
  const store = new AgentStateStore();
  vi.spyOn(store, 'persist').mockImplementation(() => {});
  const watcher = {
    recoverAgent: vi.fn<(agent: AgentState) => void>(),
    startFileWatching: vi.fn(),
    readNewLines: vi.fn(),
    reassignAgentToFile: vi.fn(),
  };
  const runtime = {
    fileWatchers: new Map(),
    pollingTimers: new Map(),
    waitingTimers: new Map(),
    permissionTimers: new Map(),
    jsonlPollTimers: new Map(),
    knownJsonlFiles: new Set(),
    getKnownJsonlFiles: vi.fn(() => knownFiles),
    activeAgentId: { current: null },
    getFileWatcher: vi.fn(() => watcher),
    getProvider: vi.fn((id: string) => (id === provider.id ? provider : undefined)),
    registerAgent: vi.fn(),
    startProjectScan: vi.fn(),
  };
  return { store, runtime: runtime as unknown as AgentRuntime, rawRuntime: runtime };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
});

describe('provider-aware VS Code lifecycle', () => {
  it('does not launch a process when the provider cannot identify its new transcript', async () => {
    const { store, runtime } = setup();
    await expect(
      launchNewTerminal(
        runtime,
        {
          ...provider,
          expectedTranscriptPath: undefined,
        },
        store,
        'C:\\workspace',
      ),
    ).rejects.toThrow('new-session transcript path');
    expect(createTerminal).not.toHaveBeenCalled();
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it('launches with provider command, terminal identity, and scoped watcher', async () => {
    vi.useFakeTimers();
    const { store, runtime, rawRuntime } = setup();
    await launchNewTerminal(runtime, provider, store, 'C:\\workspace');
    const agent = [...store.values()][0];
    expect(agent.providerId).toBe(provider.id);
    expect(agent.jsonlFile).toBe(`C:\\sessions\\${agent.sessionId}\\events.jsonl`);
    expect(agent.observation).toBe('unknown');
    expect(createTerminal).toHaveBeenCalledWith({
      name: 'Test Terminal #1',
      cwd: 'C:\\workspace',
      env: { TEST_PROVIDER: '1' },
    });
    expect(terminal.sendText).toHaveBeenCalledWith('test-cli --new');
    expect(rawRuntime.getFileWatcher).toHaveBeenCalledWith(provider.id);
    expect(rawRuntime.getKnownJsonlFiles).toHaveBeenCalledWith(provider.id);
    expect(rawRuntime.getKnownJsonlFiles().has(agent.jsonlFile)).toBe(true);
    expect(rawRuntime.knownJsonlFiles.size).toBe(0);
    expect(rawRuntime.registerAgent).toHaveBeenCalledWith(agent.sessionId, agent.id, provider.id);
    for (const timer of runtime.jsonlPollTimers.values()) clearInterval(timer);
  });

  it('restores a quiet terminal as unknown without disposing it after a silence timer', () => {
    vi.useFakeTimers();
    const { store, runtime, rawRuntime } = setup();
    const adapter = {
      loadAgents: () => [
        {
          id: 4,
          providerId: provider.id,
          terminalName: terminal.name,
          sessionId: 'old',
          jsonlFile: 'C:\\sessions\\events.jsonl',
          projectDir: 'C:\\sessions',
        },
      ],
    } as unknown as StateAdapter;
    restoreAgents(adapter, runtime, store);
    expect(store.get(4)?.sessionId).toBe('real-session');
    expect(store.get(4)?.observation).toBe('unknown');
    expect(rawRuntime.registerAgent).toHaveBeenCalledWith('real-session', 4, provider.id);
    vi.advanceTimersByTime(20_000);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(store.has(4)).toBe(true);
    for (const timer of runtime.jsonlPollTimers.values()) clearInterval(timer);
  });

  it('reconnect snapshot preserves provider identity, title, and observation', () => {
    const { store, runtime } = setup();
    const adapter = {
      loadAgents: () => [
        {
          id: 4,
          providerId: provider.id,
          terminalName: terminal.name,
          sessionId: 'old',
          jsonlFile: 'C:\\sessions\\events.jsonl',
          projectDir: 'C:\\sessions',
          sessionName: 'Current task',
        },
      ],
      loadSeats: () => ({}),
    } as unknown as StateAdapter;
    vi.useFakeTimers();
    restoreAgents(adapter, runtime, store);
    const postMessage = vi.fn();
    sendExistingAgents(store, adapter, { postMessage } as never);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIds: { 4: provider.id },
        sessionNames: { 4: 'Current task' },
        observations: { 4: 'unknown' },
      }),
    );
    for (const timer of runtime.jsonlPollTimers.values()) clearInterval(timer);
  });

  it('hydrates provider state before announcement and keeps the recovered tail offset', () => {
    const { store, runtime, rawRuntime } = setup();
    existsSync.mockReturnValue(true);
    const watcher = rawRuntime.getFileWatcher();
    watcher.recoverAgent.mockImplementation((agent) => {
      expect(store.has(agent.id)).toBe(false);
      agent.fileOffset = 42;
      agent.observation = 'known';
      agent.isWaiting = true;
    });
    const adapter = {
      loadAgents: () => [
        {
          id: 4,
          providerId: provider.id,
          terminalName: '',
          isExternal: true,
          sessionId: 'old',
          jsonlFile: 'C:\\sessions\\events.jsonl',
          projectDir: 'C:\\sessions',
        },
      ],
    } as unknown as StateAdapter;
    restoreAgents(adapter, runtime, store);
    expect(store.get(4)?.fileOffset).toBe(42);
    expect(store.get(4)?.observation).toBe('known');
    expect(watcher.startFileWatching).toHaveBeenCalled();
    expect(rawRuntime.knownJsonlFiles.size).toBe(0);
  });
});
