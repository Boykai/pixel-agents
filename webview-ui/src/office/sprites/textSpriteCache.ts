// Ported from hootbu/pixel-agents (MIT) dd427e1 — Copyright (c) 2026 Hootbu (modifications).
// The fork's PixelTextConfig { text, fontSize, pixelScale, textColor } is SignText
// { value, size, scale, color } here, and the cache is bounded (LRU) with input normalization.
import {
  SIGN_DEFAULT_COLOR,
  SIGN_DEFAULT_FONT_SIZE,
  SIGN_FONT_SIZES,
  SIGN_SCALE_MAX,
  SIGN_SCALE_MIN,
  SIGN_SPRITE_CACHE_MAX,
  SIGN_TEXT_MAX_LENGTH,
} from '../../constants.js';
import type { SignFontSize, SignText, SpriteData } from '../types.js';
import { TILE_SIZE } from '../types.js';
import { generateTextSprite, PIXEL_FONTS } from './pixelFont.js';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isSignFontSize(value: unknown): value is SignFontSize {
  return (SIGN_FONT_SIZES as readonly unknown[]).includes(value);
}

/**
 * Coerce a persisted/untrusted `text` payload into a renderable SignText, or
 * null when there is nothing to draw. layout.json is stored raw, so every field
 * is validated here rather than trusted: bad size/scale/color fall back to the
 * defaults and over-long text is truncated.
 */
export function normalizeSignText(raw: unknown): SignText | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Record<keyof SignText, unknown>>;
  if (typeof candidate.value !== 'string') return null;
  const value = candidate.value.slice(0, SIGN_TEXT_MAX_LENGTH);
  if (value.trim().length === 0) return null;
  const size = isSignFontSize(candidate.size) ? candidate.size : SIGN_DEFAULT_FONT_SIZE;
  const scale =
    typeof candidate.scale === 'number' && Number.isFinite(candidate.scale)
      ? Math.min(SIGN_SCALE_MAX, Math.max(SIGN_SCALE_MIN, Math.round(candidate.scale)))
      : SIGN_SCALE_MIN;
  const color =
    typeof candidate.color === 'string' && HEX_COLOR_RE.test(candidate.color)
      ? candidate.color
      : SIGN_DEFAULT_COLOR;
  return { value, size, scale, color };
}

function cacheKey(text: SignText): string {
  return `${text.size}|${text.scale}|${text.color}|${text.value}`;
}

// Insertion-ordered Map as an LRU: a hit is re-inserted at the end, the first key is the oldest.
// Stable identity per key also keeps spriteCache's per-SpriteData WeakMap warm.
const spriteCache = new Map<string, SpriteData>();

/** Get (or generate and cache) the text sprite for a normalized SignText. */
export function getTextSprite(text: SignText): SpriteData {
  const key = cacheKey(text);
  const cached = spriteCache.get(key);
  if (cached) {
    spriteCache.delete(key);
    spriteCache.set(key, cached);
    return cached;
  }
  const sprite = generateTextSprite(text.value, text.size, text.color, text.scale);
  if (spriteCache.size >= SIGN_SPRITE_CACHE_MAX) {
    const oldest = spriteCache.keys().next().value;
    if (oldest !== undefined) spriteCache.delete(oldest);
  }
  spriteCache.set(key, sprite);
  return sprite;
}

/** Footprint in tiles of a normalized SignText: its sprite size rounded up to whole tiles. */
export function getTextFootprint(text: SignText): { w: number; h: number } {
  const font = PIXEL_FONTS[text.size];
  // Same glyph count generateTextSprite uses (upper-casing can change the length).
  const glyphCount = text.value.toUpperCase().split('').length;
  if (!font || glyphCount === 0) return { w: 1, h: 1 };
  const pixelW = (glyphCount * font.glyphWidth + (glyphCount - 1) * font.charSpacing) * text.scale;
  const pixelH = font.glyphHeight * text.scale;
  return {
    w: Math.max(1, Math.ceil(pixelW / TILE_SIZE)),
    h: Math.max(1, Math.ceil(pixelH / TILE_SIZE)),
  };
}

/** @internal Drop every cached text sprite (tests). */
export function clearTextSpriteCache(): void {
  spriteCache.clear();
}

/** @internal Number of cached text sprites (tests). */
export function textSpriteCacheSize(): number {
  return spriteCache.size;
}

const T = '#FFFFFF';
const B = '#2A6A2A';
const G = '#3A8A3A';
const _ = '';

/** 16×16 palette thumbnail + placement ghost for a Sign that has no text yet: a white "T" on green. */
export const SIGN_ICON_SPRITE: SpriteData = [
  [_, B, B, B, B, B, B, B, B, B, B, B, B, B, B, _],
  [B, G, G, G, G, G, G, G, G, G, G, G, G, G, G, B],
  [B, G, T, T, T, T, T, T, T, T, T, T, T, T, G, B],
  [B, G, T, T, T, T, T, T, T, T, T, T, T, T, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, T, T, T, T, G, G, G, G, G, B],
  [B, G, G, G, G, G, G, G, G, G, G, G, G, G, G, B],
  [_, B, B, B, B, B, B, B, B, B, B, B, B, B, B, _],
];
