import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { decodeAllFurniture } from '../../core/src/assets/loader.js';
import { DEFAULT_FLOOR_COLOR, MAX_COLS, MAX_ROWS } from '../src/constants.js';
import type { RoomTheme } from '../src/office/editor/roomGeneration.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');
const catalog = buildFurnitureCatalog(assetsDir);
const sprites = decodeAllFurniture(assetsDir, catalog);

export function loadRoomCatalog(theme?: RoomTheme, missing: string[] = []): void {
  const selected = catalog.filter((entry) => {
    if (missing.includes(entry.id)) return false;
    if (theme && theme !== 'workspace' && entry.id.startsWith('DESK_')) return false;
    if (theme && theme !== 'meeting' && entry.id.startsWith('SMALL_TABLE_')) return false;
    if (theme && theme !== 'lounge' && entry.id.startsWith('SOFA_')) return false;
    return true;
  });
  buildDynamicCatalog({ catalog: selected, sprites });
}

export function defaultRoomLayout(): OfficeLayout {
  return JSON.parse(
    fs.readFileSync(path.join(assetsDir, 'default-layout-1.json'), 'utf8'),
  ) as OfficeLayout;
}

export function emptyLayout(cols = 12, rows = 12): OfficeLayout {
  return {
    version: 1,
    layoutRevision: 9999,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.VOID),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [],
  };
}

export function attachmentLayout(
  width: number,
  height: number,
  dc: number,
  dr: number,
  walled: boolean,
): OfficeLayout {
  const layout = emptyLayout(MAX_COLS, MAX_ROWS);
  layout.tiles.fill(TileType.WALL);
  const col = 20;
  const row = 20;
  for (let r = row; r < row + height + 2; r++) {
    for (let c = col; c < col + width + 2; c++) layout.tiles[r * layout.cols + c] = TileType.VOID;
  }
  const doorCol = dc > 0 ? col : dc < 0 ? col + width + 1 : col + Math.ceil(width / 2);
  const doorRow = dr > 0 ? row : dr < 0 ? row + height + 1 : row + Math.ceil(height / 2);
  for (let depth = 1; depth <= 3; depth++) {
    for (let across = -1; across <= 1; across++) {
      const c = doorCol - dc * depth + dr * across;
      const r = doorRow - dr * depth + dc * across;
      layout.tiles[r * layout.cols + c] = TileType.FLOOR_1;
      layout.tileColors![r * layout.cols + c] = { ...DEFAULT_FLOOR_COLOR };
    }
  }
  if (walled) {
    const count = dc ? height + 2 : width + 2;
    for (let i = 0; i < count; i++) {
      const c = dc ? doorCol : col + i;
      const r = dc ? row + i : doorRow;
      layout.tiles[r * layout.cols + c] = TileType.WALL;
    }
  }
  return layout;
}

export function seededRandom(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function generationOptions(width = 5, height = 5, seed = 1) {
  const choices = [(width - 5) / 4, (height - 5) / 4];
  const next = seededRandom(seed);
  let id = 0;
  return {
    random: () => choices.shift() ?? next(),
    createId: () => `generated-${seed}-${id++}`,
  };
}
