/**
 * Unit tests for the Pet FSM.
 *
 * Covers:
 *   - createPet initial state
 *   - IDLE → WALK transition (wanderTimer expiry + findPath succeeds)
 *   - IDLE → FOLLOW transition (when character nearby and roll succeeds)
 *   - WALK → IDLE on path exhaustion (resets frameTimer)
 *   - FOLLOW → IDLE when target despawns
 *   - FOLLOW → IDLE when duration limit reached
 *   - FOLLOW → IDLE when target reached (Manhattan distance ≤ 1)
 *   - IDLE → APPROACH → SIT beside (never on the tile of) an inactive character that's
 *     still inactive on arrival, and APPROACH's other exits
 *   - IDLE → SLEEP → IDLE and SIT → IDLE
 *   - IDLE → FLEE from a nearby active character → IDLE, faster than a walk, always to a
 *     tile farther from it (never the pet's own tile)
 *   - Sprite frames for the new states
 *   - Animation timer increments
 *   - Defensive: empty walkableTiles, etc.
 *
 * Every random decision goes through updatePet's injectable `rng`, scripted per
 * test with scriptedRng(). An expired IDLE pause draws, in order: the FOLLOW
 * roll, the behavior roll (bands in constants.ts), the chosen behavior's own
 * draws (wander tile, SIT/SLEEP duration), then the next wander pause.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  PET_APPROACH_ROLL_MAX,
  PET_FLEE_FRAME_DURATION_SEC,
  PET_FLEE_SPEED_PX_PER_SEC,
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_IDLE_SEQUENCE,
  PET_SIT_DURATION_MIN_SEC,
  PET_SLEEP_DURATION_MIN_SEC,
  PET_SLEEP_ROLL_MAX,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WALK_SEQUENCE,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
  PET_WANDER_ROLL_MAX,
} from '../src/constants.js';
import type { PetRng } from '../src/office/engine/petEntity.js';
import { createPet, getPetSpriteData, updatePet } from '../src/office/engine/petEntity.js';
import type { PetSpriteFrames } from '../src/office/sprites/petSpriteData.js';
import type { Character, Pet, SpriteData, TileType as TileTypeVal } from '../src/office/types.js';
import { CharacterState, Direction, PetState, TILE_SIZE, TileType } from '../src/office/types.js';

// ── Helpers ────────────────────────────────────────────────────

/** Build an all-FLOOR tile map of given dimensions. */
function buildOpenTileMap(cols: number, rows: number): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(TileType.FLOOR_1 as TileTypeVal);
    }
    map.push(row);
  }
  return map;
}

/** Build the walkableTiles index for a fully-open tileMap. */
function buildWalkableTiles(cols: number, rows: number): Array<{ col: number; row: number }> {
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.push({ col: c, row: r });
    }
  }
  return tiles;
}

/** Create a minimal (inactive) Character stub: only fields the FSM reads. */
function makeChar(
  id: number,
  col: number,
  row: number,
  overrides: Partial<Character> = {},
): Character {
  return {
    id,
    state: CharacterState.IDLE,
    dir: Direction.DOWN,
    x: col * 16 + 8,
    y: row * 16 + 8,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette: 0,
    hueShift: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: 5,
    isActive: false,
    seatId: null,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  };
}

/** A deterministic rng: yields `values` in order, then `fallback` forever. */
function scriptedRng(values: number[], fallback = 0.5): PetRng {
  const queue = [...values];
  return () => queue.shift() ?? fallback;
}

/** A pet at a tile, with a deterministic (mid-range) initial wander pause. */
function makePet(col: number, row: number): Pet {
  return createPet('p1', 0, col, row, scriptedRng([]));
}

/** The last tile of the pet's planned path. */
function destination(pet: Pet): { col: number; row: number } | undefined {
  return pet.path[pet.path.length - 1];
}

/** Seconds to cross exactly one tile at `speedPxPerSec`: one updatePet tick of it moves one tile. */
function tileTime(speedPxPerSec: number): number {
  return TILE_SIZE / speedPxPerSec;
}

// ── createPet ──────────────────────────────────────────────────

test('createPet returns an IDLE pet at the tile center', () => {
  const pet = createPet('p1', 0, 3, 4, scriptedRng([0.5]));
  assert.equal(pet.id, 'p1');
  assert.equal(pet.petType, 0);
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.DOWN);
  assert.equal(pet.x, 3 * 16 + 8);
  assert.equal(pet.y, 4 * 16 + 8);
  assert.equal(pet.tileCol, 3);
  assert.equal(pet.tileRow, 4);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.approachTargetId, null);
  assert.equal(pet.restTimer, 0);
  assert.equal(pet.bubbleType, null);
  assert.equal(pet.bubbleTimer, 0);
  // wanderTimer is drawn from [PET_WANDER_PAUSE_MIN_SEC, MAX) — the scripted 0.5 lands mid-range
  assert.equal(pet.wanderTimer, (PET_WANDER_PAUSE_MIN_SEC + PET_WANDER_PAUSE_MAX_SEC) / 2);
});

// ── IDLE → WALK ───────────────────────────────────────────────

test('IDLE → WALK after wanderTimer expires (follow roll fails, wander band)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0.0001;
  // FOLLOW roll fails (0.99 ≥ PET_FOLLOW_CHANCE), behavior roll 0 → wander,
  // tile pick 0 → the first candidate tile, then the next wander pause.
  updatePet(pet, 0.1, walkable, new Map(), tileMap, new Set(), scriptedRng([0.99, 0, 0]));
  assert.equal(pet.state, PetState.WALK);
  assert.deepEqual(destination(pet), { col: 0, row: 0 });
  assert.equal(pet.moveProgress, 0);
  assert.equal(pet.frame, 0);
  assert.equal(pet.frameTimer, 0);
});

test('IDLE stays IDLE when wanderTimer > 0', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.wanderTimer = 10;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE);
  assert.ok(pet.wanderTimer < 10, 'wanderTimer should decrement by dt');
});

test('IDLE stays IDLE when walkableTiles is empty', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const pet = makePet(1, 1);
  pet.wanderTimer = 0;
  // FOLLOW roll fails; the wander band has no tile to walk to
  updatePet(pet, 0.1, [], new Map(), tileMap, new Set(), scriptedRng([0.99, 0]));
  assert.equal(pet.state, PetState.IDLE);
});

// ── IDLE → FOLLOW ─────────────────────────────────────────────

test('IDLE → FOLLOW when character is nearby and follow roll succeeds', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(42, 3, 3); // distance 2 (≤ PET_FOLLOW_RADIUS_TILES=3)
  const characters = new Map<number, Character>([[character.id, character]]);
  // Roll 1: follow chance (0.0 < 0.3 → enter follow)
  // Roll 2: followDurationLimit randomRange (0.5 → middle)
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set(), scriptedRng([0.0, 0.5]));
  assert.equal(pet.state, PetState.FOLLOW);
  assert.equal(pet.followTargetId, 42);
  assert.equal(pet.followDuration, 0);
  assert.equal(pet.followRecalcTimer, 0);
  assert.ok(
    pet.followDurationLimit > 0 && pet.followDurationLimit <= PET_FOLLOW_DURATION_MAX_SEC,
    'expected followDurationLimit within bounds',
  );
});

test('IDLE does NOT enter FOLLOW when no character is in range', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const farChar = makeChar(1, 9, 9); // distance 18, beyond radius 3
  const characters = new Map<number, Character>([[1, farChar]]);
  // Roll 1: 0.0 < 0.3 → check for follow target; none found → the wander band
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set(), scriptedRng([0.0, 0.0]));
  assert.notEqual(pet.state, PetState.FOLLOW);
});

test('IDLE skips despawning characters as follow targets', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0;
  const character = makeChar(1, 3, 3, { matrixEffect: 'despawn' });
  const characters = new Map<number, Character>([[1, character]]);
  // would enter follow if a target were found
  updatePet(pet, 0.1, walkable, characters, tileMap, new Set(), scriptedRng([0.0, 0.0]));
  assert.notEqual(pet.state, PetState.FOLLOW);
});

// ── WALK → IDLE ───────────────────────────────────────────────

test('WALK → IDLE when path exhausted (resets frameTimer)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.state = PetState.WALK;
  pet.path = []; // already empty → arrival branch
  pet.moveProgress = 0;
  pet.frameTimer = 0.123;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.frameTimer, 0, 'frameTimer must reset to 0 on WALK→IDLE');
  assert.equal(pet.frame, 0);
  assert.ok(pet.wanderTimer > 0);
});

// ── FOLLOW exits ──────────────────────────────────────────────

test('FOLLOW → IDLE when target despawns (no longer in characters map)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 99; // not in map
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.5;
  updatePet(pet, 0.05, walkable, new Map(), tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.frameTimer, 0, 'frameTimer reset on FOLLOW→IDLE');
});

test('FOLLOW → IDLE when followDuration >= followDurationLimit', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 1;
  pet.followDuration = 10;
  pet.followDurationLimit = 5;
  pet.frameTimer = 0.7;
  const char = makeChar(1, 4, 4);
  const characters = new Map<number, Character>([[1, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.followTargetId, null);
  assert.equal(pet.frameTimer, 0);
});

test('FOLLOW → IDLE when within Manhattan distance 1 of target (faces target)', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = 7;
  pet.followDuration = 0;
  pet.followDurationLimit = 10;
  pet.frameTimer = 0.4;
  // Target is 1 tile to the right → pet faces RIGHT before settling.
  const char = makeChar(7, 3, 2);
  const characters = new Map<number, Character>([[7, char]]);
  updatePet(pet, 0.05, walkable, characters, tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.dir, Direction.RIGHT, 'should face target before settling');
  assert.equal(pet.frameTimer, 0);
});

// ── IDLE → APPROACH → SIT ─────────────────────────────────────

test('IDLE → APPROACH heads for the free tile beside the nearest inactive character', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([
    [1, makeChar(1, 9, 9)],
    [2, makeChar(2, 5, 0)],
  ]);
  // A seated character's own tile is blocked (seat tiles are), so the pet must
  // aim for a free neighbour of it, not for the character's tile itself.
  const blocked = new Set(['5,0']);
  // FOLLOW roll fails, behavior roll at the bottom of the APPROACH band
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    blocked,
    scriptedRng([0.99, PET_WANDER_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.APPROACH);
  assert.equal(pet.approachTargetId, 2, 'the nearer of the two inactive characters');
  assert.deepEqual(destination(pet), { col: 4, row: 0 }, 'the reachable neighbour nearest the pet');
  assert.equal(pet.path.length, 4);
});

test('APPROACH → SIT beside the character on arrival, facing it', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[2, makeChar(2, 5, 0)]]);
  const blocked = new Set(['5,0']);
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    blocked,
    scriptedRng([0.99, PET_WANDER_ROLL_MAX]),
  );
  assert.equal(pet.path.length, 4);

  // One tile per tick; the arrival tick draws the SIT duration (0 → the minimum).
  const rng = scriptedRng([0]);
  const step = tileTime(PET_WALK_SPEED_PX_PER_SEC);
  for (let i = 0; i < 3; i++) {
    updatePet(pet, step, walkable, characters, tileMap, blocked, rng);
    assert.equal(pet.state, PetState.APPROACH);
  }
  updatePet(pet, step, walkable, characters, tileMap, blocked, rng);
  assert.equal(pet.state, PetState.SIT);
  assert.deepEqual([pet.tileCol, pet.tileRow], [4, 0]);
  assert.equal(pet.dir, Direction.RIGHT, 'faces the character it sat beside');
  assert.equal(pet.restTimer, PET_SIT_DURATION_MIN_SEC);
  assert.equal(pet.approachTargetId, null);
});

test('IDLE → SIT straight away when already beside an inactive character', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 2, 3)]]);
  // FOLLOW roll fails, APPROACH band, SIT duration 0 → the minimum
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_WANDER_ROLL_MAX, 0]),
  );
  assert.equal(pet.state, PetState.SIT);
  assert.equal(pet.dir, Direction.DOWN, 'faces the character below it');
  assert.equal(pet.restTimer, PET_SIT_DURATION_MIN_SEC);
  assert.deepEqual(pet.path, []);
});

test('APPROACH skips blocked neighbours and takes the one with the shortest path', () => {
  // 10×3 room; the character sits on the bottom row with a desk on its left, so its
  // own tile, the desk tile and the off-map tile below it can't be reached.
  const tileMap = buildOpenTileMap(10, 3);
  const walkable = buildWalkableTiles(10, 3);
  const pet = makePet(0, 2);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 5, 2)]]);
  const blocked = new Set(['5,2', '4,2']);
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    blocked,
    scriptedRng([0.99, PET_WANDER_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.APPROACH);
  // Above the character (6 steps) beats its right-hand side (8 steps, around the desk).
  assert.deepEqual(destination(pet), { col: 5, row: 1 });
  assert.equal(pet.path.length, 6);
});

test('APPROACH ignores active, sub-agent, despawning and unknown-activity characters (wanders instead)', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([
    [1, makeChar(1, 5, 0, { isActive: true })],
    [2, makeChar(2, 0, 5, { isSubagent: true, parentAgentId: 1 })],
    [3, makeChar(3, 5, 5, { matrixEffect: 'despawn' })],
    [4, makeChar(4, 9, 9, { observation: 'unknown' })],
  ]);
  // FOLLOW roll fails, the APPROACH band finds no one, wander tile pick 0 → (1,0)
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_WANDER_ROLL_MAX, 0]),
  );
  assert.equal(pet.state, PetState.WALK);
  assert.equal(pet.approachTargetId, null);
  assert.deepEqual(destination(pet), { col: 1, row: 0 });
});

test('APPROACH → WALK, then IDLE without sitting, when the character leaves mid-approach', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const despawning = makeChar(2, 3, 0, { matrixEffect: 'despawn' });
  const cases: Array<Map<number, Character>> = [new Map(), new Map([[2, despawning]])];
  for (const characters of cases) {
    const pet = makePet(0, 0);
    pet.state = PetState.APPROACH;
    pet.approachTargetId = 2;
    pet.path = [
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ];
    updatePet(pet, 0.1, walkable, characters, tileMap, new Set(), scriptedRng([]));
    assert.equal(pet.state, PetState.WALK);
    assert.equal(pet.approachTargetId, null);
    assert.equal(pet.path.length, 2, 'keeps its planned walk');

    const step = tileTime(PET_WALK_SPEED_PX_PER_SEC);
    updatePet(pet, step, walkable, characters, tileMap, new Set(), scriptedRng([]));
    updatePet(pet, step, walkable, characters, tileMap, new Set(), scriptedRng([]));
    assert.equal(pet.state, PetState.IDLE);
    assert.deepEqual([pet.tileCol, pet.tileRow], [2, 0]);
  }
});

test('APPROACH → IDLE on arrival when the character has moved away', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.state = PetState.APPROACH;
  pet.approachTargetId = 1;
  pet.path = [{ col: 1, row: 0 }];
  const characters = new Map<number, Character>([[1, makeChar(1, 6, 6)]]);
  updatePet(
    pet,
    tileTime(PET_WALK_SPEED_PX_PER_SEC),
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0]),
  );
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.approachTargetId, null);
  assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
});

test('IDLE on the same tile as an inactive character → APPROACH a free neighbour, then SIT facing it', () => {
  // Pets and unseated characters don't block each other, so they can share a tile.
  // The pet must step off it first, never sit on top of the character.
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 2, 2)]]);
  // FOLLOW roll fails, behavior roll at the bottom of the APPROACH band
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_WANDER_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.APPROACH);
  assert.equal(pet.approachTargetId, 1);
  // Every neighbour is one step away; the first one tried (above the character) wins the tie.
  assert.deepEqual(pet.path, [{ col: 2, row: 1 }]);

  // One step later it's beside the character and sits (duration 0 → the minimum).
  updatePet(
    pet,
    tileTime(PET_WALK_SPEED_PX_PER_SEC),
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0]),
  );
  assert.equal(pet.state, PetState.SIT);
  assert.deepEqual([pet.tileCol, pet.tileRow], [2, 1]);
  assert.equal(pet.dir, Direction.DOWN, 'faces the character below it');
  assert.equal(pet.restTimer, PET_SIT_DURATION_MIN_SEC);
});

test('APPROACH → IDLE on arrival, without sitting, when the character stepped onto its destination', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.state = PetState.APPROACH;
  pet.approachTargetId = 1;
  pet.path = [{ col: 1, row: 0 }];
  const characters = new Map<number, Character>([[1, makeChar(1, 1, 0)]]);
  updatePet(
    pet,
    tileTime(PET_WALK_SPEED_PX_PER_SEC),
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0]),
  );
  assert.equal(pet.state, PetState.IDLE, 'never sits on the tile the character stands on');
  assert.deepEqual([pet.tileCol, pet.tileRow], [1, 0]);
  assert.equal(pet.approachTargetId, null);
  assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
});

test('APPROACH → IDLE on arrival, without sitting, when the character turned active or unknown on the way', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const changes: Array<Partial<Character>> = [{ isActive: true }, { observation: 'unknown' }];
  for (const change of changes) {
    const pet = makePet(0, 0);
    pet.state = PetState.APPROACH;
    pet.approachTargetId = 1;
    pet.path = [{ col: 1, row: 0 }];
    // Right beside the pet's destination, but no longer a character to approach.
    const characters = new Map<number, Character>([[1, makeChar(1, 2, 0, change)]]);
    updatePet(
      pet,
      tileTime(PET_WALK_SPEED_PX_PER_SEC),
      walkable,
      characters,
      tileMap,
      new Set(),
      scriptedRng([0]),
    );
    assert.equal(pet.state, PetState.IDLE, JSON.stringify(change));
    assert.deepEqual([pet.tileCol, pet.tileRow], [1, 0]);
    assert.equal(pet.approachTargetId, null);
    assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
  }
});

test('SIT keeps the idle animation going, then → IDLE when its rest runs out', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = makePet(1, 1);
  pet.state = PetState.SIT;
  pet.restTimer = 1;
  const rng = scriptedRng([0]);
  updatePet(pet, 0.6, walkable, new Map(), tileMap, new Set(), rng);
  assert.equal(pet.state, PetState.SIT);
  assert.equal(pet.frame, 1, 'SIT animates like IDLE');
  updatePet(pet, 0.6, walkable, new Map(), tileMap, new Set(), rng);
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.restTimer, 0);
  assert.equal(pet.frame, 0);
  assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
});

// ── IDLE → SLEEP ──────────────────────────────────────────────

test('IDLE → SLEEP on a SLEEP-band roll', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(2, 2);
  pet.wanderTimer = 0;
  // FOLLOW roll fails, behavior roll at the bottom of the SLEEP band, duration 0 → the minimum
  updatePet(
    pet,
    0.1,
    walkable,
    new Map(),
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_APPROACH_ROLL_MAX, 0]),
  );
  assert.equal(pet.state, PetState.SLEEP);
  assert.equal(pet.restTimer, PET_SLEEP_DURATION_MIN_SEC);
  assert.deepEqual(pet.path, []);
  assert.equal(pet.frame, 0);
});

test('SLEEP holds its first frame through nearby activity, then → IDLE when its rest runs out', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = makePet(1, 1);
  pet.state = PetState.SLEEP;
  pet.restTimer = 1;
  const characters = new Map<number, Character>([[1, makeChar(1, 1, 2, { isActive: true })]]);
  const rng = scriptedRng([0]);
  updatePet(pet, 0.6, walkable, characters, tileMap, new Set(), rng);
  assert.equal(pet.state, PetState.SLEEP);
  assert.equal(pet.frame, 0, 'a sleeping pet does not animate');
  updatePet(pet, 0.6, walkable, characters, tileMap, new Set(), rng);
  assert.equal(pet.state, PetState.IDLE);
  assert.equal(pet.restTimer, 0);
  assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
});

// ── IDLE → FLEE ───────────────────────────────────────────────

test('IDLE → FLEE away from a nearby active character', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(4, 4);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 1, 4, { isActive: true })]]);
  // FOLLOW roll fails, behavior roll at the bottom of the FLEE band
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_SLEEP_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.FLEE);
  // Mirrored away from the character: (4,4) + ((4,4) − (1,4)) = (7,4)
  assert.deepEqual(destination(pet), { col: 7, row: 4 });
});

test('FLEE runs to the walkable tile nearest the mirrored point when that is off the map', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(8, 4);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 5, 4, { isActive: true })]]);
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_SLEEP_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.FLEE);
  // The mirrored point (11,4) is off the 10-wide map; (9,4) is the nearest walkable tile.
  assert.deepEqual(destination(pet), { col: 9, row: 4 });
});

test('FLEE backed against a wall runs along it, not staying put or running to the threat', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const cases = [
    // The mirrored point (-1,4) is off the map, and the pet's own tile is the one nearest it.
    { pet: { col: 0, row: 4 }, threat: { col: 1, row: 4 }, away: { col: 0, row: 3 } },
    // Cornered: the threat's own tile (1,0) would tie (0,1) for nearest, and come first.
    { pet: { col: 0, row: 0 }, threat: { col: 1, row: 0 }, away: { col: 0, row: 1 } },
  ];
  for (const { pet: at, threat, away } of cases) {
    const pet = makePet(at.col, at.row);
    pet.wanderTimer = 0;
    const characters = new Map<number, Character>([
      [1, makeChar(1, threat.col, threat.row, { isActive: true })],
    ]);
    updatePet(
      pet,
      0.1,
      walkable,
      characters,
      tileMap,
      new Set(),
      scriptedRng([0.99, PET_SLEEP_ROLL_MAX]),
    );
    assert.equal(pet.state, PetState.FLEE, JSON.stringify(at));
    assert.deepEqual(pet.path, [away]);
  }
});

test('FLEE steps off its tile when an active character is standing on it', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(4, 4);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 4, 4, { isActive: true })]]);
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_SLEEP_ROLL_MAX]),
  );
  assert.equal(pet.state, PetState.FLEE);
  // Every neighbour is one step away; the first in the walkable list (above) wins the tie.
  assert.deepEqual(pet.path, [{ col: 4, row: 3 }]);
});

test('FLEE falls back to wandering when no tile is farther from the threat', () => {
  // A 3×1 corridor with the threat in the middle: both ends are one tile from it.
  const tileMap = buildOpenTileMap(3, 1);
  const walkable = buildWalkableTiles(3, 1);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([[1, makeChar(1, 1, 0, { isActive: true })]]);
  // FOLLOW roll fails, the FLEE band finds nowhere to run, wander tile pick 0.99 → (2,0)
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_SLEEP_ROLL_MAX, 0.99]),
  );
  assert.equal(pet.state, PetState.WALK);
  assert.deepEqual(destination(pet), { col: 2, row: 0 });
});

test('FLEE falls back to wandering when no visible active character is close', () => {
  const tileMap = buildOpenTileMap(10, 10);
  const walkable = buildWalkableTiles(10, 10);
  const pet = makePet(0, 0);
  pet.wanderTimer = 0;
  const characters = new Map<number, Character>([
    [1, makeChar(1, 1, 1)], // inactive
    [2, makeChar(2, 9, 9, { isActive: true })], // active, but far away
    [3, makeChar(3, 0, 1, { isActive: true, isSubagent: true, parentAgentId: 2 })],
    [4, makeChar(4, 0, 2, { isActive: true, observation: 'unknown' })],
  ]);
  // FOLLOW roll fails, the FLEE band finds no threat, wander tile pick 0 → (1,0)
  updatePet(
    pet,
    0.1,
    walkable,
    characters,
    tileMap,
    new Set(),
    scriptedRng([0.99, PET_SLEEP_ROLL_MAX, 0]),
  );
  assert.equal(pet.state, PetState.WALK);
  assert.deepEqual(destination(pet), { col: 1, row: 0 });
});

test('FLEE reuses the walk cycle, moving and animating faster than WALK', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const fleeing = makePet(0, 0);
  fleeing.state = PetState.FLEE;
  fleeing.path = [{ col: 1, row: 0 }];
  const walking = makePet(0, 0);
  walking.state = PetState.WALK;
  walking.path = [{ col: 1, row: 0 }];
  const startX = walking.x;
  // One FLEE frame's worth of time, shorter than a WALK frame
  for (const pet of [fleeing, walking]) {
    updatePet(
      pet,
      PET_FLEE_FRAME_DURATION_SEC,
      walkable,
      new Map(),
      tileMap,
      new Set(),
      scriptedRng([]),
    );
  }
  assert.equal(fleeing.state, PetState.FLEE);
  assert.equal(fleeing.frame, 1, 'FLEE advanced a walk-cycle frame');
  assert.equal(walking.frame, 0, 'WALK did not yet');
  const fled = fleeing.x - startX;
  const walked = walking.x - startX;
  assert.ok(fled > walked, `fled ${fled}px vs walked ${walked}px`);
  const expectedRatio = PET_FLEE_SPEED_PX_PER_SEC / PET_WALK_SPEED_PX_PER_SEC;
  assert.ok(Math.abs(fled - walked * expectedRatio) < 1e-9, 'moves at PET_FLEE_SPEED_PX_PER_SEC');
});

test('FLEE → IDLE on arrival', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.state = PetState.FLEE;
  pet.path = [{ col: 1, row: 0 }];
  updatePet(
    pet,
    tileTime(PET_FLEE_SPEED_PX_PER_SEC),
    walkable,
    new Map(),
    tileMap,
    new Set(),
    scriptedRng([0]),
  );
  assert.equal(pet.state, PetState.IDLE);
  assert.deepEqual([pet.tileCol, pet.tileRow], [1, 0]);
  assert.equal(pet.wanderTimer, PET_WANDER_PAUSE_MIN_SEC);
});

// ── Sprite frames ─────────────────────────────────────────────

/** Three distinguishable one-pixel frames tagged with their animation name. */
function taggedFrames(tag: string): [SpriteData, SpriteData, SpriteData] {
  return [[[`${tag}0`]], [[`${tag}1`]], [[`${tag}2`]]];
}

test('SIT and SLEEP draw the idle frames; APPROACH and FLEE draw the walk frames', () => {
  const frames: PetSpriteFrames = {
    walkDown: taggedFrames('walkDown'),
    idleDown: taggedFrames('idleDown'),
    walkUp: taggedFrames('walkUp'),
    idleUp: taggedFrames('idleUp'),
    walkRight: taggedFrames('walkRight'),
    walkLeft: taggedFrames('walkLeft'),
    idleRight: taggedFrames('idleRight'),
    idleLeft: taggedFrames('idleLeft'),
  };
  const pet = makePet(1, 1);
  pet.dir = Direction.RIGHT;
  pet.frame = 1;
  for (const state of [PetState.SIT, PetState.SLEEP]) {
    pet.state = state;
    assert.equal(getPetSpriteData(pet, frames), frames.idleRight[PET_IDLE_SEQUENCE[1]], state);
  }
  for (const state of [PetState.APPROACH, PetState.FLEE]) {
    pet.state = state;
    assert.equal(getPetSpriteData(pet, frames), frames.walkRight[PET_WALK_SEQUENCE[1]], state);
  }
});

// ── Animation timers ─────────────────────────────────────────

test('WALK animation: frameTimer wraps to 0 and frame increments after PET_WALK_FRAME_DURATION_SEC', () => {
  const tileMap = buildOpenTileMap(5, 5);
  const walkable = buildWalkableTiles(5, 5);
  const pet = makePet(0, 0);
  pet.state = PetState.WALK;
  pet.path = [{ col: 1, row: 0 }]; // 1-tile path so it stays in WALK
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  // Run with dt slightly larger than the animation duration
  updatePet(
    pet,
    PET_WALK_FRAME_DURATION_SEC + 0.001,
    walkable,
    new Map(),
    tileMap,
    new Set(),
    scriptedRng([]),
  );
  // frame should have advanced by 1 (4-step cycle).
  assert.equal(pet.frame, 1);
  // frameTimer should be small positive (the leftover after the threshold)
  assert.ok(pet.frameTimer >= 0 && pet.frameTimer < PET_WALK_FRAME_DURATION_SEC);
});

test('IDLE animation ticks while pet is in IDLE state', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = makePet(1, 1);
  pet.wanderTimer = 100; // ensures we stay in IDLE, no state transition
  pet.frame = 0;
  pet.frameTimer = 0;
  updatePet(pet, 0.5, walkable, new Map(), tileMap, new Set(), scriptedRng([]));
  // 0.5s > PET_IDLE_FRAME_DURATION_SEC (0.3s) → frame increments by 1, frameTimer holds the remainder
  assert.equal(pet.frame, 1);
});

// ── Defensive / edge cases ────────────────────────────────────

test('updatePet does not throw on dt=0', () => {
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = makePet(1, 1);
  assert.doesNotThrow(() =>
    updatePet(pet, 0, walkable, new Map(), tileMap, new Set(), scriptedRng([])),
  );
});

test('updatePet handles FOLLOW with null followTargetId (defensive: never enter follow without setting id)', () => {
  // Synthetic: FOLLOW state with no target id. Should exit cleanly.
  const tileMap = buildOpenTileMap(3, 3);
  const walkable = buildWalkableTiles(3, 3);
  const pet = makePet(1, 1);
  pet.state = PetState.FOLLOW;
  pet.followTargetId = null;
  pet.followDurationLimit = 5;
  updatePet(pet, 0.01, walkable, new Map(), tileMap, new Set(), scriptedRng([]));
  assert.equal(pet.state, PetState.IDLE, 'no target → exit FOLLOW');
});
