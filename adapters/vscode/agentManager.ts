import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeProjectName } from '../../core/src/normalizeProjectName.js';
import type { HookProvider } from '../../core/src/provider.js';
import { resendAgentActivity } from '../../server/src/agentActivityResend.js';
import { migrateAgentIdentity } from '../../server/src/agentMigration.js';
import type { AgentRuntime } from '../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { AgentState, PersistedAgent } from '../../server/src/types.js';

export function getProjectDirPath(cwd?: string, provider: HookProvider = claudeProvider): string {
  // Fall back to home directory when no workspace folder is open (common on Linux/macOS
  // when VS Code is launched without a folder). The provider's getSessionDirs already
  // implements the Windows case-insensitive fallback for drive-letter casing.
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirs = provider.getSessionDirs?.(workspacePath) ?? [];
  if (dirs.length === 0) {
    throw new Error(`${provider.displayName} has no session directory for this workspace`);
  }
  const projectDir = dirs[0];
  console.log(`[Pixel Agents] Terminal: Project dir: ${workspacePath} → ${projectDir}`);
  return projectDir;
}

export async function launchNewTerminal(
  runtime: AgentRuntime,
  provider: HookProvider,
  agents: AgentStateStore,
  folderPath?: string,
  bypassPermissions?: boolean,
  suppressShow?: boolean,
): Promise<void> {
  const { fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers } = runtime;
  const { readNewLines, reassignAgentToFile, startFileWatching } = runtime.getFileWatcher(
    provider.id,
  );
  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location.
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const sessionId = crypto.randomUUID();
  const launch = provider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
  if (!launch) throw new Error(`${provider.displayName} does not support terminal launch`);
  const expectedFile = provider.expectedTranscriptPath?.(sessionId, cwd);
  if (!expectedFile) {
    throw new Error(
      `${provider.displayName} has not supplied a new-session transcript path; start it externally to adopt it.`,
    );
  }
  const projectDir = path.dirname(expectedFile);
  const idx = agents.nextTerminalIndex.current++;
  const terminal = vscode.window.createTerminal({
    name: `${provider.terminalNamePrefix ?? provider.displayName} #${idx}`,
    cwd,
    env: launch.env,
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. The coding agent still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  terminal.sendText([launch.command, ...launch.args].join(' '));

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  runtime.getKnownJsonlFiles(provider.id).add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  const id = agents.nextAgentId.current++;
  // areaMappings is keyed by WorkspaceFolder.name, which can differ from the dir
  // basename, so seat placement needs that name. Pick the most specific containing
  // folder (longest path wins for nested folders).
  const owningFolder = (folders ?? [])
    .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  const folderName = owningFolder?.name ?? normalizeProjectName(cwd);
  const agent: AgentState = {
    id,
    providerId: provider.id,
    observation: provider.recoverTranscript ? 'unknown' : 'known',
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
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
    folderName,
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };

  assignPaletteIfNeeded(agent, agents);
  agents.set(id, agent);
  runtime.activeAgentId.current = id;
  runtime.registerAgent(sessionId, id, provider.id);
  agents.persist();
  console.log(`[Pixel Agents] Terminal: Agent ${id} - created for terminal ${terminal.name}`);

  runtime.startProjectScan(projectDir, undefined, provider.id);

  // Poll for the specific JSONL file to appear
  const createdAt = Date.now();
  let pollCount = 0;
  console.log(`[Pixel Agents] Terminal: Agent ${id} - waiting for JSONL at ${agent.jsonlFile}`);
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        console.log(
          `[Pixel Agents] Terminal: Agent ${id} - found JSONL file ${path.basename(agent.jsonlFile)} (after ${pollCount}s)`,
        );
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
        readNewLines(id, agents, waitingTimers, permissionTimers);
      } else if (pollCount === 10) {
        // After 10s of polling, warn with path details to help diagnose path encoding mismatches
        const dirExists = fs.existsSync(projectDir);
        let dirContents = '';
        if (dirExists) {
          try {
            const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
            dirContents =
              files.length > 0
                ? `Dir has ${files.length} JSONL file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
                : 'Dir exists but has no JSONL files';
          } catch {
            dirContents = 'Dir exists but unreadable';
          }
        } else {
          dirContents = 'Dir does not exist';
        }
        console.warn(
          `[Pixel Agents] Terminal: Agent ${id} - JSONL file not found after 10s. ` +
            `Expected: ${agent.jsonlFile}. ${dirContents}`,
        );
      } else if (pollCount > 10) {
        // Possible /resume: terminal started a different session than expected.
        // Check every tick for a file modified after the agent was created.
        try {
          const trackedFiles = new Set([...agents.values()].map((a) => path.resolve(a.jsonlFile)));
          const candidates = fs
            .readdirSync(projectDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const full = path.join(projectDir, f);
              return { file: full, mtime: fs.statSync(full).mtimeMs };
            })
            .filter((c) => !trackedFiles.has(path.resolve(c.file)) && c.mtime > createdAt)
            .sort((a, b) => b.mtime - a.mtime); // newest first

          if (candidates.length > 0) {
            console.log(
              `[Pixel Agents] Terminal: Agent ${id} - /resume detected, reassigning to ${path.basename(candidates[0].file)}`,
            );
            clearInterval(pollTimer);
            jsonlPollTimers.delete(id);
            reassignAgentToFile(
              id,
              candidates[0].file,
              agents,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              () => agents.persist(),
            );
          }
        } catch {
          /* ignore scan errors */
        }
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
  agentId: number,
  store: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
  const agent = store.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from store (fires agentRemoved event) and persist
  store.delete(agentId);
  store.persist();
}

/**
 * Reference implementation of the AgentState → PersistedAgent projection: it shows
 * exactly which fields survive a reload. Kept as the worked example for adapters that
 * persist through a StateAdapter directly; AgentStateStore.persist() is what the
 * VS Code surface calls at runtime.
 *
 * @public
 */
export function persistAgents(agents: AgentStateStore, adapter: StateAdapter): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    // Background-spawn children are derived state — never persisted (the 1s
    // scan re-materializes them from sidecars after a restore).
    if (agent.spawnToolUseId) continue;
    persisted.push({
      id: agent.id,
      providerId: agent.providerId,
      observation: agent.observation,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
      sessionName: agent.sessionName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
      backgroundAgentToolIds:
        agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
    });
  }
  adapter.saveAgents(persisted);
}

export function restoreAgents(
  adapter: StateAdapter,
  runtime: AgentRuntime,
  store: AgentStateStore,
): void {
  const { fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers } = runtime;
  const nextAgentIdRef = store.nextAgentId;
  const nextTerminalIndexRef = store.nextTerminalIndex;
  const persisted = adapter.loadAgents();
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;

  for (const persistedAgent of persisted) {
    const p = migrateAgentIdentity(persistedAgent);
    if (!p.providerId) continue;
    const provider = runtime.getProvider(p.providerId);
    if (!provider) continue;
    const { startFileWatching, recoverAgent } = runtime.getFileWatcher(provider.id);
    const knownJsonlFiles = runtime.getKnownJsonlFiles(provider.id);
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (store.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    // Background-spawn children (a leadAgentId but no teamName) are derived
    // state re-materialized by the 1s scan — never restored directly (also
    // skips stale entries written by older builds that persisted them).
    if (p.leadAgentId !== undefined && !p.teamName) continue;

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

    if (!isExternal) {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent: AgentState = {
      id: p.id,
      providerId: provider.id,
      observation: provider.recoverTranscript ? 'unknown' : 'known',
      sessionId:
        provider.resolveSessionId?.(p.jsonlFile) ??
        p.sessionId ??
        path.basename(p.jsonlFile, '.jsonl'),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      // Live spawn ids survive the reload so the 1s scan can re-adopt the
      // spawns' transcripts and the completion queue-op still matches.
      backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: provider.resolveSessionFolderName?.(p.projectDir) ?? p.folderName,
      sessionName: p.sessionName,
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      teamName: p.teamName,
      agentName: p.agentName,
      // A named agent is a teammate; never restore it as a lead (guards against
      // state persisted before linkTeammates stopped promoting teammates).
      isTeamLead: p.agentName ? undefined : p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
      palette: p.palette,
      hueShift: p.hueShift,
    };

    recoverAgent(agent, store, waitingTimers, permissionTimers);
    assignPaletteIfNeeded(agent, store);
    store.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    if (isExternal) {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored external → ${path.basename(p.jsonlFile)}`,
      );
    } else {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored → terminal "${p.terminalName}"`,
      );
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    runtime.registerAgent(agent.sessionId, agent.id, provider.id);
    runtime.startProjectScan(p.projectDir, undefined, provider.id);

    // Tail from the recovered snapshot without losing bytes appended during recovery.
    try {
      if (fs.existsSync(p.jsonlFile)) {
        startFileWatching(
          p.id,
          p.jsonlFile,
          store,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Agents] Terminal: Agent ${p.id} - found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              recoverAgent(agent, store, waitingTimers, permissionTimers);
              resendAgentActivity((message) => store.broadcast(message), store, p.id);
              startFileWatching(
                p.id,
                agent.jsonlFile,
                store,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  store.persist();
}

export function sendExistingAgents(
  agents: AgentStateStore,
  adapter: StateAdapter,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = adapter.loadSeats();

  // Include folderName and isExternal per agent
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const providerIds: Record<number, string> = {};
  const observations: Record<number, 'known' | 'unknown'> = {};
  const sessionNames: Record<number, string> = {};
  for (const [id, agent] of agents) {
    providerIds[id] = agent.providerId ?? 'claude';
    observations[id] = agent.observation ?? 'known';
    if (agent.sessionName) sessionNames[id] = agent.sessionName;
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
    providerIds,
    observations,
    sessionNames,
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: AgentStateStore,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  resendAgentActivity((msg) => webview.postMessage(msg), agents);
}

export function sendLayout(
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = loadLayout(defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    defaultLayout: defaultLayout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
