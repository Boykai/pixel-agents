/**
 * HookProvider for GitHub Copilot CLI / the GitHub Copilot app.
 *
 * Unlike Claude Code, Copilot CLI has no documented hooks API: there is no way to
 * register a callback that POSTs tool/turn events to our server as they happen.
 * What it DOES have is a transcript on disk for every session — confirmed against
 * a live session while building this provider:
 *
 *   ~/.copilot/session-state/<session-id>/events.jsonl   (event log, one JSON object per line)
 *   ~/.copilot/session-state/<session-id>/workspace.yaml (has a `cwd:` line — the session's workspace)
 *
 * So this provider is file-fallback ONLY: normalizeHookEvent always returns null
 * (nothing ever POSTs to /api/hooks/copilot), and installHooks/uninstallHooks are
 * no-ops. areHooksInstalled() resolves true so the first-run consent gate never
 * asks about a provider that writes nothing to any settings file (see
 * consentGate.ts: `hooksConsentRequest` skips a provider whose hooks are already
 * "installed").
 *
 * Record shapes below (event.type / event.data.*) come directly from a real
 * events.jsonl, not from any published spec — Copilot's dotted event names
 * (`tool.execution_start`, `assistant.turn_end`, ...) never collide with
 * Claude's bare ones (`assistant`, `system`, ...), so transcriptParser.ts
 * branches on them safely alongside Claude's own parsing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { pathsMatch } from '../../../pathKey.js';

const COPILOT_TERMINAL_NAME_PREFIX = 'GitHub Copilot';
const SESSION_FILE_NAME = 'events.jsonl';

// ── formatToolStatus ──
// Copilot's built-in tool names observed in practice (this provider's own CLI
// session while it was written): view, edit, create, grep, glob, powershell,
// web_fetch, task, ask_user. The plain `@github/copilot` CLI also documents
// `shell`/`write` in its --allow-tool examples, so both name sets are handled.

const BASH_COMMAND_DISPLAY_MAX_LENGTH = 60;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 60;

function base(p: unknown): string {
  return typeof p === 'string' ? path.basename(p) : '';
}

function firstStringField(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'view':
    case 'read':
      return `Reading ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'edit':
    case 'str_replace_editor':
      return `Editing ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'create':
    case 'write':
      return `Writing ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'grep':
      return 'Searching code';
    case 'glob':
      return 'Searching files';
    case 'web_fetch':
    case 'fetch':
      return 'Fetching web content';
    case 'web_search':
      return 'Searching the web';
    case 'shell':
    case 'bash':
    case 'powershell': {
      const cmd = firstStringField(inp, ['command']);
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'task':
    case 'agent': {
      const desc = firstStringField(inp, ['description', 'prompt']);
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'ask_user':
      return 'Waiting for your answer';
    default:
      return `Using ${toolName}`;
  }
}

// ── Session dir + launch command ──

/** Read the `cwd:` line out of a session's workspace.yaml. Hand-rolled instead
 *  of a YAML parser: the file is a flat `key: value` list (the CLI's own
 *  writer, not user-authored YAML) and cwd is the only field we need. */
function readWorkspaceCwd(workspaceYamlPath: string): string | undefined {
  try {
    const content = fs.readFileSync(workspaceYamlPath, 'utf8');
    const match = content.match(/^cwd:\s*(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Copilot has no per-workspace project folder (unlike Claude's hashed
 *  ~/.claude/projects/<dir>/): every session gets its own top-level UUID
 *  directory regardless of cwd. So "session dirs for this workspace" means
 *  scanning every session directory's workspace.yaml and keeping the ones
 *  whose cwd matches -- there can be zero, one, or several. */
function getSessionDirs(workspacePath: string): string[] {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const cwd = readWorkspaceCwd(path.join(dir, 'workspace.yaml'));
    if (cwd && pathsMatch(cwd, workspacePath)) matches.push(dir);
  }
  return matches;
}

/** Root that holds every Copilot session across all workspaces. Each entry is
 *  a session's own directory containing exactly one `events.jsonl` -- the
 *  same shape the global scanner already expects from Claude's per-workspace
 *  project dirs (a directory whose entries include `.jsonl` files), so no
 *  scanner changes were needed to support this. */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.copilot', 'session-state')];
}

/** Unlike Claude, whose project dir basename IS the workspace path (separators
 *  replaced with `-`, so decoding the dir name alone yields a readable
 *  folder name), a Copilot session dir is an opaque UUID that encodes
 *  nothing -- decoding it just displays the UUID. The actual workspace lives
 *  in that same session's workspace.yaml, so read it back out and label the
 *  session with its cwd's own basename instead, matching what Claude agents
 *  show. */
function resolveSessionFolderName(dirPath: string): string | undefined {
  const cwd = readWorkspaceCwd(path.join(dirPath, 'workspace.yaml'));
  return cwd ? path.basename(cwd) : undefined;
}

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'copilot', args: ['--resume', sessionId], env: { PWD: cwd } };
}

// ── normalizeHookEvent: no hooks API exists, so nothing ever reaches here ──

function normalizeHookEvent(
  _raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  return null;
}

// ── Hooks install: no-ops. Nothing is ever written to any Copilot config file ──

function installHooks(): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

/** Always "installed": there is nothing to install, so the first-run consent
 *  gate (which only asks when `!installed`) never asks about this provider. */
function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(true);
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: 'No hook installation needed',
    disclosure:
      'GitHub Copilot CLI has no hooks API, so Pixel Agents never modifies any of its ' +
      `settings files. Instead it reads session transcripts directly from ` +
      `~/.copilot/session-state/<session-id>/${SESSION_FILE_NAME} on this machine.`,
  };
}

// ── The provider ──

export const copilotProvider: HookProvider = {
  kind: 'hook',
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['task', 'agent', 'ask_user']),
  subagentToolNames: new Set(['task', 'agent']),
  readingTools: new Set(['view', 'read', 'grep', 'glob', 'web_fetch', 'fetch', 'web_search']),
  terminalNamePrefix: COPILOT_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  resolveSessionFolderName,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,
};
