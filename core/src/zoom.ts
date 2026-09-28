import { ZOOM_MAX, ZOOM_MIN } from './constants.js';

/**
 * Parse a persisted or client-sent zoom level. Zoom is an integer
 * device-pixels-per-sprite-pixel (pixel-perfect rendering depends on it), so
 * anything that is not an integer — fractions, NaN, Infinity, strings, null —
 * is treated as unset (`undefined`), and an out-of-range integer is clamped to
 * `ZOOM_MIN..ZOOM_MAX`. The server and the webview both parse through here, so
 * they agree on what a stored value means.
 */
export function parseZoom(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
}
