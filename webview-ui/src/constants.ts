import type { ColorValue } from './components/ui/types.js';

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48;
export const WALK_FRAME_DURATION_SEC = 0.15;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
export const BUTTON_MIN_RADIUS = 6;
export const BUTTON_RADIUS_ZOOM_FACTOR = 3;
export const BUTTON_ICON_SIZE_FACTOR = 0.45;
export const BUTTON_LINE_WIDTH_MIN = 1.5;
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;
export const FALLBACK_FLOOR_COLOR = '#808080';

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)';
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)';
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)';
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)';
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2];
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)';
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)';
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)';
export const GHOST_VALID_TINT = '#00ff00';
export const GHOST_INVALID_TINT = '#ff0000';
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4';
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)';
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)';
export const BUTTON_ICON_COLOR = '#fff';
export const CANVAS_FALLBACK_TILE_COLOR = '#444';
export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';
export const WALL_COLOR = '#3A3A5C';

// ── Camera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1;
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5;

// ── Zoom ─────────────────────────────────────────────────────
// Bounds live in core so the server clamps the persisted zoom identically.
export { ZOOM_MAX, ZOOM_MIN } from '../../core/src/constants.js';
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
export const ZOOM_LEVEL_FADE_DELAY_MS = 1500;
export const ZOOM_LEVEL_HIDE_DELAY_MS = 2000;
export const ZOOM_LEVEL_FADE_DURATION_SEC = 0.5;
export const ZOOM_SCROLL_THRESHOLD = 50;
/** Settle time before a zoom change is persisted (Ctrl+scroll steps in bursts). */
export const ZOOM_SAVE_DEBOUNCE_MS = 500;
export const PAN_MARGIN_FRACTION = 0.25;

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50;
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;

// ── Signs & Draw layers ──────────────────────────────────────
/** Furniture type id of the Sign (pixel text) — a built-in catalog entry, not an asset. */
export const SIGN_TYPE = 'PIXEL_TEXT';
export const SIGN_LABEL = 'Sign';
export const SIGN_TEXT_MAX_LENGTH = 32;
/** Pixel font glyph sizes a Sign can use (keys of PIXEL_FONTS). */
export const SIGN_FONT_SIZES = ['3x5', '5x7'] as const;
export const SIGN_DEFAULT_FONT_SIZE = '3x5';
/** Sprite pixels per font pixel. */
export const SIGN_SCALE_MIN = 1;
export const SIGN_SCALE_MAX = 5;
export const SIGN_DEFAULT_COLOR = '#FFFFFF';
export const SIGN_COLOR_PRESETS: ReadonlyArray<{ label: string; hex: string }> = [
  { label: 'White', hex: '#FFFFFF' },
  { label: 'Red', hex: '#FF0000' },
  { label: 'Blue', hex: '#4488FF' },
  { label: 'Green', hex: '#00CC00' },
  { label: 'Yellow', hex: '#FFCC00' },
  { label: 'Orange', hex: '#FF8800' },
  { label: 'Pink', hex: '#FF66CC' },
  { label: 'Cyan', hex: '#00CCCC' },
  { label: 'Purple', hex: '#9966FF' },
  { label: 'Lime', hex: '#66FF00' },
  { label: 'Coral', hex: '#FF6666' },
  { label: 'Gray', hex: '#888888' },
  { label: 'Teal', hex: '#008888' },
  { label: 'Black', hex: '#222222' },
];
/** Text sprites kept in memory; the oldest is evicted past this. */
export const SIGN_SPRITE_CACHE_MAX = 256;
/** Sign editor preview: largest on-screen zoom, width it aims to fill, minimum box. */
export const SIGN_PREVIEW_MAX_ZOOM = 3;
export const SIGN_PREVIEW_TARGET_WIDTH_PX = 200;
export const SIGN_PREVIEW_MIN_WIDTH_PX = 120;
export const SIGN_PREVIEW_MIN_HEIGHT_PX = 30;
export const SIGN_PREVIEW_PADDING_PX = 8;
export const EDIT_BUTTON_BG = 'rgba(50, 170, 80, 0.85)';
/** Draw layer: whole-tile-row depth offsets a Furniture item can be moved by. */
export const DRAW_LAYER_MIN = -4;
export const DRAW_LAYER_MAX = 4;
/** Extra depth nudge so a layered item wins/loses the tie with whatever sits on its new row. */
export const DRAW_LAYER_TIE_BREAK = 0.25;
/**
 * How far in front of a LAYERED desk the items on it sort. Unlayered desks keep the
 * default +0.5; a layered desk sits only DRAW_LAYER_TIE_BREAK off its new row, so
 * +0.5 would carry its items past what the desk itself stays behind.
 */
export const DRAW_LAYER_SURFACE_OFFSET = DRAW_LAYER_TIE_BREAK / 2;
export const LAYER_BUTTON_BG = 'rgba(180, 140, 50, 0.85)';
/** Device-pixel gap between the stacked bring-forward / send-backward canvas buttons. */
export const LAYER_BUTTON_GAP_PX = 2;
/** Alpha of a canvas editor button that can't act (e.g. already at the top Draw layer). */
export const EDITOR_BUTTON_DISABLED_ALPHA = 0.35;
/** Device-pixel slop around a round canvas editor button's hit circle. */
export const EDITOR_BUTTON_HIT_PADDING_PX = 2;

// ── Room generation ──────────────────────────────────────────
export const ROOM_INTERIOR_SIZES = [5, 6, 7, 8] as const;
export const ROOM_WALL_THICKNESS = 1;
export const ROOM_AISLE_WIDTH = 1;
export const ROOM_LARGE_INTERIOR_MIN = 7;
export const ROOM_FRAME_MARGIN_PX = 24;
export const ROOM_FRAME_TOP_INSET_PX = 64;
export const ROOM_FRAME_CONTEXT_TILES = 1;
export const ROOM_FLOOR_PATTERNS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const ROOM_ASSETS = {
  desk: 'DESK_FRONT',
  computer: 'PC_FRONT_OFF',
  deskChair: 'CUSHIONED_CHAIR_BACK',
  table: 'SMALL_TABLE_SIDE',
  rightChair: 'CUSHIONED_CHAIR_SIDE',
  leftChair: 'CUSHIONED_CHAIR_SIDE:left',
  sofa: 'SOFA_FRONT',
  coffeeTable: 'COFFEE_TABLE',
  decoration: 'POT',
} as const;
export const ROOM_THEME_LABELS = {
  workspace: 'workspace',
  meeting: 'meeting room',
  lounge: 'lounge',
} as const;
export const ROOM_MIN_SEATS = { workspace: 1, meeting: 2, lounge: 2 } as const;
export const ROOM_CANDIDATE_UID_PREFIX = 'generated-room-';

// ── Layout Import/Export (browser-native, standalone) ────────
/** Suggested filename when exporting the office layout from the standalone browser. */
export const LAYOUT_EXPORT_FILENAME = 'pixel-agents-layout.json';
/** MIME type for the exported layout Blob. */
export const LAYOUT_EXPORT_MIME = 'application/json';
export const DEFAULT_FLOOR_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 };
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// ── Carpets ──────────────────────────────────────────────────
/** Main (lowest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_COLOR: ColorValue = { h: 0, s: 71, b: -32, c: 0, colorize: true };
/** Accent (highest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_ACCENT_COLOR: ColorValue = {
  h: 34,
  s: 64,
  b: 21,
  c: 0,
  colorize: true,
};
/** Keyboard key that switches from CARPET_PAINT to CARPET_PICK while editing. */
export const KEY_CARPET_PICK = 'p';

// ── Areas (named, colored workspace-folder zones) ────────────
/** Color palette assigned to new Areas in rotation (cycles when more areas exist). */
export const AREA_DEFAULT_COLORS: readonly string[] = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
] as const;
/** Translucent overlay alpha for area tile fills. */
export const AREA_OVERLAY_ALPHA = 0.25;
/** Alpha multiplier applied to the actively-selected area's overlay. */
export const AREA_ACTIVE_ALPHA_MULTIPLIER = 1.6;
/** Base font size (pixel-pre-zoom) for area centroid labels. */
export const AREA_LABEL_FONT_SIZE_PX = 14;
/** Minimum on-screen label size to keep labels legible at low zoom. */
export const AREA_LABEL_MIN_FONT_SIZE_PX = 12;
/** Alpha of the area label text. */
export const AREA_LABEL_ALPHA = 1.0;
/** Fallback label color when an area has no color set (shouldn't happen in practice). */
export const AREA_LABEL_FALLBACK_COLOR = '#ffffff';
/** Drop-shadow color behind area labels for legibility on light backgrounds. */
export const AREA_LABEL_SHADOW_COLOR = '#000000';
/** Drop-shadow alpha behind area labels. */
export const AREA_LABEL_SHADOW_ALPHA = 0.6;

// ── VisualColorPicker (HSV wheel + brightness for carpets) ───
export const VISUAL_COLOR_PICKER_SV_SIZE_PX = 180;
export const VISUAL_COLOR_PICKER_HUE_WIDTH_PX = 20;
export const VISUAL_COLOR_PICKER_MARKER_RADIUS_PX = 6;
/**
 * The hue bar gradient is intrinsic to the color-picking interaction, not a
 * theme color — it must span the full hue circle. Centralized here so the
 * component body stays free of inline color literals. (The saturation/brightness
 * square is painted to a canvas from the carpet HSL model, not a CSS gradient.)
 */
export const VISUAL_COLOR_PICKER_HUE_GRADIENT =
  'linear-gradient(to bottom, ' +
  '#ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, ' +
  '#00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)';
export const VISUAL_COLOR_PICKER_MARKER_BORDER = '2px solid #fff';
export const VISUAL_COLOR_PICKER_MARKER_SHADOW = '0 0 0 1px rgba(0,0,0,0.6)';
/** Width of the collapsed swatch + hex trigger row (compact mode). */
export const VISUAL_COLOR_PICKER_COMPACT_WIDTH_PX = 160;
/** Swatch square size shown in the collapsed trigger. */
export const VISUAL_COLOR_PICKER_SWATCH_PX = 22;
/** Gap (px) between the collapsed trigger and the expanded popup panel. */
export const VISUAL_COLOR_PICKER_POPUP_GAP_PX = 6;

// ── Notification Sound (done: ascending chime) ─────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25; // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51; // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0;
export const NOTIFICATION_NOTE_2_START_SEC = 0.1;
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18;
export const NOTIFICATION_VOLUME = 0.14;

// ── Permission Sound (attention: descending double tap) ────
export const PERMISSION_NOTE_1_HZ = 880; // A5
export const PERMISSION_NOTE_2_HZ = 659.25; // E5 (down a fourth)
export const PERMISSION_NOTE_1_START_SEC = 0;
export const PERMISSION_NOTE_2_START_SEC = 0.12;
export const PERMISSION_NOTE_DURATION_SEC = 0.15;
export const PERMISSION_VOLUME = 0.12;

// ── Furniture Animation ─────────────────────────────────────
export const FURNITURE_ANIM_INTERVAL_SEC = 0.2;

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;
export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 6;
export const AUTO_ON_FACING_DEPTH = 3;
export const AUTO_ON_SIDE_DEPTH = 2;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;
export const AGENT_DETAILS_HIDE_DELAY_MS = 450;
export const AGENT_LABEL_EDGE_INSET_PX = 56;

// ── Costume panel (agent appearance) ────────────────────────
/** Integer zoom of the character previews in the Costume panel. */
export const COSTUME_PREVIEW_ZOOM = 2;
/** Preview button size: a 16×32 frame at COSTUME_PREVIEW_ZOOM, 2 px padding, 2 px border. */
export const COSTUME_PREVIEW_WIDTH_PX = 40;
export const COSTUME_PREVIEW_HEIGHT_PX = 72;
/** Hue slider step and upper bound in degrees; 360 would repeat 0. */
export const COSTUME_HUE_STEP_DEG = 15;
export const COSTUME_HUE_MAX_DEG = 345;
/** Palette previews per row (the bundled six fit one row). */
export const COSTUME_GRID_COLUMNS = 6;
/** Quiet period before a costume change is saved (and relayed to other clients). */
export const COSTUME_SAVE_DEBOUNCE_MS = 150;

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;
/** World px above the greeter's anchor (feet) where the bubble's bottom sits.
 *  Kept well above the head target (INTRO_TAIL_TARGET_RISE_WORLD) so the
 *  tail squares have a visible run between bubble and head. */
export const INTRO_BUBBLE_ANCHOR_RISE_WORLD = 44;
/** World px right of the greeter's center where the bubble's left edge starts —
 *  just clear of the sprite so the tail points down-left at the head. */
export const INTRO_BUBBLE_OFFSET_X_WORLD = 10;
/** Bubble width cap (CSS px) and the margin kept from the container edges.
 *  Wide on purpose: the disclosure reads as three short paragraphs instead of
 *  a tall column (still clamped to the container on narrow panels). */
export const INTRO_BUBBLE_MAX_WIDTH_PX = 560;
export const INTRO_BUBBLE_EDGE_MARGIN_PX = 4;
/** Where the Intro's Claude Code step sends people who don't have it yet. */
export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';
export const CLAUDE_CODE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
/** Speech-tail squares: placed at fraction `t` along the segment from the
 *  bubble's nearest edge point to the greeter's head, shrinking toward the
 *  speaker. Recomputed every frame so the tail stays connected no matter where
 *  edge-clamping or panning puts the bubble relative to the character. */
export const INTRO_TAIL_STEPS = [
  { t: 0.25, size: 12 },
  { t: 0.55, size: 9 },
  { t: 0.82, size: 6 },
] as const;
/** World px above the greeter's anchor (feet) the tail points at — the head. */
export const INTRO_TAIL_TARGET_RISE_WORLD = 26;
/** Camera-offset caps while centering character + bubble. The ideal composition
 *  assumes the bubble fits beside/above the character; when it can't (narrow or
 *  short viewports clamp the bubble to the screen), uncapped offsets shove the
 *  greeter to the viewport edge. Horizontal offset is capped to this fraction
 *  of the viewport; vertical offset always keeps this many world px of the
 *  character visible above the bottom edge. */
export const INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION = 0.25;
export const INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD = 48;
/** Extra downward camera shift (CSS px) so the character+bubble composition
 *  sits a bit above the vertical center instead of dead-centered. */
export const INTRO_CAMERA_DOWN_SHIFT_PX = 50;

// ── Context Fuel Gauge ──────────────────────────────────────
/** Window assumed before the runtime reports one (it always does for agents
 *  that have taken a turn; this only covers characters created ahead of it). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_WARN_THRESHOLD = 0.6;
export const CONTEXT_DANGER_THRESHOLD = 0.8;
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
export const CONTEXT_GAUGE_COLOR_WARN = '#ffcc00';
export const CONTEXT_GAUGE_COLOR_DANGER = '#ff8800';
export const CONTEXT_GAUGE_COLOR_CRITICAL = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Token Usage panel ───────────────────────────────────────
/** Breakdown colors, ported from hootbu/pixel-agents' UsagePanel. */
export const TOKEN_USAGE_INPUT_COLOR = '#5a8cff';
export const TOKEN_USAGE_OUTPUT_COLOR = '#5ac88c';
export const TOKEN_USAGE_CACHE_WRITE_COLOR = '#cca700';
export const TOKEN_USAGE_CACHE_READ_COLOR = '#9a6adf';
export const TOKEN_USAGE_BAR_BG = 'rgba(255, 255, 255, 0.06)';
/** Breakdown-bar segments smaller than this share of the total (%) are not drawn. */
export const TOKEN_USAGE_MIN_SEGMENT_PERCENT = 0.5;

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

// ── Pets ────────────────────────────────────────────────────────
/** Walking speed in world pixels per second (matches character walk speed visually but slower). */
export const PET_WALK_SPEED_PX_PER_SEC = 32;
/** Time per WALK animation cycle step (4 cycle steps × 0.15s = 0.6s per loop). */
export const PET_WALK_FRAME_DURATION_SEC = 0.15;
/** Time per IDLE animation cycle step (4 cycle steps × 0.3s = 1.2s per loop). */
export const PET_IDLE_FRAME_DURATION_SEC = 0.3;
/** Walk cycle: 4-step lookup into the 3-frame walkDown/walkUp/walkRight arrays. */
export const PET_WALK_SEQUENCE = [0, 1, 0, 2] as const;
/** Idle cycle: 4-step lookup into the 3-frame idleDown/idleUp arrays. */
export const PET_IDLE_SEQUENCE = [0, 1, 2, 1] as const;
/** Minimum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MIN_SEC = 3.0;
/** Maximum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MAX_SEC = 15.0;
/** Seconds between FOLLOW path re-computations. */
export const PET_FOLLOW_RECALC_INTERVAL_SEC = 1.0;
/** Probability that a pet enters FOLLOW (instead of WALK) when wanderTimer expires. */
export const PET_FOLLOW_CHANCE = 0.3;
/** Maximum Manhattan distance (tiles) at which a character can become a follow target. */
export const PET_FOLLOW_RADIUS_TILES = 3;
/** Minimum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MIN_SEC = 5.0;
/** Maximum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MAX_SEC = 15.0;
// Pet behaviors below are ported from hootbu/pixel-agents (MIT). When a pet's IDLE pause ends
// and it doesn't FOLLOW a nearby character, one roll in [0, 1) picks its next behavior from
// cumulative bands: wander 40%, APPROACH an inactive character 30%, SLEEP 20%, FLEE 10%.
/** Upper bound of the wander band of the behavior roll. */
export const PET_WANDER_ROLL_MAX = 0.4;
/** Upper bound of the APPROACH band of the behavior roll (starts at PET_WANDER_ROLL_MAX). */
export const PET_APPROACH_ROLL_MAX = 0.7;
/** Upper bound of the SLEEP band of the behavior roll; rolls at or above it FLEE. */
export const PET_SLEEP_ROLL_MAX = 0.9;
/** Minimum seconds a pet sleeps. */
export const PET_SLEEP_DURATION_MIN_SEC = 15.0;
/** Maximum seconds a pet sleeps. */
export const PET_SLEEP_DURATION_MAX_SEC = 40.0;
/** Minimum seconds a pet sits beside the character it approached. */
export const PET_SIT_DURATION_MIN_SEC = 8.0;
/** Maximum seconds a pet sits beside the character it approached. */
export const PET_SIT_DURATION_MAX_SEC = 20.0;
/** Maximum Manhattan distance (tiles) at which an active character makes a pet FLEE. */
export const PET_FLEE_RADIUS_TILES = 3;
/** FLEE speed in world pixels per second (twice the walk speed). */
export const PET_FLEE_SPEED_PX_PER_SEC = 64;
/** Time per FLEE walk-cycle step (twice as fast as PET_WALK_FRAME_DURATION_SEC). */
export const PET_FLEE_FRAME_DURATION_SEC = 0.075;
/** Hit-box half-width (world px) for pet click detection. */
export const PET_HIT_HALF_WIDTH = 8;
/** Hit-box height (world px) measured upward from the bottom-center anchor. */
export const PET_HIT_HEIGHT = 16;
/** Zoom factor used to draw pet thumbnails in the EditorToolbar Pets tab. */
export const PET_THUMB_ZOOM = 2;
/** Scale margin so the pet thumbnail fills the ItemSelect cell without touching the edges. */
export const PET_THUMB_SCALE_MARGIN = 0.85;
/** Fallback background fill for sprite-less thumbnail (used while pet sprites are loading). */
export const EMPTY_SPRITE_THUMBNAIL_BG = '#333';
/** Maximum string length for a PlacedPet.id (defends against pathologically-long layout entries). */
export const MAX_PET_ID_LENGTH = 128;
