/**
 * `saveAgentSeats`, shared by both surfaces (standalone /ws and the VS Code
 * webview bridge): persist the client's seats and apply any appearance change
 * to the live agents, which rebroadcasts it (`agentAppearance`) to every other
 * connected client. Nicknamed agents also refresh their nickname's profile,
 * so a later agent under the same nickname gets this look and seat back.
 */

import type { NicknameProfile } from '../../core/src/schemas.js';
import type { AgentStateStore } from './agentStateStore.js';
import { HUE_SHIFT_MAX_DEG } from './constants.js';
import { getPaletteCount } from './paletteAssigner.js';

interface SeatAssignment {
  palette?: unknown;
  hueShift?: unknown;
  seatId?: unknown;
}

function isValidPalette(value: unknown, paletteCount: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < paletteCount;
}

function isValidHueShift(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= HUE_SHIFT_MAX_DEG
  );
}

/**
 * @param paletteCount - Ceiling for a valid palette. External asset directories
 *   can add char_N.png beyond the bundled 6, so it defaults to the count the
 *   loaded assets reported rather than PALETTE_COUNT.
 */
export function applySavedSeats(
  store: AgentStateStore,
  rawSeats: unknown,
  paletteCount: number = getPaletteCount(),
): void {
  if (!rawSeats || typeof rawSeats !== 'object' || Array.isArray(rawSeats)) return;
  const seats = rawSeats as Record<string, SeatAssignment>;
  let appearanceChanged = false;
  const looks: NicknameProfile[] = [];
  for (const [idStr, meta] of Object.entries(seats)) {
    if (!meta || typeof meta !== 'object') continue;
    const agent = store.get(Number(idStr));
    if (!agent) continue;
    // Out-of-range values (a remote client, a hand-edited payload) keep the
    // current value instead of rendering as a glitch.
    const palette = isValidPalette(meta.palette, paletteCount) ? meta.palette : agent.palette;
    const hueShift = isValidHueShift(meta.hueShift) ? meta.hueShift : (agent.hueShift ?? 0);
    if (palette !== undefined && store.setAppearance(agent.id, palette, hueShift)) {
      appearanceChanged = true;
    }
    if (agent.nickname) {
      looks.push({
        nickname: agent.nickname,
        palette: agent.palette,
        hueShift: agent.hueShift,
        seatId: typeof meta.seatId === 'string' && meta.seatId ? meta.seatId : undefined,
      });
    }
  }
  store
    .getAdapter()
    ?.saveSeats(seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>);
  store.rememberNicknameLooks(looks);
  // Agents persist their palette too; keep that copy in step with the seats.
  if (appearanceChanged) store.persist();
}
