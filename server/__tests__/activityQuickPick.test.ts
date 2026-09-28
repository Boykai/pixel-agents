import { describe, expect, it } from 'vitest';

import {
  activityQuickPickItem,
  buildActivityQuickPickRows,
  SubagentActivityTracker,
} from '../../adapters/vscode/activityQuickPickRows.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import type { AgentState } from '../src/types.js';

const providers = [claudeProvider, copilotProvider];

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    sessionId: 'test-session',
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

function terminal(name: string): AgentState['terminalRef'] {
  return { name } as unknown as AgentState['terminalRef'];
}

/** Tools as the runtime records them: id → [name, status], in start order. */
function tools(entries: Record<string, [string, string]>): Partial<AgentState> {
  return {
    activeToolIds: new Set(Object.keys(entries)),
    activeToolNames: new Map(Object.entries(entries).map(([id, [name]]) => [id, name])),
    activeToolStatuses: new Map(Object.entries(entries).map(([id, [, status]]) => [id, status])),
  };
}

function setup(...agents: AgentState[]) {
  const store = new AgentStateStore();
  for (const agent of agents) store.set(agent.id, agent);
  const tracker = new SubagentActivityTracker((id) => store.get(id)?.backgroundAgentToolIds);
  const rows = () => buildActivityQuickPickRows(store, tracker, providers);
  return { store, tracker, rows };
}

describe('buildActivityQuickPickRows', () => {
  it('describes each Agent with the shared Activity label precedence', () => {
    const { rows } = setup(
      createTestAgent({ id: 1, folderName: 'thinking' }),
      createTestAgent({ id: 2, folderName: 'idle', isWaiting: true }),
      createTestAgent({ id: 3, folderName: 'asking', isWaiting: true, awaitingInput: true }),
      createTestAgent({
        id: 4,
        folderName: 'approval',
        permissionSent: true,
        ...tools({ t1: ['Bash', 'Running: npm test'] }),
      }),
      createTestAgent({
        id: 5,
        folderName: 'working',
        ...tools({ t1: ['Read', 'Reading a.ts'], t2: ['Edit', 'Editing b.ts'] }),
      }),
    );

    expect(rows().map(({ name, activity, state }) => ({ name, activity, state }))).toEqual([
      { name: 'thinking', activity: 'Thinking…', state: 'active' },
      { name: 'idle', activity: 'Idle', state: 'done' },
      { name: 'asking', activity: 'Waiting for input', state: 'input' },
      { name: 'approval', activity: 'Needs approval', state: 'permission' },
      { name: 'working', activity: 'Editing b.ts', state: 'active' },
    ]);
  });

  it('names an Agent like the office does, and says where it runs', () => {
    const { rows } = setup(
      createTestAgent({
        id: 1,
        agentName: 'researcher',
        sessionName: 'Fix login',
        folderName: 'app',
        terminalRef: terminal('Claude Code #1'),
      }),
      createTestAgent({ id: 2, sessionName: 'Fix login', folderName: 'app' }),
      createTestAgent({ id: 3, providerId: 'copilot', isExternal: true }),
    );

    expect(
      rows().map(({ key, agentId, depth, kind, name, detail }) => ({
        key,
        agentId,
        depth,
        kind,
        name,
        detail,
      })),
    ).toEqual([
      {
        key: 'agent:1',
        agentId: 1,
        depth: 0,
        kind: 'agent',
        name: 'researcher',
        detail: 'Claude Code · Claude Code #1',
      },
      {
        key: 'agent:2',
        agentId: 2,
        depth: 0,
        kind: 'agent',
        name: 'Fix login',
        detail: 'Claude Code · Headless',
      },
      {
        key: 'agent:3',
        agentId: 3,
        depth: 0,
        kind: 'agent',
        name: 'Agent #3',
        detail: 'GitHub Copilot CLI · Headless',
      },
    ]);
  });

  it('nests Teammates under their Lead, after the Lead’s Sub-agents', () => {
    const { rows } = setup(
      createTestAgent({ id: 3, agentName: 'tester', leadAgentId: 1 }),
      createTestAgent({
        id: 1,
        folderName: 'app',
        isTeamLead: true,
        terminalRef: terminal('Claude Code #1'),
        ...tools({ spawn: ['Task', 'Subtask: Explore the repo'] }),
      }),
      createTestAgent({ id: 2, agentName: 'reviewer', leadAgentId: 1 }),
      createTestAgent({ id: 4, folderName: 'other' }),
    );

    expect(
      rows().map(({ key, depth, kind, name, detail }) => ({ key, depth, kind, name, detail })),
    ).toEqual([
      {
        key: 'agent:1',
        depth: 0,
        kind: 'lead',
        name: 'app',
        detail: 'Lead · Claude Code · Claude Code #1',
      },
      {
        key: 'subagent:1:spawn',
        depth: 1,
        kind: 'subagent',
        name: 'Explore the repo',
        detail: 'Sub-agent of app',
      },
      {
        key: 'agent:3',
        depth: 1,
        kind: 'teammate',
        name: 'tester',
        detail: 'Teammate · Claude Code',
      },
      {
        key: 'agent:2',
        depth: 1,
        kind: 'teammate',
        name: 'reviewer',
        detail: 'Teammate · Claude Code',
      },
      { key: 'agent:4', depth: 0, kind: 'agent', name: 'other', detail: 'Claude Code · Headless' },
    ]);
  });

  it('hides Agents in an unknown state, lifting their Teammates to the top level', () => {
    const { rows } = setup(
      createTestAgent({ id: 1, folderName: 'app', isTeamLead: true, observation: 'unknown' }),
      createTestAgent({ id: 2, agentName: 'reviewer', leadAgentId: 1 }),
    );

    expect(rows().map(({ key, depth }) => ({ key, depth }))).toEqual([
      { key: 'agent:2', depth: 0 },
    ]);
  });

  it('never loses an Agent to a Lead link that loops', () => {
    const { rows } = setup(
      createTestAgent({ id: 1, agentName: 'a', leadAgentId: 2 }),
      createTestAgent({ id: 2, agentName: 'b', leadAgentId: 1 }),
      createTestAgent({ id: 3, agentName: 'self', leadAgentId: 3 }),
    );

    expect(rows().map(({ key, depth }) => ({ key, depth }))).toEqual([
      { key: 'agent:3', depth: 0 },
      { key: 'agent:1', depth: 0 },
      { key: 'agent:2', depth: 1 },
    ]);
  });

  it('lists a Sub-agent per running spawn, with its own latest tool', () => {
    const { tracker, rows } = setup(
      createTestAgent({
        id: 1,
        folderName: 'app',
        ...tools({
          read: ['Read', 'Reading a.ts'],
          spawn: ['Task', 'Subtask: Research'],
          bare: ['Agent', 'Running Agent'],
        }),
      }),
    );
    const subRows = () =>
      rows()
        .filter((row) => row.kind === 'subagent')
        .map(({ key, agentId, name, activity, state }) => ({
          key,
          agentId,
          name,
          activity,
          state,
        }));

    expect(subRows()).toEqual([
      {
        key: 'subagent:1:spawn',
        agentId: 1,
        name: 'Research',
        activity: 'Thinking…',
        state: 'active',
      },
      {
        key: 'subagent:1:bare',
        agentId: 1,
        name: 'Sub-agent',
        activity: 'Thinking…',
        state: 'active',
      },
    ]);

    tracker.observe({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'spawn',
      toolId: 'grep',
      status: 'Searching code',
    });
    tracker.observe({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'spawn',
      toolId: 'view',
      status: 'Reading c.ts',
    });
    expect(subRows()[0]).toMatchObject({ activity: 'Reading c.ts', state: 'active' });

    tracker.observe({ type: 'subagentToolDone', id: 1, parentToolId: 'spawn', toolId: 'view' });
    expect(subRows()[0]).toMatchObject({ activity: 'Searching code', state: 'active' });

    tracker.observe({ type: 'subagentToolDone', id: 1, parentToolId: 'spawn', toolId: 'grep' });
    expect(subRows()[0]).toMatchObject({ activity: 'Thinking…', state: 'active' });

    tracker.observe({ type: 'subagentToolPermission', id: 1, parentToolId: 'spawn' });
    expect(subRows()[0]).toMatchObject({ activity: 'Needs approval', state: 'permission' });
    expect(subRows()[1]).toMatchObject({ activity: 'Thinking…' });

    tracker.observe({ type: 'agentToolPermissionClear', id: 1, parentToolId: 'spawn' });
    expect(subRows()[0]).toMatchObject({ activity: 'Thinking…', state: 'active' });
  });

  it('knows each provider’s spawn tools', () => {
    const { rows } = setup(
      createTestAgent({
        id: 1,
        providerId: 'copilot',
        folderName: 'app',
        ...tools({ spawn: ['task', 'Subtask: Research'], other: ['Task', 'Running Task'] }),
      }),
      createTestAgent({
        id: 2,
        folderName: 'web',
        ...tools({ spawn: ['task', 'Running task'] }),
      }),
    );

    expect(rows().map(({ key }) => key)).toEqual(['agent:1', 'subagent:1:spawn', 'agent:2']);
  });

  it('leaves out spawns that the office shows as Teammates instead', () => {
    const { store, rows } = setup(
      createTestAgent({
        id: 1,
        folderName: 'app',
        isTeamLead: true,
        teammateSpawnToolIds: new Set(['named']),
        backgroundAgentToolIds: new Set(['promoted']),
        ...tools({
          named: ['Agent', 'Subtask: reviewer'],
          promoted: ['Agent', 'Subtask: tester'],
        }),
      }),
      createTestAgent({ id: 2, agentName: 'tester', leadAgentId: 1, spawnToolUseId: 'promoted' }),
    );

    // The promoted spawn is its Teammate's row, not the Lead's activity or a Sub-agent.
    expect(rows().map(({ key, activity }) => ({ key, activity }))).toEqual([
      { key: 'agent:1', activity: 'Subtask: reviewer' },
      { key: 'agent:2', activity: 'Thinking…' },
    ]);

    // Once the Teammate is gone, the spawn is an ordinary Sub-agent again.
    store.delete(2);
    expect(rows().map(({ key }) => key)).toEqual(['agent:1', 'subagent:1:promoted']);
  });

  it('shows a teamed Lead’s background spawn once it reports its own tools', () => {
    const { tracker, rows } = setup(
      createTestAgent({
        id: 1,
        folderName: 'app',
        teamName: 'session-1a2b3c4d',
        backgroundAgentToolIds: new Set(['bg']),
        ...tools({ bg: ['Agent', 'Subtask: Audit'], fg: ['Agent', 'Subtask: Plan'] }),
      }),
    );

    expect(rows().map(({ key }) => key)).toEqual(['agent:1', 'subagent:1:fg']);

    tracker.observe({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'bg',
      toolId: 'read',
      status: 'Reading d.ts',
    });
    expect(rows().map(({ key, activity }) => ({ key, activity }))).toEqual([
      { key: 'agent:1', activity: 'Subtask: Plan' },
      { key: 'subagent:1:bg', activity: 'Reading d.ts' },
      { key: 'subagent:1:fg', activity: 'Thinking…' },
    ]);
  });

  it('skips spawns of an Agent whose provider is not enabled', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        providerId: 'copilot',
        folderName: 'app',
        ...tools({ spawn: ['task', 'Subtask: Research'] }),
      }),
    );
    const tracker = new SubagentActivityTracker(() => undefined);

    expect(
      buildActivityQuickPickRows(store, tracker, [claudeProvider]).map(({ key, detail }) => ({
        key,
        detail,
      })),
    ).toEqual([{ key: 'agent:1', detail: 'copilot · Headless' }]);
  });
});

describe('SubagentActivityTracker', () => {
  const start = (id: number, parentToolId: string, toolId: string, status: string) => ({
    type: 'subagentToolStart',
    id,
    parentToolId,
    toolId,
    status,
  });

  it('keeps a finished tool finished when its start is re-sent', () => {
    const tracker = new SubagentActivityTracker(() => undefined);
    tracker.observe(start(1, 'spawn', 'read', 'Reading a.ts'));
    tracker.observe({ type: 'subagentToolDone', id: 1, parentToolId: 'spawn', toolId: 'read' });
    tracker.observe(start(1, 'spawn', 'read', 'Reading a.ts'));

    expect(tracker.describe(1, 'spawn')).toEqual({ label: 'Thinking…', state: 'active' });
  });

  it('clears every spawn’s approval when the parent’s approval clears', () => {
    const tracker = new SubagentActivityTracker(() => undefined);
    tracker.observe({ type: 'subagentToolPermission', id: 1, parentToolId: 'a' });
    tracker.observe({ type: 'subagentToolPermission', id: 1, parentToolId: 'b' });
    tracker.observe({ type: 'agentToolPermissionClear', id: 1 });

    expect(tracker.describe(1, 'a').state).toBe('active');
    expect(tracker.describe(1, 'b').state).toBe('active');
  });

  it('keeps only background spawns past the parent’s turn end', () => {
    const tracker = new SubagentActivityTracker((id) => (id === 1 ? new Set(['bg']) : undefined));
    tracker.observe(start(1, 'bg', 't1', 'Reading a.ts'));
    tracker.observe(start(1, 'fg', 't2', 'Reading b.ts'));
    tracker.observe(start(2, 'fg', 't3', 'Reading c.ts'));
    tracker.observe({ type: 'agentToolsClear', id: 1 });
    tracker.observe({ type: 'agentToolsClear', id: 2 });

    expect(tracker.has(1, 'bg')).toBe(true);
    expect(tracker.has(1, 'fg')).toBe(false);
    expect(tracker.has(2, 'fg')).toBe(false);
  });

  it('drops a finished spawn and a departed Agent', () => {
    const tracker = new SubagentActivityTracker(() => undefined);
    tracker.observe(start(1, 'a', 't1', 'Reading a.ts'));
    tracker.observe(start(1, 'b', 't2', 'Reading b.ts'));
    tracker.observe({ type: 'subagentClear', id: 1, parentToolId: 'a' });

    expect(tracker.has(1, 'a')).toBe(false);
    expect(tracker.has(1, 'b')).toBe(true);

    tracker.forget(1);
    expect(tracker.has(1, 'b')).toBe(false);
  });

  it('ignores messages it cannot place', () => {
    const tracker = new SubagentActivityTracker(() => undefined);
    tracker.observe({ type: 'subagentToolStart', id: '1', parentToolId: 'a', toolId: 't' });
    tracker.observe({ type: 'subagentToolStart', id: 1, toolId: 't', status: 'x' });
    tracker.observe({ type: 'agentToolStart', id: 1, toolId: 't', status: 'x' });

    expect(tracker.has(1, 'a')).toBe(false);
  });
});

describe('activityQuickPickItem', () => {
  it('indents nested rows and marks each state with an icon', () => {
    expect(
      activityQuickPickItem({
        key: 'agent:1',
        agentId: 1,
        depth: 0,
        kind: 'lead',
        name: 'app',
        activity: 'Reading a.ts',
        state: 'active',
        detail: 'Lead · Claude Code · Claude Code #1',
      }),
    ).toEqual({
      label: '$(sync~spin) app',
      description: 'Reading a.ts',
      detail: 'Lead · Claude Code · Claude Code #1',
    });

    expect(
      activityQuickPickItem({
        key: 'subagent:1:spawn',
        agentId: 1,
        depth: 1,
        kind: 'subagent',
        name: 'Research',
        activity: 'Needs approval',
        state: 'permission',
        detail: 'Sub-agent of app',
      }).label,
    ).toBe('\u2003$(arrow-small-right) $(warning) Research');

    expect(
      activityQuickPickItem({
        key: 'agent:2',
        agentId: 2,
        depth: 1,
        kind: 'teammate',
        name: 'reviewer',
        activity: 'Waiting for input',
        state: 'input',
        detail: 'Teammate · Claude Code',
      }).label,
    ).toBe('\u2003$(arrow-small-right) $(question) reviewer');

    expect(
      activityQuickPickItem({
        key: 'agent:3',
        agentId: 3,
        depth: 0,
        kind: 'agent',
        name: 'web',
        activity: 'Idle',
        state: 'done',
        detail: 'Claude Code · Headless',
      }).label,
    ).toBe('$(check) web');
  });
});
