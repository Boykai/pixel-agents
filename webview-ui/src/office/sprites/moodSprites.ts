// Mood bubble sprites, ported from hootbu/pixel-agents (d0843a9, MIT).
import type { SpriteData } from '../types.js';

const _ = ''; // transparent

/** Happy mood bubble: green smiley face (11x13) */
export const MOOD_HAPPY_SPRITE: SpriteData = (() => {
  const B = '#555566'; // border
  const F = '#EEEEFF'; // fill
  const G = '#44BB66'; // green face
  const E = '#227744'; // eyes/mouth dark
  return [
    [_, B, B, B, B, B, B, B, B, B, _],
    [B, F, F, F, F, F, F, F, F, F, B],
    [B, F, F, F, G, G, G, F, F, F, B],
    [B, F, F, G, G, G, G, G, F, F, B],
    [B, F, F, G, E, G, E, G, F, F, B],
    [B, F, F, G, G, G, G, G, F, F, B],
    [B, F, F, G, E, G, E, G, F, F, B],
    [B, F, F, F, G, E, G, F, F, F, B],
    [B, F, F, F, F, F, F, F, F, F, B],
    [_, B, B, B, B, B, B, B, B, B, _],
    [_, _, _, _, B, B, B, _, _, _, _],
    [_, _, _, _, _, B, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _],
  ];
})();

/** Error mood bubble: red sad face (11x13) */
export const MOOD_ERROR_SPRITE: SpriteData = (() => {
  const B = '#555566'; // border
  const F = '#EEEEFF'; // fill
  const R = '#CC4444'; // red face
  const E = '#882222'; // eyes/mouth dark
  return [
    [_, B, B, B, B, B, B, B, B, B, _],
    [B, F, F, F, F, F, F, F, F, F, B],
    [B, F, F, F, R, R, R, F, F, F, B],
    [B, F, F, R, R, R, R, R, F, F, B],
    [B, F, F, R, E, R, E, R, F, F, B],
    [B, F, F, R, R, R, R, R, F, F, B],
    [B, F, F, R, R, E, R, R, F, F, B],
    [B, F, F, F, R, R, R, F, F, F, B],
    [B, F, F, F, F, F, F, F, F, F, B],
    [_, B, B, B, B, B, B, B, B, B, _],
    [_, _, _, _, B, B, B, _, _, _, _],
    [_, _, _, _, _, B, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _],
  ];
})();

/** Stressed mood bubble: yellow sweat drop face (11x13) */
export const MOOD_STRESSED_SPRITE: SpriteData = (() => {
  const B = '#555566'; // border
  const F = '#EEEEFF'; // fill
  const Y = '#CCAA33'; // yellow face
  const E = '#887722'; // eyes/mouth dark
  const S = '#66BBEE'; // sweat drop
  return [
    [_, B, B, B, B, B, B, B, B, B, _],
    [B, F, F, F, F, F, F, F, F, F, B],
    [B, F, F, F, Y, Y, Y, F, F, F, B],
    [B, F, F, Y, Y, Y, Y, Y, S, F, B],
    [B, F, F, Y, E, Y, E, Y, S, F, B],
    [B, F, F, Y, Y, Y, Y, Y, F, F, B],
    [B, F, F, Y, E, E, E, Y, F, F, B],
    [B, F, F, F, Y, Y, Y, F, F, F, B],
    [B, F, F, F, F, F, F, F, F, F, B],
    [_, B, B, B, B, B, B, B, B, B, _],
    [_, _, _, _, B, B, B, _, _, _, _],
    [_, _, _, _, _, B, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _],
  ];
})();
