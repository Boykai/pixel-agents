/**
 * Signs: pixel-text Furniture whose sprite and footprint come from its text
 * (ported from hootbu/pixel-agents (MIT) dd427e1 and 69c433f).
 *
 * Covers the untrusted-input normalization, the text sprite and the footprint
 * it claims, the bounded sprite cache, the effective catalog entry, placement
 * rules (walls yes, VOID no), text edits, and that layout.json round-trips the
 * new optional `text` / `zLayer` fields without touching layouts that lack them.
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  SIGN_COLOR_PRESETS,
  SIGN_DEFAULT_COLOR,
  SIGN_LABEL,
  SIGN_SCALE_MAX,
  SIGN_SPRITE_CACHE_MAX,
  SIGN_TEXT_MAX_LENGTH,
  SIGN_TYPE,
} from '../src/constants.js';
import {
  canPlaceFurniture,
  placeFurniture,
  setFurnitureZLayer,
  updateFurnitureText,
} from '../src/office/editor/editorActions.js';
import {
  getCatalogByCategory,
  getCatalogEntry,
  getEffectiveCatalogEntry,
  getFurnitureEntry,
} from '../src/office/layout/furnitureCatalog.js';
import {
  deserializeLayout,
  getBlockedTiles,
  migrateLayoutColors,
  serializeLayout,
} from '../src/office/layout/layoutSerializer.js';
import { PIXEL_FONTS } from '../src/office/sprites/pixelFont.js';
import {
  clearTextSpriteCache,
  getTextFootprint,
  getTextSprite,
  normalizeSignText,
  SIGN_ICON_SPRITE,
  textSpriteCacheSize,
} from '../src/office/sprites/textSpriteCache.js';
import type { OfficeLayout, PlacedFurniture, SignText } from '../src/office/types.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';
import { defaultRoomLayout, emptyLayout, loadRoomCatalog } from './roomFixtures.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadRoomCatalog();
  clearTextSpriteCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function sign(value: string, overrides: Partial<SignText> = {}): SignText {
  return { value, color: SIGN_DEFAULT_COLOR, size: '3x5', scale: 1, ...overrides };
}

/** A Sign editor preset color by label (color literals live in constants.ts). */
function preset(label: string): string {
  const hit = SIGN_COLOR_PRESETS.find((p) => p.label === label);
  assert.ok(hit, `preset ${label} exists`);
  return hit.hex;
}

function floorLayout(cols = 12, rows = 12): OfficeLayout {
  const layout = emptyLayout(cols, rows);
  layout.tiles.fill(TileType.FLOOR_1);
  layout.pets = [];
  return layout;
}

/** A plain 1×1 floor item from the bundled catalog (not a Sign, desk, surface or wall item). */
function plainOneByOne(): string {
  const entry = getCatalogByCategory('decor').find(
    (e) =>
      e.type !== SIGN_TYPE &&
      e.footprintW === 1 &&
      e.footprintH === 1 &&
      !e.isDesk &&
      !e.canPlaceOnWalls &&
      !e.canPlaceOnSurfaces &&
      !e.backgroundTiles,
  );
  assert.ok(entry, 'the bundled catalog has a plain 1x1 decor item');
  return entry.type;
}

// ── normalizeSignText ────────────────────────────────────────────

test('normalizeSignText rejects payloads with nothing to draw', () => {
  for (const raw of [undefined, null, 42, 'Hello', [], {}, { value: 42 }, { value: '' }]) {
    assert.equal(normalizeSignText(raw), null, JSON.stringify(raw));
  }
  assert.equal(normalizeSignText({ value: '   ' }), null);
});

test('normalizeSignText fills defaults and clamps every field of an untrusted payload', () => {
  const green = preset('Green');
  const lowerGreen = green.toLowerCase();
  assert.deepEqual(normalizeSignText({ value: 'Hi' }), sign('Hi'));
  assert.deepEqual(
    normalizeSignText({ value: 'Hi', size: '5x7', scale: 3, color: lowerGreen }),
    sign('Hi', { size: '5x7', scale: 3, color: lowerGreen }),
  );
  assert.deepEqual(
    normalizeSignText({ value: 'Hi', size: 'huge', scale: 99, color: 'red' }),
    sign('Hi', { scale: SIGN_SCALE_MAX }),
  );
  assert.equal(normalizeSignText({ value: 'Hi', scale: 0 })?.scale, 1);
  assert.equal(normalizeSignText({ value: 'Hi', scale: 2.6 })?.scale, 3);
  assert.equal(normalizeSignText({ value: 'Hi', scale: Number.NaN })?.scale, 1);
  const fiveDigits = green.slice(0, -1);
  assert.equal(normalizeSignText({ value: 'Hi', color: fiveDigits })?.color, SIGN_DEFAULT_COLOR);
  const alpha = `${green}FF`; // #RRGGBBAA: sprites take it, but the Sign editor never makes it
  assert.equal(normalizeSignText({ value: 'Hi', color: alpha })?.color, SIGN_DEFAULT_COLOR);

  const long = 'x'.repeat(SIGN_TEXT_MAX_LENGTH + 10);
  assert.equal(normalizeSignText({ value: long })?.value.length, SIGN_TEXT_MAX_LENGTH);
});

// ── Text sprite + footprint ──────────────────────────────────────

test('the text sprite is exactly as large as its glyphs, and the footprint just covers it', () => {
  const samples: SignText[] = [
    sign('Hello'),
    sign('Standup 10am', { size: '5x7', scale: 2 }),
    sign('Hi', { size: '5x7', scale: 5 }),
    sign('A', { scale: 3 }),
    sign('Ship it!', { color: preset('Coral') }),
  ];
  for (const text of samples) {
    const font = PIXEL_FONTS[text.size];
    const glyphs = text.value.length;
    const sprite = getTextSprite(text);
    const width = (glyphs * font.glyphWidth + (glyphs - 1) * font.charSpacing) * text.scale;
    assert.equal(sprite.length, font.glyphHeight * text.scale, `${text.value} height`);
    assert.equal(sprite[0].length, width, `${text.value} width`);

    const { w, h } = getTextFootprint(text);
    assert.equal(w, Math.ceil(width / TILE_SIZE), `${text.value} footprint width`);
    assert.equal(h, Math.ceil(sprite.length / TILE_SIZE), `${text.value} footprint height`);

    const painted = sprite.flat().filter((px) => px !== '');
    assert.ok(painted.length > 0, `${text.value} paints pixels`);
    assert.ok(
      painted.every((px) => px === text.color),
      `${text.value} is painted in its color`,
    );
  }
  assert.deepEqual(getTextFootprint(sign('Hello')), { w: 2, h: 1 });
  assert.deepEqual(getTextFootprint(sign('Standup 10am', { size: '5x7', scale: 2 })), {
    w: 9,
    h: 1,
  });
  assert.deepEqual(getTextFootprint(sign('Hi', { size: '5x7', scale: 5 })), { w: 4, h: 3 });
});

test('characters the font lacks render as a filled glyph block, lowercase as uppercase', () => {
  const unknown = getTextSprite(sign('€'));
  assert.deepEqual(
    unknown,
    Array.from({ length: 5 }, () => new Array(3).fill(SIGN_DEFAULT_COLOR)),
  );
  assert.deepEqual(getTextSprite(sign('abc')), getTextSprite(sign('ABC')));
});

test('text sprites are cached per text and the cache stays bounded (LRU)', () => {
  const first = getTextSprite(sign('A0'));
  assert.equal(getTextSprite({ ...sign('A0') }), first, 'same text → same sprite object');
  assert.notEqual(
    getTextSprite(sign('A0', { color: preset('Red') })),
    first,
    'color is in the key',
  );
  clearTextSpriteCache();

  const kept = getTextSprite(sign('A0'));
  const evicted = getTextSprite(sign('A1'));
  getTextSprite(sign('A0')); // touch: A0 is now the most recently used
  for (let i = 2; i <= SIGN_SPRITE_CACHE_MAX; i++) getTextSprite(sign(`A${i}`));
  assert.equal(textSpriteCacheSize(), SIGN_SPRITE_CACHE_MAX);
  assert.equal(getTextSprite(sign('A0')), kept, 'the recently used sprite survived');
  assert.notEqual(getTextSprite(sign('A1')), evicted, 'the least recently used one was evicted');
  assert.equal(textSpriteCacheSize(), SIGN_SPRITE_CACHE_MAX);
});

// ── Catalog ──────────────────────────────────────────────────────

test('the Sign is a built-in 1x1 Decor entry whose icon stands in until it has text', () => {
  const entry = getCatalogEntry(SIGN_TYPE);
  assert.ok(entry);
  assert.equal(entry.label, SIGN_LABEL);
  assert.equal(entry.category, 'decor');
  assert.equal(entry.sprite, SIGN_ICON_SPRITE);
  assert.deepEqual([entry.footprintW, entry.footprintH], [1, 1]);
  assert.ok(getCatalogByCategory('decor').some((e) => e.type === SIGN_TYPE));

  assert.equal(getEffectiveCatalogEntry(SIGN_TYPE), entry);
  assert.equal(getEffectiveCatalogEntry(SIGN_TYPE, { value: '  ' }), entry);
});

test('a Sign with text gets its text sprite and footprint; other types ignore text', () => {
  const text = sign('Hello');
  const effective = getEffectiveCatalogEntry(SIGN_TYPE, text);
  assert.ok(effective);
  assert.equal(effective.sprite, getTextSprite(text));
  assert.deepEqual([effective.footprintW, effective.footprintH], [2, 1]);
  assert.equal(effective.category, 'decor');
  assert.equal(effective.isDesk, false);
  assert.deepEqual(
    [getCatalogEntry(SIGN_TYPE)!.footprintW, getCatalogEntry(SIGN_TYPE)!.sprite],
    [1, SIGN_ICON_SPRITE],
    'the shared catalog entry is not mutated',
  );
  assert.deepEqual(getFurnitureEntry({ type: SIGN_TYPE, text }), effective);

  const plain = plainOneByOne();
  assert.equal(getEffectiveCatalogEntry(plain, text), getCatalogEntry(plain));
});

// ── Placement ────────────────────────────────────────────────────

test('a Sign blocks every tile its text covers', () => {
  let layout = floorLayout();
  layout = placeFurniture(layout, {
    uid: 's',
    type: SIGN_TYPE,
    col: 3,
    row: 3,
    text: sign('Hello'),
  });
  assert.equal(layout.furniture.length, 1);
  const blocked = getBlockedTiles(layout.furniture);
  assert.deepEqual([...blocked].sort(), ['3,3', '4,3']);

  const plain = plainOneByOne();
  assert.equal(canPlaceFurniture(layout, plain, 4, 3), false);
  assert.equal(canPlaceFurniture(layout, plain, 5, 3), true);
});

test('a Sign can hang on a wall but not over VOID or past the layout edge', () => {
  const layout = floorLayout();
  for (let c = 0; c < layout.cols; c++) layout.tiles[c] = TileType.WALL; // row 0 is wall
  layout.tiles[6 * layout.cols + 4] = TileType.VOID;
  const hello = sign('Hello'); // 2 tiles wide

  assert.equal(canPlaceFurniture(layout, SIGN_TYPE, 2, 0, undefined, hello), true, 'on a wall');
  assert.equal(
    canPlaceFurniture(layout, plainOneByOne(), 2, 0),
    false,
    'plain items stay off walls',
  );
  assert.equal(canPlaceFurniture(layout, SIGN_TYPE, 2, 6, undefined, hello), true);
  assert.equal(canPlaceFurniture(layout, SIGN_TYPE, 3, 6, undefined, hello), false, 'over VOID');
  assert.equal(
    canPlaceFurniture(layout, SIGN_TYPE, layout.cols - 1, 8, undefined, hello),
    false,
    'past the right edge',
  );
  const tooLong = { uid: 's', type: SIGN_TYPE, col: layout.cols - 1, row: 8, text: hello };
  assert.equal(placeFurniture(layout, tooLong), layout, 'placeFurniture refuses it too');
});

// ── Editing ──────────────────────────────────────────────────────

test('updateFurnitureText replaces the text and keeps everything else', () => {
  const layout = floorLayout();
  layout.furniture = [
    { uid: 's', type: SIGN_TYPE, col: 1, row: 2, text: sign('Hello'), zLayer: 2 },
  ];
  const cyan = preset('Cyan');
  const next = updateFurnitureText(layout, 's', {
    ...sign('Standup 10am', { size: '5x7', scale: 2 }),
    color: cyan,
  });
  assert.notEqual(next, layout);
  assert.deepEqual(next.furniture, [
    {
      uid: 's',
      type: SIGN_TYPE,
      col: 1,
      row: 2,
      zLayer: 2,
      text: { value: 'Standup 10am', color: cyan, size: '5x7', scale: 2 },
    },
  ]);
  assert.deepEqual(layout.furniture[0].text, sign('Hello'), 'the old layout is untouched');
});

test('updateFurnitureText is a no-op when the item, the text or the fit is wrong', () => {
  const plain = plainOneByOne();
  const layout = floorLayout();
  layout.furniture = [
    { uid: 's', type: SIGN_TYPE, col: 0, row: 3, text: sign('Hello') }, // cols 0-1
    { uid: 'blocker', type: plain, col: 2, row: 3 },
  ];
  assert.equal(updateFurnitureText(layout, 'missing', sign('Hi')), layout);
  assert.equal(updateFurnitureText(layout, 'blocker', sign('Hi')), layout, 'not a Sign');
  assert.equal(updateFurnitureText(layout, 's', sign('   ')), layout, 'nothing to draw');

  const threeTiles = sign('Hello world'); // 43 px → 3 tiles: runs into the blocker
  assert.equal(getTextFootprint(threeTiles).w, 3);
  assert.equal(updateFurnitureText(layout, 's', threeTiles), layout, 'does not fit');
  const stillFits = updateFurnitureText(layout, 's', sign('Hi there')); // 31 px → 2 tiles
  assert.equal(stillFits.furniture[0].text?.value, 'Hi there');
});

test('updateFurnitureText returns the same layout when the Sign would not change', () => {
  const cyan = preset('Cyan');
  assert.notEqual(cyan.toLowerCase(), cyan, 'the preset has letters to fold');
  const layout = floorLayout();
  layout.furniture = [
    {
      uid: 's',
      type: SIGN_TYPE,
      col: 1,
      row: 2,
      text: sign('Hello', { color: cyan.toLowerCase() }),
    },
  ];
  // The Sign editor hands back what it opened with, its color upper-cased.
  assert.equal(updateFurnitureText(layout, 's', sign('Hello', { color: cyan })), layout);
  // A raw layout.json value that normalizes to the same Sign is unchanged too.
  layout.furniture = [{ ...layout.furniture[0], text: sign('Hello', { color: cyan, scale: 1.2 }) }];
  assert.equal(updateFurnitureText(layout, 's', sign('Hello', { color: cyan })), layout);

  for (const changed of [
    sign('Hello!', { color: cyan }),
    sign('Hello', { color: preset('Pink') }),
    sign('Hello', { color: cyan, size: '5x7' }),
    sign('Hello', { color: cyan, scale: 2 }),
  ]) {
    assert.notEqual(updateFurnitureText(layout, 's', changed), layout, JSON.stringify(changed));
  }
});

// ── layout.json round trip ───────────────────────────────────────

test('layout.json round-trips Sign text and Draw layers exactly', () => {
  const plain = plainOneByOne();
  const layout = floorLayout();
  layout.furniture = [
    {
      uid: 's',
      type: SIGN_TYPE,
      col: 1,
      row: 1,
      text: sign('Ship it', { color: preset('Yellow'), size: '5x7', scale: 2 }),
      zLayer: 1,
    },
    { uid: 'p', type: plain, col: 6, row: 6, zLayer: -2 },
  ];
  const reloaded = deserializeLayout(serializeLayout(layout));
  assert.deepEqual(reloaded, layout);
  assert.deepEqual(migrateLayoutColors(layout).furniture, layout.furniture);
});

test('layouts without the new fields load unchanged', () => {
  const layout = defaultRoomLayout();
  const reloaded = deserializeLayout(serializeLayout(layout));
  assert.ok(reloaded);
  assert.deepEqual(reloaded.furniture, layout.furniture);
  for (const item of reloaded.furniture) {
    assert.equal('text' in item, false, `${item.uid} gained no text`);
    assert.equal('zLayer' in item, false, `${item.uid} gained no zLayer`);
  }
});

test('setFurnitureZLayer clamps, and layer 0 removes the field', () => {
  const layout = floorLayout();
  const item: PlacedFurniture = { uid: 's', type: SIGN_TYPE, col: 1, row: 1, text: sign('Hi') };
  layout.furniture = [item];

  const forward = setFurnitureZLayer(layout, 's', 1);
  assert.equal(forward.furniture[0].zLayer, 1);
  assert.deepEqual(forward.furniture[0].text, item.text, 'the Sign keeps its text');
  assert.equal(setFurnitureZLayer(forward, 's', 99).furniture[0].zLayer, 4);
  assert.equal(setFurnitureZLayer(forward, 's', -99).furniture[0].zLayer, -4);
  assert.equal(setFurnitureZLayer(forward, 's', 1), forward, 'unchanged → same layout');

  const reset = setFurnitureZLayer(forward, 's', 0);
  assert.equal('zLayer' in reset.furniture[0], false);
  assert.equal(setFurnitureZLayer(layout, 's', 0), layout, 'already default → same layout');
  assert.equal(setFurnitureZLayer(layout, 'missing', 1), layout);
});
