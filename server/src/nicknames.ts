/**
 * Nickname memory: pure helpers over the NicknameBook that the state adapter
 * persists beside the agent list (see core/src/schemas.ts).
 *
 * Two indexes, both capped and trimmed oldest-first:
 * - sessions: which nickname an agent's session carried, so re-adopting the
 *   same session (an external or Copilot App session reappearing, a restart)
 *   brings the nickname back.
 * - profiles: the look and seat last used under each nickname, so a new agent
 *   launched under a known nickname gets that nickname's appearance back.
 */

import { normalizeNickname } from '../../core/src/normalizeNickname.js';
import type { NicknameBook, NicknameProfile } from '../../core/src/schemas.js';
import { HUE_SHIFT_MAX_DEG, NICKNAME_BOOK_MAX_ENTRIES } from './constants.js';

export function emptyNicknameBook(): NicknameBook {
  return { sessions: {}, profiles: [] };
}

/**
 * The identity a session nickname is keyed on: provider + session, plus the
 * Teammate name, because in-process Teammates share their Lead's session.
 * Undefined while the agent has no session to key on.
 */
export function nicknameSessionKey(agent: {
  providerId?: string;
  sessionId?: string;
  agentName?: string;
}): string | undefined {
  if (!agent.sessionId) return undefined;
  const base = `${agent.providerId ?? 'claude'}:${agent.sessionId}`;
  return agent.agentName ? `${base}#${agent.agentName}` : base;
}

function foldNickname(nickname: string): string {
  return nickname.toLowerCase();
}

/** Nicknames match case-insensitively: "Ada" and "ada" are the same agent to a person. */
export function findNicknameProfile(
  book: NicknameBook,
  nickname: string,
): NicknameProfile | undefined {
  const folded = foldNickname(nickname);
  return book.profiles.find((profile) => foldNickname(profile.nickname) === folded);
}

/** Record (or, with '', forget) a session's nickname. Returns whether the book changed. */
export function rememberSessionNickname(
  book: NicknameBook,
  key: string,
  nickname: string,
): boolean {
  const known = Object.prototype.hasOwnProperty.call(book.sessions, key);
  if (!nickname) {
    if (!known) return false;
    delete book.sessions[key];
    return true;
  }
  if (known && book.sessions[key] === nickname) return false;
  // Re-insert so the entry counts as newest when trimming.
  delete book.sessions[key];
  book.sessions[key] = nickname;
  const keys = Object.keys(book.sessions);
  for (let i = 0; i < keys.length - NICKNAME_BOOK_MAX_ENTRIES; i++) {
    delete book.sessions[keys[i]];
  }
  return true;
}

/**
 * Merge what is now known about a nickname's look and seat into its profile
 * (fields left undefined keep their remembered value). The profile moves to
 * the newest position when it changes. Returns whether the book changed.
 */
export function rememberNicknameProfile(book: NicknameBook, update: NicknameProfile): boolean {
  if (!update.nickname) return false;
  const folded = foldNickname(update.nickname);
  const index = book.profiles.findIndex((profile) => foldNickname(profile.nickname) === folded);
  const previous = index >= 0 ? book.profiles[index] : undefined;
  const next: NicknameProfile = { nickname: update.nickname };
  const palette = update.palette ?? previous?.palette;
  const hueShift = update.hueShift ?? previous?.hueShift;
  const seatId = update.seatId ?? previous?.seatId;
  if (palette !== undefined) next.palette = palette;
  if (hueShift !== undefined) next.hueShift = hueShift;
  if (seatId !== undefined) next.seatId = seatId;
  if (
    previous &&
    previous.nickname === next.nickname &&
    previous.palette === next.palette &&
    previous.hueShift === next.hueShift &&
    previous.seatId === next.seatId
  ) {
    return false;
  }
  if (index >= 0) book.profiles.splice(index, 1);
  book.profiles.push(next);
  if (book.profiles.length > NICKNAME_BOOK_MAX_ENTRIES) {
    book.profiles.splice(0, book.profiles.length - NICKNAME_BOOK_MAX_ENTRIES);
  }
  return true;
}

/**
 * Parse an untrusted (hand-edited or older) book: keeps only well-formed
 * entries, so one bad value can't take the whole memory down with it.
 */
export function parseNicknameBook(raw: unknown): NicknameBook {
  const book = emptyNicknameBook();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return book;
  const { sessions, profiles } = raw as { sessions?: unknown; profiles?: unknown };
  if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
    for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
      // Every real key has a provider prefix, which also rules out "__proto__".
      const nickname = normalizeNickname(value);
      if (key.includes(':') && nickname) rememberSessionNickname(book, key, nickname);
    }
  }
  if (Array.isArray(profiles)) {
    for (const entry of profiles as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const { palette, hueShift, seatId } = entry as Record<string, unknown>;
      const nickname = normalizeNickname((entry as Record<string, unknown>).nickname);
      if (!nickname) continue;
      const profile: NicknameProfile = { nickname };
      if (Number.isInteger(palette) && (palette as number) >= 0) {
        profile.palette = palette as number;
      }
      if (
        Number.isInteger(hueShift) &&
        (hueShift as number) >= 0 &&
        (hueShift as number) <= HUE_SHIFT_MAX_DEG
      ) {
        profile.hueShift = hueShift as number;
      }
      if (typeof seatId === 'string' && seatId) profile.seatId = seatId;
      rememberNicknameProfile(book, profile);
    }
  }
  return book;
}
