import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  applyCopilotRecovery,
  readCopilotRecovery,
  recoverCopilotTranscript,
} from '../src/providers/hook/copilot/recovery.js';
import type { AgentState } from '../src/types.js';

const fixtureDir = path.resolve('.copilot-recovery-test', `${process.pid}`);
const fixture = path.join(fixtureDir, 'events.jsonl');
const line = (type: string, data = {}): string => JSON.stringify({ type, data }) + '\n';

describe('bounded read-only Copilot recovery', () => {
  beforeEach(() => mkdirSync(fixtureDir, { recursive: true }));
  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  function apply(): { activity: string; agent: AgentState; emit: ReturnType<typeof vi.fn> } {
    const agent: AgentState = {
      id: 1,
      sessionId: 'session',
      providerId: 'copilot',
      isExternal: true,
      projectDir: fixtureDir,
      jsonlFile: fixture,
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
      maxContextTokens: 0,
    };
    const store = new AgentStateStore();
    store.set(1, agent);
    const emit = vi.fn();
    store.on('broadcast', emit);
    const activity = applyCopilotRecovery(
      readCopilotRecovery(fixture, { maxRecords: 2 }),
      1,
      agent,
      store,
      new Map(),
      new Map(),
    );
    return { activity, agent, emit };
  }

  it('retains a partial final line and exact byte offset without modifying the file', () => {
    const content = line('assistant.turn_start', { turnId: 't' }) + '{"type":"tool.';
    writeFileSync(fixture, content);
    const snapshot = readCopilotRecovery(fixture);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.lineBuffer).toBe('{"type":"tool.');
    expect(snapshot.fileOffset).toBe(Buffer.byteLength(content));
    expect(readFileSync(fixture, 'utf8')).toBe(content);
  });

  it('bounds both bytes and records and discards the partial leading line', () => {
    writeFileSync(
      fixture,
      line('session.start') + line('assistant.turn_start') + line('session.idle'),
    );
    expect(readCopilotRecovery(fixture, { maxRecords: 1 }).records).toHaveLength(1);
    const snapshot = readCopilotRecovery(fixture, { maxBytes: 45 });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.records).toEqual([{ type: 'session.idle', data: {} }]);
  });

  it('does not parse the future suffix of an oversized partial line as a new event', () => {
    writeFileSync(fixture, '{"padding":"' + 'x'.repeat(500));
    const snapshot = readCopilotRecovery(fixture, { maxBytes: 40 });
    expect(snapshot.complete).toBe(false);
    expect(snapshot.lineBuffer).toBe('\0');
    expect(() => JSON.parse(snapshot.lineBuffer + '{"type":"session.idle","data":{}}')).toThrow();
  });

  it('marks a truncated suffix unknown even when it contains an unmatched tool completion', () => {
    writeFileSync(
      fixture,
      line('session.start') +
        line('tool.execution_complete', { toolCallId: 't' }) +
        line('assistant.turn_end', { turnId: 'turn' }),
    );
    const result = apply();
    expect(result.activity).toBe('unknown');
    expect(result.agent.observation).toBe('unknown');
    expect(result.emit).not.toHaveBeenCalled();
  });

  it('uses an aggregate idle checkpoint to establish a bounded suffix silently', () => {
    writeFileSync(
      fixture,
      line('session.start') +
        line('session.idle') +
        line('tool.execution_start', { toolCallId: 'q', toolName: 'ask_user' }),
    );
    const result = apply();
    expect(result.activity).toBe('input');
    expect(result.agent.activeToolIds.has('q')).toBe(true);
    expect(result.emit).not.toHaveBeenCalled();
  });

  it('recovers observed interaction completion silently only with sufficient preceding history', () => {
    writeFileSync(
      fixture,
      line('assistant.turn_end', { turnId: 'step' }) +
        line('hook.start', { hookType: 'agentStop' }),
    );
    const complete = apply();
    expect(complete.activity).toBe('done');
    expect(complete.emit).not.toHaveBeenCalled();
    writeFileSync(
      fixture,
      line('session.start') +
        line('assistant.turn_end', { turnId: 'step' }) +
        line('hook.start', { hookType: 'agentStop' }),
    );
    expect(apply().activity).toBe('unknown');
  });

  it('returns unavailable on missing files, not fake idle', () => {
    expect(readCopilotRecovery(fixture)).toMatchObject({
      available: false,
      complete: false,
      records: [],
    });
    expect(apply().activity).toBe('unknown');
  });

  it('treats malformed lines as incomplete evidence without throwing', () => {
    writeFileSync(fixture, '{bad json}\n' + line('assistant.turn_start'));
    expect(readCopilotRecovery(fixture).complete).toBe(false);
    expect(apply().activity).toBe('unknown');
  });

  it('does not trust an idle checkpoint followed by an unreadable event', () => {
    writeFileSync(fixture, line('session.idle') + '{bad json}\n');
    expect(apply().activity).toBe('unknown');
    writeFileSync(fixture, '{bad json}\n' + line('session.idle'));
    expect(apply().activity).toBe('done');
  });

  it('implements the provider snapshot seam without notification or synthetic occupancy', () => {
    expect(recoverCopilotTranscript([line('assistant.turn_start', { turnId: 't' })], true)).toEqual(
      { observation: 'known', status: 'active' },
    );
    expect(
      recoverCopilotTranscript(
        [line('tool.execution_start', { toolCallId: 'q', toolName: 'ask_user' })],
        true,
      ),
    ).toEqual({ observation: 'known', status: 'waiting' });
    expect(recoverCopilotTranscript([line('hook.start', { hookType: 'agentStop' })], true)).toEqual(
      { observation: 'known', status: 'idle' },
    );
    expect(
      recoverCopilotTranscript([line('hook.start', { hookType: 'agentStop' })], false),
    ).toEqual({ observation: 'unknown' });
    expect(
      recoverCopilotTranscript(
        [line('permission.requested', { requestId: 'p', permissionRequest: {} })],
        true,
      ),
    ).toEqual({ observation: 'unknown' });
  });

  it('passes exact occupancy through the provider snapshot independently of activity evidence', () => {
    expect(
      recoverCopilotTranscript(
        [line('session.usage_info', { currentTokens: 123, tokenLimit: 456 })],
        false,
      ),
    ).toEqual({ observation: 'unknown', contextTokens: 123, maxContextTokens: 456 });
    expect(
      recoverCopilotTranscript(
        [line('session.usage_checkpoint', { totalNanoAiu: 123, totalPremiumRequests: 456 })],
        true,
      ),
    ).toEqual({ observation: 'unknown' });
  });
});
