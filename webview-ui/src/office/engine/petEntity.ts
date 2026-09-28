import {
  PET_APPROACH_ROLL_MAX,
  PET_FLEE_FRAME_DURATION_SEC,
  PET_FLEE_RADIUS_TILES,
  PET_FLEE_SPEED_PX_PER_SEC,
  PET_FOLLOW_CHANCE,
  PET_FOLLOW_DURATION_MAX_SEC,
  PET_FOLLOW_DURATION_MIN_SEC,
  PET_FOLLOW_RADIUS_TILES,
  PET_FOLLOW_RECALC_INTERVAL_SEC,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_IDLE_SEQUENCE,
  PET_SIT_DURATION_MAX_SEC,
  PET_SIT_DURATION_MIN_SEC,
  PET_SLEEP_DURATION_MAX_SEC,
  PET_SLEEP_DURATION_MIN_SEC,
  PET_SLEEP_ROLL_MAX,
  PET_WALK_FRAME_DURATION_SEC,
  PET_WALK_SEQUENCE,
  PET_WALK_SPEED_PX_PER_SEC,
  PET_WANDER_PAUSE_MAX_SEC,
  PET_WANDER_PAUSE_MIN_SEC,
  PET_WANDER_ROLL_MAX,
} from '../../constants.js';
import { findPath, isWalkable } from '../layout/tileMap.js';
import type { PetSpriteFrames } from '../sprites/petSpriteData.js';
import type { Character, Pet, SpriteData, TileType as TileTypeVal } from '../types.js';
import { Direction, PetState, TILE_SIZE } from '../types.js';

/**
 * Source of randomness for the pet FSM: a float in [0, 1), like `Math.random`.
 * Injectable so tests can script every decision.
 */
export type PetRng = () => number;

/** Inclusive-min / exclusive-max random float */
function randomRange(min: number, max: number, rng: PetRng): number {
  return min + rng() * (max - min);
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
  };
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
): Direction {
  const dc = toCol - fromCol;
  const dr = toRow - fromRow;
  if (dc > 0) return Direction.RIGHT;
  if (dc < 0) return Direction.LEFT;
  if (dr > 0) return Direction.DOWN;
  return Direction.UP;
}

/** Manhattan distance between two tile coords */
function manhattanDistance(c1: number, r1: number, c2: number, r2: number): number {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

/**
 * Pick the closest non-sub-agent character within PET_FOLLOW_RADIUS_TILES
 * by Manhattan distance. Excludes despawning characters (matrixEffect === 'despawn').
 */
function findNearbyCharacter(pet: Pet, characters: Map<number, Character>): Character | null {
  let closest: Character | null = null;
  let closestDist = Number.POSITIVE_INFINITY;
  for (const ch of characters.values()) {
    if (ch.matrixEffect === 'despawn') continue;
    const d = manhattanDistance(pet.tileCol, pet.tileRow, ch.tileCol, ch.tileRow);
    if (d > PET_FOLLOW_RADIUS_TILES) continue;
    if (d < closestDist) {
      closest = ch;
      closestDist = d;
    }
  }
  return closest;
}

/**
 * Find a walkable tile adjacent (4-connected) to a character's current tile.
 * Returns the first hit in N/S/W/E scan order, or null if all neighbours are blocked.
 */
function findAdjacentTile(
  ch: Character,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): { col: number; row: number } | null {
  const candidates = [
    { col: ch.tileCol, row: ch.tileRow - 1 },
    { col: ch.tileCol, row: ch.tileRow + 1 },
    { col: ch.tileCol - 1, row: ch.tileRow },
    { col: ch.tileCol + 1, row: ch.tileRow },
  ];
  for (const t of candidates) {
    if (isWalkable(t.col, t.row, tileMap, blockedTiles)) return t;
  }
  return null;
}

/** Advance the walk-cycle frame counter (4-step cycle). */
function updateWalkAnimation(
  pet: Pet,
  dt: number,
  frameDuration: number = PET_WALK_FRAME_DURATION_SEC,
): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= frameDuration) {
    pet.frameTimer -= frameDuration;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/** Advance the idle-cycle frame counter (4-step cycle, slower than walk). */
function updateIdleAnimation(pet: Pet, dt: number): void {
  pet.frameTimer += dt;
  if (pet.frameTimer >= PET_IDLE_FRAME_DURATION_SEC) {
    pet.frameTimer -= PET_IDLE_FRAME_DURATION_SEC;
    pet.frame = (pet.frame + 1) % 4;
  }
}

/**
 * Lerp the pet along its current `path`. When it reaches the next tile,
 * shift the tile off the path and update `tileCol`/`tileRow`. Sets `dir`.
 */
function movePetAlongPath(
  pet: Pet,
  dt: number,
  speedPxPerSec: number = PET_WALK_SPEED_PX_PER_SEC,
): void {
  if (pet.path.length === 0) return;
  const nextTile = pet.path[0];
  pet.dir = directionBetween(pet.tileCol, pet.tileRow, nextTile.col, nextTile.row);

  pet.moveProgress += (speedPxPerSec / TILE_SIZE) * dt;

  const fromCenter = tileCenter(pet.tileCol, pet.tileRow);
  const toCenter = tileCenter(nextTile.col, nextTile.row);
  const t = Math.min(pet.moveProgress, 1);
  pet.x = fromCenter.x + (toCenter.x - fromCenter.x) * t;
  pet.y = fromCenter.y + (toCenter.y - fromCenter.y) * t;

  if (pet.moveProgress >= 1) {
    pet.tileCol = nextTile.col;
    pet.tileRow = nextTile.row;
    pet.x = toCenter.x;
    pet.y = toCenter.y;
    pet.path.shift();
    pet.moveProgress = 0;
  }
}

/** Settle into IDLE with a fresh wander pause. */
function enterIdle(pet: Pet, rng: PetRng): void {
  pet.state = PetState.IDLE;
  pet.path = [];
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
}

/** Stay put in SIT or SLEEP for `duration` seconds, then return to IDLE. */
function rest(
  pet: Pet,
  state: typeof PetState.SIT | typeof PetState.SLEEP,
  duration: number,
): void {
  pet.state = state;
  pet.restTimer = duration;
  pet.path = [];
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
}

/** SIT beside `target`, facing it when it's on a neighbouring tile. */
function sitBeside(pet: Pet, target: Character, rng: PetRng): void {
  if (manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow) === 1) {
    pet.dir = directionBetween(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
  }
  rest(pet, PetState.SIT, randomRange(PET_SIT_DURATION_MIN_SEC, PET_SIT_DURATION_MAX_SEC, rng));
}

/**
 * The nearest character within `maxDistance` tiles (Manhattan) whose `isActive` equals `active`.
 * Skips sub-agents, despawning characters, and characters whose activity is unknown
 * (`observation: 'unknown'`), since their `isActive` can't be trusted.
 */
function findNearestCharacter(
  pet: Pet,
  characters: Map<number, Character>,
  active: boolean,
  maxDistance: number,
): Character | null {
  let closest: Character | null = null;
  let closestDist = Number.POSITIVE_INFINITY;
  for (const ch of characters.values()) {
    if (ch.isActive !== active || ch.isSubagent) continue;
    if (ch.matrixEffect === 'despawn' || ch.observation === 'unknown') continue;
    const d = manhattanDistance(pet.tileCol, pet.tileRow, ch.tileCol, ch.tileRow);
    if (d <= maxDistance && d < closestDist) {
      closest = ch;
      closestDist = d;
    }
  }
  return closest;
}

/** The walkable tile nearest (Manhattan) to `col`,`row`; ties keep the earliest in the list. */
function findNearestWalkable(
  col: number,
  row: number,
  walkableTiles: Array<{ col: number; row: number }>,
): { col: number; row: number } | null {
  let best: { col: number; row: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of walkableTiles) {
    const d = manhattanDistance(t.col, t.row, col, row);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

/** WALK to a random walkable tile other than the pet's own. Stays IDLE when none is reachable. */
function startWander(
  pet: Pet,
  walkableTiles: Array<{ col: number; row: number }>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  rng: PetRng,
): void {
  // Filter out own tile to avoid zero-length paths
  const candidates = walkableTiles.filter((t) => t.col !== pet.tileCol || t.row !== pet.tileRow);
  if (candidates.length === 0) return;
  const target = candidates[Math.floor(rng() * candidates.length)];
  const path = findPath(pet.tileCol, pet.tileRow, target.col, target.row, tileMap, blockedTiles);
  if (path.length === 0) return;
  pet.state = PetState.WALK;
  pet.path = path;
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
}

/**
 * APPROACH the nearest inactive character (any distance): walk to the free tile beside it with
 * the shortest path, to SIT there. Already beside it: SIT straight away. Returns false when
 * there's no one to approach or no free tile beside them can be reached.
 */
function startApproach(
  pet: Pet,
  characters: Map<number, Character>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  rng: PetRng,
): boolean {
  const target = findNearestCharacter(pet, characters, false, Number.POSITIVE_INFINITY);
  if (!target) return false;
  if (manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow) <= 1) {
    sitBeside(pet, target, rng);
    return true;
  }
  // A seated character's own tile is blocked, so aim for a free neighbour of it instead.
  const neighbours = [
    { col: target.tileCol, row: target.tileRow - 1 },
    { col: target.tileCol, row: target.tileRow + 1 },
    { col: target.tileCol - 1, row: target.tileRow },
    { col: target.tileCol + 1, row: target.tileRow },
  ];
  let best: Array<{ col: number; row: number }> = [];
  for (const t of neighbours) {
    const path = findPath(pet.tileCol, pet.tileRow, t.col, t.row, tileMap, blockedTiles);
    if (path.length > 0 && (best.length === 0 || path.length < best.length)) best = path;
  }
  if (best.length === 0) return false;
  pet.state = PetState.APPROACH;
  pet.approachTargetId = target.id;
  pet.path = best;
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  return true;
}

/**
 * FLEE from the nearest active character within PET_FLEE_RADIUS_TILES, toward the walkable tile
 * nearest the point mirrored away from it. Returns false when no active character is that close
 * or the pet has nowhere to run.
 */
function startFlee(
  pet: Pet,
  walkableTiles: Array<{ col: number; row: number }>,
  characters: Map<number, Character>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
): boolean {
  const threat = findNearestCharacter(pet, characters, true, PET_FLEE_RADIUS_TILES);
  if (!threat) return false;
  const away = findNearestWalkable(
    2 * pet.tileCol - threat.tileCol,
    2 * pet.tileRow - threat.tileRow,
    walkableTiles,
  );
  if (!away) return false;
  const path = findPath(pet.tileCol, pet.tileRow, away.col, away.row, tileMap, blockedTiles);
  if (path.length === 0) return false;
  pet.state = PetState.FLEE;
  pet.path = path;
  pet.moveProgress = 0;
  pet.frame = 0;
  pet.frameTimer = 0;
  return true;
}

/** Build a fresh pet at a tile with the IDLE FSM entry point. */
export function createPet(
  id: string,
  petType: number,
  col: number,
  row: number,
  rng: PetRng = Math.random,
): Pet {
  const center = tileCenter(col, row);
  return {
    id,
    name: '', // Filled by OfficeState.addPet() via getPetName(petType)
    petType,
    state: PetState.IDLE,
    dir: Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    frame: 0,
    frameTimer: 0,
    wanderTimer: randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng),
    followTargetId: null,
    followRecalcTimer: 0,
    followDuration: 0,
    followDurationLimit: 0,
    approachTargetId: null,
    restTimer: 0,
    bubbleType: null,
    bubbleTimer: 0,
  };
}

/**
 * Tick the pet's FSM by `dt` seconds. Mutates `pet` in place.
 * `walkableTiles`/`characters`/`tileMap`/`blockedTiles` are read-only inputs.
 * `rng` drives every random decision (defaults to `Math.random`).
 */
export function updatePet(
  pet: Pet,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  characters: Map<number, Character>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  rng: PetRng = Math.random,
): void {
  switch (pet.state) {
    case PetState.IDLE: {
      updateIdleAnimation(pet, dt);
      pet.wanderTimer -= dt;
      if (pet.wanderTimer > 0) break;

      // Roll for follow first
      if (rng() < PET_FOLLOW_CHANCE) {
        const target = findNearbyCharacter(pet, characters);
        if (target) {
          pet.state = PetState.FOLLOW;
          pet.followTargetId = target.id;
          pet.followDuration = 0;
          pet.followRecalcTimer = 0;
          pet.followDurationLimit = randomRange(
            PET_FOLLOW_DURATION_MIN_SEC,
            PET_FOLLOW_DURATION_MAX_SEC,
            rng,
          );
          pet.frame = 0;
          pet.frameTimer = 0;
          break;
        }
      }

      // Else one roll picks the next behavior from the bands in constants.ts.
      // APPROACH and FLEE fall back to wandering when they have no target.
      const roll = rng();
      if (roll < PET_WANDER_ROLL_MAX) {
        startWander(pet, walkableTiles, tileMap, blockedTiles, rng);
      } else if (roll < PET_APPROACH_ROLL_MAX) {
        if (!startApproach(pet, characters, tileMap, blockedTiles, rng)) {
          startWander(pet, walkableTiles, tileMap, blockedTiles, rng);
        }
      } else if (roll < PET_SLEEP_ROLL_MAX) {
        rest(
          pet,
          PetState.SLEEP,
          randomRange(PET_SLEEP_DURATION_MIN_SEC, PET_SLEEP_DURATION_MAX_SEC, rng),
        );
      } else if (!startFlee(pet, walkableTiles, characters, tileMap, blockedTiles)) {
        startWander(pet, walkableTiles, tileMap, blockedTiles, rng);
      }
      pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
      break;
    }

    case PetState.WALK: {
      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);

      if (pet.path.length === 0 && pet.moveProgress === 0) {
        // Arrived
        pet.state = PetState.IDLE;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
        pet.frame = 0;
        pet.frameTimer = 0;
      }
      break;
    }

    case PetState.APPROACH: {
      const target =
        pet.approachTargetId !== null ? characters.get(pet.approachTargetId) : undefined;
      if (!target || target.matrixEffect === 'despawn') {
        // The character left: finish the walk as a plain WALK, without sitting down.
        pet.approachTargetId = null;
        pet.state = PetState.WALK;
        break;
      }

      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);

      if (pet.path.length === 0 && pet.moveProgress === 0) {
        // Arrived: sit if the character is still beside us, otherwise settle.
        pet.approachTargetId = null;
        if (manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow) <= 1) {
          sitBeside(pet, target, rng);
        } else {
          enterIdle(pet, rng);
        }
      }
      break;
    }

    case PetState.FLEE: {
      updateWalkAnimation(pet, dt, PET_FLEE_FRAME_DURATION_SEC);
      movePetAlongPath(pet, dt, PET_FLEE_SPEED_PX_PER_SEC);
      if (pet.path.length === 0 && pet.moveProgress === 0) enterIdle(pet, rng);
      break;
    }

    case PetState.SIT:
    case PetState.SLEEP: {
      // Sitting keeps the idle animation going; sleeping holds its first frame.
      if (pet.state === PetState.SIT) updateIdleAnimation(pet, dt);
      pet.restTimer -= dt;
      if (pet.restTimer <= 0) {
        pet.restTimer = 0;
        enterIdle(pet, rng);
      }
      break;
    }

    case PetState.FOLLOW: {
      pet.followDuration += dt;
      const target = pet.followTargetId !== null ? characters.get(pet.followTargetId) : undefined;

      // Exit: target gone
      if (!target) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
        break;
      }

      // Exit: duration limit
      if (pet.followDuration >= pet.followDurationLimit) {
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
        break;
      }

      // Exit: reached target (Manhattan distance ≤ 1)
      const dist = manhattanDistance(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
      if (dist <= 1) {
        // Face the target before settling
        if (dist === 1) {
          pet.dir = directionBetween(pet.tileCol, pet.tileRow, target.tileCol, target.tileRow);
        }
        pet.state = PetState.IDLE;
        pet.followTargetId = null;
        pet.path = [];
        pet.moveProgress = 0;
        pet.frame = 0;
        pet.frameTimer = 0;
        pet.wanderTimer = randomRange(PET_WANDER_PAUSE_MIN_SEC, PET_WANDER_PAUSE_MAX_SEC, rng);
        break;
      }

      // Continue following: recompute path periodically
      pet.followRecalcTimer -= dt;
      if (pet.followRecalcTimer <= 0) {
        const adj = findAdjacentTile(target, tileMap, blockedTiles);
        if (adj) {
          const path = findPath(pet.tileCol, pet.tileRow, adj.col, adj.row, tileMap, blockedTiles);
          if (path.length > 0) {
            pet.path = path;
            pet.moveProgress = 0;
          }
        }
        pet.followRecalcTimer = PET_FOLLOW_RECALC_INTERVAL_SEC;
      }

      updateWalkAnimation(pet, dt);
      movePetAlongPath(pet, dt);
      break;
    }
  }
}

/**
 * Resolve the sprite for the pet's current state + direction + frame.
 * Returns null when sprites haven't loaded yet — renderer guards.
 */
export function getPetSpriteData(pet: Pet, petSprites: PetSpriteFrames | null): SpriteData | null {
  if (!petSprites) return null;

  // Resting states reuse the idle frames (SLEEP holds frame 0: its tick never advances it).
  if (pet.state === PetState.IDLE || pet.state === PetState.SIT || pet.state === PetState.SLEEP) {
    const frameIdx = PET_IDLE_SEQUENCE[pet.frame % PET_IDLE_SEQUENCE.length];
    switch (pet.dir) {
      case Direction.DOWN:
        return petSprites.idleDown[frameIdx];
      case Direction.UP:
        return petSprites.idleUp[frameIdx];
      case Direction.RIGHT:
        return petSprites.idleRight[frameIdx];
      case Direction.LEFT:
        return petSprites.idleLeft[frameIdx];
    }
  }

  // WALK, FOLLOW, APPROACH and FLEE (FLEE just cycles these frames faster)
  const frameIdx = PET_WALK_SEQUENCE[pet.frame % PET_WALK_SEQUENCE.length];
  switch (pet.dir) {
    case Direction.DOWN:
      return petSprites.walkDown[frameIdx];
    case Direction.UP:
      return petSprites.walkUp[frameIdx];
    case Direction.RIGHT:
      return petSprites.walkRight[frameIdx];
    case Direction.LEFT:
      return petSprites.walkLeft[frameIdx];
  }
}
