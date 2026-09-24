/**
 * HookProvider for GitHub Copilot CLI / the GitHub Copilot app.
 *
 * Copilot supports observational hooks and persisted session events:
 *
 *   ~/.copilot/session-state/<session-id>/events.jsonl   (event log, one JSON object per line)
 *   ~/.copilot/session-state/<session-id>/workspace.yaml (has a `cwd:` line — the session's workspace)
 *
 * Hook availability and persisted event shapes vary across App/CLI versions.
 * See docs/copilot-compatibility.md for source and capability boundaries.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { pathsMatch } from '../../../pathKey.js';
import { CONSENT_DISCLOSURE, CONSENT_INSTALL_HEADLINE } from './consentCopy.js';
import {
  areHooksInstalled as areCopilotHooksInstalled,
  getCopilotHome,
  installHooks as installCopilotHooks,
  uninstallHooks as uninstallCopilotHooks,
} from './copilotHookInstaller.js';
import { recoverCopilotTranscript } from './recovery.js';

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
  return typeof p === 'string'
    ? p.includes('\\')
      ? path.win32.basename(p)
      : path.basename(p)
    : '';
}

function firstStringField(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  switch (toolName) {
    case 'view':
    case 'read':
      return `Reading ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'edit':
    case 'str_replace_editor':
      return `Editing ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'apply_patch':
      return 'Applying patch';
    case 'create':
    case 'write':
      return `Writing ${base(firstStringField(inp, ['path', 'file_path']))}`;
    case 'grep':
    case 'rg':
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

function readWorkspaceYamlContent(workspaceYamlPath: string): string | undefined {
  try {
    return fs.readFileSync(workspaceYamlPath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read the `cwd:` line out of a session's workspace.yaml. Hand-rolled instead
 *  of a YAML parser: the file is a flat `key: value` list (the CLI's own
 *  writer, not user-authored YAML) and cwd is the only field we need. */
function readWorkspaceCwd(workspaceYamlPath: string): string | undefined {
  const content = readWorkspaceYamlContent(workspaceYamlPath);
  return content ? readWorkspaceYamlField(content, 'cwd') : undefined;
}

/** Read a scalar field out of workspace.yaml content, handling the three
 *  forms the CLI's own writer produces: a plain inline value (`field: foo`),
 *  a quoted inline value (`field: 'foo: bar'`, quoted because the value
 *  contains YAML-special characters), and a block scalar (`field: |-`
 *  followed by indented lines) used for long auto-generated text like task
 *  descriptions. Block scalars are collapsed to their first non-blank line --
 *  good enough for a short UI label, and the full multi-paragraph text would
 *  just get truncated anyway. */
function readWorkspaceYamlField(content: string, field: string): string | undefined {
  const headerMatch = content.match(new RegExp(`^${field}:[ \\t]*(.*)$`, 'm'));
  if (!headerMatch) return undefined;
  const inline = headerMatch[1].trim();
  // A bare block-scalar indicator (|, |-, >, >-, optionally with a digit
  // indentation hint) means the real value is on the following lines, not here.
  if (inline && !/^[|>][+-]?\d*$/.test(inline)) {
    const quoted = inline.match(/^(['"])(.*)\1$/);
    return quoted ? quoted[2] : inline;
  }
  const headerIndex = content.indexOf(headerMatch[0]);
  const rest = content.slice(headerIndex + headerMatch[0].length);
  const lineMatch = rest.match(/^\r?\n[ \t]+(\S.*)$/m);
  return lineMatch?.[1]?.trim();
}

/** Copilot has no per-workspace project folder (unlike Claude's hashed
 *  ~/.claude/projects/<dir>/): every session gets its own top-level UUID
 *  directory regardless of cwd. So "session dirs for this workspace" means
 *  scanning every session directory's workspace.yaml and keeping the ones
 *  whose cwd matches -- there can be zero, one, or several. */
function getSessionDirs(workspacePath: string): string[] {
  const [root] = getAllSessionRoots();
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
  return [path.join(getCopilotHome(), 'session-state')];
}

function getSessionFile(sessionId: string): string | undefined {
  return /^[a-zA-Z0-9_-]+$/.test(sessionId)
    ? path.join(getAllSessionRoots()[0], sessionId, SESSION_FILE_NAME)
    : undefined;
}

/** Unlike Claude, whose project dir basename IS the workspace path (separators
 *  replaced with `-`, so decoding the dir name alone yields a readable
 *  folder name), a Copilot session dir is an opaque UUID that encodes
 *  nothing -- decoding it just displays the UUID. The actual workspace lives
 *  in that same session's workspace.yaml, so read it back out.
 *
 *  Prefers CLI-supplied `repository` ("owner/repo") when present; this is not
 *  an authoritative App project identifier. It is a useful label when Watch
 *  All Sessions mixes different repos into one office. `repository` is
 *  absent for sessions whose cwd isn't inside a tracked GitHub repo, so those
 *  fall back to the cwd's own basename, matching what Claude agents show. */
function resolveSessionFolderName(dirPath: string): string | undefined {
  const workspaceYamlPath = path.join(dirPath, 'workspace.yaml');
  const content = readWorkspaceYamlContent(workspaceYamlPath);
  const repository = content ? readWorkspaceYamlField(content, 'repository') : undefined;
  if (repository) return repository;
  const cwd = readWorkspaceCwd(workspaceYamlPath);
  return cwd ? base(cwd) : undefined;
}

/** Use the session title supplied by the CLI instead of an opaque UUID.
 *  App-local titles and identifiers may differ; do not infer a mapping. */
function resolveSessionName(dirPath: string): string | undefined {
  const content = readWorkspaceYamlContent(path.join(dirPath, 'workspace.yaml'));
  const name = content ? readWorkspaceYamlField(content, 'name') : undefined;
  if (!name) return undefined;
  return name.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH
    ? name.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026'
    : name;
}

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  return { command: 'copilot', args: ['--session-id', sessionId], env: { PWD: cwd } };
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = raw.sessionId ?? raw.session_id;
  const hookType = raw.hookType ?? raw.hook_event_name;
  if (typeof sessionId !== 'string' || !sessionId || typeof hookType !== 'string') return null;
  switch (hookType) {
    case 'userPromptSubmitted':
      return { sessionId, event: { kind: 'turnStart' } };
    case 'sessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          transcriptPath: getSessionFile(sessionId),
        },
      };
    case 'agentStop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'notification':
      if (
        raw.notification_type === 'permission_prompt' ||
        raw.notificationType === 'permission_prompt'
      ) {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      if (
        raw.notification_type === 'elicitation_dialog' ||
        raw.notificationType === 'elicitation_dialog'
      ) {
        return { sessionId, event: { kind: 'turnEnd', awaitingInput: true } };
      }
      return { sessionId, event: { kind: 'observation' } };
    case 'preToolUse':
      if (typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string') {
        return { sessionId, event: { kind: 'observation' } };
      }
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: raw.toolCallId,
          toolName: raw.toolName,
          input: raw.toolArgs,
        },
      };
    case 'postToolUse':
    case 'postToolUseFailure':
      return typeof raw.toolCallId === 'string'
        ? { sessionId, event: { kind: 'toolEnd', toolId: raw.toolCallId } }
        : { sessionId, event: { kind: 'observation' } };
    // Neither permission evaluation nor the App's recurring sessionEnd proves a terminal state.
    default:
      return null;
  }
}

async function areHooksInstalled(): Promise<boolean> {
  return areCopilotHooksInstalled();
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: CONSENT_INSTALL_HEADLINE,
    disclosure: CONSENT_DISCLOSURE,
  };
}

// ── The provider ──

export const copilotProvider: HookProvider = {
  kind: 'hook',
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  protocolVersion: 1,
  capabilities: {
    hooks: true,
    discovery: true,
    permissionRequests: true,
    userInput: true,
    contextUsage: true,
    subagents: true,
    teams: false,
    sessionEnd: false,
  },

  normalizeHookEvent,

  installHooks: installCopilotHooks,
  uninstallHooks: uninstallCopilotHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(['task', 'agent', 'ask_user']),
  subagentToolNames: new Set(['task', 'agent']),
  readingTools: new Set(['view', 'read', 'grep', 'rg', 'glob', 'web_fetch', 'fetch', 'web_search']),
  terminalNamePrefix: COPILOT_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  getSessionFile,
  getSessionCwd: (dir) => readWorkspaceCwd(path.join(dir, 'workspace.yaml')),
  resolveSessionId: (file) =>
    path.basename(file) === SESSION_FILE_NAME ? path.basename(path.dirname(file)) : undefined,
  isSessionCandidate: ({ previousSize, size }) => previousSize !== undefined && size > previousSize,
  resolveSessionFolderName,
  resolveSessionName,
  recoverTranscript: recoverCopilotTranscript,
  sessionFilePattern: 'events.jsonl',
  expectedTranscriptPath: (sessionId) => {
    const file = getSessionFile(sessionId);
    if (!file) throw new Error('Invalid Copilot session ID');
    return file;
  },
  buildLaunchCommand,
};
