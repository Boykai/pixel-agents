/**
 * https://docs.github.com/en/copilot/reference/hooks-reference (checked 2026-09-24).
 * sessionEnd is NOT proof an App session ended. Child starts lack instance IDs,
 * and built-in general-purpose children do not emit these hooks at all.
 */
export const COPILOT_HOOK_EVENTS = [
  'sessionStart',
  'agentStop',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'notification',
] as const;

export const COPILOT_HOOK_SCRIPT_NAME = 'copilot-hook.js';
export const COPILOT_HOOK_CONFIG_NAME = 'pixel-agents.json';
export const COPILOT_HOOK_SCRIPT_BANNER = '#!/usr/bin/env node\n// Pixel Agents Copilot hook v1';
/** Missing or broken bridge must not produce a nonzero preToolUse exit. No shell is involved. */
export const COPILOT_HOOK_BOOTSTRAP = 'try { require(process.argv[1]); } catch {}';
export const COPILOT_HOOK_NODE_PROBE =
  "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)";
export const COPILOT_HOOK_TIMEOUT_SECONDS = 3;
export const COPILOT_HOOK_DEADLINE_MS = 1500;
export const COPILOT_HOOK_HTTP_TIMEOUT_MS = 750;
export const COPILOT_HOOK_MAX_INPUT_BYTES = 256 * 1024;
export const COPILOT_HOOK_MAX_PAYLOAD_BYTES = 16 * 1024;
export const COPILOT_HOOK_MAX_FIELD_LENGTH = 2048;
export const COPILOT_HOOK_MAX_DISCOVERY_BYTES = 16 * 1024;
export const COPILOT_HOOK_MAX_TARGETS = 32;
export const COPILOT_HOOK_MAX_TOOL_CALLS = 32;
export const COPILOT_HOOK_FILE_MODE = 0o600;
export const COPILOT_HOOK_WRITE_ATTEMPTS = 3;
export const COPILOT_NOTIFICATION_TYPES = [
  'shell_completed',
  'shell_detached_completed',
  'agent_completed',
  'agent_idle',
  'permission_prompt',
  'elicitation_dialog',
] as const;
