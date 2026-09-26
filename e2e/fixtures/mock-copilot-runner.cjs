#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const home = process.env.PIXEL_AGENTS_MOCK_HOME;
if (
  !home ||
  process.env.HOME !== home ||
  process.env.USERPROFILE !== home ||
  process.env.COPILOT_HOME !== path.join(home, '.copilot')
) {
  throw new Error('mock-copilot requires explicitly isolated HOME, USERPROFILE and COPILOT_HOME');
}
const sessionId = process.argv[process.argv.indexOf('--session-id') + 1];
if (!process.argv.includes('--session-id') || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
  throw new Error('mock-copilot requires a safe --session-id');
}
const sessionDir = path.join(process.env.COPILOT_HOME, 'session-state', sessionId);
const repository = process.argv.includes('--repository')
  ? process.argv[process.argv.indexOf('--repository') + 1]
  : undefined;
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(
  path.join(sessionDir, 'workspace.yaml'),
  `id: ${sessionId}\ncwd: ${process.cwd()}\n${repository ? `repository: ${JSON.stringify(repository)}\n` : ''}`,
  { flag: 'wx' },
);

let parentId = null;
let lastTimestamp = 0;
function append(record) {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  const event = {
    id: randomUUID(),
    timestamp: new Date(lastTimestamp).toISOString(),
    parentId,
    ...record,
  };
  fs.appendFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  parentId = event.id;
}
append({
  type: 'session.start',
  data: { sessionId, version: 1, context: { cwd: process.cwd() } },
});

async function emitHook(hookType, input) {
  const configPath = path.join(process.env.COPILOT_HOME, 'hooks', 'pixel-agents.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const commands = config.hooks?.[hookType];
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error(`No installed Copilot hook for ${hookType}`);
  }
  for (const command of commands) {
    const shellCommand = process.platform === 'win32' ? command.powershell : command.bash;
    const executable =
      typeof command.exec === 'string'
        ? command.exec
        : process.platform === 'win32'
          ? 'powershell.exe'
          : 'bash';
    const args =
      typeof command.exec === 'string' && Array.isArray(command.args)
        ? command.args
        : typeof shellCommand === 'string'
          ? process.platform === 'win32'
            ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', shellCommand]
            : ['-c', shellCommand]
          : undefined;
    if (command.type !== 'command' || !args) {
      throw new Error(`Unsupported installed Copilot command for ${hookType}`);
    }
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Installed Copilot bridge timed out'));
      }, 10_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Copilot bridge exited ${code}: ${stderr}`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ sessionId, cwd: process.cwd(), ...input }));
    });
  }
}

const input = readline.createInterface({ input: process.stdin });
let work = Promise.resolve();
input.on('line', (line) => {
  work = work
    .then(async () => {
      const request = JSON.parse(line);
      try {
        for (const action of request.actions) {
          if (action.kind === 'append') append(action.record);
          else if (action.kind === 'hook') await emitHook(action.hookType, action.input);
          else throw new Error(`Unknown scenario action: ${action.kind}`);
        }
        process.stdout.write(`${JSON.stringify({ id: request.id, ok: true })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: request.id, error: error.message })}\n`);
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      input.close();
    });
});
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
