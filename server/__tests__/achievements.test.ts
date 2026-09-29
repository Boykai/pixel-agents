import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AchievementId } from '../../core/src/achievements.js';
import { ACHIEVEMENTS } from '../../core/src/achievements.js';
import type { StateAdapter } from '../../core/src/adapter.js';
import type { AchievementProgress } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AchievementTrackerOptions } from '../src/achievements.js';
import { AchievementTracker } from '../src/achievements.js';
import type { AgentActivity } from '../src/agentActivity.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  ACHIEVEMENTS_SAVE_DEBOUNCE_MS,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  TEXT_IDLE_DELAY_MS,
} from '../src/constants.js';
import { watchLayoutFile, writeLayoutToFile } from '../src/layoutPersistence.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import type { AgentState } from '../src/types.js';

/** Local time on a fixed day, so hour-of-day checks don't depend on the time zone. */
const at = (hour: number, minute = 0, second = 0) =>
  new Date(2026, 0, 15, hour, minute, second).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const providers: Record<string, HookProvider> = {
  claude: claudeProvider,
  copilot: copilotProvider,
};

interface StoredRecord {
  unlocked?: boolean;
  unlockedAt?: number;
  slots?: Record<string, number>;
  max?: number;
  keys?: string[];
}

let dir: string;
let file: string;
let clock: number;
const runtimes: AgentRuntime[] = [];
const trackers: AchievementTracker[] = [];
const stores: AgentStateStore[] = [];

beforeEach(() => {
  // Timers only: Date stays real, and every clock the code reads is injected.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-achievements-'));
  file = path.join(dir, 'achievements.json');
  clock = at(12);
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const tracker of trackers.splice(0)) tracker.dispose();
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A store on the test clock, and the unlocks it announces. */
function office() {
  const store = new AgentStateStore({ now: () => clock });
  stores.push(store);
  const unlocks: string[] = [];
  store.on('broadcast', (message) => {
    if (message.type === 'achievementUnlocked') unlocks.push(String(message.id));
  });
  return { store, unlocks };
}

function track(store: AgentStateStore, options: Partial<AchievementTrackerOptions> = {}) {
  const tracker = new AchievementTracker(store, (id) => providers[id], {
    namespace: 'standalone',
    filePath: file,
    now: () => clock,
    readLayout: () => null,
    ...options,
  });
  trackers.push(tracker);
  return tracker;
}

function agentState(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    providerId: 'claude',
    sessionId: `session-${id}`,
    isExternal: true,
    projectDir: dir,
    jsonlFile: path.join(dir, `session-${id}.jsonl`),
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
    ...overrides,
  };
}

function progress(tracker: AchievementTracker, id: AchievementId): AchievementProgress {
  return tracker.snapshot().find((entry) => entry.id === id)!;
}

/** The records in the achievements file, or undefined when there is no file. */
function stored(): Record<string, StoredRecord> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    achievements: Record<string, StoredRecord>;
  };
  return parsed.achievements;
}

function report(
  store: AgentStateStore,
  agent: AgentState,
  activity: AgentActivity,
  recordedAt?: number,
): void {
  store.activity.live(agent, activity, recordedAt);
}

function tool(
  store: AgentStateStore,
  agent: AgentState,
  toolName: string,
  input: unknown = {},
  options: { subagent?: boolean; recordedAt?: number } = {},
): void {
  report(
    store,
    agent,
    {
      kind: 'toolStart',
      toolId: randomUUID(),
      toolName,
      input,
      ...(options.subagent ? { subagent: true } : {}),
    },
    options.recordedAt,
  );
}

function stubHome(): void {
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
}

describe('Achievements: agents', () => {
  it('starts every Achievement locked at zero, and writes nothing until something counts', () => {
    const { store } = office();
    const tracker = track(store);

    expect(tracker.snapshot()).toEqual(
      ACHIEVEMENTS.map(({ id }) => ({ id, current: 0, unlocked: false })),
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it('unlocks First Agent for any tracked agent, including an adopted Copilot session', () => {
    clock = at(9, 30);
    const { store, unlocks } = office();
    const tracker = track(store);

    store.set(1, agentState(1, { providerId: 'copilot' }));

    expect(unlocks).toEqual(['first_agent']);
    expect(progress(tracker, 'first_agent')).toEqual({
      id: 'first_agent',
      current: 1,
      unlocked: true,
      unlockedAt: at(9, 30),
    });
    expect(stored()?.first_agent).toEqual({ max: 1, unlocked: true, unlockedAt: at(9, 30) });
  });

  it('keeps the most agents tracked at once for Team Player; teammates count', () => {
    const { store, unlocks } = office();
    const tracker = track(store);

    store.set(1, agentState(1));
    store.set(2, agentState(2, { providerId: 'copilot' }));
    store.set(3, agentState(3, { agentName: 'researcher', leadAgentId: 1, teamName: 'team' }));
    expect(progress(tracker, 'team_player').current).toBe(3);

    store.delete(2);
    store.set(4, agentState(4));
    expect(progress(tracker, 'team_player').current).toBe(3);
    store.set(5, agentState(5));
    expect(progress(tracker, 'team_player').current).toBe(4);
    store.set(6, agentState(6));
    expect(progress(tracker, 'team_player')).toMatchObject({ current: 5, unlocked: true });

    store.delete(1);
    store.delete(3);
    expect(progress(tracker, 'team_player')).toMatchObject({ current: 5, unlocked: true });
    expect(unlocks).toEqual(['first_agent', 'team_player']);
  });

  it('counts the agents already tracked when it starts', () => {
    const { store } = office();
    store.set(1, agentState(1));
    store.set(2, agentState(2));

    const tracker = track(store);

    expect(progress(tracker, 'first_agent').unlocked).toBe(true);
    expect(progress(tracker, 'team_player').current).toBe(2);
  });

  it('never counts Sub-agents, including those watched in the shadow store', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store } = office();
    const tracker = track(store);
    const lead = agentState(1);
    store.set(1, lead);

    const watch = new SubagentWatch(store, { startFileWatching() {}, readNewLines() {} });
    try {
      for (let i = 0; i < 6; i++) {
        watch.watch(lead, 1, {
          jsonlPath: path.join(dir, `agent-${i}.jsonl`),
          toolUseId: `toolu_${i}`,
        });
      }
      expect(watch.store.size).toBe(6);
      expect(progress(tracker, 'team_player')).toMatchObject({ current: 1, unlocked: false });
    } finally {
      watch.dispose();
    }
  });
});

describe('Achievements: Night Owl', () => {
  it('unlocks for a tool started during the 3 AM hour, local time', () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    const agent = agentState(1);

    clock = at(2, 59, 59);
    tool(store, agent, 'Bash');
    clock = at(4);
    tool(store, agent, 'Bash');
    clock = at(3, 10);
    report(store, agent, { kind: 'interactionStart' });
    report(store, agent, { kind: 'interactionEnd' });
    report(store, agent, { kind: 'toolFailure', toolId: 'failed' });
    expect(progress(tracker, 'night_owl')).toMatchObject({ current: 0, unlocked: false });

    tool(store, agent, 'Read');

    expect(unlocks).toEqual(['night_owl']);
    expect(progress(tracker, 'night_owl')).toEqual({
      id: 'night_owl',
      current: 1,
      unlocked: true,
      unlockedAt: at(3, 10),
    });
  });

  it('judges the hour by when the tool was seen, not by its record timestamp', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1, { providerId: 'copilot' });

    clock = at(12);
    tool(store, agent, 'powershell', {}, { recordedAt: at(3, 15) });
    expect(progress(tracker, 'night_owl').unlocked).toBe(false);

    clock = at(3, 15);
    tool(store, agent, 'powershell', {}, { recordedAt: at(12) });
    expect(progress(tracker, 'night_owl').unlocked).toBe(true);
  });
});

describe('Achievements: Architect', () => {
  it('counts the distinct files Claude edits, however their path is spelled', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    tool(store, agent, 'Edit', {
      file_path: path.join(dir, 'src', 'a.ts'),
      old_string: 'a',
      new_string: 'b',
    });
    tool(store, agent, 'Write', {
      file_path: [dir, 'src', '..', 'src', 'a.ts'].join(path.sep),
      content: '',
    });
    tool(store, agent, 'MultiEdit', { file_path: path.join(dir, 'src', 'b.ts'), edits: [] });
    tool(store, agent, 'NotebookEdit', {
      notebook_path: path.join(dir, 'notes.ipynb'),
      new_source: '',
    });
    tool(store, agent, 'Read', { file_path: path.join(dir, 'src', 'c.ts') });
    tool(store, agent, 'Bash', { command: 'touch d.ts' });

    expect(progress(tracker, 'architect').current).toBe(3);
  });

  it("counts Copilot's edits, resolving relative paths against the session's cwd", () => {
    const repo = path.join(dir, 'repo');
    const sessionDir = path.join(dir, 'copilot-session');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `id: x\ncwd: ${repo}\n`);
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1, {
      providerId: 'copilot',
      projectDir: sessionDir,
      jsonlFile: path.join(sessionDir, 'events.jsonl'),
    });

    tool(store, agent, 'edit', { path: 'src/app.ts', old_str: 'a', new_str: 'b' });
    tool(store, agent, 'create', { path: path.join(repo, 'src', 'app.ts'), file_text: '' });
    tool(store, agent, 'str_replace_editor', { command: 'view', path: 'src/viewed.ts' });
    tool(store, agent, 'str_replace_editor', { command: 'str_replace', path: 'src/util.ts' });
    tool(
      store,
      agent,
      'apply_patch',
      [
        '*** Begin Patch',
        '*** Update File: src/main.ts',
        '@@',
        '-a',
        '+b',
        '*** Add File: src/new.ts',
        '+x',
        '*** Delete File: src/old.ts',
        '*** End Patch',
      ].join('\n'),
    );
    tool(store, agent, 'view', { path: 'src/other.ts' });

    expect(progress(tracker, 'architect').current).toBe(4);
  });

  it("keys a relative path by its session when the session's cwd is unknown", () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    tool(store, agent, 'Edit', { file_path: 'src/a.ts' });
    tool(store, agent, 'Edit', { file_path: './src/a.ts' });
    tool(store, agent, 'Edit', { file_path: 'src\\a.ts' });
    tool(store, agentState(2, { projectDir: path.join(dir, 'other') }), 'Edit', {
      file_path: 'src/a.ts',
    });

    expect(progress(tracker, 'architect').current).toBe(2);
  });

  it('stores hashes, never paths, and stops storing at the target', () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    const agent = agentState(1);

    for (let i = 0; i < 60; i++) {
      tool(store, agent, 'Write', { file_path: path.join(dir, `file-${i}.ts`), content: '' });
    }

    const record = stored()?.architect;
    expect(record?.keys).toHaveLength(50);
    expect(record?.keys?.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(record?.unlocked).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('file-');
    expect(unlocks).toEqual(['architect']);
    expect(progress(tracker, 'architect')).toMatchObject({ current: 50, unlocked: true });
  });
});

describe('Achievements: Marathon Runner', () => {
  it('counts each completed interaction once, however many sources report its end', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    report(store, agent, { kind: 'interactionStart' }, at(12, 0, 0));
    tool(store, agent, 'Edit', {}, { recordedAt: at(12, 0, 1) });
    clock = at(12, 0, 5);
    report(store, agent, { kind: 'interactionEnd' }); // the Stop hook
    report(store, agent, { kind: 'interactionEnd' }); // a repeated Stop
    report(store, agent, { kind: 'interactionEnd' }, at(12, 0, 5)); // turn_duration, read later
    report(store, agent, { kind: 'interactionEnd' }, at(12, 0, 3)); // an earlier text-idle end
    expect(progress(tracker, 'marathon').current).toBe(1);

    clock = at(12, 1);
    report(store, agent, { kind: 'interactionStart' });
    clock = at(12, 2);
    report(store, agent, { kind: 'interactionEnd' });
    expect(progress(tracker, 'marathon').current).toBe(2);
  });

  it('files a late transcript start under the interaction whose end was already seen', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    clock = at(12, 0, 30);
    report(store, agent, { kind: 'interactionEnd' }); // the Stop hook comes first
    clock = at(12, 0, 31);
    report(store, agent, { kind: 'interactionStart' }, at(12, 0, 0)); // its prompt, read late
    tool(store, agent, 'Edit', {}, { recordedAt: at(12, 0, 10) });
    report(store, agent, { kind: 'interactionEnd' }, at(12, 0, 30)); // its turn_duration

    expect(progress(tracker, 'marathon').current).toBe(1);
  });

  it('does not count an interaction whose start it never saw', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    clock = at(12, 0, 30);
    report(store, agent, { kind: 'interactionEnd' }); // adopted mid-turn
    clock = at(12, 5);
    report(store, agent, { kind: 'interactionStart' });
    expect(progress(tracker, 'marathon').current).toBe(0);

    clock = at(12, 6);
    report(store, agent, { kind: 'interactionEnd' });
    expect(progress(tracker, 'marathon').current).toBe(1);
  });

  it('counts each agent separately', () => {
    const { store } = office();
    const tracker = track(store);
    const lead = agentState(1);
    const other = agentState(2, { providerId: 'copilot' });

    report(store, lead, { kind: 'interactionStart' });
    report(store, other, { kind: 'interactionStart' });
    clock = at(12, 1);
    report(store, lead, { kind: 'interactionEnd' });
    report(store, other, { kind: 'interactionEnd' });

    expect(progress(tracker, 'marathon').current).toBe(2);
  });

  it("does not let a Sub-agent's tool start its lead's interaction", () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    tool(store, agent, 'Bash', {}, { subagent: true });
    clock = at(12, 0, 30);
    report(store, agent, { kind: 'interactionEnd' });
    expect(progress(tracker, 'marathon').current).toBe(0);

    clock = at(12, 1);
    tool(store, agent, 'Bash');
    clock = at(12, 2);
    report(store, agent, { kind: 'interactionEnd' });
    expect(progress(tracker, 'marathon').current).toBe(1);
  });

  it('ignores an end recorded before the open interaction began', () => {
    const { store } = office();
    const tracker = track(store);
    const agent = agentState(1);

    clock = at(12, 1);
    report(store, agent, { kind: 'interactionStart' });
    report(store, agent, { kind: 'interactionEnd' }, at(12, 0, 30));
    expect(progress(tracker, 'marathon').current).toBe(0);

    clock = at(12, 2);
    report(store, agent, { kind: 'interactionEnd' });
    expect(progress(tracker, 'marathon').current).toBe(1);
  });

  it('unlocks at the hundredth interaction', () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    const agent = agentState(1);
    const interaction = () => {
      clock += 1_000;
      report(store, agent, { kind: 'interactionStart' });
      clock += 1_000;
      report(store, agent, { kind: 'interactionEnd' });
    };

    for (let i = 0; i < 99; i++) interaction();
    expect(progress(tracker, 'marathon')).toMatchObject({ current: 99, unlocked: false });

    interaction();
    expect(progress(tracker, 'marathon')).toMatchObject({ current: 100, unlocked: true });
    expect(unlocks).toEqual(['marathon']);
  });
});

describe('Achievements: Token Millionaire', () => {
  it('counts only live usage, summing all four token kinds', () => {
    const { store } = office();
    const tracker = track(store);
    store.tokenUsage.seed(
      1,
      'a.jsonl',
      {
        samples: [{ kind: 'delta', messageId: 'm0', inputTokens: 900_000, outputTokens: 900_000 }],
        primers: [],
        complete: true,
      },
      100,
    );

    // Replayed: a record from before the live point.
    store.tokenUsage.readingFrom(1, 0);
    store.tokenUsage.observe(1, { kind: 'delta', messageId: 'm1', inputTokens: 500_000 });
    expect(progress(tracker, 'token_millionaire').current).toBe(0);

    store.tokenUsage.readingFrom(1, 100);
    const m2 = {
      kind: 'delta',
      messageId: 'm2',
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 15,
    } as const;
    store.tokenUsage.observe(1, m2);
    // Claude repeats a message's usage on every content block: only growth is new.
    store.tokenUsage.observe(1, { ...m2, outputTokens: 50 });

    expect(progress(tracker, 'token_millionaire').current).toBe(105);
  });

  it("credits Copilot's session totals once they carry tokens", () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    store.tokenUsage.seed(1, 'events.jsonl');

    store.tokenUsage.observe(1, { kind: 'total', premiumRequests: 1, nanoAiu: 5_000 });
    expect(progress(tracker, 'token_millionaire').current).toBe(0);

    store.tokenUsage.observe(1, {
      kind: 'total',
      premiumRequests: 2,
      nanoAiu: 9_000,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });

    expect(unlocks).toEqual(['token_millionaire']);
    expect(stored()?.token_millionaire).toEqual({
      slots: { standalone: 1_000_000 },
      unlocked: true,
      unlockedAt: at(12),
    });
  });

  it('saves what it counted on dispose, and counts nothing after', () => {
    const { store } = office();
    const tracker = track(store);
    store.tokenUsage.seed(1, 'a.jsonl');
    store.tokenUsage.observe(1, { kind: 'delta', messageId: 'm1', inputTokens: 42 });

    tracker.dispose();
    expect(stored()?.token_millionaire).toEqual({ slots: { standalone: 42 } });

    store.tokenUsage.observe(1, { kind: 'delta', messageId: 'm2', inputTokens: 1_000 });
    vi.advanceTimersByTime(ACHIEVEMENTS_SAVE_DEBOUNCE_MS * 2);
    expect(stored()?.token_millionaire).toEqual({ slots: { standalone: 42 } });
  });
});

describe('Achievements: Bug Squasher', () => {
  it('counts every reported tool failure, from either provider, up to ten', () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    const claude = agentState(1);
    const copilot = agentState(2, { providerId: 'copilot' });

    for (let i = 0; i < 5; i++) report(store, claude, { kind: 'toolFailure', toolId: `c${i}` });
    for (let i = 0; i < 4; i++) report(store, copilot, { kind: 'toolFailure', toolId: `p${i}` });
    expect(progress(tracker, 'bug_squasher')).toMatchObject({ current: 9, unlocked: false });

    report(store, claude, { kind: 'toolFailure', toolId: 'sub', subagent: true });
    expect(unlocks).toEqual(['bug_squasher']);

    report(store, claude, { kind: 'toolFailure', toolId: 'late' });
    expect(progress(tracker, 'bug_squasher')).toMatchObject({ current: 10, unlocked: true });
    expect(unlocks).toEqual(['bug_squasher']);
  });
});

describe('Achievements: Interior Decorator', () => {
  const layout = (...uids: string[]) => ({
    version: 1,
    cols: 2,
    rows: 2,
    tiles: [],
    furniture: uids.map((uid) => ({ uid, type: 'DESK', col: 0, row: 0 })),
  });

  it('counts furniture the user places, once each', () => {
    stubHome();
    const { store } = office();
    const tracker = track(store, { readLayout: () => layout('desk-1', 'chair-1') });

    writeLayoutToFile(layout('desk-1', 'chair-1', 'plant-1'), 'edit');
    writeLayoutToFile(layout('desk-1', 'chair-1', 'plant-1', 'lamp-1'), 'edit');
    writeLayoutToFile(layout('desk-1', 'chair-1', 'plant-1'), 'edit'); // undo
    writeLayoutToFile(layout('desk-1', 'chair-1', 'plant-1', 'lamp-1'), 'edit'); // redo

    expect(progress(tracker, 'decorator').current).toBe(2);
  });

  it('never counts furniture that arrives wholesale: imports, the default, other windows', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubHome();
    const { store } = office();
    const tracker = track(store);

    writeLayoutToFile(layout('import-1', 'import-2'), 'replace');
    tracker.seedLayout(layout('default-1'));
    const watcher = watchLayoutFile(() => {});
    try {
      // Another window saves: seen by this window's watcher.
      const layoutFile = path.join(dir, '.pixel-agents', 'layout.json');
      fs.writeFileSync(layoutFile, JSON.stringify(layout('import-1', 'import-2', 'other-1')));
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(layoutFile, later, later);
      vi.advanceTimersByTime(LAYOUT_FILE_POLL_INTERVAL_MS);
    } finally {
      watcher.dispose();
    }
    expect(progress(tracker, 'decorator').current).toBe(0);

    writeLayoutToFile(
      layout('import-1', 'import-2', 'other-1', 'default-1', 'new-1', 'new-2', 'new-3'),
      'edit',
    );
    expect(progress(tracker, 'decorator').current).toBe(3);
  });

  it('takes the layout on disk when tracking starts as already placed', () => {
    stubHome();
    const baseline = Array.from({ length: 25 }, (_, i) => `base-${i}`);
    writeLayoutToFile(layout(...baseline), 'replace');
    const { store, unlocks } = office();
    const tracker = track(store, { readLayout: undefined });

    const placed = Array.from({ length: 19 }, (_, i) => `new-${i}`);
    writeLayoutToFile(layout(...baseline, ...placed), 'edit');
    expect(progress(tracker, 'decorator')).toMatchObject({ current: 19, unlocked: false });

    writeLayoutToFile(layout(...baseline, ...placed, 'new-19'), 'edit');
    expect(progress(tracker, 'decorator')).toMatchObject({ current: 20, unlocked: true });
    expect(unlocks).toEqual(['decorator']);
  });
});

describe('Achievements: persistence', () => {
  it('defaults to ~/.pixel-agents/achievements.json', () => {
    stubHome();
    const { store } = office();
    track(store, { filePath: undefined });

    store.set(1, agentState(1));

    expect(fs.existsSync(path.join(dir, '.pixel-agents', 'achievements.json'))).toBe(true);
  });

  it('debounces progress, but writes an unlock at once', () => {
    const { store } = office();
    track(store);
    const agent = agentState(1);

    report(store, agent, { kind: 'toolFailure', toolId: 't1' });
    vi.advanceTimersByTime(ACHIEVEMENTS_SAVE_DEBOUNCE_MS - 1);
    expect(stored()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(stored()).toEqual({ bug_squasher: { slots: { standalone: 1 } } });

    clock = at(3, 30);
    tool(store, agent, 'Bash');
    expect(stored()?.night_owl).toEqual({
      slots: { standalone: 1 },
      unlocked: true,
      unlockedAt: at(3, 30),
    });
  });

  it('merges two processes that share the file, without counting anything twice', () => {
    const a = office();
    const b = office();
    const vscode = track(a.store, { namespace: 'vscode' });
    const standalone = track(b.store, { namespace: 'standalone' });

    a.store.set(1, agentState(1));
    a.store.set(2, agentState(2));
    a.store.set(3, agentState(3));
    b.store.set(1, agentState(1));
    b.store.set(2, agentState(2));
    for (let i = 0; i < 3; i++) {
      report(a.store, agentState(1), { kind: 'toolFailure', toolId: `a${i}` });
    }
    for (let i = 0; i < 2; i++) {
      report(b.store, agentState(1), { kind: 'toolFailure', toolId: `b${i}` });
    }
    // The same session watched by both: its files are counted once.
    tool(a.store, agentState(1), 'Write', { file_path: path.join(dir, 'x.ts') });
    tool(a.store, agentState(1), 'Write', { file_path: path.join(dir, 'y.ts') });
    tool(b.store, agentState(1), 'Write', { file_path: path.join(dir, 'y.ts') });
    tool(b.store, agentState(1), 'Write', { file_path: path.join(dir, 'z.ts') });
    vscode.flush();
    standalone.flush();

    expect(stored()?.bug_squasher).toEqual({ slots: { vscode: 3, standalone: 2 } });
    expect(stored()?.architect?.keys).toHaveLength(3);
    expect(stored()?.team_player).toEqual({ max: 3 });
    for (const tracker of [vscode, standalone]) {
      expect(progress(tracker, 'bug_squasher').current).toBe(3);
      expect(progress(tracker, 'architect').current).toBe(3);
      expect(progress(tracker, 'team_player').current).toBe(3);
      expect(progress(tracker, 'first_agent').unlocked).toBe(true);
    }
    expect(a.unlocks).toEqual(['first_agent']);
    expect(b.unlocks).toEqual([]);
  });

  it("continues a counter from another surface's total", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, achievements: { bug_squasher: { slots: { vscode: 7 } } } }),
    );
    const { store, unlocks } = office();
    const tracker = track(store);
    const agent = agentState(1);

    report(store, agent, { kind: 'toolFailure', toolId: 't1' });
    report(store, agent, { kind: 'toolFailure', toolId: 't2' });
    expect(progress(tracker, 'bug_squasher').current).toBe(9);

    report(store, agent, { kind: 'toolFailure', toolId: 't3' });
    expect(unlocks).toEqual(['bug_squasher']);
    expect(stored()?.bug_squasher).toEqual({
      slots: { vscode: 7, standalone: 10 },
      unlocked: true,
      unlockedAt: at(12),
    });
  });

  it('restores progress that another process dropped by replacing the file', () => {
    const { store } = office();
    track(store);
    const agent = agentState(1);

    for (let i = 0; i < 3; i++) report(store, agent, { kind: 'toolFailure', toolId: `t${i}` });
    vi.advanceTimersByTime(ACHIEVEMENTS_SAVE_DEBOUNCE_MS);
    expect(stored()).toEqual({ bug_squasher: { slots: { standalone: 3 } } });

    // Another process read the file before that write, then renamed its own over it.
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, achievements: { marathon: { slots: { vscode: 4 } } } }),
    );
    vi.advanceTimersByTime(ACHIEVEMENTS_SAVE_DEBOUNCE_MS);

    expect(stored()).toEqual({
      bug_squasher: { slots: { standalone: 3 } },
      marathon: { slots: { vscode: 4 } },
    });
  });

  it("restores a newer build's record that another process dropped, and keeps its current value", () => {
    const newer = { unlocked: true, unlockedAt: at(9), level: 2 };
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        achievements: { future_x: newer, marathon: { slots: { vscode: 4 } } },
      }),
    );
    const { store } = office();
    const tracker = track(store);

    // A writer that read the file before future_x existed renames its copy over it.
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, achievements: { marathon: { slots: { vscode: 4 } } } }),
    );
    tracker.flush();
    expect(stored()?.future_x).toEqual(newer);

    // The build that defines it moves it on: the file's value wins, and is not rewritten.
    const moved = JSON.stringify({
      version: 1,
      achievements: { future_x: { ...newer, level: 3 }, marathon: { slots: { vscode: 4 } } },
    });
    fs.writeFileSync(file, moved);
    tracker.flush();
    expect(fs.readFileSync(file, 'utf-8')).toBe(moved);
  });

  it('keeps the earliest unlock time', () => {
    const { store, unlocks } = office();
    const tracker = track(store);
    store.set(1, agentState(1));
    expect(progress(tracker, 'first_agent').unlockedAt).toBe(at(12));

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        achievements: { first_agent: { max: 1, unlocked: true, unlockedAt: at(8) } },
      }),
    );

    expect(progress(tracker, 'first_agent').unlockedAt).toBe(at(8));
    expect(stored()?.first_agent?.unlockedAt).toBe(at(8));
    expect(unlocks).toEqual(['first_agent']);
  });

  it('announces an unlock once, never again after a restart', () => {
    const first = office();
    const before = track(first.store);
    first.store.set(1, agentState(1));
    before.dispose();

    clock = at(13);
    const second = office();
    const after = track(second.store);
    second.store.set(1, agentState(1));

    expect(first.unlocks).toEqual(['first_agent']);
    expect(second.unlocks).toEqual([]);
    expect(progress(after, 'first_agent')).toMatchObject({ unlocked: true, unlockedAt: at(12) });
  });

  it('reads a hand-edited or newer file leniently, and keeps what it does not know', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        achievements: {
          marathon: { slots: { vscode: 12.5, standalone: -3, other: 'x' } },
          architect: { keys: ['a', 'a', 'b', 7, ''] },
          night_owl: { unlocked: 'yes' },
          team_player: { unlocked: true, unlockedAt: -1, max: 5 },
          bug_squasher: { slots: { vscode: 250 } },
          future_badge: { anything: [1, 2] },
        },
      }),
    );
    const { store, unlocks } = office();
    const tracker = track(store);

    const byId = new Map(tracker.snapshot().map((entry) => [entry.id, entry]));
    expect(byId.get('marathon')).toEqual({ id: 'marathon', current: 12, unlocked: false });
    expect(byId.get('architect')).toEqual({ id: 'architect', current: 2, unlocked: false });
    expect(byId.get('night_owl')).toEqual({ id: 'night_owl', current: 0, unlocked: false });
    expect(byId.get('team_player')).toEqual({ id: 'team_player', current: 5, unlocked: true });
    // Past its target: clamped, and unlocked at the next save.
    expect(byId.get('bug_squasher')).toEqual({
      id: 'bug_squasher',
      current: 10,
      unlocked: true,
      unlockedAt: at(12),
    });
    expect(unlocks).toEqual(['bug_squasher']);

    const written = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      version: number;
      achievements: Record<string, unknown>;
    };
    expect(written.version).toBe(1);
    expect(written.achievements.future_badge).toEqual({ anything: [1, 2] });
    expect(written.achievements.marathon).toEqual({ slots: { vscode: 12.5 } });
    expect(written.achievements.architect).toEqual({ keys: ['a', 'b'] });
    expect(written.achievements.bug_squasher).toEqual({
      slots: { vscode: 10 },
      unlocked: true,
      unlockedAt: at(12),
    });
  });

  it.each([
    ['truncated JSON', '{"version":1,'],
    ['a number', '42'],
    ['null', 'null'],
    ['an array', '[]'],
    ['achievements that are not an object', '{"version":1,"achievements":[1]}'],
  ])('moves an unreadable file aside and starts fresh: %s', (_name, content) => {
    fs.writeFileSync(file, content);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, unlocks } = office();
    const tracker = track(store);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(`${file}.corrupt-${at(12)}`, 'utf-8')).toBe(content);

    store.set(1, agentState(1));
    expect(unlocks).toEqual(['first_agent']);
    expect(progress(tracker, 'first_agent').unlocked).toBe(true);
  });

  it('reads a file without achievements as empty, not as corrupt', () => {
    fs.writeFileSync(file, '{"version":1,"achievements":null}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = office();
    const tracker = track(store);

    expect(tracker.snapshot().every((entry) => entry.current === 0)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(['achievements.json']);
  });

  it('keeps counting while the file cannot be read, and saves once it can', () => {
    fs.mkdirSync(file);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, unlocks } = office();
    const tracker = track(store);

    expect(() => store.set(1, agentState(1))).not.toThrow();
    expect(progress(tracker, 'first_agent')).toEqual({
      id: 'first_agent',
      current: 1,
      unlocked: false,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(unlocks).toEqual([]);

    fs.rmdirSync(file);
    vi.advanceTimersByTime(ACHIEVEMENTS_SAVE_DEBOUNCE_MS);

    expect(unlocks).toEqual(['first_agent']);
    expect(stored()?.first_agent).toMatchObject({ max: 1, unlocked: true });
  });
});

describe('Achievements through the runtime', () => {
  const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
  const prompt = (text: string, ms: number) =>
    line({ type: 'user', message: { role: 'user', content: text }, timestamp: iso(ms) });
  const toolUse = (id: string, name: string, input: Record<string, unknown>, ms: number) =>
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      timestamp: iso(ms),
    });
  const toolError = (id: string, ms: number) =>
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'boom' }],
      },
      timestamp: iso(ms),
    });
  const toolOk = (id: string, ms: number) =>
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      timestamp: iso(ms),
    });
  const reply = (text: string, ms: number) =>
    line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      timestamp: iso(ms),
    });
  const turnDuration = (ms: number) =>
    line({ type: 'system', subtype: 'turn_duration', durationMs: 5_000, timestamp: iso(ms) });
  const copilot = (type: string, data: Record<string, unknown>) =>
    line({ type, data, id: randomUUID(), timestamp: iso(clock) });

  /** Restore one external agent the way a restarting server does. */
  function restore(provider: HookProvider, persisted: PersistedAgent) {
    let saved = [persisted];
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
    const { store, unlocks } = office();
    store.setAdapter(adapter);
    const runtime = new AgentRuntime(store, provider, {
      achievements: {
        namespace: 'standalone',
        filePath: file,
        now: () => clock,
        readLayout: () => null,
      },
    });
    runtimes.push(runtime);
    runtime.restoreExternalAgents();
    const append = (text: string) => {
      fs.appendFileSync(store.get(persisted.id)!.jsonlFile, text);
      runtime
        .getFileWatcher(provider.id)
        .readNewLines(persisted.id, store, runtime.waitingTimers, runtime.permissionTimers);
    };
    return { store, unlocks, runtime, tracker: runtime.achievements!, append };
  }

  function claudeSession() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = randomUUID();
    const jsonlFile = path.join(dir, `${sessionId}.jsonl`);
    // History from before the restart: never counted again.
    const edit = { file_path: path.join(dir, 'src', 'old.ts'), old_string: 'a', new_string: 'b' };
    fs.writeFileSync(
      jsonlFile,
      prompt('earlier', at(11)) +
        toolUse('toolu_old', 'Edit', edit, at(11, 0, 1)) +
        toolError('toolu_old', at(11, 0, 2)) +
        turnDuration(at(11, 0, 5)),
    );
    const session = restore(claudeProvider, {
      id: 1,
      providerId: 'claude',
      sessionId,
      terminalName: '',
      isExternal: true,
      projectDir: dir,
      jsonlFile,
    });
    return { ...session, sessionId, jsonlFile };
  }

  const counts = (tracker: AchievementTracker) =>
    Object.fromEntries(tracker.snapshot().map((entry) => [entry.id, entry.current]));

  it('Claude, hooks on: counts one failed edit and one interaction, not the history', () => {
    const o = claudeSession();
    expect(counts(o.tracker)).toMatchObject({
      first_agent: 1,
      architect: 0,
      bug_squasher: 0,
      marathon: 0,
    });
    const hook = (event: Record<string, unknown>) =>
      o.runtime.handleHookEvent('claude', { session_id: o.sessionId, ...event });
    hook({ hook_event_name: 'SessionStart', source: 'resume', transcript_path: o.jsonlFile });
    expect(o.store.get(1)!.hookDelivered).toBe(true);

    const edit = { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' };
    o.append(prompt('fix it', at(12)));
    clock = at(12, 0, 1);
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit });
    hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', error: 'boom' });
    clock = at(12, 0, 5);
    hook({ hook_event_name: 'Stop' });
    // The transcript's copy of the same turn, read after the hooks.
    clock = at(12, 0, 6);
    o.append(
      toolUse('toolu_1', 'Edit', edit, at(12, 0, 1)) +
        toolError('toolu_1', at(12, 0, 2)) +
        reply('done', at(12, 0, 4)) +
        turnDuration(at(12, 0, 5)),
    );

    expect(counts(o.tracker)).toMatchObject({ architect: 1, bug_squasher: 1, marathon: 1 });
  });

  it('Claude, hooks off: counts the same turn from the transcript alone', () => {
    const o = claudeSession();
    const edit = { file_path: path.join(dir, 'src', 'a.ts'), old_string: 'a', new_string: 'b' };

    clock = at(12, 0, 6);
    o.append(
      prompt('fix it', at(12)) +
        toolUse('toolu_1', 'Edit', edit, at(12, 0, 1)) +
        toolError('toolu_1', at(12, 0, 2)) +
        reply('done', at(12, 0, 4)) +
        turnDuration(at(12, 0, 5)),
    );

    expect(o.store.get(1)!.hookDelivered).toBe(false);
    expect(counts(o.tracker)).toMatchObject({ architect: 1, bug_squasher: 1, marathon: 1 });
  });

  describe('a transcript read from its start counts only what is written after', () => {
    const editOf = (name: string) => ({
      file_path: path.join(dir, 'src', name),
      old_string: 'a',
      new_string: 'b',
    });
    const spawn = { description: 'probe', prompt: 'look around' };

    function claudeLead(provider: HookProvider) {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const sessionId = randomUUID();
      const jsonlFile = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(jsonlFile, prompt('before the restart', at(10)));
      const session = restore(provider, {
        id: 1,
        providerId: 'claude',
        sessionId,
        terminalName: '',
        isExternal: true,
        projectDir: dir,
        jsonlFile,
      });
      return { ...session, sessionId };
    }

    // A provider without Token usage is never tracked by the usage tracker, so
    // only the watermark reassignAgentToFile set keeps the history out.
    it.each<[string, HookProvider]>([
      ['with Token usage', claudeProvider],
      ['without Token usage', { ...claudeProvider, extractTokenUsage: undefined }],
    ])('a session resumed into a new transcript (%s)', (_label, provider) => {
      const o = claudeLead(provider);
      const resumed = randomUUID();
      const resumedFile = path.join(dir, `${resumed}.jsonl`);
      // A spawn's done stays with the transcript with hooks on, so its failure
      // is the transcript's to count.
      fs.writeFileSync(
        resumedFile,
        prompt('earlier', at(11)) +
          toolUse('toolu_old_edit', 'Edit', editOf('old.ts'), at(11, 0, 1)) +
          toolOk('toolu_old_edit', at(11, 0, 2)) +
          toolUse('toolu_old_spawn', 'Agent', spawn, at(11, 0, 3)) +
          toolError('toolu_old_spawn', at(11, 0, 4)) +
          turnDuration(at(11, 0, 5)),
      );

      o.runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: o.sessionId,
        reason: 'resume',
      });
      o.runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: resumed,
        source: 'resume',
        transcript_path: resumedFile,
        cwd: dir,
      });
      vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);

      expect(o.store.get(1)!.jsonlFile).toBe(resumedFile);
      expect(counts(o.tracker)).toMatchObject({ architect: 0, bug_squasher: 0, marathon: 0 });

      o.append(
        prompt('next', at(12)) +
          toolUse('toolu_edit', 'Edit', editOf('new.ts'), at(12, 0, 1)) +
          toolOk('toolu_edit', at(12, 0, 2)) +
          toolUse('toolu_spawn', 'Agent', spawn, at(12, 0, 3)) +
          toolError('toolu_spawn', at(12, 0, 4)) +
          turnDuration(at(12, 0, 5)),
      );

      expect(counts(o.tracker)).toMatchObject({ architect: 1, bug_squasher: 1, marathon: 1 });
    });

    it('a teammate discovered late', () => {
      const teammateFile = path.join(dir, 'teammate.jsonl');
      const o = claudeLead({
        ...claudeProvider,
        team: {
          ...claudeTeamProvider,
          discoverTeammates: () =>
            fs.existsSync(teammateFile)
              ? [{ jsonlPath: teammateFile, teammateName: 'researcher' }]
              : [],
        },
      });
      fs.writeFileSync(
        teammateFile,
        prompt('research', at(11)) +
          toolUse('toolu_old', 'Edit', editOf('old.ts'), at(11, 0, 1)) +
          toolError('toolu_old', at(11, 0, 2)) +
          turnDuration(at(11, 0, 5)),
      );

      const watcher = o.runtime.getFileWatcher('claude');
      watcher.scanForTeammateFiles(
        dir,
        o.sessionId,
        1,
        o.store.nextAgentId,
        o.store,
        o.runtime.fileWatchers,
        o.runtime.pollingTimers,
        o.runtime.waitingTimers,
        o.runtime.permissionTimers,
        () => o.store.persist(),
      );
      vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);

      const teammate = [...o.store.values()].find((agent) => agent.agentName === 'researcher');
      expect(teammate).toMatchObject({ leadAgentId: 1, jsonlFile: teammateFile });
      // The teammate itself is live: only its transcript's past is not.
      expect(counts(o.tracker)).toMatchObject({
        team_player: 2,
        architect: 0,
        bug_squasher: 0,
        marathon: 0,
      });

      fs.appendFileSync(
        teammateFile,
        prompt('more', at(12)) +
          toolUse('toolu_new', 'Edit', editOf('new.ts'), at(12, 0, 1)) +
          toolError('toolu_new', at(12, 0, 2)) +
          turnDuration(at(12, 0, 5)),
      );
      watcher.readNewLines(
        teammate!.id,
        o.store,
        o.runtime.waitingTimers,
        o.runtime.permissionTimers,
      );

      expect(counts(o.tracker)).toMatchObject({ architect: 1, bug_squasher: 1, marathon: 1 });
    });
  });

  function copilotSession(history: string) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sessionId = randomUUID();
    const sessionDir = path.join(dir, sessionId);
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `cwd: ${path.join(dir, 'repo')}\n`);
    const jsonlFile = path.join(sessionDir, 'events.jsonl');
    fs.writeFileSync(jsonlFile, history);
    return restore(copilotProvider, {
      id: 1,
      providerId: 'copilot',
      sessionId,
      terminalName: '',
      isExternal: true,
      projectDir: sessionDir,
      jsonlFile,
    });
  }

  it('Copilot: counts what a restored session does next, never its recovered history', () => {
    clock = at(3, 5);
    const o = copilotSession(
      copilot('session.start', { selectedModel: 'gpt-5' }) +
        copilot('user.message', { content: 'earlier' }) +
        copilot('assistant.turn_start', { turnId: 't0' }) +
        copilot('tool.execution_start', {
          toolCallId: 'old',
          toolName: 'edit',
          arguments: { path: 'src/old.ts' },
          turnId: 't0',
        }) +
        copilot('tool.execution_complete', { toolCallId: 'old', success: false, turnId: 't0' }) +
        copilot('assistant.turn_end', { turnId: 't0' }) +
        copilot('session.idle', {}),
    );
    expect(counts(o.tracker)).toMatchObject({
      first_agent: 1,
      night_owl: 0,
      architect: 0,
      bug_squasher: 0,
      marathon: 0,
    });

    o.append(
      copilot('user.message', { content: 'fix it' }) +
        copilot('assistant.turn_start', { turnId: 't1' }) +
        copilot('tool.execution_start', {
          toolCallId: 'c1',
          toolName: 'edit',
          arguments: { path: 'src/app.ts', old_str: 'a', new_str: 'b' },
          turnId: 't1',
        }) +
        copilot('tool.execution_complete', { toolCallId: 'c1', success: false, turnId: 't1' }) +
        copilot('tool.execution_start', {
          toolCallId: 'c2',
          toolName: 'apply_patch',
          arguments: [
            '*** Begin Patch',
            `*** Update File: ${path.join(dir, 'repo', 'src', 'app.ts')}`,
            '*** Add File: src/b.ts',
            '*** Add File: src/c.ts',
            '*** End Patch',
          ].join('\n'),
          turnId: 't1',
        }) +
        copilot('tool.execution_failed', { toolCallId: 'c2', turnId: 't1' }) +
        copilot('assistant.turn_end', { turnId: 't1' }),
    );
    // The end of one model-loop step is not the end of the interaction.
    expect(counts(o.tracker)).toMatchObject({ marathon: 0 });

    o.append(copilot('session.idle', {}));

    expect(counts(o.tracker)).toMatchObject({
      night_owl: 1,
      architect: 3,
      bug_squasher: 2,
      marathon: 1,
    });
  });

  it('Copilot: credits tokens when the session shuts down, from the last known total', () => {
    const shutdown = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
      copilot('session.shutdown', {
        totalPremiumRequests: 1,
        totalNanoAiu: 1_000,
        currentModel: 'gpt-5',
        tokenDetails: {
          input: { tokenCount: input },
          output: { tokenCount: output },
          cache_read: { tokenCount: cacheRead },
          cache_write: { tokenCount: cacheWrite },
        },
      });
    const o = copilotSession(
      copilot('session.start', { selectedModel: 'gpt-5' }) +
        copilot('user.message', { content: 'hi' }) +
        copilot('assistant.message', { content: 'hello', model: 'gpt-5' }) +
        shutdown(100_000, 20_000, 500_000, 30_000),
    );

    o.append(
      copilot('session.resume', { selectedModel: 'gpt-5' }) +
        copilot('user.message', { content: 'more' }) +
        copilot('assistant.turn_start', { turnId: 't1' }) +
        copilot('assistant.message', { content: 'done', model: 'gpt-5' }) +
        copilot('assistant.turn_end', { turnId: 't1' }) +
        copilot('session.idle', {}),
    );
    // Copilot writes its token counts only when a run shuts down.
    expect(counts(o.tracker)).toMatchObject({ token_millionaire: 0, marathon: 1 });

    // 200k + 80k + 700k + 20k more than the history's shutdown.
    o.append(shutdown(300_000, 100_000, 1_200_000, 50_000));

    expect(progress(o.tracker, 'token_millionaire')).toMatchObject({
      current: 1_000_000,
      unlocked: true,
    });
    expect(o.unlocks).toContain('token_millionaire');
  });
});
