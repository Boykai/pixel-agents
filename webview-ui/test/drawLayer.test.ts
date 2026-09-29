/**
 * Furniture depth (zY): the footprint-based rule ported from hootbu/pixel-agents
 * (MIT) 4db21f3, and the per-item Draw layer (`zLayer`) applied on top of it.
 *
 * The renderer paints walls, furniture, characters and pets in ascending zY
 * (walls first in the array, stable sort), so these tests pin zY relations
 * rather than pixels.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { decodeAllWalls } from '../../core/src/assets/loader.js';
import {
  CHARACTER_Z_SORT_OFFSET,
  DRAW_LAYER_MAX,
  DRAW_LAYER_MIN,
  DRAW_LAYER_SURFACE_OFFSET,
  DRAW_LAYER_TIE_BREAK,
  SIGN_DEFAULT_COLOR,
  SIGN_TYPE,
} from '../src/constants.js';
import { getWallPlacementRow } from '../src/office/editor/editorActions.js';
import { drawLayerDepth, normalizeZLayer } from '../src/office/layout/drawLayer.js';
import { getCatalogEntry, getFurnitureEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  layoutToFurnitureInstances,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import type { FurnitureInstance, OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';
import { getWallInstances, setWallSprites } from '../src/office/wallTiles.js';
import { defaultRoomLayout, emptyLayout, loadRoomCatalog } from './roomFixtures.js';

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadRoomCatalog();
});
afterEach(() => {
  setWallSprites([]);
  vi.restoreAllMocks();
});

function zOf(furniture: PlacedFurniture[], uid: string): number {
  const index = furniture.findIndex((f) => f.uid === uid);
  assert.ok(index >= 0, `${uid} is placed`);
  const instances = layoutToFurnitureInstances(furniture);
  assert.equal(instances.length, furniture.length, 'every item resolves to an instance');
  return instances[index].zY;
}

/** Character sort key, as renderer.ts computes it for a Character standing on `row`. */
function characterZY(row: number): number {
  const centerY = row * TILE_SIZE + TILE_SIZE / 2;
  return centerY + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
}

/** The pre-4db21f3 rule (depth from sprite height, not footprint), kept verbatim for comparison. */
function spriteHeightZY(furniture: PlacedFurniture[]): number[] {
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        const prev = deskZByTile.get(key);
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY);
      }
    }
  }
  const out: number[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    let zY = item.row * TILE_SIZE + entry.sprite.length;
    if (entry.category === 'chairs') {
      zY =
        entry.orientation === 'back'
          ? (item.row + entry.footprintH) * TILE_SIZE + 1
          : (item.row + 1) * TILE_SIZE;
    }
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5;
        }
      }
    }
    out.push(zY);
  }
  return out;
}

function wallRowsLayout(cols: number, rows: number, wallRows: number[]): OfficeLayout {
  const layout = emptyLayout(cols, rows);
  layout.tiles.fill(TileType.FLOOR_1);
  for (const r of wallRows) {
    for (let c = 0; c < cols; c++) layout.tiles[r * cols + c] = TileType.WALL;
  }
  return layout;
}

function wallAt(layout: OfficeLayout, col: number, row: number): FurnitureInstance {
  const walls = getWallInstances(layoutToTileMap(layout), undefined, layout.cols);
  // Wall sprites are drawn 16 px above their tile; zY is the tile's bottom edge.
  const wall = walls.find((w) => w.x === col * TILE_SIZE && w.zY === (row + 1) * TILE_SIZE);
  assert.ok(wall, `a wall instance at ${col},${row}`);
  return wall;
}

// ── normalizeZLayer / drawLayerDepth ─────────────────────────────

test('normalizeZLayer coerces untrusted values to an integer in the Draw layer range', () => {
  for (const raw of [undefined, null, '2', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.equal(normalizeZLayer(raw), 0, String(raw));
  }
  assert.equal(normalizeZLayer(1.4), 1);
  assert.equal(normalizeZLayer(1.6), 2);
  assert.ok(Object.is(normalizeZLayer(-0.2), 0), '-0 folds into 0');
  assert.equal(normalizeZLayer(99), DRAW_LAYER_MAX);
  assert.equal(normalizeZLayer(-99), DRAW_LAYER_MIN);
});

test('each Draw layer is one tile row of depth plus a tie-break; layer 0 is no offset', () => {
  assert.equal(drawLayerDepth(undefined), 0);
  assert.equal(drawLayerDepth(0), 0);
  assert.equal(drawLayerDepth(1), TILE_SIZE + DRAW_LAYER_TIE_BREAK);
  assert.equal(drawLayerDepth(-1), -(TILE_SIZE + DRAW_LAYER_TIE_BREAK));
  assert.equal(drawLayerDepth(99), DRAW_LAYER_MAX * TILE_SIZE + DRAW_LAYER_TIE_BREAK);
  assert.ok(
    DRAW_LAYER_TIE_BREAK < CHARACTER_Z_SORT_OFFSET,
    'a layered item never overtakes a Character standing on its new row',
  );
});

// ── Footprint depth (4db21f3) ────────────────────────────────────

test('every bundled sprite is exactly its footprint tall, so the footprint rule changes nothing', () => {
  for (const asset of buildFurnitureCatalog(assetsDir)) {
    const entry = getCatalogEntry(asset.id);
    assert.ok(entry, asset.id);
    assert.equal(entry.sprite.length, entry.footprintH * TILE_SIZE, asset.id);
  }
  const { furniture } = defaultRoomLayout();
  assert.deepEqual(
    layoutToFurnitureInstances(furniture).map((i) => i.zY),
    spriteHeightZY(furniture),
  );
});

test('a Sign hung on a wall row sorts with that wall, and is drawn after it', () => {
  setWallSprites(decodeAllWalls(assetsDir));
  const layout = wallRowsLayout(8, 6, [0]);
  const item: PlacedFurniture = {
    uid: 's',
    type: SIGN_TYPE,
    col: 2,
    row: 0,
    text: { value: 'Hi', color: SIGN_DEFAULT_COLOR, size: '3x5', scale: 1 },
  };
  const [sign] = layoutToFurnitureInstances([item]);
  const wall = wallAt(layout, 2, 0);
  assert.equal(sign.zY, wall.zY);
  assert.ok(
    item.row * TILE_SIZE + getFurnitureEntry(item)!.sprite.length < wall.zY,
    'by sprite height it would have sorted behind the wall',
  );
  // The renderer lists walls before furniture and sorts stably, so the tie goes to the Sign.
  const walls = getWallInstances(layoutToTileMap(layout), undefined, layout.cols);
  const painted = [...walls, sign].sort((a, b) => a.zY - b.zY);
  assert.ok(painted.indexOf(sign) > painted.indexOf(wall));
});

test('wall items sort at their own footprint: thick walls need a Draw layer, vertical walls do not grow', () => {
  // dd427e1 pushed wall items down to the lowest wall tile under them. Not ported:
  // it re-sorted the default layouts and, down a vertical wall, covered Characters.
  setWallSprites(decodeAllWalls(assetsDir));
  const thick = wallRowsLayout(8, 6, [0, 1]);
  const clockRow = getWallPlacementRow('CLOCK', 0);
  const clock: PlacedFurniture = { uid: 'clock', type: 'CLOCK', col: 2, row: clockRow };
  const lowerWall = wallAt(thick, 2, 1);
  assert.equal(zOf([clock], 'clock'), TILE_SIZE, 'sorts at the upper wall row');
  assert.ok(zOf([clock], 'clock') < lowerWall.zY, 'so the lower wall row covers it');
  assert.ok(zOf([{ ...clock, zLayer: 1 }], 'clock') > lowerWall.zY, 'until brought forward');

  // A clock at the top of a vertical wall stays behind a Character walking beside the wall.
  assert.ok(zOf([{ ...clock, col: 0 }], 'clock') < characterZY(2));
});

// ── Draw layer ───────────────────────────────────────────────────

test('a Draw layer moves an item past its neighbour one row in front, and back again', () => {
  const back: PlacedFurniture = { uid: 'back', type: 'POT', col: 2, row: 3 };
  const front: PlacedFurniture = { uid: 'front', type: 'POT', col: 2, row: 4 };
  assert.ok(zOf([back, front], 'back') < zOf([back, front], 'front'));

  const forward = [{ ...back, zLayer: 1 }, front];
  assert.ok(zOf(forward, 'back') > zOf(forward, 'front'));

  const backward = [
    { ...back, zLayer: 1 },
    { ...front, zLayer: -1 },
  ];
  assert.ok(zOf(backward, 'front') < zOf(backward, 'back'));
  assert.equal(zOf([{ ...back, zLayer: 99 }], 'back'), zOf([{ ...back, zLayer: 4 }], 'back'));
});

test('a Draw layer offsets exactly the item it is set on, on top of every default rule', () => {
  const { furniture } = defaultRoomLayout();
  const defaults = layoutToFurnitureInstances(furniture).map((i) => i.zY);
  for (const layer of [-2, 1, 3]) {
    for (let i = 0; i < furniture.length; i++) {
      const layered = furniture.map((f, j) => (j === i ? { ...f, zLayer: layer } : f));
      const zY = layoutToFurnitureInstances(layered)[i].zY;
      assert.equal(zY, defaults[i] + drawLayerDepth(layer), `${furniture[i].type} layer ${layer}`);
    }
  }
});

test('what sits on a desk moves with the Draw layer of the desk, just in front of it', () => {
  const desk: PlacedFurniture = { uid: 'desk', type: 'DESK_FRONT', col: 2, row: 2 };
  const coffee: PlacedFurniture = { uid: 'coffee', type: 'COFFEE', col: 3, row: 3 };
  // A PC whose front row hangs one row past the desk sorts by its own footprint.
  const pc: PlacedFurniture = { uid: 'pc', type: 'PC_FRONT_OFF', col: 4, row: 3 };
  const deskBottom = 4 * TILE_SIZE;
  const pcBottom = 5 * TILE_SIZE;

  const unlayered = [desk, coffee, pc];
  assert.equal(zOf(unlayered, 'desk'), deskBottom);
  assert.equal(zOf(unlayered, 'coffee'), deskBottom + 0.5, 'the default surface rule');
  assert.equal(zOf(unlayered, 'pc'), pcBottom);

  // Exact values at ±1: desk 64 ± 16.25 → 80.25 / 47.75, coffee 0.125 in front → 80.375 / 47.875.
  assert.equal(zOf([{ ...desk, zLayer: 1 }, coffee], 'coffee'), 80.375);
  assert.equal(zOf([{ ...desk, zLayer: -1 }, coffee], 'coffee'), 47.875);

  for (let layer = DRAW_LAYER_MIN; layer <= DRAW_LAYER_MAX; layer++) {
    if (layer === 0) continue;
    const items = [{ ...desk, zLayer: layer }, coffee, pc];
    const deskZY = deskBottom + drawLayerDepth(layer);
    assert.equal(zOf(items, 'desk'), deskZY, `desk layer ${layer}`);
    assert.equal(
      zOf(items, 'coffee'),
      deskZY + DRAW_LAYER_SURFACE_OFFSET,
      `coffee, desk layer ${layer}`,
    );
    assert.equal(zOf(items, 'pc'), pcBottom + drawLayerDepth(layer), `pc, desk layer ${layer}`);
  }
});

test('a layered desk keeps what sits on it between the same neighbours as the desk', () => {
  const desk: PlacedFurniture = { uid: 'desk', type: 'DESK_FRONT', col: 2, row: 2 };
  const coffee: PlacedFurniture = { uid: 'coffee', type: 'COFFEE', col: 3, row: 3 };

  // Forward onto row 4: over the furniture there, but the Character seated there stays
  // in front of the desk AND of its coffee (the default +0.5 would draw the coffee over it).
  const forward = [{ ...desk, zLayer: 1 }, coffee, { uid: 'pot', type: 'POT', col: 8, row: 4 }];
  assert.ok(zOf(forward, 'desk') > zOf(forward, 'pot'));
  assert.ok(zOf(forward, 'coffee') > zOf(forward, 'desk'));
  assert.ok(zOf(forward, 'coffee') < characterZY(4));

  // Backward onto row 2: the furniture there now covers the desk, and its coffee too.
  const backward = [{ ...desk, zLayer: -1 }, coffee, { uid: 'pot', type: 'POT', col: 8, row: 2 }];
  assert.ok(zOf(backward, 'desk') < zOf(backward, 'pot'));
  assert.ok(zOf(backward, 'coffee') > zOf(backward, 'desk'));
  assert.ok(zOf(backward, 'coffee') < zOf(backward, 'pot'));
});

test("a surface item's own Draw layer applies on top of its layered desk", () => {
  const desk: PlacedFurniture = { uid: 'desk', type: 'DESK_FRONT', col: 2, row: 2 };
  const coffee: PlacedFurniture = { uid: 'coffee', type: 'COFFEE', col: 3, row: 3 };
  for (const deskLayer of [-1, 1]) {
    const layeredDesk = { ...desk, zLayer: deskLayer };
    const onDesk = zOf([layeredDesk, coffee], 'coffee');
    for (const own of [-2, -1, 1, 2]) {
      const items = [layeredDesk, { ...coffee, zLayer: own }];
      assert.equal(
        zOf(items, 'coffee'),
        onDesk + drawLayerDepth(own),
        `desk layer ${deskLayer}, coffee layer ${own}`,
      );
    }
    const sentBack = [layeredDesk, { ...coffee, zLayer: -1 }];
    assert.ok(zOf(sentBack, 'coffee') < zOf(sentBack, 'desk'), `behind a desk at ${deskLayer}`);
  }
});

test('an item brought forward covers the row in front of it but not the Characters on it', () => {
  const pot: PlacedFurniture = { uid: 'pot', type: 'POT', col: 2, row: 3, zLayer: 1 };
  const neighbour: PlacedFurniture = { uid: 'n', type: 'POT', col: 2, row: 4 };
  const zY = zOf([pot, neighbour], 'pot');
  assert.ok(zY > zOf([pot, neighbour], 'n'), 'in front of furniture one row down');
  assert.ok(zY > characterZY(3), 'in front of a Character on its own row');
  assert.ok(zY < characterZY(4), 'behind a Character one row down');
});
