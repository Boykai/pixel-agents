import type { ColorValue } from '../../components/ui/types.js';
import {
  DEFAULT_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  ROOM_AISLE_WIDTH,
  ROOM_ASSETS,
  ROOM_CANDIDATE_UID_PREFIX,
  ROOM_FLOOR_PATTERNS,
  ROOM_INTERIOR_SIZES,
  ROOM_LARGE_INTERIOR_MIN,
  ROOM_MIN_SEATS,
  ROOM_THEME_LABELS,
  ROOM_WALL_THICKNESS,
} from '../../constants.js';
import { getFloorPatternCount } from '../floorTiles.js';
import type { CatalogEntryWithCategory } from '../layout/furnitureCatalog.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { getBlockedTiles, layoutToSeats, layoutToTileMap } from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import type { OfficeLayout, PlacedFurniture } from '../types.js';
import { MAX_COLS, MAX_ROWS, TileType } from '../types.js';
import { canPlaceFurniture, expandLayout, placeFurniture } from './editorActions.js';

export type RoomTheme = keyof typeof ROOM_THEME_LABELS;
export interface RoomBounds {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

interface Position {
  col: number;
  row: number;
}

export interface GeneratedRoom {
  ok: true;
  layout: OfficeLayout;
  shift: Position;
  bounds: RoomBounds;
  interior: RoomBounds;
  doorway: Position;
  theme: RoomTheme;
  notice?: string;
}

export type RoomGenerationResult =
  | GeneratedRoom
  | {
      ok: false;
      reason: 'assets' | 'layout' | 'no-floor' | 'no-space' | 'identity';
      message: string;
    };

interface GenerationOptions {
  random?: () => number;
  createId?: () => string;
  floorColor?: ColorValue;
  wallColor?: ColorValue;
}

interface Attachment extends Position {
  dc: number;
  dr: number;
}

interface RecipeItem extends Position {
  type: string;
}

interface Recipe {
  theme: RoomTheme;
  items: RecipeItem[];
}

const DIRECTIONS = [
  { dc: 0, dr: -1 },
  { dc: 1, dr: 0 },
  { dc: 0, dr: 1 },
  { dc: -1, dr: 0 },
];

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function tileAt(layout: OfficeLayout, col: number, row: number): TileType {
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return TileType.VOID;
  return layout.tiles[row * layout.cols + col];
}

function isFloor(tile: TileType): boolean {
  return tile !== TileType.VOID && tile !== TileType.WALL;
}

function footprint(item: RecipeItem, entry: CatalogEntryWithCategory): RoomBounds {
  return { col: item.col, row: item.row, cols: entry.footprintW, rows: entry.footprintH };
}

function contains(bounds: RoomBounds, col: number, row: number): boolean {
  return (
    col >= bounds.col &&
    row >= bounds.row &&
    col < bounds.col + bounds.cols &&
    row < bounds.row + bounds.rows
  );
}

function roomAsset(type: string): CatalogEntryWithCategory | undefined {
  const entry = getCatalogEntry(type);
  if (
    !entry ||
    !Number.isInteger(entry.footprintW) ||
    entry.footprintW <= 0 ||
    !Number.isInteger(entry.footprintH) ||
    entry.footprintH <= 0 ||
    !Number.isInteger(entry.backgroundTiles ?? 0) ||
    (entry.backgroundTiles ?? 0) < 0 ||
    (entry.backgroundTiles ?? 0) > entry.footprintH
  )
    return undefined;
  return entry;
}

function recipes(): Recipe[] {
  const a = ROOM_ASSETS;
  const available: Recipe[] = [];
  const decoration = roomAsset(a.decoration);
  if (!decoration || decoration.category !== 'decor') return available;

  const desk = roomAsset(a.desk);
  const chair = roomAsset(a.deskChair);
  const computer = roomAsset(a.computer);
  if (
    desk?.isDesk &&
    chair?.category === 'chairs' &&
    chair.orientation === 'back' &&
    !chair.backgroundTiles &&
    computer?.canPlaceOnSurfaces &&
    computer.category === 'electronics' &&
    computer.footprintW <= desk.footprintW &&
    computer.footprintH <= desk.footprintH
  ) {
    available.push({
      theme: 'workspace',
      items: [
        { type: desk.type, col: 0, row: 0 },
        {
          type: chair.type,
          col: Math.floor((desk.footprintW - chair.footprintW) / 2),
          row: desk.footprintH,
        },
        {
          type: computer.type,
          col: Math.floor((desk.footprintW - computer.footprintW) / 2),
          row: desk.footprintH - computer.footprintH,
        },
        { type: decoration.type, col: 0, row: desk.footprintH },
      ],
    });
  }
  const table = roomAsset(a.table);
  const right = roomAsset(a.rightChair);
  const left = roomAsset(a.leftChair);
  if (
    table?.isDesk &&
    right?.category === 'chairs' &&
    left?.category === 'chairs' &&
    (right.orientation === 'side' || right.orientation === 'right') &&
    left.orientation === 'left'
  ) {
    const chairRow = table.backgroundTiles ?? 0;
    available.push({
      theme: 'meeting',
      items: [
        { type: table.type, col: right.footprintW, row: 0 },
        { type: right.type, col: 0, row: chairRow },
        { type: left.type, col: right.footprintW + table.footprintW, row: chairRow },
        { type: decoration.type, col: 0, row: 0 },
      ],
    });
  }
  const sofa = roomAsset(a.sofa);
  const coffeeTable = roomAsset(a.coffeeTable);
  if (
    sofa?.category === 'chairs' &&
    sofa.orientation === 'front' &&
    sofa.footprintW * (sofa.footprintH - (sofa.backgroundTiles ?? 0)) >= 2 &&
    coffeeTable?.isDesk
  ) {
    available.push({
      theme: 'lounge',
      items: [
        { type: sofa.type, col: 0, row: 0 },
        { type: coffeeTable.type, col: 0, row: sofa.footprintH },
        { type: decoration.type, col: Math.max(sofa.footprintW, coffeeTable.footprintW), row: 0 },
      ],
    });
  }
  return available.filter(
    (recipe) =>
      layoutToSeats(
        recipe.items.map((item, index) => ({
          ...item,
          uid: String(index),
        })),
      ).size >= ROOM_MIN_SEATS[recipe.theme],
  );
}

function recipeSize(items: RecipeItem[]): { cols: number; rows: number } {
  let cols = 0;
  let rows = 0;
  for (const item of items) {
    const entry = getCatalogEntry(item.type)!;
    cols = Math.max(cols, item.col + entry.footprintW);
    rows = Math.max(rows, item.row + entry.footprintH);
  }
  return { cols, rows };
}

function recipeVariants(recipe: Recipe, interior: RoomBounds): RecipeItem[][] {
  const items = recipe.items;
  const size = recipeSize(items);
  const large = Math.max(interior.cols, interior.rows) >= ROOM_LARGE_INTERIOR_MIN;
  let extra: RecipeItem[] = [];
  if (recipe.theme === 'workspace') {
    if (size.cols * 2 + ROOM_AISLE_WIDTH * 2 <= interior.cols) {
      extra = items.map((item) => ({ ...item, col: item.col + size.cols }));
    } else if (size.rows * 2 + ROOM_AISLE_WIDTH * 2 <= interior.rows) {
      extra = items.map((item) => ({ ...item, row: item.row + size.rows }));
    }
  } else if (recipe.theme === 'meeting' && large) {
    extra = items
      .filter((item) => getCatalogEntry(item.type)?.category === 'chairs')
      .map((item) => ({ ...item, row: item.row + getCatalogEntry(item.type)!.footprintH }));
  } else if (
    recipe.theme === 'lounge' &&
    large &&
    roomAsset(ROOM_ASSETS.leftChair)?.category === 'chairs'
  ) {
    const sofa = getCatalogEntry(ROOM_ASSETS.sofa)!;
    const table = getCatalogEntry(ROOM_ASSETS.coffeeTable)!;
    extra = [{ type: ROOM_ASSETS.leftChair, col: table.footprintW, row: sofa.footprintH }];
  }
  return extra.length ? [[...items, ...extra], items] : [items];
}

function attachments(layout: OfficeLayout, walkable: Position[]): Attachment[] {
  const result: Attachment[] = [];
  for (const floor of walkable) {
    for (const direction of DIRECTIONS) {
      const col = floor.col + direction.dc;
      const row = floor.row + direction.dr;
      const tile = tileAt(layout, col, row);
      if (
        !isFloor(tile) &&
        tileAt(layout, col + direction.dc, row + direction.dr) === TileType.VOID
      ) {
        result.push({ col, row, ...direction });
      }
    }
  }
  return result;
}

function roomBounds(door: Attachment, width: number, height: number, offset: number): RoomBounds {
  const cols = width + ROOM_WALL_THICKNESS * 2;
  const rows = height + ROOM_WALL_THICKNESS * 2;
  return {
    col: door.dc > 0 ? door.col : door.dc < 0 ? door.col - cols + 1 : door.col - offset,
    row: door.dr > 0 ? door.row : door.dr < 0 ? door.row - rows + 1 : door.row - offset,
    cols,
    rows,
  };
}

function fits(layout: OfficeLayout, bounds: RoomBounds, occupied: Set<string>): boolean {
  for (let row = bounds.row; row < bounds.row + bounds.rows; row++) {
    for (let col = bounds.col; col < bounds.col + bounds.cols; col++) {
      if (occupied.has(`${col},${row}`)) return false;
      const tile = tileAt(layout, col, row);
      const edge =
        col === bounds.col ||
        row === bounds.row ||
        col === bounds.col + bounds.cols - 1 ||
        row === bounds.row + bounds.rows - 1;
      if (tile !== TileType.VOID && !(edge && tile === TileType.WALL)) return false;
    }
  }
  return true;
}

function buildGeometry(
  original: OfficeLayout,
  bounds: RoomBounds,
  door: Attachment,
  floor: TileType,
  floorColor: ColorValue,
  wallColor: ColorValue,
): {
  layout: OfficeLayout;
  bounds: RoomBounds;
  interior: RoomBounds;
  doorway: Position;
  shift: Position;
} {
  let layout = original;
  const shift = { col: Math.max(0, -bounds.col), row: Math.max(0, -bounds.row) };
  for (let i = 0; i < shift.col; i++) layout = expandLayout(layout, 'left')!.layout;
  for (let i = 0; i < shift.row; i++) layout = expandLayout(layout, 'up')!.layout;
  const shifted = { ...bounds, col: bounds.col + shift.col, row: bounds.row + shift.row };
  while (layout.cols < shifted.col + shifted.cols) layout = expandLayout(layout, 'right')!.layout;
  while (layout.rows < shifted.row + shifted.rows) layout = expandLayout(layout, 'down')!.layout;
  const doorway = { col: door.col + shift.col, row: door.row + shift.row };
  const interior = {
    col: shifted.col + ROOM_WALL_THICKNESS,
    row: shifted.row + ROOM_WALL_THICKNESS,
    cols: shifted.cols - ROOM_WALL_THICKNESS * 2,
    rows: shifted.rows - ROOM_WALL_THICKNESS * 2,
  };
  const tiles = [...layout.tiles];
  const colors = layout.tileColors
    ? [...layout.tileColors]
    : new Array<ColorValue | null>(tiles.length).fill(null);
  const sharedWallColor =
    tileAt(original, door.col, door.row) === TileType.WALL
      ? original.tileColors?.[door.row * original.cols + door.col]
      : undefined;
  for (let row = shifted.row; row < shifted.row + shifted.rows; row++) {
    for (let col = shifted.col; col < shifted.col + shifted.cols; col++) {
      const i = row * layout.cols + col;
      if (contains(interior, col, row) || (col === doorway.col && row === doorway.row)) {
        tiles[i] = floor;
        colors[i] = { ...floorColor };
      } else if (tiles[i] !== TileType.WALL) {
        tiles[i] = TileType.WALL;
        colors[i] = { ...(sharedWallColor ?? wallColor) };
      }
    }
  }
  return {
    layout: { ...layout, tiles, tileColors: colors },
    bounds: shifted,
    interior,
    doorway,
    shift,
  };
}

function reachableFrom(layout: OfficeLayout, from: Position, blocked: Set<string>): Set<string> {
  const map = layoutToTileMap(layout);
  const seen = new Set<string>();
  if (!isWalkable(from.col, from.row, map, blocked)) return seen;
  const queue = [from];
  seen.add(`${from.col},${from.row}`);
  for (let head = 0; head < queue.length; head++) {
    const tile = queue[head];
    for (const { dc, dr } of DIRECTIONS) {
      const col = tile.col + dc;
      const row = tile.row + dr;
      const key = `${col},${row}`;
      if (!seen.has(key) && isWalkable(col, row, map, blocked)) {
        seen.add(key);
        queue.push({ col, row });
      }
    }
  }
  return seen;
}

function navigable(
  layout: OfficeLayout,
  interior: RoomBounds,
  doorway: Position,
  added: PlacedFurniture[],
  theme: RoomTheme,
): boolean {
  const blocked = getBlockedTiles(layout.furniture);
  const map = layoutToTileMap(layout);
  const reachable = reachableFrom(layout, doorway, blocked);
  if (!reachable.has(`${doorway.col},${doorway.row}`)) return false;
  for (let row = interior.row; row < interior.row + interior.rows; row++) {
    for (let col = interior.col; col < interior.col + interior.cols; col++) {
      if (isWalkable(col, row, map, blocked) && !reachable.has(`${col},${row}`)) return false;
    }
  }
  const seats = layoutToSeats(added);
  if (seats.size < ROOM_MIN_SEATS[theme]) return false;
  for (const seat of seats.values()) {
    const key = `${seat.seatCol},${seat.seatRow}`;
    blocked.delete(key);
    const path = findPath(doorway.col, doorway.row, seat.seatCol, seat.seatRow, map, blocked);
    blocked.add(key);
    if (!path.length) return false;
  }
  return true;
}

function furnish(
  layout: OfficeLayout,
  interior: RoomBounds,
  doorway: Position,
  recipe: Recipe,
  random: () => number,
): OfficeLayout | null {
  for (const items of recipeVariants(recipe, interior)) {
    const size = recipeSize(items);
    const positions: Position[] = [];
    for (let row = ROOM_AISLE_WIDTH; row + size.rows <= interior.rows - ROOM_AISLE_WIDTH; row++) {
      for (let col = ROOM_AISLE_WIDTH; col + size.cols <= interior.cols - ROOM_AISLE_WIDTH; col++) {
        positions.push({ col: interior.col + col, row: interior.row + row });
      }
    }
    const centerCol = interior.col + (interior.cols - size.cols) / 2;
    const centerRow = interior.row + (interior.rows - size.rows) / 2;
    const distance = (position: Position) =>
      Math.abs(position.col - centerCol) + Math.abs(position.row - centerRow);
    const centered = shuffled(positions, random).sort((a, b) => distance(a) - distance(b));
    for (const origin of centered) {
      let candidate = layout;
      let valid = true;
      const added: PlacedFurniture[] = [];
      const ids = new Set(layout.furniture.map((item) => item.uid));
      let id = 0;
      for (const item of items) {
        const entry = getCatalogEntry(item.type)!;
        const col = origin.col + item.col;
        const row = origin.row + item.row;
        if (!canPlaceFurniture(candidate, item.type, col, row)) {
          valid = false;
          break;
        }
        if (entry.canPlaceOnSurfaces) {
          const supported = added.some((host) => {
            const hostEntry = getCatalogEntry(host.type)!;
            return (
              hostEntry.isDesk &&
              col >= host.col &&
              row >= host.row &&
              col + entry.footprintW <= host.col + hostEntry.footprintW &&
              row + entry.footprintH <= host.row + hostEntry.footprintH
            );
          });
          if (!supported) {
            valid = false;
            break;
          }
        }
        // Surface collision exemptions include the whole desk; don't stack two accessories there.
        const overlapsAccessory = added.some((other) => {
          const otherEntry = getCatalogEntry(other.type)!;
          if (!entry.canPlaceOnSurfaces || !otherEntry.canPlaceOnSurfaces) return false;
          return (
            col < other.col + otherEntry.footprintW &&
            col + entry.footprintW > other.col &&
            row < other.row + otherEntry.footprintH &&
            row + entry.footprintH > other.row
          );
        });
        if (overlapsAccessory) {
          valid = false;
          break;
        }
        while (ids.has(`${ROOM_CANDIDATE_UID_PREFIX}${id}`)) id++;
        const placed = { type: item.type, col, row, uid: `${ROOM_CANDIDATE_UID_PREFIX}${id++}` };
        ids.add(placed.uid);
        const next = placeFurniture(candidate, placed);
        if (next === candidate) {
          valid = false;
          break;
        }
        candidate = next;
        added.push(placed);
      }
      if (valid && navigable(candidate, interior, doorway, added, recipe.theme)) return candidate;
    }
  }
  return null;
}

export function generateRoom(
  layout: OfficeLayout,
  options: GenerationOptions = {},
): RoomGenerationResult {
  if (
    !Number.isInteger(layout.cols) ||
    !Number.isInteger(layout.rows) ||
    layout.cols < 1 ||
    layout.rows < 1 ||
    layout.cols > MAX_COLS ||
    layout.rows > MAX_ROWS ||
    layout.tiles.length !== layout.cols * layout.rows ||
    !layout.tiles.every(
      (tile) =>
        tile === TileType.WALL ||
        tile === TileType.VOID ||
        ROOM_FLOOR_PATTERNS.some((pattern) => pattern === tile),
    )
  ) {
    return {
      ok: false,
      reason: 'layout',
      message: 'The layout has invalid grid data. Import a valid layout before generating a room.',
    };
  }
  const random = options.random ?? Math.random;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const available = recipes();
  if (!available.length) {
    return {
      ok: false,
      reason: 'assets',
      message: 'Room furniture is unavailable. Load the bundled furniture assets and try again.',
    };
  }
  const occupied = new Set<string>();
  for (const item of layout.furniture) {
    const entry = roomAsset(item.type);
    if (!entry)
      return {
        ok: false,
        reason: 'assets',
        message: `Furniture "${item.type}" is unavailable or has an invalid footprint. Restore its assets before generating a room.`,
      };
    const bounds = footprint(item, entry);
    for (let row = bounds.row; row < bounds.row + bounds.rows; row++) {
      for (let col = bounds.col; col < bounds.col + bounds.cols; col++)
        occupied.add(`${col},${row}`);
    }
  }
  const walkable = getWalkableTiles(layoutToTileMap(layout), getBlockedTiles(layout.furniture));
  if (!walkable.length) {
    return {
      ok: false,
      reason: 'no-floor',
      message: 'No existing walkable floor to attach to. Paint some floor first.',
    };
  }
  const firstWidth = ROOM_INTERIOR_SIZES[Math.floor(random() * ROOM_INTERIOR_SIZES.length)];
  const firstHeight = ROOM_INTERIOR_SIZES[Math.floor(random() * ROOM_INTERIOR_SIZES.length)];
  const otherSizes = ROOM_INTERIOR_SIZES.flatMap((width) =>
    ROOM_INTERIOR_SIZES.filter((height) => width !== firstWidth || height !== firstHeight).map(
      (height) => ({ width, height }),
    ),
  );
  const sizes = [{ width: firstWidth, height: firstHeight }, ...shuffled(otherSizes, random)];
  const entrances = shuffled(attachments(layout, walkable), random);
  const themes = shuffled(available, random);
  const floorPatterns = ROOM_FLOOR_PATTERNS.slice(0, getFloorPatternCount());
  const floor = floorPatterns[Math.floor(random() * floorPatterns.length)];
  for (const allowExpansion of [false, true]) {
    for (const { width, height } of sizes) {
      for (const door of entrances) {
        const offsets = shuffled(
          Array.from({ length: door.dc ? height : width }, (_, i) => i + ROOM_WALL_THICKNESS),
          random,
        );
        for (const offset of offsets) {
          const bounds = roomBounds(door, width, height, offset);
          const cols = Math.max(layout.cols, bounds.col + bounds.cols) - Math.min(0, bounds.col);
          const rows = Math.max(layout.rows, bounds.row + bounds.rows) - Math.min(0, bounds.row);
          if ((cols !== layout.cols || rows !== layout.rows) !== allowExpansion) continue;
          if (cols > MAX_COLS || rows > MAX_ROWS || !fits(layout, bounds, occupied)) continue;
          const geometry = buildGeometry(
            layout,
            bounds,
            door,
            floor,
            options.floorColor ?? DEFAULT_FLOOR_COLOR,
            options.wallColor ?? DEFAULT_WALL_COLOR,
          );
          for (const recipe of themes) {
            const furnished = furnish(
              geometry.layout,
              geometry.interior,
              geometry.doorway,
              recipe,
              random,
            );
            if (!furnished) continue;
            const map = layoutToTileMap(furnished);
            const blocked = getBlockedTiles(furnished.furniture);
            if (
              !walkable.every((tile) =>
                isWalkable(
                  tile.col + geometry.shift.col,
                  tile.row + geometry.shift.row,
                  map,
                  blocked,
                ),
              )
            )
              continue;
            const ids = new Set(layout.furniture.map((item) => item.uid));
            const furniture = furnished.furniture.slice(0, layout.furniture.length);
            for (const item of furnished.furniture.slice(layout.furniture.length)) {
              const uid = createId();
              if (!uid || ids.has(uid))
                return {
                  ok: false,
                  reason: 'identity',
                  message: 'Could not create unique furniture IDs. Try generating the room again.',
                };
              ids.add(uid);
              furniture.push({ ...item, uid });
            }
            const unavailable = (Object.keys(ROOM_THEME_LABELS) as RoomTheme[])
              .filter((theme) => !available.some((recipe) => recipe.theme === theme))
              .map((theme) => ROOM_THEME_LABELS[theme]);
            return {
              ok: true,
              ...geometry,
              layout: { ...furnished, furniture },
              theme: recipe.theme,
              ...(unavailable.length
                ? { notice: `Unavailable with the current assets: ${unavailable.join(', ')}.` }
                : {}),
            };
          }
        }
      }
    }
  }
  return {
    ok: false,
    reason: 'no-space',
    message: `No safe furnished room fits within the ${MAX_COLS}-by-${MAX_ROWS} layout limit. Free some space and try again.`,
  };
}
