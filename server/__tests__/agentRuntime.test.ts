import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

/**
 * Tool-failure seam: a turn's failed tool reaches the store before the turn
 * end that concludes it. In hooks mode the Stop hook ends the turn while the
 * transcript still holds the spawn tool's done (deferred TOOL_DONE_DELAY_MS);
 * the runtime must hand its handler the flush of ITS OWN parser, or the flush
 * reaches the module-level facade and misses.
 */
describe('AgentRuntime -- tool-failure ordering', () => {
  let dir: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tool-failure-'));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the Stop hook reports a failed spawn tool before the turn's end", () => {
    const sessionId = crypto.randomUUID();
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '');
    const persisted: PersistedAgent = {
      id: 1,
      providerId: 'claude',
      sessionId,
      terminalName: '',
      isExternal: true,
      projectDir: dir,
      jsonlFile: file,
    };
    const store = new AgentStateStore();
    store.setAdapter({
      loadAgents: () => [persisted],
      saveAgents: () => {},
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, fallback: T) => fallback,
      setSetting: () => {},
    });
    const messages: Array<Record<string, unknown>> = [];
    store.on('broadcast', (message) => messages.push(message));
    const current = new AgentRuntime(store, claudeProvider);
    runtime = current;
    current.restoreExternalAgents();
    current.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      transcript_path: file,
      cwd: dir,
      source: 'resume',
    });
    expect(store.get(1)?.hookDelivered).toBe(true);

    const records = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { prompt: 'x' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_task', is_error: true, content: 'failed' },
          ],
        },
      },
    ];
    fs.appendFileSync(file, records.map((record) => JSON.stringify(record) + '\n').join(''));
    current
      .getFileWatcher('claude')
      .readNewLines(1, store, current.waitingTimers, current.permissionTimers);
    messages.length = 0;

    current.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });

    const order = messages.flatMap((m) => {
      if (m.type === 'agentToolDone') return [m.isError === true ? 'agentToolDone:error' : m.type];
      if (m.type === 'agentToolsClear') return [m.type];
      if (m.type === 'agentStatus') return [`agentStatus:${m.status as string}`];
      return [];
    });
    expect(order).toEqual(['agentToolDone:error', 'agentToolsClear', 'agentStatus:waiting']);
  });
});
