import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider, TokenUsageSample } from '../../core/src/provider.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  TOKEN_USAGE_BROADCAST_INTERVAL_MS,
  TOKEN_USAGE_SEED_MAX_BYTES,
  TOKEN_USAGE_SEED_TAIL_BYTES,
} from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { extractClaudeTokenUsage } from '../src/providers/hook/claude/tokenUsage.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import { extractCopilotTokenUsage } from '../src/providers/hook/copilot/tokenUsage.js';
import {
  type LiveTokenUsage,
  readTokenUsageHistory,
  type TokenUsageHistory,
  TokenUsageTracker,
} from '../src/tokenUsage.js';

type Message = Record<string, unknown>;
type Amounts = Pick<
  TokenUsageSample,
  'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'
>;

const MODEL = 'claude-opus-5';

/** Claude's usage block, in the order Claude Code writes it. */
function usage(input: number, cacheWrite: number, cacheRead: number, output: number) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
  };
}

/** One Claude transcript record. Claude writes one per content block, each
 *  repeating its message's usage. */
function assistant(id: string, tokens: ReturnType<typeof usage>): string {
  return (
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        id,
        model: MODEL,
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: tokens,
      },
    }) + '\n'
  );
}

const userPrompt =
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';

/** One persisted Copilot session event. */
function copilot(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, id: randomUUID() }) + '\n';
}

/** Transcript lines that carry no usage for either provider. */
const FILLER_LINE = JSON.stringify({ type: 'filler', data: { text: 'x'.repeat(1_000) } }) + '\n';
const filler = (bytes: number) => FILLER_LINE.repeat(Math.ceil(bytes / FILLER_LINE.length));

const reply = (messageId: string, amounts: Amounts): TokenUsageSample => ({
  kind: 'delta',
  messageId,
  model: MODEL,
  ...amounts,
});

const checkpoint = (
  premiumRequests: number,
  nanoAiu: number,
  tokens: Amounts = {},
): TokenUsageSample => ({ kind: 'total', premiumRequests, nanoAiu, ...tokens });

function tracked() {
  const sent: Message[] = [];
  const live: LiveTokenUsage[] = [];
  const tracker = new TokenUsageTracker(
    (message) => sent.push(message),
    TOKEN_USAGE_BROADCAST_INTERVAL_MS,
  );
  tracker.onLiveUsage((usage) => live.push(usage));
  return { tracker, sent, live };
}

describe('TokenUsageTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts a message once, however many content-block records repeat its usage', () => {
    const { tracker, sent } = tracked();
    const first = reply('msg_1', {
      inputTokens: 3,
      outputTokens: 20,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 1_000,
    });
    tracker.observe(1, first);
    tracker.observe(1, first);
    tracker.observe(1, first);
    tracker.observe(
      1,
      reply('msg_2', {
        inputTokens: 5,
        outputTokens: 30,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1_100,
      }),
    );
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);

    const expected = {
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      inputTokens: 8,
      outputTokens: 50,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 2_100,
    };
    expect(tracker.snapshot(1)).toEqual(expected);
    expect(sent.at(-1)).toEqual(expected);
  });

  it('adds only the growth when a repeated record reports more for its message', () => {
    const { tracker, live } = tracked();
    tracker.observe(1, reply('msg_1', { inputTokens: 3, outputTokens: 10 }));
    tracker.observe(1, reply('msg_1', { inputTokens: 3, outputTokens: 40 }));
    tracker.observe(1, reply('msg_1', { inputTokens: 3, outputTokens: 25 }));

    expect(tracker.snapshot(1)).toMatchObject({ inputTokens: 3, outputTokens: 40 });
    expect(live.map((usage) => usage.delta)).toEqual([
      { inputTokens: 3, outputTokens: 10 },
      { outputTokens: 30 },
    ]);
  });

  it('sends the first change at once, then at most one message per interval', () => {
    const { tracker, sent } = tracked();
    tracker.observe(1, reply('a', { outputTokens: 1 }));
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(100);
    tracker.observe(1, reply('b', { outputTokens: 2 }));
    vi.advanceTimersByTime(100);
    tracker.observe(1, reply('c', { outputTokens: 4 }));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS - 201);
    expect(sent).toHaveLength(1);

    // The trailing send carries the latest totals.
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ outputTokens: 7 });

    // Nothing changed, so nothing is sent.
    tracker.observe(1, reply('c', { outputTokens: 4 }));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS * 5);
    expect(sent).toHaveLength(2);

    // Once the interval has passed, a change goes out at once again.
    tracker.observe(1, reply('d', { outputTokens: 8 }));
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ outputTokens: 15 });
  });

  it('throttles each agent on its own', () => {
    const { tracker, sent } = tracked();
    tracker.observe(1, reply('a', { outputTokens: 1 }));
    tracker.observe(1, reply('b', { outputTokens: 1 }));
    tracker.observe(2, reply('c', { outputTokens: 1 }));
    expect(sent.map((message) => message.id)).toEqual([1, 2]);
  });

  it('drops a pending message when its agent is removed', () => {
    const { tracker, sent } = tracked();
    tracker.observe(1, reply('a', { outputTokens: 1 }));
    tracker.observe(1, reply('b', { outputTokens: 2 }));
    tracker.remove(1);
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);

    expect(sent).toHaveLength(1);
    expect(tracker.snapshot(1)).toBeUndefined();
  });

  it('replaces cumulative totals instead of adding them up', () => {
    const { tracker } = tracked();
    tracker.observe(1, checkpoint(1, 1_000));
    tracker.observe(1, checkpoint(2.5, 3_000));
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      premiumRequests: 2.5,
      nanoAiu: 3_000,
    });

    // A newer total without tokens drops the older, now stale, token counts.
    tracker.observe(1, checkpoint(3, 4_000, { inputTokens: 500, outputTokens: 50 }));
    tracker.observe(1, checkpoint(4, 5_000));
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      premiumRequests: 4,
      nanoAiu: 5_000,
    });
  });

  it('shows the model before any numbers arrive', () => {
    const { tracker, sent } = tracked();
    tracker.observe(1, { kind: 'delta', model: 'gpt-5' });
    expect(sent).toEqual([{ type: 'agentUsage', id: 1, model: 'gpt-5' }]);
  });

  it('seeds whole-session totals without reporting them as new usage', () => {
    const { tracker, sent, live } = tracked();
    const seen = reply('m1', { inputTokens: 5, outputTokens: 7 });
    const history: TokenUsageHistory = { samples: [seen, seen], primers: [], complete: true };
    tracker.seed(1, 'session.jsonl', history);

    expect(sent).toEqual([
      { type: 'agentUsage', id: 1, model: MODEL, inputTokens: 5, outputTokens: 7 },
    ]);
    expect(live).toEqual([]);
    expect(tracker.isTracking(1, 'session.jsonl')).toBe(true);
  });

  it('labels totals that could not be read back to the session start "since tracked"', () => {
    const { tracker, live } = tracked();
    // A transcript too large to scan: its tail only primes the model and message ids.
    const history: TokenUsageHistory = {
      samples: [],
      primers: [reply('m9', { inputTokens: 5 })],
      complete: false,
    };
    tracker.seed(1, 'session.jsonl', history);
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      sinceTracked: true,
    });

    tracker.observe(1, reply('m9', { inputTokens: 5 })); // spent before tracking began
    tracker.observe(1, reply('m10', { inputTokens: 4 }));
    expect(tracker.snapshot(1)).toMatchObject({ inputTokens: 4, sinceTracked: true });
    expect(live.map((usage) => usage.delta)).toEqual([{ inputTokens: 4 }]);
  });

  it('clears "since tracked" on a cumulative total, without reporting it as new usage', () => {
    const { tracker, live } = tracked();
    tracker.seed(1, 'events.jsonl', { samples: [], primers: [], complete: false });
    expect(tracker.snapshot(1)).toEqual({ type: 'agentUsage', id: 1, sinceTracked: true });

    tracker.observe(1, checkpoint(7, 70_000));
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      premiumRequests: 7,
      nanoAiu: 70_000,
    });
    // How much of it was spent before tracking began is unknown.
    expect(live).toEqual([]);

    tracker.observe(1, checkpoint(8, 75_000));
    expect(live.map((usage) => usage.delta)).toEqual([{ premiumRequests: 1, nanoAiu: 5_000 }]);
  });

  it('reports a first total in full only when no usage preceded tracking', () => {
    const fresh = tracked();
    fresh.tracker.seed(1, 'events.jsonl');
    fresh.tracker.observe(1, checkpoint(1, 10_000));
    fresh.tracker.observe(1, checkpoint(1, 10_000, { inputTokens: 900, outputTokens: 90 }));
    expect(fresh.live.map((usage) => usage.delta)).toEqual([
      { premiumRequests: 1, nanoAiu: 10_000 },
      { inputTokens: 900, outputTokens: 90 },
    ]);

    // A restored session: its tokens so far were never reported, so a shutdown's
    // session-wide tokens can't be split into old and new.
    const restored = tracked();
    restored.tracker.seed(1, 'events.jsonl', {
      samples: [checkpoint(1, 10_000)],
      primers: [],
      complete: true,
    });
    restored.tracker.observe(1, checkpoint(2, 15_000, { inputTokens: 900, outputTokens: 90 }));
    expect(restored.live.map((usage) => usage.delta)).toEqual([
      { premiumRequests: 1, nanoAiu: 5_000 },
    ]);
  });

  it('counts records re-read from before the live point without reporting them', () => {
    const { tracker, live } = tracked();
    // /clear onto a transcript that already holds 500 bytes, read from its start.
    tracker.seed(1, 'session.jsonl', undefined, 500);
    tracker.readingFrom(1, 0);
    tracker.observe(1, reply('old', { outputTokens: 6 }));
    tracker.readingFrom(1, 500);
    tracker.observe(1, reply('new', { outputTokens: 4 }));

    expect(tracker.snapshot(1)).toMatchObject({ outputTokens: 10 });
    expect(live).toEqual([{ id: 1, model: MODEL, delta: { outputTokens: 4 } }]);
  });

  it('starts over on reset with a message that clears the agent', () => {
    const { tracker, sent } = tracked();
    tracker.observe(1, reply('a', { outputTokens: 5 }));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    tracker.reset(1);

    expect(sent.at(-1)).toEqual({ type: 'agentUsage', id: 1 });
    expect(tracker.snapshot(1)).toBeUndefined();
  });
});

describe('readTokenUsageHistory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-token-history-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(text: string): string {
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, text);
    return file;
  }

  it('reads a small transcript whole, up to where the live reader resumes', () => {
    const first = assistant('msg_1', usage(3, 100, 1_000, 20));
    const text =
      first +
      first +
      userPrompt +
      assistant('msg_2', usage(5, 0, 1_100, 30)) +
      '{"type":"assistant","message":{"id":"msg_3"';
    const file = write(text);

    const history = readTokenUsageHistory(file, text.length, extractClaudeTokenUsage);
    expect(history.complete).toBe(true);
    expect(history.primers).toEqual([]);
    expect(history.samples.map((sample) => sample.messageId)).toEqual(['msg_1', 'msg_1', 'msg_2']);

    // A line cut by the live reader's offset belongs to the live reader.
    const cut = readTokenUsageHistory(file, first.length + 10, extractClaudeTokenUsage);
    expect(cut.samples).toHaveLength(1);
  });

  it('has nothing to seed before offset 0, and cannot seed a file it cannot read', () => {
    const file = write(assistant('msg_1', usage(1, 0, 0, 1)));
    expect(readTokenUsageHistory(file, 0, extractClaudeTokenUsage)).toEqual({
      samples: [],
      primers: [],
      complete: true,
    });
    const missing = path.join(dir, 'missing.jsonl');
    expect(readTokenUsageHistory(missing, 100, extractClaudeTokenUsage)).toEqual({
      samples: [],
      primers: [],
      complete: false,
    });
  });

  it('takes the newest cumulative total from the tail without scanning the rest', () => {
    const text =
      copilot('session.start', { selectedModel: 'claude-sonnet-4.5' }) +
      copilot('session.usage_checkpoint', { totalPremiumRequests: 1, totalNanoAiu: 10_000 }) +
      filler(TOKEN_USAGE_SEED_TAIL_BYTES) +
      copilot('assistant.message', { content: 'ok', model: 'gpt-5' }) +
      copilot('session.usage_checkpoint', { totalPremiumRequests: 4, totalNanoAiu: 40_000 }) +
      copilot('session.usage_checkpoint', { totalPremiumRequests: 5, totalNanoAiu: 52_000 });
    const file = write(text);

    const history = readTokenUsageHistory(file, text.length, extractCopilotTokenUsage);
    expect(history).toEqual({
      primers: [{ kind: 'delta', model: 'gpt-5' }],
      samples: [
        { kind: 'total', premiumRequests: 4, nanoAiu: 40_000 },
        { kind: 'total', premiumRequests: 5, nanoAiu: 52_000 },
      ],
      complete: false,
    });

    const { tracker } = tracked();
    tracker.seed(1, file, history);
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      model: 'gpt-5',
      premiumRequests: 5,
      nanoAiu: 52_000,
    });
  });

  it('scans the whole transcript when the tail holds no total and the file is small enough', () => {
    const text =
      assistant('msg_1', usage(3, 100, 1_000, 20)) +
      filler(TOKEN_USAGE_SEED_TAIL_BYTES) +
      assistant('msg_2', usage(5, 0, 1_100, 30));
    const file = write(text);

    const history = readTokenUsageHistory(file, text.length, extractClaudeTokenUsage);
    expect(history.complete).toBe(true);
    expect(history.samples.map((sample) => sample.messageId)).toEqual(['msg_1', 'msg_2']);
  });

  it('gives up on history past the scan limit, so the totals are "since tracked"', () => {
    const text =
      assistant('msg_1', usage(3, 100, 1_000, 20)) +
      filler(TOKEN_USAGE_SEED_MAX_BYTES) +
      assistant('msg_2', usage(5, 0, 1_100, 30));
    const file = write(text);

    const history = readTokenUsageHistory(file, text.length, extractClaudeTokenUsage);
    expect(history.complete).toBe(false);
    expect(history.samples).toEqual([]);
    expect(history.primers.map((sample) => sample.messageId)).toEqual(['msg_2']);

    const { tracker } = tracked();
    tracker.seed(1, file, history);
    expect(tracker.snapshot(1)).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      sinceTracked: true,
    });
  });
});

describe('extractClaudeTokenUsage', () => {
  it('reads the token counts, message id and model, sidechain records included', () => {
    expect(
      extractClaudeTokenUsage({
        type: 'assistant',
        isSidechain: true,
        message: { id: 'msg_1', model: MODEL, usage: usage(3, 120, 4_000, 0) },
      }),
    ).toEqual({
      kind: 'delta',
      messageId: 'msg_1',
      model: MODEL,
      inputTokens: 3,
      outputTokens: 0,
      cacheCreationInputTokens: 120,
      cacheReadInputTokens: 4_000,
    });
  });

  it('ignores records that carry no real usage', () => {
    for (const record of [
      null,
      'not a record',
      { type: 'user', message: { usage: usage(5, 0, 0, 0) } },
      { type: 'assistant', message: { id: 'msg_1' } },
      { type: 'assistant', message: { id: 'msg_1', usage: usage(0, 0, 0, 0) } },
      // API errors and interrupts: Claude Code's own records, not a model turn.
      { type: 'assistant', message: { model: '<synthetic>', usage: usage(5, 0, 0, 1) } },
    ]) {
      expect(extractClaudeTokenUsage(record)).toBeUndefined();
    }
  });

  it('keeps valid counts and drops values that are not token counts', () => {
    expect(
      extractClaudeTokenUsage({
        type: 'assistant',
        message: {
          id: 'msg_1',
          usage: {
            input_tokens: -1,
            output_tokens: 2.5,
            cache_creation_input_tokens: '7',
            cache_read_input_tokens: 9,
          },
        },
      }),
    ).toEqual({ kind: 'delta', messageId: 'msg_1', cacheReadInputTokens: 9 });
  });
});

describe('extractCopilotTokenUsage', () => {
  it('reads cumulative premium requests and nano AIU from a usage checkpoint', () => {
    expect(
      extractCopilotTokenUsage({
        type: 'session.usage_checkpoint',
        data: { totalPremiumRequests: 3, totalNanoAiu: 123_456 },
      }),
    ).toEqual({ kind: 'total', premiumRequests: 3, nanoAiu: 123_456 });
  });

  it('adds the session tokens and current model from a shutdown', () => {
    expect(
      extractCopilotTokenUsage({
        type: 'session.shutdown',
        data: {
          totalPremiumRequests: 4.5,
          totalNanoAiu: 200_000,
          currentModel: 'gpt-5',
          tokenDetails: {
            input: { tokenCount: 1_200 },
            output: { tokenCount: 300 },
            cache_read: { tokenCount: 5_000 },
            cache_write: { tokenCount: 0 },
          },
        },
      }),
    ).toEqual({
      kind: 'total',
      model: 'gpt-5',
      premiumRequests: 4.5,
      nanoAiu: 200_000,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 5_000,
    });
  });

  it('takes the model from session start, resume, model changes and replies', () => {
    const model = (type: string, data: Record<string, unknown>) =>
      extractCopilotTokenUsage({ type, data });
    expect(model('session.start', { selectedModel: 'claude-sonnet-4.5' })).toEqual({
      kind: 'delta',
      model: 'claude-sonnet-4.5',
    });
    expect(model('session.resume', { selectedModel: 'gpt-5' })).toEqual({
      kind: 'delta',
      model: 'gpt-5',
    });
    expect(model('session.model_change', { previousModel: 'gpt-5', newModel: 'gpt-5.1' })).toEqual({
      kind: 'delta',
      model: 'gpt-5.1',
    });
    expect(model('assistant.message', { content: 'ok', model: 'gpt-5.1' })).toEqual({
      kind: 'delta',
      model: 'gpt-5.1',
    });
  });

  it("ignores children's records and per-call usage that transcripts don't keep", () => {
    for (const record of [
      {
        type: 'session.usage_checkpoint',
        agentId: 'child',
        data: { totalPremiumRequests: 1, totalNanoAiu: 1 },
      },
      { type: 'assistant.message', agentId: 'child', data: { model: 'claude-haiku-4.5' } },
      // Per-call events: counted next to a shutdown's session totals they would count twice.
      { type: 'assistant.usage', data: { model: 'gpt-5', inputTokens: 5, outputTokens: 6 } },
      { type: 'session.usage_info', data: { currentTokens: 100, tokenLimit: 1_000 } },
      { type: 'session.usage_checkpoint', data: {} },
      { type: 'session.shutdown', data: {} },
    ]) {
      expect(extractCopilotTokenUsage(record)).toBeUndefined();
    }
  });
});

describe('Token usage through the runtime', () => {
  let dir: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-token-usage-'));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
    const store = new AgentStateStore();
    store.setAdapter(adapter);
    const messages: Message[] = [];
    store.on('broadcast', (message) => messages.push(message));
    const live: LiveTokenUsage[] = [];
    store.tokenUsage.onLiveUsage((usage) => live.push(usage));
    const current = new AgentRuntime(store, provider);
    runtime = current;
    current.restoreExternalAgents();

    const read = () =>
      current
        .getFileWatcher(provider.id)
        .readNewLines(persisted.id, store, current.waitingTimers, current.permissionTimers);
    const append = (text: string) => {
      fs.appendFileSync(store.get(persisted.id)!.jsonlFile, text);
      read();
    };
    const latestUsage = () =>
      messages
        .filter((message) => message.type === 'agentUsage' && message.id === persisted.id)
        .at(-1);
    return { store, runtime: current, live, read, append, latestUsage };
  }

  function claudeSession(history: string) {
    const sessionId = randomUUID();
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, history);
    const office = restore(claudeProvider, {
      id: 1,
      providerId: 'claude',
      sessionId,
      terminalName: '',
      isExternal: true,
      projectDir: dir,
      jsonlFile: file,
    });
    return { ...office, sessionId, file };
  }

  it('Claude, hooks off: seeds the whole session, then counts each new message once', () => {
    const msg1 = assistant('msg_1', usage(3, 100, 1_000, 20));
    const o = claudeSession(msg1 + msg1 + userPrompt + assistant('msg_2', usage(5, 0, 1_100, 30)));
    expect(o.store.get(1)!.hookDelivered).toBe(false);
    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      inputTokens: 8,
      outputTokens: 50,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 2_100,
    });
    expect(o.live).toEqual([]);

    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    const msg3 = assistant('msg_3', usage(2, 50, 2_200, 10));
    o.append(msg3 + msg3 + assistant('msg_3', usage(2, 50, 2_200, 40)));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);

    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      inputTokens: 10,
      outputTokens: 90,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 4_300,
    });
    expect(o.live).toEqual([
      {
        id: 1,
        model: MODEL,
        delta: {
          inputTokens: 2,
          outputTokens: 10,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 2_200,
        },
      },
      { id: 1, model: MODEL, delta: { outputTokens: 30 } },
    ]);

    // The webviewReady handshake replays the totals to a client that connects later.
    const replay: Message[] = [];
    resendAgentActivity((message) => replay.push(message), o.store);
    expect(replay).toContainEqual(o.latestUsage());
  });

  it('Claude, hooks on: the transcript still feeds the totals, and /clear starts them over', () => {
    const o = claudeSession(assistant('msg_1', usage(3, 100, 1_000, 20)));
    o.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: o.sessionId,
      transcript_path: o.file,
      cwd: dir,
      source: 'resume',
    });
    expect(o.store.get(1)!.hookDelivered).toBe(true);

    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    o.append(assistant('msg_2', usage(4, 0, 1_200, 15)));
    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      inputTokens: 7,
      outputTokens: 35,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 2_200,
    });

    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    const clearedSession = randomUUID();
    const cleared = path.join(dir, `${clearedSession}.jsonl`);
    fs.writeFileSync(cleared, '');
    o.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: o.sessionId,
      reason: 'clear',
    });
    o.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: clearedSession,
      transcript_path: cleared,
      cwd: dir,
      source: 'clear',
    });
    expect(o.store.get(1)!.jsonlFile).toBe(cleared);
    expect(o.latestUsage()).toEqual({ type: 'agentUsage', id: 1 });

    o.append(assistant('msg_9', usage(6, 300, 400, 12)));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    const fresh = {
      inputTokens: 6,
      outputTokens: 12,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
    };
    expect(o.latestUsage()).toEqual({ type: 'agentUsage', id: 1, model: MODEL, ...fresh });
    expect(o.live.at(-1)).toEqual({ id: 1, model: MODEL, delta: fresh });
  });

  it('Claude: a rewritten transcript is seeded again instead of adding to the old totals', () => {
    const msg1 = assistant('msg_1', usage(3, 100, 1_000, 20));
    const o = claudeSession(msg1 + assistant('msg_2', usage(5, 0, 1_100, 30)));
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);

    fs.writeFileSync(o.file, msg1);
    o.read();

    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: MODEL,
      inputTokens: 3,
      outputTokens: 20,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 1_000,
    });
    expect(o.live).toEqual([]);
  });

  it('Copilot: seeds the newest checkpoint, then follows new checkpoints and shutdown tokens', () => {
    const sessionId = randomUUID();
    const sessionDir = path.join(dir, sessionId);
    fs.mkdirSync(sessionDir);
    const file = path.join(sessionDir, 'events.jsonl');
    fs.writeFileSync(
      file,
      copilot('session.start', { sessionId, selectedModel: 'claude-sonnet-4.5' }) +
        copilot('user.message', { content: 'hi' }) +
        copilot('assistant.message', { content: 'hello', model: 'claude-sonnet-4.5' }) +
        copilot('session.usage_checkpoint', { totalPremiumRequests: 1, totalNanoAiu: 50_000 }) +
        copilot('session.idle', {}),
    );
    const o = restore(copilotProvider, {
      id: 1,
      providerId: 'copilot',
      sessionId,
      terminalName: '',
      isExternal: true,
      projectDir: sessionDir,
      jsonlFile: file,
    });
    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: 'claude-sonnet-4.5',
      premiumRequests: 1,
      nanoAiu: 50_000,
    });

    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    o.append(
      copilot('session.model_change', { previousModel: 'claude-sonnet-4.5', newModel: 'gpt-5' }) +
        copilot('session.usage_checkpoint', { totalPremiumRequests: 2, totalNanoAiu: 90_000 }),
    );
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: 'gpt-5',
      premiumRequests: 2,
      nanoAiu: 90_000,
    });

    o.append(
      copilot('session.shutdown', {
        totalPremiumRequests: 2,
        totalNanoAiu: 90_000,
        currentModel: 'gpt-5',
        tokenDetails: {
          input: { tokenCount: 1_200 },
          output: { tokenCount: 300 },
          cache_read: { tokenCount: 5_000 },
          cache_write: { tokenCount: 700 },
        },
      }),
    );
    vi.advanceTimersByTime(TOKEN_USAGE_BROADCAST_INTERVAL_MS);
    expect(o.latestUsage()).toEqual({
      type: 'agentUsage',
      id: 1,
      model: 'gpt-5',
      premiumRequests: 2,
      nanoAiu: 90_000,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheCreationInputTokens: 700,
      cacheReadInputTokens: 5_000,
    });

    // Only spend after the restore is new. The shutdown's session-wide tokens
    // include turns from before it, so they are not reported as new usage.
    expect(o.live).toEqual([
      { id: 1, model: 'gpt-5', delta: { premiumRequests: 1, nanoAiu: 40_000 } },
    ]);
  });
});
