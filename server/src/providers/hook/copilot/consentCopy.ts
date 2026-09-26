import { COPILOT_HOOK_EVENTS } from './constants.js';

export const CONSENT_INSTALL_HEADLINE = 'Enable GitHub Copilot hooks?';
export const CONSENT_DISCLOSURE = [
  `Pixel Agents creates ~/.copilot/hooks/pixel-agents.json (or $COPILOT_HOME/hooks/pixel-agents.json) ` +
    `for ${COPILOT_HOOK_EVENTS.length} Copilot CLI events, and copies its bridge to ` +
    '~/.pixel-agents/hooks/copilot-hook.js. This applies to all local Copilot sessions loading user hooks. ' +
    'Other hook files and settings are not changed; an existing unrecognized file is refused.',
  'Hooks send session IDs, timestamps, workspace/transcript paths and notification types ' +
    'to authenticated Pixel Agents servers on this machine. Prompts, tool arguments, tool results, ' +
    'error text and notification messages are not forwarded. The server listens locally by default; ' +
    'starting it with --host can expose the office on your network.',
  'The bridge observes only: it never approves tools, changes prompts or forces a turn to continue. ' +
    'It requires Node.js 18 or later on PATH. An unavailable Pixel Agents server is ignored. ' +
    'Tool hooks are not installed: they lack call IDs, so tool activity is read from local transcripts.',
  'Remove these hooks from Settings → Instant Detection (Hooks), or delete only pixel-agents.json ' +
    'from the hooks directory. The shared bridge file is retained for other adapters. ' +
    'Restart existing Copilot CLI/App sessions to load changed hooks; Pixel Agents never restarts them. ' +
    'App hook delivery and session termination are not yet verified; sessionEnd and child hooks are not installed.',
].join('\n\n');
