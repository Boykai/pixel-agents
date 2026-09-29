/**
 * World coordinates → screen coordinates, in one place.
 *
 * The office is drawn by centering the map in the canvas and then applying the
 * pan, both snapped to whole device pixels so sprites stay on the pixel grid.
 * That formula was reproduced in the renderer and in each DOM overlay that
 * floats something above a character; a copy that rounds differently puts the
 * overlay a pixel off the sprite it is labelling, which is invisible in review
 * and obvious on screen.
 *
 * Deliberately free of DOM access — `dpr` is passed in, not read from
 * `window`. Reading the environment belongs at the component boundary; a state
 * or math module that reaches for `window` drags the DOM into every module
 * graph that imports it.
 */

import { ROOM_FRAME_CONTEXT_TILES, ROOM_FRAME_MARGIN_PX, ZOOM_MIN } from '../constants.js';
import { TILE_SIZE } from './types.js';

/** Device-pixel offset of the map's top-left corner inside the canvas.
 *  This is the renderer's own frame of reference — overlays go through
 *  {@link overlayProjection} instead of calling this directly. */
export function mapOffset(
  canvasWidth: number,
  canvasHeight: number,
  cols: number,
  rows: number,
  zoom: number,
  panX: number,
  panY: number,
): { offsetX: number; offsetY: number } {
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  return {
    offsetX: Math.floor((canvasWidth - mapW) / 2) + Math.round(panX),
    offsetY: Math.floor((canvasHeight - mapH) / 2) + Math.round(panY),
  };
}

/** The pan that puts a world point — the followed Character or Pet — at the
 *  canvas center. It depends on the zoom but not on the canvas size, and the
 *  camera follow recomputes it every frame, so a zoom that changes mid-follow
 *  (a user zoom, or the stored zoom `settingsLoaded` restores after a reload)
 *  re-centers the camera instead of drifting. */
export function centeringPan(
  layout: { cols: number; rows: number },
  focus: { x: number; y: number },
  zoom: number,
): { x: number; y: number } {
  return {
    x: (layout.cols * TILE_SIZE * zoom) / 2 - focus.x * zoom,
    y: (layout.rows * TILE_SIZE * zoom) / 2 - focus.y * zoom,
  };
}

/** Frame a tile rectangle inside the canvas area left unobscured by editor controls. */
export function frameLayoutBounds(
  layout: { cols: number; rows: number },
  bounds: { col: number; row: number; cols: number; rows: number },
  viewport: { width: number; height: number; top: number; bottom: number },
  currentZoom: number,
  dpr: number,
): { zoom: number; pan: { x: number; y: number } } {
  const worldWidth = (bounds.cols + ROOM_FRAME_CONTEXT_TILES * 2) * TILE_SIZE;
  const worldHeight = (bounds.rows + ROOM_FRAME_CONTEXT_TILES * 2) * TILE_SIZE;
  const width = Math.max(1, viewport.width - ROOM_FRAME_MARGIN_PX * 2) * dpr;
  const height = Math.max(1, viewport.bottom - viewport.top - ROOM_FRAME_MARGIN_PX * 2) * dpr;
  const zoom = Math.max(
    ZOOM_MIN,
    Math.min(currentZoom, Math.floor(Math.min(width / worldWidth, height / worldHeight))),
  );
  const { offsetX, offsetY } = mapOffset(
    Math.round(viewport.width * dpr),
    Math.round(viewport.height * dpr),
    layout.cols,
    layout.rows,
    zoom,
    0,
    0,
  );
  return {
    zoom,
    pan: {
      x: (viewport.width * dpr) / 2 - offsetX - (bounds.col + bounds.cols / 2) * TILE_SIZE * zoom,
      y:
        ((viewport.top + viewport.bottom) * dpr) / 2 -
        offsetY -
        (bounds.row + bounds.rows / 2) * TILE_SIZE * zoom,
    },
  };
}

/** Projects world points into CSS pixels within the overlay container that
 *  sits on top of the canvas. */
export interface OverlayProjection {
  toScreenX(worldX: number): number;
  toScreenY(worldY: number): number;
  /** Container size in world units — what the viewport currently covers.
   *  Used to cap overlay offsets against the visible area. */
  readonly viewportWorldWidth: number;
  readonly viewportWorldHeight: number;
  /** CSS px → world units, for sizing overlay geometry in world terms. */
  toWorldLength(cssPx: number): number;
}

export function overlayProjection(
  layout: { cols: number; rows: number },
  containerRect: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
  dpr: number,
): OverlayProjection {
  const canvasW = Math.round(containerRect.width * dpr);
  const canvasH = Math.round(containerRect.height * dpr);
  const { offsetX, offsetY } = mapOffset(
    canvasW,
    canvasH,
    layout.cols,
    layout.rows,
    zoom,
    pan.x,
    pan.y,
  );
  return {
    toScreenX: (worldX) => (offsetX + worldX * zoom) / dpr,
    toScreenY: (worldY) => (offsetY + worldY * zoom) / dpr,
    viewportWorldWidth: canvasW / zoom,
    viewportWorldHeight: canvasH / zoom,
    toWorldLength: (cssPx) => (cssPx * dpr) / zoom,
  };
}
