// ── User-Level Layout Persistence (re-exports from server/) ──
// The user-level persistence contract, surfaced as one adapter-facing barrel so
// VS Code code never reaches into server/src/constants.js directly. Only
// LAYOUT_REVISION_KEY has an adapter consumer today (PixelAgentsViewProvider);
// the rest travel with it because they describe the same ~/.pixel-agents
// file layout, and splitting the set would leave the next caller guessing which
// half to import from where.
/** @public */
export {
  CONFIG_FILE_NAME,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from '../../server/src/constants.js';

// ── Settings Persistence (VS Code globalState keys) ─────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
export const GLOBAL_KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
export const GLOBAL_KEY_SHOW_AREAS = 'pixel-agents.showAreas';
export const GLOBAL_KEY_ZOOM = 'pixel-agents.zoom';

/**
 * Folder→Area mappings live inside the shared ~/.pixel-agents/config.json
 * (vscode.areaMappings), not in VS Code globalState. Kept here as a key
 * constant for callers that need to reference it symbolically.
 *
 * @public
 */
export const SETTING_KEY_AREA_MAPPINGS = 'pixel-agents.areaMappings';

// ── VS Code Settings (contributes.configuration keys) ───────
export const CONFIG_KEY_AUTO_SHOW_PANEL = 'pixel-agents.autoShowPanel';
export const CONFIG_KEY_AUTO_SPAWN_AGENT = 'pixel-agents.autoSpawnAgent';
export const CONFIG_KEY_PROVIDERS = 'pixel-agents.providers';
export const CONFIG_KEY_LAUNCH_PROVIDER = 'pixel-agents.launchProvider';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
export const COMMAND_NEW_AGENT = 'pixel-agents.newAgent';
export const COMMAND_SHOW_ACTIVITY = 'pixel-agents.showActivity';

// ── Status Bar ──────────────────────────────────────────────
export const STATUS_BAR_NEW_AGENT_ID = 'pixel-agents.statusBar.newAgent';
export const STATUS_BAR_NEW_AGENT_NAME = 'Pixel Agents: New Agent';
export const STATUS_BAR_NEW_AGENT_TEXT = '$(add) Agent';
export const STATUS_BAR_ACTIVITY_ID = 'pixel-agents.statusBar.activity';
export const STATUS_BAR_ACTIVITY_NAME = 'Pixel Agents: Show Activity';
export const STATUS_BAR_ACTIVITY_TEXT = '$(checklist) Activity';
/** Right-aligned; higher priority sits further left, keeping the pair together. */
export const STATUS_BAR_NEW_AGENT_PRIORITY = 100_000;
export const STATUS_BAR_ACTIVITY_PRIORITY = 99_999;
export const NEW_AGENT_FOLDER_PLACEHOLDER = 'Launch the agent in which folder?';

// ── Activity Quick Pick ─────────────────────────────────────
export const ACTIVITY_QUICK_PICK_TITLE = 'Pixel Agents: Activity';
export const ACTIVITY_QUICK_PICK_PLACEHOLDER =
  'Pick an agent to focus its terminal, or to select it in the office';
export const ACTIVITY_QUICK_PICK_EMPTY = '$(info) No active agents';
/** Coalesces a burst of store events into one Quick Pick refresh. */
export const ACTIVITY_QUICK_PICK_REFRESH_MS = 100;
/** Codicon per Activity state (core/src/activityLabel.ts ActivityState). */
export const ACTIVITY_QUICK_PICK_STATE_ICONS = {
  active: '$(sync~spin)',
  permission: '$(warning)',
  input: '$(question)',
  done: '$(check)',
} as const;
/** Prefix of a Sub-agent or Teammate row, after its indent. */
export const ACTIVITY_QUICK_PICK_NESTED_ICON = '$(arrow-small-right)';
/** One nesting level. An em space, because the Quick Pick collapses leading ASCII spaces. */
export const ACTIVITY_QUICK_PICK_INDENT = '\u2003';
export const ACTIVITY_QUICK_PICK_DETAIL_SEPARATOR = ' \u00b7 ';
/** How long a headless Agent picked in the Quick Pick waits for the office to
 *  open (first load included) before the pick is dropped. */
export const AGENT_REVEAL_TIMEOUT_MS = 10_000;
