import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// agentManager.ts imports `vscode`, which only exists inside the extension host.
// vi.hoisted is required because vi.mock is hoisted above the imports.
const { terminals, createTerminal, workspace } = vi.hoisted(() => {
  const terminals: Array<{ name: string; show: () => void; sendText: () => void }> = [];
  const createTerminal = vi.fn((options: { name: string }) => {
    const terminal = { name: options.name, show: vi.fn(), sendText: vi.fn() };
    terminals.push(terminal);
    return terminal;
  });
  return { terminals, createTerminal, workspace: { workspaceFolders: [] } };
});
vi.mock('vscode', () => ({ window: { createTerminal, terminals }, workspace }));

import {
  launchNewTerminal,
  restoreAgents,
  sendExistingAgents,
} from '../../adapters/vscode/agentManager.js';
import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { NicknameBook, PersistedAgent } from '../../core/src/schemas.js';
import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { emptyNicknameBook } from '../src/nicknames.js';

// Never created: the launch's poll timer only ever finds nothing here.
const sessionsDir = path.join(os.tmpdir(), 'pxl-vscode-nicknames-absent');

const provider = {
  id: 'test-provider',
  displayName: 'Test Provider',
  terminalNamePrefix: 'Test Terminal',
  getSessionDirs: () => [sessionsDir],
  expectedTranscriptPath: (sessionId: string) => path.join(sessionsDir, `${sessionId}.jsonl`),
  buildLaunchCommand: () => ({ command: 'test-cli', args: [], env: {} }),
} as unknown as HookProvider;

type Seats = Record<string, { palette?: number; hueShift?: number; seatId?: string }>;

function createMemoryAdapter(
  initial: { agents?: PersistedAgent[]; book?: NicknameBook; seats?: Seats } = {},
) {
  const state = {
    agents: initial.agents ?? [],
    seats: initial.seats ?? ({} as Seats),
    book: initial.book ?? emptyNicknameBook(),
  };
  const adapter = {
    loadAgents: () => structuredClone(state.agents),
    saveAgents: vi.fn((agents: PersistedAgent[]) => {
      state.agents = structuredClone(agents);
    }),
    loadSeats: () => structuredClone(state.seats),
    saveSeats: vi.fn((seats: Seats) => {
      state.seats = structuredClone(seats);
    }),
    loadNicknameBook: () => structuredClone(state.book),
    saveNicknameBook: vi.fn((book: NicknameBook) => {
      state.book = structuredClone(book);
    }),
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: () => {},
  } satisfies StateAdapter;
  return { adapter, state };
}

function setup(adapter: StateAdapter) {
  const store = new AgentStateStore();
  store.setAdapter(adapter);
  const watcher = {
    recoverAgent: vi.fn(),
    startFileWatching: vi.fn(),
    readNewLines: vi.fn(),
    reassignAgentToFile: vi.fn(),
  };
  const runtime = {
    fileWatchers: new Map(),
    pollingTimers: new Map(),
    waitingTimers: new Map(),
    permissionTimers: new Map(),
    jsonlPollTimers: new Map<number, ReturnType<typeof setInterval>>(),
    getKnownJsonlFiles: vi.fn(() => new Set<string>()),
    activeAgentId: { current: null },
    getFileWatcher: vi.fn(() => watcher),
    getProvider: vi.fn((id: string) => (id === provider.id ? provider : undefined)),
    registerAgent: vi.fn(),
    startProjectScan: vi.fn(),
  };
  return { store, runtime: runtime as unknown as AgentRuntime, rawRuntime: runtime };
}

describe('VS Code agent nicknames', () => {
  let cleanup: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    cleanup = [];
  });

  afterEach(() => {
    for (const run of cleanup) run();
    terminals.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function track(rawRuntime: ReturnType<typeof setup>['rawRuntime'], store: AgentStateStore) {
    cleanup.push(() => {
      for (const timer of rawRuntime.jsonlPollTimers.values()) clearInterval(timer);
      store.dispose();
    });
  }

  it('names the terminal after the nickname and persists both', async () => {
    const { adapter, state } = createMemoryAdapter();
    const { store, runtime, rawRuntime } = setup(adapter);
    track(rawRuntime, store);

    await launchNewTerminal(runtime, provider, store, sessionsDir, false, true, '  Ada  ');

    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ada' }));
    const [agent] = [...store.values()];
    expect(agent.nickname).toBe('Ada');
    expect(state.agents).toEqual([
      expect.objectContaining({ id: agent.id, terminalName: 'Ada', nickname: 'Ada' }),
    ]);
  });

  it('adds the terminal index when a live terminal already has that name', async () => {
    const { adapter } = createMemoryAdapter();
    const { store, runtime, rawRuntime } = setup(adapter);
    track(rawRuntime, store);
    terminals.push({ name: 'Ada', show: vi.fn(), sendText: vi.fn() });

    await launchNewTerminal(runtime, provider, store, sessionsDir, false, true, 'Ada');

    expect(createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ada #1' }));
    expect([...store.values()][0].nickname).toBe('Ada');
  });

  it('keeps the provider terminal name when the nickname is blank', async () => {
    const { adapter } = createMemoryAdapter();
    const { store, runtime, rawRuntime } = setup(adapter);
    track(rawRuntime, store);

    await launchNewTerminal(runtime, provider, store, sessionsDir, false, true, ' \t ');

    expect(createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test Terminal #1' }),
    );
    expect([...store.values()][0].nickname).toBeUndefined();
  });

  it("brings back a reused nickname's costume and offers its seat", async () => {
    const { adapter } = createMemoryAdapter({
      book: {
        sessions: {},
        profiles: [{ nickname: 'Ada', palette: 4, hueShift: 60, seatId: 'seat-a' }],
      },
    });
    const { store, runtime, rawRuntime } = setup(adapter);
    track(rawRuntime, store);
    const created: Array<{ nickname?: string; palette?: number }> = [];
    store.on('agentAdded', (_id, agent) => created.push({ ...agent }));

    await launchNewTerminal(runtime, provider, store, sessionsDir, false, true, 'ada');

    const [agent] = [...store.values()];
    expect(created).toEqual([expect.objectContaining({ nickname: 'ada', palette: 4 })]);
    expect(agent.hueShift).toBe(60);
    expect(agent.preferredSeatId).toBe('seat-a');
    const postMessage = vi.fn();
    sendExistingAgents(store, adapter, { postMessage } as never);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        nicknames: { [agent.id]: 'ada' },
        agentMeta: { [agent.id]: { seatId: 'seat-a' } },
      }),
    );
  });

  it('restores the nickname and re-binds the terminal named after it', () => {
    const { adapter } = createMemoryAdapter({
      agents: [
        {
          id: 4,
          providerId: provider.id,
          terminalName: 'Ada',
          sessionId: 'old',
          jsonlFile: path.join(sessionsDir, 'old.jsonl'),
          projectDir: sessionsDir,
          nickname: 'Ada',
        },
      ],
      seats: { '4': { palette: 1, hueShift: 0, seatId: 'seat-b' } },
    });
    const { store, runtime, rawRuntime } = setup(adapter);
    track(rawRuntime, store);
    terminals.push({ name: 'Ada', show: vi.fn(), sendText: vi.fn() });

    restoreAgents(adapter, runtime, store);

    expect(store.get(4)?.nickname).toBe('Ada');
    expect(store.get(4)?.terminalRef?.name).toBe('Ada');
    const postMessage = vi.fn();
    sendExistingAgents(store, adapter, { postMessage } as never);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        nicknames: { 4: 'Ada' },
        agentMeta: { 4: { palette: 1, hueShift: 0, seatId: 'seat-b' } },
      }),
    );
  });
});
