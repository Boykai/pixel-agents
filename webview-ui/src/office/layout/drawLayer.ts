// Draw layer (zLayer): a per-Furniture depth offset in whole tile rows, applied on top of
// the default depth rules (footprint bottom, chair, surface, background tiles, walls).
// Idea ported from hootbu/pixel-agents (MIT) 69c433f; the fork only brought items to the front.
import {
  DRAW_LAYER_MAX,
  DRAW_LAYER_MIN,
  DRAW_LAYER_TIE_BREAK,
  TILE_SIZE,
} from '../../constants.js';

/** Coerce a persisted/untrusted zLayer to an integer in DRAW_LAYER_MIN..MAX (absent/invalid → 0). */
export function normalizeZLayer(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  // `|| 0` folds -0 into 0.
  return Math.min(DRAW_LAYER_MAX, Math.max(DRAW_LAYER_MIN, Math.round(raw))) || 0;
}

/**
 * Depth (zY) offset for a draw layer. Each layer moves the item one tile row
 * forward (+) or backward (−) in the painter's order, plus a small tie-break so
 * it wins (or loses) against whatever already sorts at its new depth. Layer 0 is
 * exactly 0, so an item without a draw layer sorts as it always did.
 */
export function drawLayerDepth(raw: unknown): number {
  const layer = normalizeZLayer(raw);
  if (layer === 0) return 0;
  return layer * TILE_SIZE + Math.sign(layer) * DRAW_LAYER_TIE_BREAK;
}
