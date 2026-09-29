import { AGENT_NICKNAME_MAX_LENGTH } from './constants.js';

/** Bidi overrides and isolates: invisible, and able to make one label read as another. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * Canonical form of a user-typed nickname: control characters and whitespace runs
 * collapse to one space, bidi controls are dropped, and the result is trimmed and
 * capped at AGENT_NICKNAME_MAX_LENGTH code points (so a surrogate pair is never
 * split). Anything that isn't a string normalizes to '', which means "no nickname".
 */
export function normalizeNickname(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, AGENT_NICKNAME_MAX_LENGTH).join('').trim();
}
