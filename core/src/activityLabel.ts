/**
 * Activity label: the short text that says what an Agent is doing right now.
 *
 * One precedence, shared by every surface that shows it (the Character's
 * floating label, the webview Activity panel and the VS Code Activity Quick
 * Pick), so no two of them describe the same Agent differently. Tool statuses
 * ("Reading foo.ts") come from the provider's formatToolStatus and pass
 * through verbatim; everything else is the fixed copy below.
 */
export const ACTIVITY_LABEL = {
  needsApproval: 'Needs approval',
  waitingForInput: 'Waiting for input',
  thinking: 'Thinking…',
  active: 'Active',
  // The glossary state is Done; "Idle" is the user-facing copy.
  done: 'Idle',
} as const;

/** One tool row, as the webview (ToolActivity) and the server (activeToolStatuses) track it. */
export interface ActivityTool {
  readonly status: string;
  readonly done?: boolean;
  readonly permissionWait?: boolean;
}

// Providers' formatToolStatus prefixes a spawn's status with this ("Subtask: Research").
const SUBTASK_STATUS_PREFIX = 'Subtask:';

/** The Sub-agent name a spawn's status carries ("Subtask: Research" → "Research"), or ''. */
export function subtaskLabel(status: string | undefined): string {
  return status?.startsWith(SUBTASK_STATUS_PREFIX)
    ? status.slice(SUBTASK_STATUS_PREFIX.length).trim()
    : '';
}

export interface AgentActivityInput {
  /** Tool rows in start order. The newest running one wins. */
  readonly tools?: readonly ActivityTool[];
  /** The Agent's turn is in progress. */
  readonly isActive: boolean;
  /** A permission request is pending on the Agent itself. */
  readonly needsApproval?: boolean;
  /** The Agent went idle waiting on the user. */
  readonly waitingForInput?: boolean;
}

/** Active, or one of the three Inactive states (see CONTEXT.md, Agent Status). */
export type ActivityState = 'active' | 'permission' | 'input' | 'done';

export interface AgentActivity {
  readonly label: string;
  readonly state: ActivityState;
}

/**
 * Describe an Agent's activity. Precedence: waiting for input, then a pending
 * permission request, then the newest running tool, then the turn state.
 *
 * `sticky` keeps the last finished tool's status while the turn is still in
 * progress (the Character's floating label). Without it, an Active Agent with
 * no running tool reads "Thinking…" (the Activity panel and Quick Pick).
 */
export function describeAgentActivity(
  input: AgentActivityInput,
  options: { readonly sticky?: boolean } = {},
): AgentActivity {
  if (input.waitingForInput) return { label: ACTIVITY_LABEL.waitingForInput, state: 'input' };
  if (input.needsApproval) return { label: ACTIVITY_LABEL.needsApproval, state: 'permission' };
  const tools = input.tools ?? [];
  for (let index = tools.length - 1; index >= 0; index--) {
    const tool = tools[index];
    if (tool.done) continue;
    return tool.permissionWait
      ? { label: ACTIVITY_LABEL.needsApproval, state: 'permission' }
      : { label: tool.status, state: 'active' };
  }
  if (!input.isActive) return { label: ACTIVITY_LABEL.done, state: 'done' };
  if (options.sticky) {
    return { label: tools[tools.length - 1]?.status ?? ACTIVITY_LABEL.active, state: 'active' };
  }
  return { label: ACTIVITY_LABEL.thinking, state: 'active' };
}

/** Identity fields every surface names an Agent by. */
export interface AgentIdentity {
  readonly nickname?: string;
  readonly agentName?: string;
  readonly sessionName?: string;
  readonly folderName?: string;
}

/**
 * The name an Agent is shown by: the Nickname the user gave it, else its
 * Teammate name, else its session title, else its workspace folder. Undefined
 * when none is known, so each surface picks its own fallback ("Agent",
 * "Agent #3"). An empty nickname is a cleared one and falls through.
 */
export function agentDisplayName(agent: AgentIdentity | undefined): string | undefined {
  return (
    agent?.nickname || agent?.agentName || agent?.sessionName || agent?.folderName || undefined
  );
}
