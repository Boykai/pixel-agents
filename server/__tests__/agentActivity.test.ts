import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';
import type { AgentActivityEvent } from '../src/agentActivity.js';
import { AgentActivityFeed, recordTime } from '../src/agentActivity.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { TEXT_IDLE_DELAY_MS } from '../src/constants.js';
import {
  readNewLines,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeamProvider,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import { setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Local noon on a fixed day. */
const T0 = new Date(2026, 0, 15, 12).getTime();
const sec = (n: number) => T0 + n * 1_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Claude without Token usage: liveness must not depend on the usage tracker. */
const tokenless: HookProvider = { ...claudeProvider, extractTokenUsage: undefined };
const providers: Array<[string, HookProvider]> = [
  ['with Token usage', claudeProvider],
  ['without Token usage', tokenless],
];

const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const prompt = (text: string, ms: number) =>
  line({ type: 'user', message: { role: 'user', content: text }, timestamp: iso(ms) });
const toolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  ms: number,
  extra: Record<string, unknown> = {},
) =>
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    timestamp: iso(ms),
    ...extra,
  });
const toolResult = (id: string, ms: number, isError = false, extra: Record<string, unknown> = {}) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: isError ? 'boom' : 'ok',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
    timestamp: iso(ms),
    ...extra,
  });
const reply = (text: string, ms: number) =>
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: iso(ms),
  });
const turnDuration = (ms: number) =>
  line({ type: 'system', subtype: 'turn_duration', durationMs: 5_000, timestamp: iso(ms) });
/** An `agent_progress` record: one message of a Sub-agent spawned by `parentToolUseID`. */
const progress = (parentToolUseID: string, role: 'assistant' | 'user', block: object, ms: number) =>
  line({
    type: 'progress',
    parentToolUseID,
    data: { type: 'agent_progress', message: { type: role, message: { role, content: [block] } } },
    timestamp: iso(ms),
  });
const copilot = (type: string, data: Record<string, unknown>, ms: number) =>
  line({ type, data, id: randomUUID(), timestamp: iso(ms) });

function brief(event: AgentActivityEvent): string {
  const subject =
    event.kind === 'toolStart'
      ? `toolStart ${event.toolName}${event.subagent ? ' (sub-agent)' : ''}`
      : event.kind === 'toolFailure'
        ? `toolFailure ${event.toolId}${event.subagent ? ' (sub-agent)' : ''}`
        : event.kind;
  return `${event.agentId} ${subject}`;
}

let dir: string;
let clock: number;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  // Timers only: Date stays real, and the store reads the injected clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-activity-'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('COPILOT_HOME', path.join(dir, '.copilot'));
  clock = T0;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe('AgentActivityFeed', () => {
  const feedAgent = (id: number, overrides: Partial<AgentState> = {}) =>
    agentState(id, { projectDir: '/repo', jsonlFile: `/repo/${id}.jsonl`, ...overrides });

  function feed() {
    const activity = new AgentActivityFeed(() => clock);
    const events: AgentActivityEvent[] = [];
    const unsubscribe = activity.subscribe((event) => events.push(event));
    return { activity, events, unsubscribe };
  }

  it('reads record timestamps leniently', () => {
    expect(recordTime(iso(sec(1)))).toBe(sec(1));
    expect(recordTime(sec(2))).toBe(sec(2));
    for (const junk of ['', 'yesterday', NaN, Infinity, null, undefined, {}, [], true]) {
      expect(recordTime(junk)).toBeUndefined();
    }
  });

  it('stamps each event with the agent, its provider, and both clocks', () => {
    const { activity, events, unsubscribe } = feed();
    activity.live(
      feedAgent(1, { providerId: undefined }),
      { kind: 'toolFailure', toolId: 't1' },
      iso(sec(-5)),
    );
    clock = sec(1);
    activity.live(feedAgent(2, { providerId: 'copilot' }), { kind: 'interactionEnd' }, 'soon');
    unsubscribe();
    activity.live(feedAgent(1), { kind: 'interactionStart' });

    expect(events).toStrictEqual([
      {
        kind: 'toolFailure',
        toolId: 't1',
        agentId: 1,
        providerId: 'claude',
        projectDir: '/repo',
        at: T0,
        recordedAt: sec(-5),
      },
      {
        kind: 'interactionEnd',
        agentId: 2,
        providerId: 'copilot',
        projectDir: '/repo',
        at: sec(1),
      },
    ]);
  });

  it('drops transcript records that end at or before the live watermark', () => {
    const { activity, events } = feed();
    const lead = feedAgent(1);
    // Fed from its lead's transcript (a Copilot teammate): judged by the lead's reader.
    const promoted = feedAgent(2, { jsonlFile: '', leadAgentId: 1 });
    // Its own transcript, not tracked yet: nothing marks it as history.
    const untracked = feedAgent(3, { leadAgentId: 1 });
    activity.markLiveFrom(1, 100, lead.jsonlFile);

    for (const recordEnd of [60, 100, 101]) {
      activity.reading(1, recordEnd);
      activity.transcript(lead, { kind: 'interactionStart' }, recordEnd);
      activity.transcript(promoted, { kind: 'interactionStart' }, recordEnd);
    }
    activity.reading(1, 60);
    activity.transcript(untracked, { kind: 'interactionEnd' });
    activity.live(lead, { kind: 'interactionEnd' });

    expect(events.map((e) => `${e.agentId} ${e.kind} ${e.recordedAt ?? '-'}`)).toEqual([
      '1 interactionStart 101',
      '2 interactionStart 101',
      '3 interactionEnd -',
      '1 interactionEnd -',
    ]);
    expect(activity.liveFromIn(1, lead.jsonlFile)).toBe(100);
    expect(activity.liveFromIn(1, '/repo/other.jsonl')).toBeUndefined();
  });

  it('keeps notifying the other listeners when one throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { activity, events } = feed();
    activity.subscribe(() => {
      throw new Error('boom');
    });
    const later: string[] = [];
    activity.subscribe((event) => later.push(event.kind));

    activity.live(feedAgent(1), { kind: 'interactionStart' });

    expect(events.map((e) => e.kind)).toEqual(['interactionStart']);
    expect(later).toEqual(['interactionStart']);
    expect(error).toHaveBeenCalledWith(
      '[Pixel Agents] Agent activity listener failed:',
      expect.any(Error),
    );
  });
});

/** Restore one external agent the way a restarting server does, and record its activity. */
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
  const store = new AgentStateStore({ now: () => clock });
  store.setAdapter(adapter);
  const events: AgentActivityEvent[] = [];
  store.activity.subscribe((event) => events.push(event));
  const runtime = new AgentRuntime(store, provider);
  cleanups.push(() => {
    runtime.dispose();
    store.dispose();
  });
  runtime.restoreExternalAgents();
  const agent = () => store.get(persisted.id)!;
  const sessionKey = provider.id === 'copilot' ? 'sessionId' : 'session_id';
  return {
    runtime,
    events,
    agent,
    hook: (event: Record<string, unknown>) =>
      runtime.handleHookEvent(provider.id, { [sessionKey]: agent().sessionId, ...event }),
    append: (text: string) => {
      fs.appendFileSync(agent().jsonlFile, text);
      runtime
        .getFileWatcher(provider.id)
        .readNewLines(persisted.id, store, runtime.waitingTimers, runtime.permissionTimers);
    },
  };
}

function restoreClaude(provider: HookProvider, history: string) {
  const sessionId = randomUUID();
  const jsonlFile = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlFile, history);
  return restore(provider, {
    id: 1,
    providerId: provider.id,
    sessionId,
    terminalName: '',
    isExternal: true,
    projectDir: dir,
    jsonlFile,
  });
}

function restoreCopilot(history: string) {
  const sessionId = randomUUID();
  const sessionDir = path.join(dir, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `cwd: ${dir}\n`);
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

describe('Agent activity liveness: a transcript read from its start', () => {
  const spawn = { description: 'probe', prompt: 'look around' };

  // Regression: a provider without Token usage is never tracked by the usage
  // tracker, so startFileWatching must keep the watermark reassignAgentToFile set.
  it.each(providers)("a resumed session's history is not new activity (%s)", (_label, provider) => {
    const o = restoreClaude(provider, prompt('before the restart', sec(-90)));
    const resumed = randomUUID();
    const resumedFile = path.join(dir, `${resumed}.jsonl`);
    fs.writeFileSync(
      resumedFile,
      prompt('earlier', sec(-60)) +
        toolUse('toolu_old', 'Agent', spawn, sec(-59)) +
        toolResult('toolu_old', sec(-58), true) +
        reply('ok', sec(-57)) +
        turnDuration(sec(-56)),
    );

    o.hook({ hook_event_name: 'SessionEnd', reason: 'resume' });
    o.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: resumed,
      source: 'resume',
      transcript_path: resumedFile,
      cwd: dir,
    });
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);

    expect(o.agent().jsonlFile).toBe(resumedFile);
    expect(o.events).toEqual([]);

    o.append(
      prompt('next', sec(1)) +
        toolUse('toolu_new', 'Agent', spawn, sec(2)) +
        toolResult('toolu_new', sec(3), true) +
        turnDuration(sec(4)),
    );

    expect(o.events.map(brief)).toEqual([
      '1 interactionStart',
      '1 toolStart Agent',
      '1 toolFailure toolu_new',
      '1 interactionEnd',
    ]);
  });

  describe('scanned transcripts (existingIsHistory)', () => {
    const LEAD_SESSION = 'lead-session-1';
    const SPAWN_TOOL_ID = 'toolu_spawn';
    const sidechain = { isSidechain: true };
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const fileWatchers = new Map<number, fs.FSWatcher>();

    /** The module-level scanners, wired the way AgentRuntime wires its own. */
    function wire(provider: HookProvider, team: TeamProvider = claudeTeamProvider) {
      setHookProvider(provider);
      setFileWatcherHookProvider(provider);
      setTeamProvider(team);
      const store = new AgentStateStore({ now: () => clock });
      const watch = new SubagentWatch(store);
      setSubagentWatch(watch);
      const events: AgentActivityEvent[] = [];
      store.activity.subscribe((event) => events.push(event));
      store.set(
        1,
        agentState(1, {
          sessionId: LEAD_SESSION,
          jsonlFile: path.join(dir, `${LEAD_SESSION}.jsonl`),
        }),
      );
      cleanups.push(() => {
        for (const timer of pollingTimers.values()) clearInterval(timer);
        for (const timer of [...waitingTimers.values(), ...permissionTimers.values()]) {
          clearTimeout(timer);
        }
        pollingTimers.clear();
        waitingTimers.clear();
        permissionTimers.clear();
        watch.dispose();
        setSubagentWatch(null);
        setTeamProvider(claudeTeamProvider);
        setHookProvider(claudeProvider);
        setFileWatcherHookProvider(claudeProvider);
        store.dispose();
      });
      return { store, watch, events };
    }

    it.each(providers)(
      'a teammate discovered late: only what it does next (%s)',
      (_l, provider) => {
        const file = path.join(dir, 'teammate.jsonl');
        fs.writeFileSync(
          file,
          prompt('research', sec(-30)) +
            toolUse('toolu_old', 'Read', { file_path: '/repo/a.ts' }, sec(-29)) +
            toolResult('toolu_old', sec(-28), true) +
            // Arms the text-idle timer: the turn that ends would be history too.
            reply('found it', sec(-27)),
        );
        const { store, events } = wire(provider, {
          ...claudeTeamProvider,
          discoverTeammates: () => [{ jsonlPath: file, teammateName: 'researcher' }],
        });

        scanForTeammateFiles(
          dir,
          LEAD_SESSION,
          1,
          { current: 100 },
          store,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          () => {},
        );
        vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);

        expect(store.get(100)).toMatchObject({ agentName: 'researcher', leadAgentId: 1 });
        expect(events).toEqual([]);

        fs.appendFileSync(
          file,
          prompt('more', sec(1)) +
            toolUse('toolu_new', 'Bash', { command: 'ls' }, sec(2)) +
            toolResult('toolu_new', sec(3), true) +
            turnDuration(sec(4)),
        );
        readNewLines(100, store, waitingTimers, permissionTimers);

        expect(events.map(brief)).toEqual([
          '100 interactionStart',
          '100 toolStart Bash',
          '100 toolFailure toolu_new',
          '100 interactionEnd',
        ]);
      },
    );

    it.each(providers)(
      'a re-materialized Sub-agent watch forwards only new tools to its lead (%s)',
      (_label, provider) => {
        const subagents = path.join(dir, LEAD_SESSION, 'subagents');
        fs.mkdirSync(subagents, { recursive: true });
        const file = path.join(subagents, 'agent-a4cb86c99458dbe55.jsonl');
        fs.writeFileSync(
          file,
          toolUse('toolu_sub_old', 'Read', { file_path: '/repo/a.ts' }, sec(-20), sidechain) +
            toolResult('toolu_sub_old', sec(-19), true, sidechain),
        );
        fs.writeFileSync(
          path.join(subagents, 'agent-a4cb86c99458dbe55.meta.json'),
          JSON.stringify({ agentType: 'general-purpose', toolUseId: SPAWN_TOOL_ID }),
        );
        const { store, watch, events } = wire(provider);
        // After a reload the lead's live spawn comes back from persistence, and
        // the scan watches the spawn's transcript again from its start.
        store.get(1)!.backgroundAgentToolIds.add(SPAWN_TOOL_ID);

        scanForBackgroundAgentFiles(
          1,
          store,
          { current: 100 },
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          () => {},
        );

        const shadow = [...watch.store.values()].find((agent) => agent.jsonlFile === file);
        expect(shadow?.id).toBeGreaterThanOrEqual(1_000_000);
        expect(store.size).toBe(1);
        expect(events).toEqual([]);

        fs.appendFileSync(
          file,
          toolUse('toolu_sub', 'Bash', { command: 'ls' }, sec(1), sidechain) +
            toolResult('toolu_sub', sec(2), true, sidechain) +
            turnDuration(sec(3)),
        );
        readNewLines(shadow!.id, watch.store, new Map(), new Map());

        // Only tool work reaches the lead; the Sub-agent's own turns are not its lead's.
        expect(events.map(brief)).toEqual([
          '1 toolStart Bash (sub-agent)',
          '1 toolFailure toolu_sub (sub-agent)',
        ]);
      },
    );
  });
});

describe('Agent activity emission', () => {
  it('Claude hooks: tool starts, own failures and Done; Sub-agent and spawn failures are left to the transcript', () => {
    const o = restoreClaude(claudeProvider, prompt('before the restart', sec(-60)));
    const edit = { file_path: path.join(dir, 'a.ts'), old_string: 'a', new_string: 'b' };

    o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit });
    o.hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', error: 'boom' });
    o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    // A Sub-agent's failure: its own transcript reports it.
    o.hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', agent_id: 'a1' });
    o.hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } });
    // A spawn's failure: the transcript owns spawn tools.
    o.hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', error: 'boom' });
    // Waiting for input is not Done.
    o.hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: '?' });
    clock = sec(5);
    o.hook({ hook_event_name: 'Stop' });

    expect(o.agent().hookDelivered).toBe(true);
    expect(o.events.map(brief)).toEqual([
      '1 toolStart Edit',
      expect.stringMatching(/^1 toolFailure hook-\d+$/),
      '1 toolStart Bash',
      '1 toolStart Agent',
      '1 interactionEnd',
    ]);
    const [start, failure] = o.events;
    expect(start).toEqual({
      kind: 'toolStart',
      toolId: expect.stringMatching(/^hook-\d+$/),
      toolName: 'Edit',
      input: edit,
      agentId: 1,
      providerId: 'claude',
      projectDir: dir,
      at: T0,
    });
    expect(failure).toMatchObject({
      kind: 'toolFailure',
      toolId: (start as { toolId: string }).toolId,
    });
    expect(o.events.at(-1)).toMatchObject({ kind: 'interactionEnd', at: sec(5) });
  });

  it('Claude transcript: marks Sub-agent work, and ends a text-only turn when it goes quiet', () => {
    const o = restoreClaude(claudeProvider, prompt('before the restart', sec(-60)));
    // Records with usage set this; sidechain records after it are Sub-agents'.
    o.agent().sawMainChainUsage = true;
    const subTool = { type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'ls' } };
    const subFailure = { type: 'tool_result', tool_use_id: 'toolu_sub', is_error: true };

    o.append(
      prompt('go', sec(1)) +
        toolUse('toolu_task', 'Task', { description: 'probe', prompt: 'x' }, sec(2)) +
        progress('toolu_task', 'assistant', subTool, sec(3)) +
        progress('toolu_task', 'user', subFailure, sec(4)) +
        toolResult('toolu_task', sec(5)) +
        toolUse('toolu_side', 'Grep', { pattern: 'x' }, sec(6), { isSidechain: true }) +
        toolResult('toolu_side', sec(7), false, { isSidechain: true }),
    );
    o.append(prompt('and?', sec(8)) + reply('nothing else', sec(9)));
    clock = sec(20);
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);

    expect(o.events.map(brief)).toEqual([
      '1 interactionStart',
      '1 toolStart Task',
      '1 toolStart Bash (sub-agent)',
      '1 toolFailure toolu_sub (sub-agent)',
      '1 toolStart Grep (sub-agent)',
      '1 interactionStart',
      '1 interactionEnd',
    ]);
    expect(o.events.at(-1)).toEqual({
      kind: 'interactionEnd',
      agentId: 1,
      providerId: 'claude',
      projectDir: dir,
      at: sec(20),
      recordedAt: sec(9),
    });
  });

  describe.each(['array', 'string'] as const)(
    'Claude transcript: a text-only record (%s content) that goes quiet',
    (content) => {
      const text = (ms: number, extra: Record<string, unknown> = {}) =>
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: content === 'array' ? [{ type: 'text', text: 'hmm' }] : 'hmm',
          },
          timestamp: iso(ms),
          ...extra,
        });

      function quietAfter(record: string) {
        const o = restoreClaude(claudeProvider, prompt('before the restart', sec(-60)));
        // Records with usage set this; sidechain records after it are Sub-agents'.
        o.agent().sawMainChainUsage = true;
        // Every tool of the turn is done, so a text-only record arms the text-idle timer.
        o.append(
          prompt('go', sec(1)) +
            toolUse('toolu_grep', 'Grep', { pattern: 'x' }, sec(2)) +
            toolResult('toolu_grep', sec(3)) +
            record,
        );
        clock = sec(20);
        vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);
        return o;
      }

      it("ends the lead's interaction when the record is the lead's", () => {
        const o = quietAfter(text(sec(4)));

        expect(o.events.map(brief)).toEqual([
          '1 interactionStart',
          '1 toolStart Grep',
          '1 interactionEnd',
        ]);
        expect(o.events.at(-1)).toMatchObject({ at: sec(20), recordedAt: sec(4) });
      });

      // Regression: it ended the lead's interaction mid-turn, so the lead's next
      // tool opened a second one and Marathon counted the turn twice.
      it("leaves it open when the record is a Sub-agent's", () => {
        const o = quietAfter(text(sec(4), { isSidechain: true }));

        expect(o.events.map(brief)).toEqual(['1 interactionStart', '1 toolStart Grep']);
      });
    },
  );

  it('Copilot hooks: a prompt starts an interaction, and agentStop settles it Done', () => {
    const o = restoreCopilot(
      copilot('session.start', { selectedModel: 'gpt-5' }, sec(-60)) +
        copilot('user.message', { content: 'hi' }, sec(-59)) +
        copilot('assistant.turn_start', { turnId: 't0' }, sec(-58)) +
        copilot('assistant.turn_end', { turnId: 't0' }, sec(-57)) +
        copilot('session.idle', {}, sec(-56)),
    );
    expect(o.events).toEqual([]);

    o.hook({ hookType: 'userPromptSubmitted', timestamp: iso(sec(1)) });
    clock = sec(9);
    o.hook({ hookType: 'agentStop', timestamp: iso(sec(8)) });

    const common = { agentId: 1, providerId: 'copilot', projectDir: o.agent().projectDir };
    expect(o.events).toStrictEqual([
      { kind: 'interactionStart', ...common, at: T0, recordedAt: sec(1) },
      { kind: 'interactionEnd', ...common, at: sec(9), recordedAt: sec(8) },
    ]);
  });
});
