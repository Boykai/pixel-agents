const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TEXT_IDLE_DELAY_MS, TOOL_DONE_DELAY_MS } from './constants.js';
import { updateContextUsage } from './contextUsage.js';
import type { CopilotRecordOptions } from './providers/hook/copilot/eventReducer.js';
import { processCopilotRecord } from './providers/hook/copilot/eventReducer.js';
import { hasInlineTeammates, hasPromotedBackgroundAgent } from './teamUtils.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

/** Empty set used as safe fallback when no HookProvider is registered. */
const EMPTY_EXEMPT_TOOLS: ReadonlySet<string> = new Set();

/** A parser's provider and lifecycle callbacks belong to its runtime, not the process. */
export function createTranscriptParser() {
  let copilotOptions:
    ((agentId: number, record: Record<string, unknown>) => CopilotRecordOptions) | undefined;
  let afterCopilotRecord: ((agentId: number) => void) | undefined;
  function setCopilotRecordOptions(
    factory: (agentId: number, record: Record<string, unknown>) => CopilotRecordOptions,
    afterRecord?: (agentId: number) => void,
  ): void {
    copilotOptions = factory;
    afterCopilotRecord = afterRecord;
  }
  /** Tool dones go out TOOL_DONE_DELAY_MS late so a brief tool's active state
   *  survives React batching. The delay must never carry a done past the turn
   *  boundary that follows it: a failed tool's done (isError) has to reach the
   *  store before the turn-end status that concludes its turn, and before the
   *  next prompt's clear, or the failure is charged to the wrong turn. Each
   *  agent's pending dones are kept in order so flushToolDones() can send them
   *  early at those boundaries. */
  type PendingToolDone = { timer: ReturnType<typeof setTimeout>; send: () => void };
  const deferred = new Set<ReturnType<typeof setTimeout>>();
  let pendingToolDones = new WeakMap<AgentState, PendingToolDone[]>();

  function deferToolDone(
    agentId: number,
    agent: AgentState,
    agents: AgentStateStore,
    message: Record<string, unknown>,
  ): void {
    const send = (): void => {
      if (agents.get(agentId) === agent) agents.broadcast(message);
    };
    const timer = setTimeout(() => {
      deferred.delete(timer);
      const queue = pendingToolDones.get(agent) ?? [];
      const index = queue.findIndex((entry) => entry.timer === timer);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) pendingToolDones.delete(agent);
      send();
    }, TOOL_DONE_DELAY_MS);
    deferred.add(timer);
    let queue = pendingToolDones.get(agent);
    if (!queue) {
      queue = [];
      pendingToolDones.set(agent, queue);
    }
    queue.push({ timer, send });
  }

  /** Send the agent's pending tool dones now, in order. Called at every turn
   *  boundary: turn_duration, a new user prompt, /clear, and the hook path's
   *  turn end (HookEventHandler.markAgentWaiting). The text-idle timer needs no
   *  flush: new transcript data cancels it, and TEXT_IDLE_DELAY_MS far exceeds
   *  TOOL_DONE_DELAY_MS. */
  function flushToolDones(agent: AgentState): void {
    const queue = pendingToolDones.get(agent);
    if (!queue) return;
    pendingToolDones.delete(agent);
    for (const { timer, send } of queue) {
      clearTimeout(timer);
      deferred.delete(timer);
      send();
    }
  }

  function dispose(): void {
    for (const timer of deferred) clearTimeout(timer);
    deferred.clear();
    pendingToolDones = new WeakMap();
    backgroundAgentDetectedCallback = null;
    backgroundAgentCompletedCallback = null;
    teamSwitchCallback = null;
    copilotOptions = undefined;
    afterCopilotRecord = undefined;
  }
  /** Hook provider: supplies formatToolStatus + team.extractTeamMetadataFromRecord.
   *  Registered once at startup via setHookProvider(). Functions below assume it's set. */
  let hookProvider: HookProvider | null = null;

  /** Permission-exempt tools come from the active provider. Fail-open if unset. */
  function exemptTools(): ReadonlySet<string> {
    return hookProvider?.permissionExemptTools ?? EMPTY_EXEMPT_TOOLS;
  }

  /** Whether the given tool name spawns a sub-agent according to the active provider. */
  function isSubagentTool(toolName: string | null | undefined): boolean {
    if (!toolName || !hookProvider) return false;
    return hookProvider.subagentToolNames.has(toolName);
  }

  /** Register the HookProvider that owns CLI-specific formatting and team metadata extraction. */
  function setHookProvider(provider: HookProvider): void {
    hookProvider = provider;
  }

  /** The registered provider, for modules that need it outside line parsing
   *  (fileWatcher seeds context gauges before any line has been read). */
  function getHookProvider(): HookProvider | null {
    return hookProvider;
  }

  /** Called when a lead's tool_result reports an async agent launch. The host
   *  reacts by scanning the lead's subagents/ sidecars and classifying each
   *  spawn by its sidecar name: named -> teammate character, unnamed -> shadow-
   *  watched sub-agent (fileWatcher.scanForBackgroundAgentFiles). */
  let backgroundAgentDetectedCallback: ((leadAgentId: number) => void) | null = null;

  function setBackgroundAgentDetectedCallback(cb: (leadAgentId: number) => void): void {
    backgroundAgentDetectedCallback = cb;
  }

  /** Called when a queue-operation record marks a background agent finished.
   *  The host removes the teammate character or stops the shadow watch. */
  let backgroundAgentCompletedCallback: ((leadAgentId: number, toolUseId: string) => void) | null =
    null;

  function setBackgroundAgentCompletedCallback(
    cb: (leadAgentId: number, toolUseId: string) => void,
  ): void {
    backgroundAgentCompletedCallback = cb;
  }

  /** Notify the host that a spawn tool finished, so it can remove the spawn's
   *  teammate character or stop its shadow watch. Exported for hookEventHandler,
   *  which clears foreground tools on the Stop hook. Safe to fire for tools that
   *  never had a watch — the host's lookups simply miss. */
  function notifyBackgroundAgentCompleted(leadAgentId: number, toolUseId: string): void {
    backgroundAgentCompletedCallback?.(leadAgentId, toolUseId);
  }

  /** Called when a lead's spawn result names a DIFFERENT team than the one it is
   *  latched to. Every CLI run of a session mints a fresh implicit team, so a
   *  resumed lead that spawns again belongs to the new team; the host removes
   *  the defunct team's teammate characters. */
  let teamSwitchCallback: ((leadAgentId: number, previousTeamName: string) => void) | null = null;

  function setTeamSwitchCallback(
    cb: (leadAgentId: number, previousTeamName: string) => void,
  ): void {
    teamSwitchCallback = cb;
  }

  /** Format a tool status line. Delegates to the active HookProvider's formatToolStatus.
   *  Invariant: a provider is registered before any transcript lines are parsed. */
  function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
    return hookProvider?.formatToolStatus(toolName, input) ?? `Using ${toolName}`;
  }

  /** A text-only turn is Done when the text-idle timer fires: that completes
   *  an interaction, unless the record that armed the timer was history. */
  function textIdleDone(
    agent: AgentState,
    agents: AgentStateStore,
    recordedAt: unknown,
  ): ((agent: AgentState) => void) | undefined {
    if (agents.activity.isReplaying(agent)) return undefined;
    return (done) => agents.activity.live(done, { kind: 'interactionEnd' }, recordedAt);
  }

  /** A sidechain record is one of the agent's Sub-agents at work (older Claude
   *  formats inline them) once the transcript has a main chain of its own; a
   *  teammate's own transcript is sidechain top to bottom. Same positional
   *  rule as the context gauge (contextUsage.ts). */
  function isSubagentRecord(agent: AgentState, record: { isSidechain?: unknown }): boolean {
    return record.isSidechain === true && agent.sawMainChainUsage === true;
  }

  function processTranscriptLine(
    agentId: number,
    line: string,
    agents: AgentStateStore,
    waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  ): void {
    const agent = agents.get(agentId);
    if (!agent) return;
    if (hookProvider && agent.providerId && agent.providerId !== hookProvider.id) return;
    agent.lastDataAt = Date.now();
    agent.linesProcessed++;
    try {
      const record = JSON.parse(line);

      // -- Agent Teams: extract team metadata via the active provider --
      // The provider reads its CLI's own field names (Claude: record.teamName + record.agentName).
      // Other CLIs would implement this differently or not at all.
      const teamMeta = hookProvider?.team?.extractTeamMetadataFromRecord(record);
      if (teamMeta?.teamName && teamMeta.teamName !== agent.teamName) {
        agent.teamName = teamMeta.teamName;
        agent.teamNameFromTags = true;
        agent.agentName = teamMeta.agentName;
        agent.isTeamLead = undefined;
        agent.leadAgentId = undefined;
        if (debug) {
          console.log(
            `[Pixel Agents] Agent ${agentId} team metadata: team=${agent.teamName}, role=${agent.agentName ?? 'lead'}`,
          );
        }
        // Link teammates to leads within the same team
        linkTeammates(agentId, agent, agents);

        agents.broadcast({
          type: 'agentTeamInfo',
          id: agentId,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
        });
      }

      // -- Token usage: the provider reads its CLI's fields; the store's tracker
      // dedupes, accumulates and broadcasts. Separate from the context gauge below.
      const usage = hookProvider?.extractTokenUsage?.(record);
      if (usage) agents.tokenUsage.observe(agentId, usage);

      // Copilot's dotted record.type namespace never overlaps with Claude's bare
      // one, so it's handled as a clean parallel branch rather than folded into
      // the Claude-specific chain below.
      if (hookProvider?.id === 'copilot') {
        processCopilotRecord(
          agentId,
          record,
          agent,
          agents,
          waitingTimers,
          permissionTimers,
          copilotOptions?.(agentId, record),
        );
        afterCopilotRecord?.(agentId);
        return;
      }
      updateContextUsage(agentId, agent, agents, record, hookProvider);

      // Resilient content extraction: support both record.message.content and record.content
      // Claude Code may change the JSONL structure across versions
      const assistantContent = record.message?.content ?? record.content;

      if (record.type === 'assistant' && Array.isArray(assistantContent)) {
        const blocks = assistantContent as Array<{
          type: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        const hasToolUse = blocks.some((b) => b.type === 'tool_use');

        if (hasToolUse) {
          cancelWaitingTimer(agentId, waitingTimers);
          agent.isWaiting = false;
          agent.hadToolsInTurn = true;
          agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
          let hasNonExemptTool = false;
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.id) {
              const toolName = block.name || '';
              const status = formatToolStatus(toolName, block.input || {});
              console.log(
                `[Pixel Agents] JSONL: Agent ${agentId} - tool start: ${block.id} ${status}`,
              );
              agent.activeToolIds.add(block.id);
              agent.activeToolStatuses.set(block.id, status);
              agent.activeToolNames.set(block.id, toolName);
              agents.activity.transcript(
                agent,
                {
                  kind: 'toolStart',
                  toolId: block.id,
                  toolName,
                  input: block.input,
                  // An inline Sub-agent's records share the transcript.
                  subagent: isSubagentRecord(agent, record) || undefined,
                },
                record.timestamp,
              );
              if (!exemptTools().has(toolName)) {
                hasNonExemptTool = true;
              }
              // Detect tmux vs inline team mode from the team provider's spawn predicate.
              if (
                agent.teamName &&
                hookProvider?.team?.isTeammateSpawnCall(toolName, block.input ?? {}) &&
                !agent.teamUsesTmux
              ) {
                agent.teamUsesTmux = true;
                agents.broadcast({
                  type: 'agentTeamInfo',
                  id: agentId,
                  teamName: agent.teamName,
                  agentName: agent.agentName,
                  isTeamLead: agent.isTeamLead,
                  leadAgentId: agent.leadAgentId,
                  teamUsesTmux: true,
                });
                for (const [id, teammate] of agents) {
                  if (id === agentId || teammate.leadAgentId !== agentId) continue;
                  teammate.teamUsesTmux = true;
                  agents.broadcast({
                    type: 'agentTeamInfo',
                    id,
                    teamName: teammate.teamName,
                    agentName: teammate.agentName,
                    isTeamLead: teammate.isTeamLead,
                    leadAgentId: teammate.leadAgentId,
                    teamUsesTmux: true,
                  });
                }
              }
              // Skip webview message when hooks handle tool visuals (PreToolUse sent it instantly).
              // EXCEPTION: subagent-spawn tools (Task/Agent) ALWAYS use JSONL so the sub-agent
              // character is created with the REAL tool id. SubagentStop and subagentClear use
              // the real id -- a synthetic-id sub-agent from PreToolUse could never be matched.
              // EXCEPTION: inline teammates need JSONL tool events even in hooks mode so their
              // tool activity is displayed correctly.
              const isSubagentSpawn = isSubagentTool(toolName);
              // A spawn call carrying a `name` is a Teammate-to-be: flag it so
              // the webview never creates a Subtask ghost that the teammate
              // character replaces seconds later.
              const isTeammateSpawn =
                isSubagentSpawn &&
                typeof block.input?.name === 'string' &&
                block.input.name.length > 0;
              if (isTeammateSpawn) {
                (agent.teammateSpawnToolIds ??= new Set()).add(block.id);
              }
              const useJsonlToolEvents = agent.hookDelivered && hasInlineTeammates(agentId, agents);
              if (!agent.hookDelivered || useJsonlToolEvents || isSubagentSpawn) {
                const runInBackground = isSubagentSpawn && block.input?.run_in_background === true;
                agents.broadcast({
                  type: 'agentToolStart',
                  id: agentId,
                  toolId: block.id,
                  status,
                  toolName,
                  permissionActive: agent.permissionSent,
                  runInBackground,
                  isTeammateSpawn: isTeammateSpawn || undefined,
                });
              }
            }
          }
          // Skip heuristic timer when hooks are active OR for teammates.
          // Teammate tools (WebFetch, WebSearch) are naturally slow; the heuristic
          // produces false positives. Permission on teammates comes from the lead's
          // routed Notification(permission_prompt) hook — slower but accurate.
          if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
            startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
          }
        } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
          // Text-only response in a turn that hasn't used any tools.
          // turn_duration handles tool-using turns reliably but is never
          // emitted for text-only turns, so we use a silence-based timer:
          // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
          // Skip when hooks are active — Stop hook handles this exactly.
          if (!agent.hookDelivered) {
            startWaitingTimer(
              agentId,
              TEXT_IDLE_DELAY_MS,
              agents,
              waitingTimers,
              textIdleDone(agent, agents, record.timestamp),
            );
          }
        }
      } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
        // Text-only assistant response (content is a string, not an array)
        if (!agent.hadToolsInTurn && !agent.hookDelivered) {
          startWaitingTimer(
            agentId,
            TEXT_IDLE_DELAY_MS,
            agents,
            waitingTimers,
            textIdleDone(agent, agents, record.timestamp),
          );
        }
      } else if (record.type === 'assistant' && assistantContent === undefined) {
        // Assistant record with no recognizable content structure
        console.warn(
          `[Pixel Agents] Agent ${agentId}: assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
        );
      } else if (record.type === 'progress') {
        processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers);
      } else if (record.type === 'user') {
        const content = record.message?.content ?? record.content;
        if (Array.isArray(content)) {
          const blocks = content as Array<{
            type: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: unknown;
          }>;
          const hasToolResult = blocks.some((b) => b.type === 'tool_result');
          if (hasToolResult) {
            for (const block of blocks) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const completedToolId = block.tool_use_id;
                const completedToolName = agent.activeToolNames.get(completedToolId);

                // Teammate spawn result (newer harnesses: every Agent spawn is a
                // background teammate of an implicit team; the lead's own records
                // carry no team tags, so this result line is the only lead-side
                // signal). Marks the agent as lead so teammate discovery engages,
                // then falls through to normal tool-done handling -- the teammate
                // character replaces the transient Subtask one.
                const teammateSpawn = completedToolName
                  ? hookProvider?.team?.extractTeammateSpawnFromToolResult?.(
                      completedToolName,
                      block.content,
                    )
                  : null;
                if (
                  teammateSpawn &&
                  !agent.teamNameFromTags &&
                  !agent.leadAgentId &&
                  agent.teamName !== teammateSpawn.teamName
                ) {
                  // Last-wins for tag-less LEADS: a resumed session's transcript
                  // carries spawn results from several team generations (each CLI
                  // run mints a fresh session-<8hex> team). Re-latch to the
                  // newest team and drop the defunct team's teammates. Tag-
                  // derived identity (tmux/inline, teammate sessions) stays.
                  //
                  // `!agent.leadAgentId` keeps a TEAMMATE that spawns its own
                  // named Agent from re-latching itself out of its team: it would
                  // flip to the nested team, set isTeamLead, and linkTeammates
                  // would then detach it from its real lead (phantom LEAD, broken
                  // click-to-focus). An agent that already has a lead is never a
                  // re-latch candidate, whatever its teamNameFromTags says.
                  if (agent.teamName) {
                    teamSwitchCallback?.(agentId, agent.teamName);
                  }
                  agent.teamName = teammateSpawn.teamName;
                  agent.isTeamLead = true;
                  if (debug) {
                    console.log(
                      `[Pixel Agents] Agent ${agentId} spawned teammate "${teammateSpawn.teammateName}" -> lead of team ${teammateSpawn.teamName}`,
                    );
                  }
                  linkTeammates(agentId, agent, agents);
                  agents.broadcast({
                    type: 'agentTeamInfo',
                    id: agentId,
                    teamName: agent.teamName,
                    agentName: agent.agentName,
                    isTeamLead: agent.isTeamLead,
                    leadAgentId: agent.leadAgentId,
                  });
                }

                // Detect background agent launches — keep the tool alive until queue-operation
                if (
                  !teammateSpawn &&
                  isSubagentTool(completedToolName) &&
                  isAsyncAgentResult(block)
                ) {
                  console.log(
                    `[Pixel Agents] Agent ${agentId} background agent launched: ${completedToolId}`,
                  );
                  agent.backgroundAgentToolIds.add(completedToolId);
                  // Current harnesses OMIT run_in_background from the tool_use
                  // input, so the spawn's original agentToolStart went out
                  // unflagged. Re-broadcast it flagged now that the result
                  // proves it's background: the webview marks the Subtask as
                  // background-parented BEFORE the first turn-end clear, or the
                  // sub-character gets removed and recreated at a new tile.
                  const spawnStatus = agent.activeToolStatuses.get(completedToolId);
                  if (spawnStatus) {
                    agents.broadcast({
                      type: 'agentToolStart',
                      id: agentId,
                      toolId: completedToolId,
                      status: spawnStatus,
                      toolName: completedToolName,
                      runInBackground: true,
                      isTeammateSpawn:
                        agent.teammateSpawnToolIds?.has(completedToolId) || undefined,
                    });
                  }
                  // Classify the spawn right away (sidecar may lag; the periodic
                  // teammate scan retries until it lands).
                  backgroundAgentDetectedCallback?.(agentId);
                  continue; // don't mark as done yet
                }

                console.log(
                  `[Pixel Agents] JSONL: Agent ${agentId} - tool done: ${block.tool_use_id}`,
                );
                // If the completed tool spawned a subagent, clear its subagent tools
                if (isSubagentTool(completedToolName)) {
                  agent.activeSubagentToolIds.delete(completedToolId);
                  agent.activeSubagentToolNames.delete(completedToolId);
                  agents.broadcast({
                    type: 'subagentClear',
                    id: agentId,
                    parentToolId: completedToolId,
                  });
                  // Stop the shadow watch on a foreground spawn's transcript.
                  backgroundAgentCompletedCallback?.(agentId, completedToolId);
                }
                agent.activeToolIds.delete(completedToolId);
                agent.activeToolStatuses.delete(completedToolId);
                agent.activeToolNames.delete(completedToolId);
                // Send agentToolDone when hooks are off, or for Task/Agent tools
                // (which always use JSONL path for consistent sub-agent lifecycle).
                // tool_result.is_error is the transcript's tool-failure signal (also
                // set for validation errors, permission denials and interrupts).
                const isCompletedAgentTool =
                  completedToolName === 'Task' || completedToolName === 'Agent';
                const useJsonlToolEvents =
                  agent.hookDelivered && hasInlineTeammates(agentId, agents);
                if (!agent.hookDelivered || useJsonlToolEvents || isCompletedAgentTool) {
                  deferToolDone(agentId, agent, agents, {
                    type: 'agentToolDone',
                    id: agentId,
                    toolId: completedToolId,
                    ...(block.is_error === true ? { isError: true } : {}),
                  });
                  // Reported where the failed done is decided (synchronously; the
                  // done itself is deferred), so each failure is reported once.
                  if (block.is_error === true) {
                    agents.activity.transcript(
                      agent,
                      { kind: 'toolFailure', toolId: completedToolId },
                      record.timestamp,
                    );
                  }
                }
              }
            }
            // All tools completed — allow text-idle timer as fallback
            // for turn-end detection when turn_duration is not emitted
            if (agent.activeToolIds.size === 0) {
              agent.hadToolsInTurn = false;
            }
          } else {
            // New user text prompt — new turn starting
            cancelWaitingTimer(agentId, waitingTimers);
            flushToolDones(agent);
            clearAgentActivity(agent, agentId, agents, permissionTimers);
            agent.hadToolsInTurn = false;
            if (!isSubagentRecord(agent, record)) {
              agents.activity.transcript(agent, { kind: 'interactionStart' }, record.timestamp);
            }
          }
        } else if (typeof content === 'string' && content.trim()) {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          flushToolDones(agent);
          clearAgentActivity(agent, agentId, agents, permissionTimers);
          agent.hadToolsInTurn = false;
          if (!isSubagentRecord(agent, record)) {
            agents.activity.transcript(agent, { kind: 'interactionStart' }, record.timestamp);
          }
        }
      } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
        // Background agent completed — parse tool-use-id from XML content
        const content = record.content as string | undefined;
        if (content) {
          const toolIdMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
          if (toolIdMatch) {
            const completedToolId = toolIdMatch[1];
            if (agent.backgroundAgentToolIds.has(completedToolId)) {
              console.log(
                `[Pixel Agents] Agent ${agentId} background agent done: ${completedToolId}`,
              );
              agent.backgroundAgentToolIds.delete(completedToolId);
              agent.activeSubagentToolIds.delete(completedToolId);
              agent.activeSubagentToolNames.delete(completedToolId);
              agents.broadcast({
                type: 'subagentClear',
                id: agentId,
                parentToolId: completedToolId,
              });
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              // Remove the spawn's teammate character or stop its shadow watch.
              backgroundAgentCompletedCallback?.(agentId, completedToolId);
              if (!agent.hookDelivered) {
                deferToolDone(agentId, agent, agents, {
                  type: 'agentToolDone',
                  id: agentId,
                  toolId: completedToolId,
                });
              }
            }
          }
        }
      } else if (record.type === 'system' && record.subtype === 'turn_duration') {
        // The turn's tool dones, failures included, precede its end.
        flushToolDones(agent);
        cancelWaitingTimer(agentId, waitingTimers);
        cancelPermissionTimer(agentId, permissionTimers);

        // Definitive turn-end: clean up any stale tool state, but preserve background agents.
        // When hooks are active, the Stop hook already handled the status change,
        // but we still perform state cleanup here as a safety net.
        const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
        if (hasForegroundTools) {
          // Remove only non-background tool state
          for (const toolId of agent.activeToolIds) {
            if (agent.backgroundAgentToolIds.has(toolId)) continue;
            agent.activeToolIds.delete(toolId);
            agent.activeToolStatuses.delete(toolId);
            const toolName = agent.activeToolNames.get(toolId);
            agent.activeToolNames.delete(toolId);
            if (isSubagentTool(toolName)) {
              agent.activeSubagentToolIds.delete(toolId);
              agent.activeSubagentToolNames.delete(toolId);
              // A foreground spawn dropped at turn end without a tool_result:
              // stop its shadow watch too, or it lingers until sessionEnd.
              backgroundAgentCompletedCallback?.(agentId, toolId);
            }
          }
          if (!agent.hookDelivered) {
            agents.broadcast({ type: 'agentToolsClear', id: agentId });
          }
          // Re-send background agent tools so webview keeps their sub-agents alive.
          // toolName + runInBackground are REQUIRED: without them the webview can't
          // recognize the re-sent tool as a subagent spawn and never recreates the
          // Subtask sub-character. Skip tools whose agent was promoted to its own
          // character -- re-sending would spawn a ghost Subtask alongside it.
          for (const toolId of agent.backgroundAgentToolIds) {
            if (hasPromotedBackgroundAgent(agentId, toolId, agents)) continue;
            const status = agent.activeToolStatuses.get(toolId);
            if (status) {
              agents.broadcast({
                type: 'agentToolStart',
                id: agentId,
                toolId,
                status,
                toolName: agent.activeToolNames.get(toolId),
                runInBackground: true,
                isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
              });
            }
          }
        } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
          agent.activeToolIds.clear();
          agent.activeToolStatuses.clear();
          agent.activeToolNames.clear();
          agent.activeSubagentToolIds.clear();
          agent.activeSubagentToolNames.clear();
          if (!agent.hookDelivered) {
            agents.broadcast({ type: 'agentToolsClear', id: agentId });
          }
        }

        agent.isWaiting = true;
        agent.permissionSent = false;
        agent.hadToolsInTurn = false;
        // Skip status post when hooks already handled it
        if (!agent.hookDelivered) {
          agents.broadcast({
            type: 'agentStatus',
            id: agentId,
            status: 'waiting',
            // turn_duration = the turn completed, so this is "Done".
            awaitingInput: false,
          });
        }
        // Also in hooks mode: the Stop hook reports the same end, and the
        // consumer counts one completed interaction per start.
        if (!isSubagentRecord(agent, record)) {
          agents.activity.transcript(agent, { kind: 'interactionEnd' }, record.timestamp);
        }
      } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type)) {
        // Log first occurrence of unrecognized record types to help diagnose issues
        // where Claude Code changes JSONL format. Known types we intentionally skip:
        // file-history-snapshot, queue-operation (non-enqueue), etc.
        const knownSkippableTypes = new Set(['file-history-snapshot', 'system', 'queue-operation']);
        if (!knownSkippableTypes.has(record.type)) {
          agent.seenUnknownRecordTypes.add(record.type);
          if (debug) {
            console.log(
              `[Pixel Agents] JSONL: Agent ${agentId} - unrecognized record type '${record.type}'. ` +
                `Keys: ${Object.keys(record).join(', ')}`,
            );
          }
        }
      }
    } catch {
      // Ignore malformed lines
    }
  }

  function processProgressRecord(
    agentId: number,
    record: Record<string, unknown>,
    agents: AgentStateStore,
    _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  ): void {
    const agent = agents.get(agentId);
    if (!agent) return;

    const parentToolId = record.parentToolUseID as string | undefined;
    if (!parentToolId) return;

    const data = record.data as Record<string, unknown> | undefined;
    if (!data) return;

    // bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
    // Restart the permission timer to give the running tool another window.
    // Skip when hooks are active — Notification hook handles permission detection exactly.
    const dataType = data.type as string | undefined;
    if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
      if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered && !agent.leadAgentId) {
        startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
      }
      return;
    }

    // Verify parent is an active subagent-spawning tool (agent_progress handling)
    const parentToolName = agent.activeToolNames.get(parentToolId);
    if (!isSubagentTool(parentToolName)) return;

    const msg = data.message as Record<string, unknown> | undefined;
    if (!msg) return;

    const msgType = msg.type as string;
    const innerMsg = msg.message as Record<string, unknown> | undefined;
    const content = innerMsg?.content;
    if (!Array.isArray(content)) return;

    if (msgType === 'assistant') {
      let hasNonExemptSubTool = false;
      for (const block of content) {
        if (block.type === 'tool_use' && block.id) {
          const toolName = block.name || '';
          const status = formatToolStatus(toolName, block.input || {});
          console.log(
            `[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
          );

          // Track sub-tool IDs
          let subTools = agent.activeSubagentToolIds.get(parentToolId);
          if (!subTools) {
            subTools = new Set();
            agent.activeSubagentToolIds.set(parentToolId, subTools);
          }
          subTools.add(block.id);

          // Track sub-tool names (for permission checking)
          let subNames = agent.activeSubagentToolNames.get(parentToolId);
          if (!subNames) {
            subNames = new Map();
            agent.activeSubagentToolNames.set(parentToolId, subNames);
          }
          subNames.set(block.id, toolName);

          if (!exemptTools().has(toolName)) {
            hasNonExemptSubTool = true;
          }

          agents.broadcast({
            type: 'subagentToolStart',
            id: agentId,
            parentToolId,
            toolId: block.id,
            status,
            toolName,
          });
          agents.activity.transcript(
            agent,
            {
              kind: 'toolStart',
              toolId: block.id,
              toolName,
              input: block.input,
              subagent: true,
            },
            record.timestamp,
          );
        }
      }
      if (hasNonExemptSubTool && !agent.hookDelivered) {
        startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
      }
    } else if (msgType === 'user') {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          console.log(
            `[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
          );

          // Remove from tracking
          const subTools = agent.activeSubagentToolIds.get(parentToolId);
          if (subTools) {
            subTools.delete(block.tool_use_id);
          }
          const subNames = agent.activeSubagentToolNames.get(parentToolId);
          if (subNames) {
            subNames.delete(block.tool_use_id);
          }

          deferToolDone(agentId, agent, agents, {
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId: block.tool_use_id,
            ...(block.is_error === true ? { isError: true } : {}),
          });
          // A Sub-agent's failures are only ever reported here (its hook
          // carries agent_id and is left to the transcript).
          if (block.is_error === true) {
            agents.activity.transcript(
              agent,
              { kind: 'toolFailure', toolId: block.tool_use_id, subagent: true },
              record.timestamp,
            );
          }
        }
      }
      // If there are still active non-exempt sub-agent tools, restart the permission timer
      // (handles the case where one sub-agent completes but another is still stuck)
      let stillHasNonExempt = false;
      for (const [, subNames] of agent.activeSubagentToolNames) {
        for (const [, toolName] of subNames) {
          if (!exemptTools().has(toolName)) {
            stillHasNonExempt = true;
            break;
          }
        }
        if (stillHasNonExempt) break;
      }
      if (stillHasNonExempt && !agent.hookDelivered) {
        startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
      }
    }
  }

  /**
   * Link teammates within the same team.
   * The lead is the agent with no agentName (or one already marked isTeamLead).
   * Teammates get leadAgentId pointing to the lead. If only named teammates are
   * tracked, linking waits until the lead is detected.
   */
  function linkTeammates(_agentId: number, agent: AgentState, agents: AgentStateStore): void {
    const teamName = agent.teamName;
    if (!teamName) return;

    // Find all agents in this team
    const teamAgents: AgentState[] = [];
    for (const a of agents.values()) {
      if (
        a.teamName === teamName &&
        (a.providerId ?? 'claude') === (agent.providerId ?? 'claude')
      ) {
        teamAgents.push(a);
      }
    }

    // Determine lead: always prefer the agent WITHOUT agentName (the real lead has agentName=null).
    // This handles the case where a teammate is detected first and temporarily marked as lead,
    // then the real lead joins later.
    let lead: AgentState | undefined;
    for (const a of teamAgents) {
      if (!a.agentName) {
        lead = a;
        break;
      }
    }
    if (!lead) {
      // No agent without agentName -- an already-marked lead may carry one
      for (const a of teamAgents) {
        if (a.isTeamLead) {
          lead = a;
          break;
        }
      }
    }
    if (!lead) {
      // Every tracked member carries an agentName: they are all teammates and
      // the real lead's session isn't tracked (yet). Don't badge a teammate as
      // LEAD -- this re-runs and links properly once the lead is detected.
      return;
    }

    // Update all team members: mark lead, clear stale lead flags, link teammates
    for (const a of teamAgents) {
      if (a.id === lead.id) {
        a.isTeamLead = true;
        a.leadAgentId = undefined;
      } else {
        a.isTeamLead = false;
        a.leadAgentId = lead.id;
      }
    }
  }

  /** Check if a tool_result block indicates an async/background agent launch */
  function isAsyncAgentResult(block: Record<string, unknown>): boolean {
    const content = block.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).text === 'string' &&
          ((item as Record<string, unknown>).text as string).startsWith(
            'Async agent launched successfully.',
          )
        ) {
          return true;
        }
      }
    } else if (typeof content === 'string') {
      return content.startsWith('Async agent launched successfully.');
    }
    return false;
  }
  return {
    setHookProvider,
    getHookProvider,
    setBackgroundAgentDetectedCallback,
    setBackgroundAgentCompletedCallback,
    notifyBackgroundAgentCompleted,
    setTeamSwitchCallback,
    formatToolStatus,
    processTranscriptLine,
    flushToolDones,
    setCopilotRecordOptions,
    dispose,
  };
}

export type TranscriptParserContext = ReturnType<typeof createTranscriptParser>;
/** Compatibility facade for callers outside AgentRuntime. Runtime instances never mutate it. */
export const {
  setHookProvider,
  getHookProvider,
  setBackgroundAgentDetectedCallback,
  setBackgroundAgentCompletedCallback,
  notifyBackgroundAgentCompleted,
  setTeamSwitchCallback,
  formatToolStatus,
  processTranscriptLine,
  flushToolDones,
  setCopilotRecordOptions,
} = createTranscriptParser();
