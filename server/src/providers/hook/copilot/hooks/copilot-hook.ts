import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  HOOK_API_PREFIX,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVERS_DIR,
} from '../../../../constants.js';
import type { ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';
import {
  COPILOT_HOOK_DEADLINE_MS,
  COPILOT_HOOK_EVENTS,
  COPILOT_HOOK_HTTP_TIMEOUT_MS,
  COPILOT_HOOK_MAX_DISCOVERY_BYTES,
  COPILOT_HOOK_MAX_FIELD_LENGTH,
  COPILOT_HOOK_MAX_INPUT_BYTES,
  COPILOT_HOOK_MAX_PAYLOAD_BYTES,
  COPILOT_HOOK_MAX_TARGETS,
  COPILOT_NOTIFICATION_TYPES,
} from '../constants.js';

// No output, decisions or diagnostics: even a preToolUse hook must always exit successfully.
const finish = (): never => process.exit(0);
setTimeout(finish, COPILOT_HOOK_DEADLINE_MS);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitize(event: string, input: unknown): Record<string, unknown> | undefined {
  if (!record(input)) return undefined;
  const stringField = (
    key: string,
    source: Record<string, unknown> = input,
  ): string | undefined => {
    const value = source[key];
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= COPILOT_HOOK_MAX_FIELD_LENGTH &&
      !/[\u0000-\u001f]/.test(value)
      ? value
      : undefined;
  };
  const sessionId = stringField('sessionId');
  if (!sessionId) return undefined;
  const result: Record<string, unknown> = { hookType: event, sessionId };
  const fields = ['cwd'];
  if (
    event === 'sessionStart' &&
    ['startup', 'resume', 'new'].includes(stringField('source') ?? '')
  ) {
    fields.push('source');
  }
  if (event === 'agentStop') {
    fields.push('transcriptPath');
    if (input.stopReason === 'end_turn') fields.push('stopReason');
  }
  if (
    event === 'notification' &&
    COPILOT_NOTIFICATION_TYPES.some((type) => type === input.notification_type)
  ) {
    fields.push('notification_type');
  }
  for (const key of fields) {
    const value = stringField(key);
    if (value !== undefined) result[key] = value;
  }
  if (Number.isSafeInteger(input.timestamp) && (input.timestamp as number) >= 0) {
    result.timestamp = input.timestamp;
  }
  if (event === 'agentStop' && typeof input.stop_hook_active === 'boolean') {
    result.stop_hook_active = input.stop_hook_active;
  }
  return result;
}

function readJson(file: string): unknown {
  const initialStat = fs.lstatSync(file);
  if (!initialStat.isFile() || initialStat.size > COPILOT_HOOK_MAX_DISCOVERY_BYTES)
    return undefined;
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > COPILOT_HOOK_MAX_DISCOVERY_BYTES) return undefined;
    const buffer = Buffer.alloc(COPILOT_HOOK_MAX_DISCOVERY_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > COPILOT_HOOK_MAX_DISCOVERY_BYTES) return undefined;
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

function targets(): ServerTarget[] {
  const home = path.join(os.homedir(), SERVER_JSON_DIR);
  const servers: ServerTarget[] = [];
  try {
    const directory = fs.opendirSync(path.join(home, SERVERS_DIR));
    try {
      let examined = 0;
      let entry: fs.Dirent | null;
      while (examined++ < COPILOT_HOOK_MAX_TARGETS && (entry = directory.readSync())) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const server = readJson(path.join(home, SERVERS_DIR, entry.name));
          if (!isServerConfig(server)) continue;
          process.kill(server.pid, 0);
          if (
            !servers.some((other) => other.port === server.port && other.token === server.token)
          ) {
            servers.push(server);
          }
        } catch {
          /* A broken registry entry never prevents other deliveries. */
        }
      }
    } finally {
      directory.closeSync();
    }
  } catch {
    /* Older servers only have server.json. */
  }
  if (servers.length === 0) {
    try {
      const legacy = readJson(path.join(home, SERVER_JSON_NAME));
      if (isServerTarget(legacy)) servers.push(legacy);
    } catch {
      /* No server is a normal condition. */
    }
  }
  return servers;
}

function post(server: ServerTarget, body: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/copilot`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: COPILOT_HOOK_HTTP_TIMEOUT_MS,
        },
        (response) => {
          response.destroy();
          request.destroy();
          resolve();
        },
      );
      request.on('error', () => resolve());
      request.on('timeout', () => {
        request.destroy();
        resolve();
      });
      request.end(body);
    } catch {
      resolve();
    }
  });
}

async function main(): Promise<void> {
  const event = process.argv[2];
  if (!COPILOT_HOOK_EVENTS.some((supported) => supported === event)) return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > COPILOT_HOOK_MAX_INPUT_BYTES) return;
    chunks.push(bytes);
  }
  const data = sanitize(event, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
  if (!data) return;
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > COPILOT_HOOK_MAX_PAYLOAD_BYTES) return;
  await Promise.all(targets().map((server) => post(server, body)));
}

main()
  .catch(() => {})
  .finally(finish);
