import assert from 'node:assert/strict';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ROOM_ASSETS, TILE_SIZE } from '../src/constants.js';
import { expandLayout } from '../src/office/editor/editorActions.js';
import { generateRoom } from '../src/office/editor/roomGeneration.js';
import { createCharacter } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { isWalkable } from '../src/office/layout/tileMap.js';
import { setPetTemplates } from '../src/office/sprites/petSpriteData.js';
import type { Character, Pet } from '../src/office/types.js';
import { CharacterState, PetState, TileType } from '../src/office/types.js';
import { emptyLayout, generationOptions, loadRoomCatalog } from './roomFixtures.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadRoomCatalog();
  const frames = [[['']], [['']], [['']]];
  setPetTemplates([
    { walkDown: frames, idleDown: frames, walkUp: frames, idleUp: frames, walkRight: frames },
  ]);
});
afterEach(() => {
  setPetTemplates([]);
  vi.restoreAllMocks();
});

function position(entity: Character | Pet, col: number, row: number): void {
  entity.tileCol = col;
  entity.tileRow = row;
  entity.x = col * TILE_SIZE + TILE_SIZE / 2;
  entity.y = row * TILE_SIZE + TILE_SIZE / 2;
}

it('translates seats, unseated characters, pets, Greeter, and camera target in both directions', () => {
  const layout = emptyLayout(10, 10);
  layout.tiles.fill(TileType.FLOOR_1);
  layout.furniture = [{ uid: 'original-seat', type: ROOM_ASSETS.deskChair, col: 5, row: 5 }];
  layout.pets = [{ id: 'original-pet', petType: 0 }];
  const os = new OfficeState(layout);
  os.addAgent(1, 0, 0);
  const seated = os.characters.get(1)!;
  seated.currentTool = 'view';
  seated.observation = 'unknown';
  const unseated = createCharacter(2, 0, null, null);
  unseated.observation = 'unknown';
  position(unseated, 2, 2);
  unseated.state = CharacterState.WALK;
  unseated.path = [{ col: 3, row: 2 }];
  os.characters.set(2, unseated);
  const sub = os.characters.get(os.addSubagent(2, 'hidden-task'))!;
  position(sub, 3, 2);
  sub.path = [{ col: 4, row: 2 }];
  os.spawnGreeter();
  position(os.greeter!, 1, 3);
  os.greeterCameraTarget = { x: 16, y: 24 };
  const pet = os.pets[0];
  position(pet, 3, 4);
  pet.path = [{ col: 4, row: 4 }];
  pet.state = PetState.WALK;
  let expanded = layout;
  for (let i = 0; i < 3; i++) expanded = expandLayout(expanded, 'left')!.layout;
  for (let i = 0; i < 2; i++) expanded = expandLayout(expanded, 'up')!.layout;

  os.rebuildFromLayout(expanded, { col: 3, row: 2 });
  expect([seated.tileCol, seated.tileRow, seated.seatId]).toEqual([8, 7, 'original-seat']);
  expect([unseated.tileCol, unseated.tileRow, unseated.seatId]).toEqual([5, 4, null]);
  expect(unseated.path).toHaveLength(0);
  expect(unseated.state).toBe(CharacterState.IDLE);
  expect([sub.tileCol, sub.tileRow]).toEqual([6, 4]);
  expect(sub.path).toHaveLength(0);
  expect(os.isCharacterVisible(sub.id)).toBe(false);
  expect([pet.tileCol, pet.tileRow]).toEqual([6, 6]);
  expect(pet.path).toEqual([{ col: 7, row: 6 }]);
  expect([os.greeter!.tileCol, os.greeter!.tileRow]).toEqual([4, 5]);
  expect(os.greeterCameraTarget).toEqual({ x: 64, y: 56 });

  os.rebuildFromLayout(layout, { col: -3, row: -2 });
  expect([seated.tileCol, seated.tileRow, seated.seatId]).toEqual([5, 5, 'original-seat']);
  expect([unseated.tileCol, unseated.tileRow]).toEqual([2, 2]);
  expect([sub.tileCol, sub.tileRow]).toEqual([3, 2]);
  expect([pet.tileCol, pet.tileRow]).toEqual([3, 4]);
  expect(pet.path).toEqual([{ col: 4, row: 4 }]);
  expect([os.greeter!.tileCol, os.greeter!.tileRow]).toEqual([1, 3]);
  expect(os.greeterCameraTarget).toEqual({ x: 16, y: 24 });
  expect(seated.currentTool).toBe('view');
  expect(seated.observation).toBe('unknown');
});

it('Undo relocates inhabitants whose room becomes in-bounds VOID, without undoing activity', () => {
  const original = emptyLayout(24, 24);
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) original.tiles[row * original.cols + col] = TileType.FLOOR_1;
  }
  original.pets = [{ id: 'pet', petType: 0 }];
  const generated = generateRoom(original, generationOptions());
  assert.ok(generated.ok);
  expect(generated.shift).toEqual({ col: 0, row: 0 });
  const os = new OfficeState(generated.layout);
  os.addAgent(1, 0, 0);
  const agent = os.characters.get(1)!;
  agent.currentTool = 'Bash';
  agent.bubbleType = 'permission';
  agent.observation = 'unknown';
  const sub = os.characters.get(os.addSubagent(1, 'task'))!;
  const inside = { col: generated.interior.col, row: generated.interior.row };
  position(sub, inside.col, inside.row);
  const pet = os.pets[0];
  position(pet, inside.col, inside.row);
  pet.path = [{ col: inside.col + 1, row: inside.row }];
  os.spawnGreeter();
  position(os.greeter!, inside.col, inside.row);

  os.rebuildFromLayout(original);
  for (const inhabitant of [...os.characters.values(), os.greeter!, ...os.pets]) {
    expect(isWalkable(inhabitant.tileCol, inhabitant.tileRow, os.tileMap, os.blockedTiles)).toBe(
      true,
    );
    expect(inhabitant.path).toHaveLength(0);
  }
  expect(agent.currentTool).toBe('Bash');
  expect(agent.bubbleType).toBe('permission');
  expect(agent.seatId).toBeNull();
  expect(sub.isSubagent).toBe(true);
  expect(os.isCharacterVisible(sub.id)).toBe(false);
  os.setAgentObservation(1, 'known');
  expect(os.isCharacterVisible(sub.id)).toBe(true);
  expect(os.pets).toHaveLength(1);
});

it('creating room seats does not give Sub-agents or the Greeter an assigned seat', () => {
  const layout = emptyLayout(24, 24);
  for (let row = 1; row <= 3; row++) {
    for (let col = 1; col <= 3; col++) layout.tiles[row * layout.cols + col] = TileType.FLOOR_1;
  }
  const os = new OfficeState(layout);
  os.addAgent(1, 0, 0);
  const subId = os.addSubagent(1, 'task');
  os.spawnGreeter();
  const generated = generateRoom(layout, generationOptions(8, 8));
  assert.ok(generated.ok);
  os.rebuildFromLayout(generated.layout, generated.shift);
  expect(os.characters.get(1)!.seatId).not.toBeNull();
  expect(os.characters.get(subId)!.seatId).toBeNull();
  expect(os.greeter!.seatId).toBeNull();
  expect(Object.keys(os.getPersistableSeats())).toEqual(['1']);
});
