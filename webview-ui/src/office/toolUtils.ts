/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps = new Map<
  string,
  {
    readingTools: Set<string>;
    subagentToolNames: Set<string>;
    displayName?: string;
  }
>();

export function setProviderCapabilities(caps: {
  providerId?: string;
  displayName?: string;
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.set(caps.providerId ?? 'claude', {
    readingTools: new Set(caps.readingTools),
    subagentToolNames: new Set(caps.subagentToolNames),
    displayName: caps.displayName,
  });
}

export function providerDisplayName(providerId: string): string {
  return providerCaps.get(providerId)?.displayName ?? providerId;
}

export function isReadingToolName(name: string | null | undefined, providerId = 'claude'): boolean {
  return typeof name === 'string' && providerCaps.get(providerId)?.readingTools.has(name) === true;
}

export function isSubagentToolName(
  name: string | null | undefined,
  providerId = 'claude',
): boolean {
  return (
    typeof name === 'string' && providerCaps.get(providerId)?.subagentToolNames.has(name) === true
  );
}
