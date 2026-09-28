import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AGENT_NICKNAME_MAX_LENGTH } from '../../core/src/constants.js';
import { normalizeNickname } from '../../core/src/normalizeNickname.js';
import type { NicknameBook, PersistedAgent } from '../../core/src/schemas.js';
import { applySavedSeats } from '../src/agentAppearance.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { NICKNAME_BOOK_MAX_ENTRIES, PALETTE_COUNT } from '../src/constants.js';
import {
  emptyNicknameBook,
  findNicknameProfile,
  nicknameSessionKey,
  parseNicknameBook,
  rememberNicknameProfile,
  rememberSessionNickname,
} from '../src/nicknames.js';
import { assignPaletteIfNeeded, setPaletteCount } from '../src/paletteAssigner.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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

type Seats = Record<string, { palette?: number; hueShift?: number; seatId?: string }>;

/** A StateAdapter over plain objects; every load hands out a copy, like a file would. */
function createMemoryAdapter(initial: { book?: NicknameBook; seats?: Seats } = {}) {
  const state = {
    agents: [] as PersistedAgent[],
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

function lastOf<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

describe('normalizeNickname', () => {
  it('treats anything but a string as no nickname', () => {
    expect(normalizeNickname(undefined)).toBe('');
    expect(normalizeNickname(null)).toBe('');
    expect(normalizeNickname(42)).toBe('');
    expect(normalizeNickname({ nickname: 'Ada' })).toBe('');
  });

  it('collapses whitespace and control characters and trims', () => {
    expect(normalizeNickname('  Ada \t\n Lovelace  ')).toBe('Ada Lovelace');
    expect(normalizeNickname('Ada\u0000\u0007Byron')).toBe('Ada Byron');
    expect(normalizeNickname(' \t\r\n ')).toBe('');
  });

  it('drops bidi overrides so a label cannot read as another', () => {
    expect(normalizeNickname('Ada\u202Eecil\u2066')).toBe('Adaecil');
  });

  it('caps the length in code points without splitting a surrogate pair', () => {
    const long = 'a'.repeat(AGENT_NICKNAME_MAX_LENGTH + 10);
    expect(normalizeNickname(long)).toHaveLength(AGENT_NICKNAME_MAX_LENGTH);
    const emoji = '🦊'.repeat(AGENT_NICKNAME_MAX_LENGTH + 1);
    expect(Array.from(normalizeNickname(emoji))).toEqual(
      Array.from('🦊'.repeat(AGENT_NICKNAME_MAX_LENGTH)),
    );
  });
});

describe('nickname book helpers', () => {
  it('keys a session by provider and session, plus the Teammate name', () => {
    expect(nicknameSessionKey({ sessionId: 's1' })).toBe('claude:s1');
    expect(nicknameSessionKey({ providerId: 'copilot', sessionId: 's1' })).toBe('copilot:s1');
    expect(nicknameSessionKey({ providerId: 'claude', sessionId: 's1', agentName: 'qa' })).toBe(
      'claude:s1#qa',
    );
    expect(nicknameSessionKey({ providerId: 'copilot' })).toBeUndefined();
  });

  it('records, refreshes and forgets a session nickname', () => {
    const book = emptyNicknameBook();
    expect(rememberSessionNickname(book, 'claude:s1', 'Ada')).toBe(true);
    expect(rememberSessionNickname(book, 'claude:s1', 'Ada')).toBe(false);
    expect(rememberSessionNickname(book, 'claude:s1', 'Grace')).toBe(true);
    expect(book.sessions).toEqual({ 'claude:s1': 'Grace' });
    expect(rememberSessionNickname(book, 'claude:s1', '')).toBe(true);
    expect(rememberSessionNickname(book, 'claude:s1', '')).toBe(false);
    expect(book.sessions).toEqual({});
  });

  it('caps the session index, dropping the least recently set first', () => {
    const book = emptyNicknameBook();
    for (let i = 0; i < NICKNAME_BOOK_MAX_ENTRIES; i++) {
      rememberSessionNickname(book, `claude:s${i}`, `n${i}`);
    }
    // Touch the oldest so it counts as newest, then overflow by one.
    rememberSessionNickname(book, 'claude:s0', 'renamed');
    rememberSessionNickname(book, 'claude:new', 'fresh');
    expect(Object.keys(book.sessions)).toHaveLength(NICKNAME_BOOK_MAX_ENTRIES);
    expect(book.sessions['claude:s0']).toBe('renamed');
    expect(book.sessions['claude:s1']).toBeUndefined();
    expect(book.sessions['claude:new']).toBe('fresh');
  });

  it('finds a profile case-insensitively and merges updates into it', () => {
    const book = emptyNicknameBook();
    expect(rememberNicknameProfile(book, { nickname: 'Ada', palette: 2, hueShift: 30 })).toBe(true);
    expect(rememberNicknameProfile(book, { nickname: 'Bob', palette: 1 })).toBe(true);
    // Undefined fields keep what was remembered; the profile moves to the newest slot.
    expect(rememberNicknameProfile(book, { nickname: 'ADA', seatId: 'seat-a' })).toBe(true);
    expect(rememberNicknameProfile(book, { nickname: 'ADA', seatId: 'seat-a' })).toBe(false);
    expect(rememberNicknameProfile(book, { nickname: '' })).toBe(false);
    expect(book.profiles).toEqual([
      { nickname: 'Bob', palette: 1 },
      { nickname: 'ADA', palette: 2, hueShift: 30, seatId: 'seat-a' },
    ]);
    expect(findNicknameProfile(book, 'ada')?.seatId).toBe('seat-a');
    expect(findNicknameProfile(book, 'Cy')).toBeUndefined();
  });

  it('caps the profile list, dropping the oldest first', () => {
    const book = emptyNicknameBook();
    for (let i = 0; i <= NICKNAME_BOOK_MAX_ENTRIES; i++) {
      rememberNicknameProfile(book, { nickname: `n${i}`, palette: 0 });
    }
    expect(book.profiles).toHaveLength(NICKNAME_BOOK_MAX_ENTRIES);
    expect(findNicknameProfile(book, 'n0')).toBeUndefined();
    expect(lastOf(book.profiles)?.nickname).toBe(`n${NICKNAME_BOOK_MAX_ENTRIES}`);
  });

  it('parses only well-formed books and never writes through __proto__', () => {
    expect(parseNicknameBook(undefined)).toEqual(emptyNicknameBook());
    expect(parseNicknameBook([])).toEqual(emptyNicknameBook());
    expect(parseNicknameBook('book')).toEqual(emptyNicknameBook());
    const parsed = parseNicknameBook(
      JSON.parse('{"sessions":{"__proto__":"x","claude:s1":"Ada"},"profiles":{}}'),
    );
    expect(parsed).toEqual({ sessions: { 'claude:s1': 'Ada' }, profiles: [] });
    expect(Object.getPrototypeOf(parsed.sessions)).toBe(Object.prototype);
  });
});

describe('AgentStateStore nicknames', () => {
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    store.dispose();
  });

  it('renames, persists, and broadcasts the normalized nickname even when unchanged', () => {
    const { adapter, state } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, palette: 3, hueShift: 15 }));

    expect(store.setNickname(1, '  Ada ')).toBe(true);
    expect(store.get(1)?.nickname).toBe('Ada');
    expect(lastOf(state.agents)?.nickname).toBe('Ada');
    expect(state.book.profiles).toEqual([{ nickname: 'Ada', palette: 3, hueShift: 15 }]);

    const saves = adapter.saveNicknameBook.mock.calls.length;
    expect(store.setNickname(1, 'Ada')).toBe(true);
    expect(adapter.saveNicknameBook.mock.calls.length).toBe(saves);
    expect(broadcasts.filter((m) => m.type === 'agentMetadata')).toEqual([
      { type: 'agentMetadata', id: 1, nickname: 'Ada' },
      { type: 'agentMetadata', id: 1, nickname: 'Ada' },
    ]);
    expect(store.setNickname(99, 'Ada')).toBe(false);
  });

  it('works without a nickname-capable adapter', () => {
    store.set(1, createTestAgent({ id: 1 }));
    expect(store.setNickname(1, 'Ada')).toBe(true);
    expect(store.get(1)?.nickname).toBe('Ada');
    expect(store.setNickname(1, '')).toBe(true);
    expect(store.get(1)?.nickname).toBeUndefined();
  });

  it('gives a re-adopted session its nickname back before agentAdded fires', () => {
    const { adapter } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, providerId: 'copilot', sessionId: 'app-session' }));
    store.setNickname(1, 'Ada');
    store.delete(1);

    const namesAtAnnouncement: Array<string | undefined> = [];
    store.on('agentAdded', (_id, agent) => namesAtAnnouncement.push(agent.nickname));
    store.set(7, createTestAgent({ id: 7, providerId: 'copilot', sessionId: 'app-session' }));
    // Same session id under another provider is another agent.
    store.set(8, createTestAgent({ id: 8, providerId: 'claude', sessionId: 'app-session' }));

    expect(namesAtAnnouncement).toEqual(['Ada', undefined]);
  });

  it('keeps Teammates that share a session apart', () => {
    const { adapter } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, sessionId: 'lead', agentName: 'qa' }));
    store.setNickname(1, 'Tester');
    store.delete(1);

    store.set(2, createTestAgent({ id: 2, sessionId: 'lead', agentName: 'docs' }));
    store.set(3, createTestAgent({ id: 3, sessionId: 'lead', agentName: 'qa' }));

    expect(store.get(2)?.nickname).toBeUndefined();
    expect(store.get(3)?.nickname).toBe('Tester');
  });

  it('forgets the session on clear but keeps the look for the next agent under that name', () => {
    const { adapter, state } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, palette: 4, hueShift: 90 }));
    store.setNickname(1, 'Ada');
    store.setNickname(1, '');

    expect(store.get(1)?.nickname).toBeUndefined();
    expect(lastOf(state.agents)?.nickname).toBeUndefined();
    expect(state.book.sessions).toEqual({});
    expect(findNicknameProfile(state.book, 'Ada')).toEqual({
      nickname: 'Ada',
      palette: 4,
      hueShift: 90,
    });
    expect(lastOf(broadcasts)).toEqual({ type: 'agentMetadata', id: 1, nickname: '' });
  });

  it('re-records the nickname under a new session id and recalls one remembered there', () => {
    const { adapter, state } = createMemoryAdapter({
      book: { sessions: { 'claude:after-clear': 'Grace' }, profiles: [] },
    });
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, sessionId: 'before' }));
    store.setNickname(1, 'Ada');

    const ada = store.get(1)!;
    ada.sessionId = 'after';
    store.rememberNickname(ada);
    expect(state.book.sessions['claude:after']).toBe('Ada');

    store.set(2, createTestAgent({ id: 2, sessionId: 'unnamed' }));
    const other = store.get(2)!;
    broadcasts = [];
    other.sessionId = 'after-clear';
    store.rememberNickname(other);
    expect(other.nickname).toBe('Grace');
    expect(broadcasts).toEqual([{ type: 'agentMetadata', id: 2, nickname: 'Grace' }]);
  });
});

describe('name-keyed restore', () => {
  let store: AgentStateStore;

  beforeEach(() => {
    store = new AgentStateStore();
  });

  afterEach(() => {
    store.dispose();
    setPaletteCount(PALETTE_COUNT);
  });

  it("gives a new agent under a known nickname that nickname's look and seat", () => {
    const { adapter } = createMemoryAdapter({
      book: {
        sessions: {},
        profiles: [{ nickname: 'Ada', palette: 5, hueShift: 45, seatId: 'seat-a' }],
      },
    });
    store.setAdapter(adapter);
    const agent = createTestAgent({ id: 3, sessionId: 'brand-new', nickname: 'ada' });

    assignPaletteIfNeeded(agent, store);

    expect(agent.palette).toBe(5);
    expect(agent.hueShift).toBe(45);
    expect(agent.preferredSeatId).toBe('seat-a');
  });

  it('recalls the nickname of a re-adopted session before picking its look', () => {
    const { adapter } = createMemoryAdapter({
      book: {
        sessions: { 'copilot:app-1': 'Ada' },
        profiles: [{ nickname: 'Ada', palette: 1, hueShift: 0 }],
      },
    });
    store.setAdapter(adapter);
    const agent = createTestAgent({ id: 3, providerId: 'copilot', sessionId: 'app-1' });

    assignPaletteIfNeeded(agent, store);

    expect(agent.nickname).toBe('Ada');
    expect(agent.palette).toBe(1);
  });

  it('falls back to the diverse pick when the remembered palette is no longer loaded', () => {
    const { adapter } = createMemoryAdapter({
      book: { sessions: {}, profiles: [{ nickname: 'Ada', palette: 7, seatId: 'seat-a' }] },
    });
    store.setAdapter(adapter);
    setPaletteCount(6);
    const agent = createTestAgent({ id: 3, nickname: 'Ada' });

    assignPaletteIfNeeded(agent, store);

    expect(agent.palette).toBeGreaterThanOrEqual(0);
    expect(agent.palette).toBeLessThan(6);
    expect(agent.preferredSeatId).toBeUndefined();
  });

  it('an agent without a nickname keeps the diverse pick', () => {
    const { adapter } = createMemoryAdapter({
      book: { sessions: {}, profiles: [{ nickname: 'Ada', palette: 5 }] },
    });
    store.setAdapter(adapter);
    const agent = createTestAgent({ id: 3 });

    assignPaletteIfNeeded(agent, store);

    expect(agent.nickname).toBeUndefined();
    expect(agent.preferredSeatId).toBeUndefined();
  });
});

describe('applySavedSeats', () => {
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    store.dispose();
  });

  it('ignores a payload that is not a seat map', () => {
    const { adapter } = createMemoryAdapter();
    store.setAdapter(adapter);
    applySavedSeats(store, null, PALETTE_COUNT);
    applySavedSeats(store, [], PALETTE_COUNT);
    applySavedSeats(store, 'seats', PALETTE_COUNT);
    expect(adapter.saveSeats).not.toHaveBeenCalled();
  });

  it("refreshes a nicknamed agent's profile with its new look and seat", () => {
    const { adapter, state } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, nickname: 'Ada', palette: 0, hueShift: 0 }));
    store.set(2, createTestAgent({ id: 2, sessionId: 'sess-2', palette: 1, hueShift: 0 }));
    broadcasts = [];

    applySavedSeats(
      store,
      {
        '1': { palette: 2, hueShift: 75, seatId: 'seat-a' },
        '2': { palette: 3, hueShift: 15, seatId: 'seat-b' },
      },
      PALETTE_COUNT,
    );

    expect(broadcasts).toEqual([
      { type: 'agentAppearance', id: 1, palette: 2, hueShift: 75 },
      { type: 'agentAppearance', id: 2, palette: 3, hueShift: 15 },
    ]);
    expect(state.seats['1']).toEqual({ palette: 2, hueShift: 75, seatId: 'seat-a' });
    expect(state.book.profiles).toEqual([
      { nickname: 'Ada', palette: 2, hueShift: 75, seatId: 'seat-a' },
    ]);
    expect(lastOf(state.agents)).toMatchObject({ id: 2, palette: 3, hueShift: 15 });
  });

  it('persists the agents only when a costume changed', () => {
    const { adapter } = createMemoryAdapter();
    store.setAdapter(adapter);
    store.set(1, createTestAgent({ id: 1, palette: 2, hueShift: 30 }));
    const persist = vi.spyOn(store, 'persist');

    applySavedSeats(store, { '1': { palette: 2, hueShift: 30, seatId: 'seat-a' } }, PALETTE_COUNT);
    expect(persist).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);

    applySavedSeats(store, { '1': { palette: 2, hueShift: 45, seatId: 'seat-a' } }, PALETTE_COUNT);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(broadcasts).toEqual([{ type: 'agentAppearance', id: 1, palette: 2, hueShift: 45 }]);
  });
});
