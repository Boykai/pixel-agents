import assert from 'node:assert/strict';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_COLS, MAX_ROWS, ROOM_ASSETS, ROOM_INTERIOR_SIZES } from '../src/constants.js';
import type { GeneratedRoom, RoomTheme } from '../src/office/editor/roomGeneration.js';
import { generateRoom } from '../src/office/editor/roomGeneration.js';
import { getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  layoutToSeats,
  layoutToTileMap,
  migrateLayoutColors,
} from '../src/office/layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../src/office/layout/tileMap.js';
import type { OfficeLayout } from '../src/office/types.js';
import { Direction, TileType } from '../src/office/types.js';
import {
  attachmentLayout,
  defaultRoomLayout,
  emptyLayout,
  generationOptions,
  loadRoomCatalog,
} from './roomFixtures.js';

beforeAll(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterAll(() => vi.restoreAllMocks());

const SMALLEST = Math.min(...ROOM_INTERIOR_SIZES);
const LARGEST = Math.max(...ROOM_INTERIOR_SIZES);

function verifyRoom(before: OfficeLayout, result: GeneratedRoom): void {
  const after = result.layout;
  const map = layoutToTileMap(after);
  const blocked = getBlockedTiles(after.furniture);
  expect(after.cols).toBeLessThanOrEqual(MAX_COLS);
  expect(after.rows).toBeLessThanOrEqual(MAX_ROWS);
  expect(new Set(after.furniture.map((item) => item.uid)).size).toBe(after.furniture.length);
  expect(isWalkable(result.doorway.col, result.doorway.row, map, blocked)).toBe(true);
  for (const old of before.furniture) {
    expect(after.furniture.find((item) => item.uid === old.uid)).toEqual({
      ...old,
      col: old.col + result.shift.col,
      row: old.row + result.shift.row,
    });
  }
  for (let row = 0; row < before.rows; row++) {
    for (let col = 0; col < before.cols; col++) {
      const old = before.tiles[row * before.cols + col];
      if (old === TileType.VOID) continue;
      const c = col + result.shift.col;
      const r = row + result.shift.row;
      if (c === result.doorway.col && r === result.doorway.row) {
        expect(old).toBe(TileType.WALL);
      } else {
        assert.equal(after.tiles[r * after.cols + c], old, `changed existing tile ${col},${row}`);
        assert.deepEqual(
          after.tileColors?.[r * after.cols + c],
          before.tileColors?.[row * before.cols + col] ?? null,
        );
      }
    }
  }
  const oldWalkable = getWalkableTiles(layoutToTileMap(before), getBlockedTiles(before.furniture));
  for (const tile of oldWalkable) {
    assert.ok(isWalkable(tile.col + result.shift.col, tile.row + result.shift.row, map, blocked));
  }
  const added = after.furniture.slice(before.furniture.length);
  expect(added.some((item) => getCatalogEntry(item.type)?.category === 'decor')).toBe(true);
  const seats = layoutToSeats(added);
  expect(seats.size).toBeGreaterThanOrEqual(result.theme === 'workspace' ? 1 : 2);
  for (const seat of seats.values()) {
    const key = `${seat.seatCol},${seat.seatRow}`;
    blocked.delete(key);
    assert.ok(
      findPath(result.doorway.col, result.doorway.row, seat.seatCol, seat.seatRow, map, blocked)
        .length,
      `unreachable seat ${seat.uid}`,
    );
    blocked.add(key);
    const dc = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
    const dr = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
    expect(
      added.some((item) => {
        const entry = getCatalogEntry(item.type)!;
        return (
          entry.isDesk &&
          seat.seatCol + dc >= item.col &&
          seat.seatCol + dc < item.col + entry.footprintW &&
          seat.seatRow + dr >= item.row &&
          seat.seatRow + dr < item.row + entry.footprintH
        );
      }),
    ).toBe(true);
  }
  for (const item of added) {
    const entry = getCatalogEntry(item.type)!;
    assert.ok(item.col >= result.interior.col && item.row >= result.interior.row);
    assert.ok(item.col + entry.footprintW <= result.interior.col + result.interior.cols);
    assert.ok(item.row + entry.footprintH <= result.interior.row + result.interior.rows);
    if (!entry.canPlaceOnSurfaces) continue;
    expect(
      added.some((desk) => {
        const host = getCatalogEntry(desk.type)!;
        return (
          host.isDesk &&
          item.col >= desk.col &&
          item.row >= desk.row &&
          item.col + entry.footprintW <= desk.col + host.footprintW &&
          item.row + entry.footprintH <= desk.row + host.footprintH
        );
      }),
    ).toBe(true);
  }
}

describe.each(['workspace', 'meeting', 'lounge'] as RoomTheme[])('%s template', (theme) => {
  it.each(ROOM_INTERIOR_SIZES)(
    'fits interior width %i at every height on every side with both open and walled attachment',
    (width) => {
      loadRoomCatalog(theme);
      for (const height of ROOM_INTERIOR_SIZES) {
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          for (const walled of [true, false]) {
            const layout = attachmentLayout(width, height, dc, dr, walled);
            const original = structuredClone(layout);
            const result = generateRoom(layout, generationOptions(width, height));
            assert.ok(
              result.ok,
              `${theme} ${width} by ${height}, ${dc},${dr}, walled=${walled}: ${JSON.stringify(result)}`,
            );
            assert.equal(result.theme, theme);
            assert.equal(result.interior.cols, width);
            assert.equal(result.interior.rows, height);
            assert.equal(
              layout.tiles[(result.doorway.row - dr) * layout.cols + result.doorway.col - dc],
              TileType.FLOOR_1,
            );
            assert.equal(
              layout.tiles[result.doorway.row * layout.cols + result.doorway.col],
              walled ? TileType.WALL : TileType.VOID,
            );
            assert.deepEqual(layout, original);
            verifyRoom(layout, result);
          }
        }
      }
    },
  );
});

it('generates repeatedly in the bundled office without changing old furniture or routes', () => {
  loadRoomCatalog();
  let layout = defaultRoomLayout();
  for (let seed = 1; seed <= 10; seed++) {
    const result = generateRoom(
      layout,
      generationOptions(
        ROOM_INTERIOR_SIZES[seed % ROOM_INTERIOR_SIZES.length],
        ROOM_INTERIOR_SIZES[(seed + 1) % ROOM_INTERIOR_SIZES.length],
        seed,
      ),
    );
    assert.ok(result.ok);
    verifyRoom(layout, result);
    layout = result.layout;
  }
  assert.deepEqual(migrateLayoutColors(JSON.parse(JSON.stringify(layout)) as OfficeLayout), {
    ...layout,
    pets: [],
  });
});

it('can attach to a generated room after the original room has no free entrance', () => {
  loadRoomCatalog();
  const original = emptyLayout(24, 24);
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) original.tiles[row * original.cols + col] = TileType.FLOOR_1;
  }
  const first = generateRoom(original, generationOptions());
  assert.ok(first.ok);
  const occupiedOriginal = {
    ...first.layout,
    furniture: [...first.layout.furniture],
  };
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) {
      occupiedOriginal.furniture.push({
        uid: `occupy-${col}-${row}`,
        type: ROOM_ASSETS.decoration,
        col: col + first.shift.col,
        row: row + first.shift.row,
      });
    }
  }
  const second = generateRoom(occupiedOriginal, generationOptions(SMALLEST, SMALLEST, 2));
  assert.ok(second.ok);
  verifyRoom(occupiedOriginal, second);
  const door = {
    col: second.doorway.col - second.shift.col,
    row: second.doorway.row - second.shift.row,
  };
  expect(
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(
      ([dc, dr]) =>
        door.col + dc >= first.interior.col &&
        door.col + dc < first.interior.col + first.interior.cols &&
        door.row + dr >= first.interior.row &&
        door.row + dr < first.interior.row + first.interior.rows,
    ),
  ).toBe(true);
});

it.each([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
])('expands in direction %s,%s and preserves every coordinate layer', (dc, dr) => {
  loadRoomCatalog();
  const layout = emptyLayout(9, 9);
  layout.tiles.fill(TileType.FLOOR_1);
  // Only this boundary floor is unblocked, so no other side can supply an entrance.
  const floorCol = dc > 0 ? 8 : dc < 0 ? 0 : 4;
  const floorRow = dr > 0 ? 8 : dr < 0 ? 0 : 4;
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      if (col === floorCol && row === floorRow) continue;
      layout.furniture.push({ uid: `old-${col}-${row}`, type: ROOM_ASSETS.decoration, col, row });
    }
  }
  layout.areas = [{ label: 'Original', color: 'red' }];
  layout.areaTiles = new Array<string | null>(81).fill('Original');
  layout.carpetTiles = new Array(81).fill({ variant: 0 });
  layout.pets = [{ id: 'existing-pet', petType: 0 }];
  const result = generateRoom(layout, generationOptions());
  assert.ok(result.ok);
  verifyRoom(layout, result);
  expect(result.shift.col > 0).toBe(dc < 0);
  expect(result.shift.row > 0).toBe(dr < 0);
  expect(result.layout.areas).toEqual(layout.areas);
  expect(result.layout.pets).toEqual(layout.pets);
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      const i = (row + result.shift.row) * result.layout.cols + col + result.shift.col;
      expect(result.layout.areaTiles?.[i]).toBe('Original');
      expect(result.layout.carpetTiles?.[i]).toEqual({ variant: 0 });
    }
  }
});

it('tries a smaller size when only a minimum-size attachment fits', () => {
  loadRoomCatalog();
  const layout = attachmentLayout(SMALLEST, SMALLEST, 1, 0, true);
  const last = 20 + SMALLEST + 1;
  for (let row = 20; row <= last; row++) {
    for (let col = 20; col <= last; col++) {
      if (row === 20 || row === last || col === 20 || col === last) {
        layout.tiles[row * layout.cols + col] = TileType.WALL;
      }
    }
  }
  const result = generateRoom(layout, generationOptions(LARGEST, LARGEST));
  assert.ok(result.ok);
  expect(result.interior.cols).toBe(SMALLEST);
  expect(result.interior.rows).toBe(SMALLEST);
  verifyRoom(layout, result);
});

it('uses a supported theme with an explicit notice instead of missing assets', () => {
  loadRoomCatalog('lounge');
  const result = generateRoom(defaultRoomLayout(), generationOptions());
  // The default contains old assets excluded from this catalog; don't guess their bounds.
  expect(result).toMatchObject({ ok: false, reason: 'assets' });
  const supported = generateRoom(
    attachmentLayout(SMALLEST, SMALLEST, 1, 0, false),
    generationOptions(),
  );
  assert.ok(supported.ok);
  expect(supported.theme).toBe('lounge');
  expect(supported.notice).toContain('workspace');
  expect(supported.notice).toContain('meeting room');
});

it('refuses missing minimum furnishings rather than generating an empty room', () => {
  loadRoomCatalog(undefined, [ROOM_ASSETS.decoration]);
  const layout = defaultRoomLayout();
  const original = structuredClone(layout);
  expect(generateRoom(layout)).toMatchObject({ ok: false, reason: 'assets' });
  expect(layout).toEqual(original);
});

it('rejects unusable chair footprints instead of succeeding without seats', () => {
  loadRoomCatalog('meeting');
  for (const type of [ROOM_ASSETS.rightChair, ROOM_ASSETS.leftChair]) {
    const entry = getCatalogEntry(type)!;
    entry.backgroundTiles = entry.footprintH;
  }
  expect(generateRoom(attachmentLayout(SMALLEST, SMALLEST, 1, 0, false))).toMatchObject({
    ok: false,
    reason: 'assets',
  });
});

it('rejects invalid grid data and unresolved footprints without mutating the layout', () => {
  loadRoomCatalog();
  const invalid = emptyLayout();
  invalid.tiles.pop();
  const original = structuredClone(invalid);
  expect(generateRoom(invalid)).toMatchObject({ ok: false, reason: 'layout' });
  expect(invalid).toEqual(original);
  const layout = defaultRoomLayout();
  getCatalogEntry(layout.furniture[0].type)!.footprintW = 0;
  expect(generateRoom(layout)).toMatchObject({ ok: false, reason: 'assets' });
});

it('fails on empty floor and crowded layouts without mutating input', () => {
  loadRoomCatalog();
  const empty = emptyLayout();
  expect(generateRoom(empty)).toMatchObject({ ok: false, reason: 'no-floor' });
  const crowded = emptyLayout(MAX_COLS, MAX_ROWS);
  crowded.tiles.fill(TileType.FLOOR_1);
  const original = structuredClone(crowded);
  expect(generateRoom(crowded)).toMatchObject({ ok: false, reason: 'no-space' });
  expect(crowded).toEqual(original);
});

it('finishes the finite search on a fragmented maximum-size grid', () => {
  loadRoomCatalog();
  const layout = emptyLayout(MAX_COLS, MAX_ROWS);
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      if ((row + col) % 2 === 0) layout.tiles[row * layout.cols + col] = TileType.FLOOR_1;
    }
  }
  expect(generateRoom(layout, generationOptions())).toMatchObject({
    ok: false,
    reason: 'no-space',
  });
});

it('protects wall decoration and background footprints on otherwise empty candidate tiles', () => {
  loadRoomCatalog();
  const layout = attachmentLayout(SMALLEST, SMALLEST, 1, 0, true);
  for (let row = 20; row < 20 + SMALLEST + 2; row++) {
    layout.furniture.push({
      uid: `painting-${row}`,
      type: 'SMALL_PAINTING',
      col: 20,
      row: row - 1,
    });
  }
  const original = structuredClone(layout);
  expect(generateRoom(layout)).toMatchObject({ ok: false, reason: 'no-space' });
  expect(layout).toEqual(original);
});

it('keeps rooms clear of wall decoration overhanging the top of the grid', () => {
  loadRoomCatalog();
  // The top wall's only opening is at (4, 0) and every other floor tile holds furniture, so every
  // candidate room expands the grid upward, and its bottom wall on row -1 covers columns 3 to 5.
  const layout = emptyLayout(9, 9);
  layout.tiles.fill(TileType.FLOOR_1);
  for (let col = 0; col < layout.cols; col++) {
    if (col !== 4) layout.tiles[col] = TileType.WALL;
  }
  for (let row = 1; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      layout.furniture.push({ uid: `old-${col}-${row}`, type: ROOM_ASSETS.decoration, col, row });
    }
  }
  const open = generateRoom(layout, generationOptions());
  assert.ok(open.ok);
  expect(open.shift.row).toBeGreaterThan(0);
  verifyRoom(layout, open);

  // A 1×2 painting hung on the top wall at `col` overhangs the grid at (col, -1).
  const hang = (col: number): OfficeLayout => ({
    ...layout,
    furniture: [...layout.furniture, { uid: 'painting', type: 'SMALL_PAINTING', col, row: -1 }],
  });

  // Beside the opening, the overhang lies under every candidate's wall ring.
  const blocked = hang(3);
  const original = structuredClone(blocked);
  expect(generateRoom(blocked, generationOptions())).toMatchObject({
    ok: false,
    reason: 'no-space',
  });
  expect(blocked).toEqual(original);

  // Further along the wall a room still fits, but never over the overhanging tile.
  const beside = hang(1);
  for (let seed = 1; seed <= 8; seed++) {
    const result = generateRoom(beside, generationOptions(SMALLEST, SMALLEST, seed));
    assert.ok(result.ok);
    verifyRoom(beside, result);
    const overhang = (result.shift.row - 1) * result.layout.cols + 1 + result.shift.col;
    expect(result.layout.tiles[overhang]).toBe(TileType.VOID);
  }
});

it('replays deterministically and rejects duplicate IDs without changing the layout', () => {
  loadRoomCatalog();
  const layout = defaultRoomLayout();
  const a = generateRoom(layout, generationOptions(7, 6, 43));
  const b = generateRoom(layout, generationOptions(7, 6, 43));
  expect(a).toEqual(b);
  expect(
    generateRoom(layout, { ...generationOptions(), createId: () => 'duplicate' }),
  ).toMatchObject({ ok: false, reason: 'identity' });
});
