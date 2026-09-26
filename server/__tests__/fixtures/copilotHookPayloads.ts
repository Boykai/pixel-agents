// Synthetic values matching the camelCase command-hook input schemas:
// https://docs.github.com/en/copilot/reference/hooks-reference (2026-09-26).
// Unlike transcript tool records, these inputs contain no toolCallId.
const common = {
  sessionId: 'documented-session',
  timestamp: 1790445600000,
  cwd: 'C:\\work\\example',
  toolName: 'view',
  toolArgs: { path: 'example.ts' },
};

export const copilotToolHookPayloads = [
  { event: 'preToolUse', input: { ...common } },
  {
    event: 'postToolUse',
    input: {
      ...common,
      toolResult: { resultType: 'success', textResultForLlm: 'Synthetic file contents' },
    },
  },
  { event: 'postToolUseFailure', input: { ...common, error: 'Synthetic read failure' } },
] as const;
