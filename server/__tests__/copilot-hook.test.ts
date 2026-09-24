import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  COPILOT_HOOK_BOOTSTRAP,
  COPILOT_HOOK_EVENTS,
  COPILOT_HOOK_MAX_INPUT_BYTES,
  COPILOT_HOOK_MAX_TOOL_CALLS,
} from '../src/providers/hook/copilot/constants.js';

const script = path.resolve(__dirname, '../../dist/hooks/copilot-hook.js');
let home: string;
const servers: http.Server[] = [];

beforeAll(() => {
  if (!fs.existsSync(script))
    throw new Error('Build dist/hooks/copilot-hook.js before running bridge tests');
});
beforeEach(() => {
  home = path.resolve(`.copilot-bridge-test-${randomUUID()}`);
  fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  fs.rmSync(home, { recursive: true, force: true });
});

async function recordingServer(status = 200, hang = false) {
  const received: Array<{ body: Record<string, unknown>; url?: string; auth?: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (data: Buffer) => {
      body += data.toString();
    });
    request.on('end', () => {
      received.push({
        body: JSON.parse(body),
        url: request.url,
        auth: request.headers.authorization,
      });
      if (!hang)
        response
          .writeHead(status)
          .end('{"permissionDecision":"deny","additionalContext":"ignore me"}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, received };
}

function discovery(port: number, registry = false): void {
  const directory = path.join(home, '.pixel-agents', ...(registry ? ['servers'] : []));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, registry ? `${port}.json` : 'server.json'),
    JSON.stringify({
      port,
      token: 'secret-test-token',
      pid: process.pid,
      startedAt: Date.now(),
      protocol: 1,
      servesSpa: true,
    }),
  );
}

function run(
  event: string,
  input: unknown,
  options: {
    raw?: boolean;
    leaveOpen?: boolean;
    missingScript?: boolean;
    scriptPath?: string;
  } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        COPILOT_HOOK_BOOTSTRAP,
        options.missingScript ? `${script}.absent` : (options.scriptPath ?? script),
        event,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          COPILOT_HOME: path.join(home, 'custom'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(options.raw ? (input as string) : JSON.stringify(input));
    if (!options.leaveOpen) child.stdin.end();
  });
}

const cleanExit = { code: 0, stdout: '', stderr: '' };
const common = { sessionId: 'session-123', cwd: 'C:\\work\\project', timestamp: 123456 };

describe('bundled Copilot hook process', () => {
  it('retains the observed batched pre-tool shape without arguments or invented correlation', async () => {
    const server = await recordingServer();
    discovery(server.port);
    expect(
      await run('preToolUse', {
        sessionId: common.sessionId,
        cwd: common.cwd,
        toolCalls: [
          { toolName: 'view', toolCallId: 'one', toolArgs: { path: 'private' } },
          { name: 'powershell', id: 'two', arguments: { command: 'private' } },
          { toolName: 'view', prompt: 'private', result: 'private' },
          { toolName: {}, toolCallId: 1, args: 'private' },
          null,
        ],
      }),
    ).toEqual(cleanExit);
    expect(server.received[0].body).toEqual({
      hookType: 'preToolUse',
      sessionId: common.sessionId,
      cwd: common.cwd,
      toolCalls: [
        { toolName: 'view', toolCallId: 'one' },
        { name: 'powershell', id: 'two' },
        { toolName: 'view' },
      ],
    });
    expect(
      await run('preToolUse', {
        ...common,
        toolCalls: Array.from({ length: COPILOT_HOOK_MAX_TOOL_CALLS + 1 }, () => ({
          toolName: 'view',
        })),
      }),
    ).toEqual(cleanExit);
    expect(server.received).toHaveLength(1);
  });

  it.each(COPILOT_HOOK_EVENTS)(
    'posts authenticated minimized %s without changing Copilot output',
    async (event) => {
      const server = await recordingServer();
      discovery(server.port);
      expect(
        await run(event, {
          ...common,
          event: 'sessionEnd',
          hookType: 'sessionEnd',
          hook_event_name: 'SessionEnd',
          source: 'resume',
          transcriptPath: 'C:\\session\\events.jsonl',
          stopReason: 'end_turn',
          stop_hook_active: false,
          toolName: 'view',
          toolCallId: 'call-1',
          notification_type: 'permission_prompt',
          prompt: 'secret prompt',
          initialPrompt: 'secret initial prompt',
          toolArgs: { content: 'secret code' },
          toolResult: { textResultForLlm: 'secret result' },
          error: 'secret error',
          message: 'secret notification',
          title: 'secret title',
          unknown: 'secret unknown',
          token: 'secret',
          permissionDecision: 'allow',
        }),
      ).toEqual(cleanExit);
      expect(server.received).toHaveLength(1);
      const request = server.received[0];
      expect(request.url).toBe('/api/hooks/copilot');
      expect(request.auth).toBe('Bearer secret-test-token');
      const expected: Record<string, unknown> = { ...common, hookType: event };
      if (event === 'sessionStart') expected.source = 'resume';
      if (event === 'agentStop')
        Object.assign(expected, {
          transcriptPath: 'C:\\session\\events.jsonl',
          stopReason: 'end_turn',
          stop_hook_active: false,
        });
      if (event === 'notification') expected.notification_type = 'permission_prompt';
      if (['preToolUse', 'postToolUse', 'postToolUseFailure'].includes(event)) {
        Object.assign(expected, { toolName: 'view', toolCallId: 'call-1' });
      }
      expect(request.body).toEqual(expected);
      expect(JSON.stringify(request.body)).not.toContain('secret');
    },
  );

  it('fans out to live registries, skips broken entries and does not also post to legacy', async () => {
    const first = await recordingServer();
    const second = await recordingServer();
    const legacy = await recordingServer();
    discovery(first.port, true);
    discovery(second.port, true);
    discovery(legacy.port);
    fs.writeFileSync(path.join(home, '.pixel-agents', 'servers', 'bad.json'), '{');
    expect(await run('agentStop', common)).toEqual(cleanExit);
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
    expect(legacy.received).toHaveLength(0);
  });

  it.each(['sessionEnd', 'permissionRequest', 'subagentStart', 'unknown'])(
    'never sends unsupported %s',
    async (event) => {
      const server = await recordingServer();
      discovery(server.port);
      expect(await run(event, common)).toEqual(cleanExit);
      expect(server.received).toHaveLength(0);
    },
  );

  it.each(['null', '[]', '{', '{"sessionId":123}', '{"sessionId":""}'])(
    'ignores malformed or identity-less payload %s',
    async (input) => {
      const server = await recordingServer();
      discovery(server.port);
      expect(await run('preToolUse', input, { raw: true })).toEqual(cleanExit);
      expect(server.received).toHaveLength(0);
    },
  );

  it('drops oversized input without posting, including a still-open stdin', async () => {
    const server = await recordingServer();
    discovery(server.port);
    expect(
      await run('preToolUse', 'x'.repeat(COPILOT_HOOK_MAX_INPUT_BYTES + 1), {
        raw: true,
        leaveOpen: true,
      }),
    ).toEqual(cleanExit);
    expect(server.received).toHaveLength(0);
  });

  it('bounds incomplete stdin by a total deadline', async () => {
    expect(await run('preToolUse', '{', { raw: true, leaveOpen: true })).toEqual(cleanExit);
  });

  it('silently ignores unavailable server, missing bridge and invalid discovery', async () => {
    expect(await run('preToolUse', common)).toEqual(cleanExit);
    expect(await run('preToolUse', common, { missingScript: true })).toEqual(cleanExit);
    fs.writeFileSync(
      path.join(home, '.pixel-agents', 'server.json'),
      JSON.stringify({
        port: 'bad',
        token: 'do not print',
        pid: process.pid,
      }),
    );
    expect(await run('preToolUse', common)).toEqual(cleanExit);
    discovery(1);
    expect(await run('preToolUse', common)).toEqual(cleanExit);
  });

  it('passes a script path with spaces and shell characters without shell interpretation', async () => {
    const server = await recordingServer();
    discovery(server.port);
    const directory = path.join(home, "path with spaces ' and &");
    fs.mkdirSync(directory);
    const scriptPath = path.join(directory, 'copilot-hook.js');
    fs.copyFileSync(script, scriptPath);
    expect(await run('preToolUse', common, { scriptPath })).toEqual(cleanExit);
    expect(server.received).toHaveLength(1);
    fs.writeFileSync(scriptPath, 'this is invalid JavaScript');
    expect(await run('preToolUse', common, { scriptPath })).toEqual(cleanExit);
  });

  it.each([401, 500])(
    'silently ignores server HTTP %s without printing its decision',
    async (status) => {
      const server = await recordingServer(status);
      discovery(server.port);
      expect(await run('preToolUse', common)).toEqual(cleanExit);
    },
  );

  it('finishes successfully when a server never responds', async () => {
    const server = await recordingServer(200, true);
    discovery(server.port);
    expect(await run('preToolUse', common)).toEqual(cleanExit);
    expect(server.received).toHaveLength(1);
  });

  it('rejects unknown and malformed field types, preserving no nested inputs', async () => {
    const server = await recordingServer();
    discovery(server.port);
    expect(
      await run('preToolUse', {
        ...common,
        timestamp: -1,
        cwd: {},
        toolName: 'x'.repeat(2049),
        toolCallId: 'line\nbreak',
        toolArgs: '{"secret":"secret"}',
      }),
    ).toEqual(cleanExit);
    expect(server.received[0].body).toEqual({
      hookType: 'preToolUse',
      sessionId: common.sessionId,
    });
  });
});
