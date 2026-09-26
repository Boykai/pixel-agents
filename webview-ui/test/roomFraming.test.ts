import { expect, it } from 'vitest';

import { ROOM_FRAME_CONTEXT_TILES, ROOM_FRAME_MARGIN_PX, TILE_SIZE } from '../src/constants.js';
import { frameLayoutBounds, overlayProjection } from '../src/office/projection.js';

it.each([
  { width: 960, height: 720, top: 64, bottom: 540, dpr: 1 },
  { width: 360, height: 640, top: 64, bottom: 380, dpr: 1 },
  { width: 360, height: 640, top: 64, bottom: 380, dpr: 2 },
])(
  'frames the room and entrance context above the toolbar at $width CSS pixels / DPR $dpr',
  (viewport) => {
    const layout = { cols: 64, rows: 64 };
    const room = { col: 46, row: 50, cols: 10, rows: 10 };
    const frame = frameLayoutBounds(layout, room, viewport, 8, viewport.dpr);
    expect(Number.isInteger(frame.zoom)).toBe(true);
    expect(frame.zoom).toBeGreaterThanOrEqual(1);
    const projection = overlayProjection(layout, viewport, frame.zoom, frame.pan, viewport.dpr);
    expect(
      projection.toScreenX((room.col - ROOM_FRAME_CONTEXT_TILES) * TILE_SIZE),
    ).toBeGreaterThanOrEqual(ROOM_FRAME_MARGIN_PX - 1);
    expect(
      projection.toScreenX((room.col + room.cols + ROOM_FRAME_CONTEXT_TILES) * TILE_SIZE),
    ).toBeLessThanOrEqual(viewport.width - ROOM_FRAME_MARGIN_PX + 1);
    expect(
      projection.toScreenY((room.row - ROOM_FRAME_CONTEXT_TILES) * TILE_SIZE),
    ).toBeGreaterThanOrEqual(viewport.top + ROOM_FRAME_MARGIN_PX - 1);
    expect(
      projection.toScreenY((room.row + room.rows + ROOM_FRAME_CONTEXT_TILES) * TILE_SIZE),
    ).toBeLessThanOrEqual(viewport.bottom - ROOM_FRAME_MARGIN_PX + 1);
  },
);

it('does not zoom in over the user-selected zoom level', () => {
  const frame = frameLayoutBounds(
    { cols: 30, rows: 30 },
    { col: 10, row: 10, cols: 7, rows: 7 },
    { width: 1200, height: 1000, top: 64, bottom: 850 },
    2,
    2,
  );
  expect(frame.zoom).toBe(2);
});
