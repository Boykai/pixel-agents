/**
 * Unit tests for pet camera follow in OfficeState (`cameraFollowPetId`).
 *
 * Covers clickPet toggling the follow together with the heart bubble, its
 * mutual exclusion with agent selection and agent follow, getFollowedPet, and
 * the follow ending when its pet leaves the layout, plus the centering both
 * follows share (`centeringPan`) at every zoom level. The canvas gestures that
 * also end it (pans, empty-space clicks, entering the Layout editor) live in
 * OfficeCanvas / useEditorActions and are covered by e2e (pets.spec.ts).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import { ZOOM_MAX, ZOOM_MIN } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { centeringPan, mapOffset } from '../src/office/projection.js';
import { setPetTemplates } from '../src/office/sprites/petSpriteData.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

beforeEach(() => {
  const frames = [[['']], [['']], [['']]];
  setPetTemplates([
    { walkDown: frames, idleDown: frames, walkUp: frames, idleUp: frames, walkRight: frames },
  ]);
});

afterEach(() => {
  setPetTemplates([]);
});

/** All-floor layout, no furniture (no catalog needed), with the given pets placed. */
function layoutWithPets(...petIds: string[]): OfficeLayout {
  const cols = 8;
  const rows = 6;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
    pets: petIds.map((id) => ({ id, petType: 0 })),
  };
}

test('clicking a pet makes the camera follow it and shows its heart', () => {
  const os = new OfficeState(layoutWithPets('rex'));
  os.clickPet('rex');
  assert.equal(os.cameraFollowPetId, 'rex');
  assert.equal(os.getFollowedPet()?.id, 'rex');
  assert.equal(os.pets[0].bubbleType, 'heart');
});

test('clicking the followed pet again stops the follow', () => {
  const os = new OfficeState(layoutWithPets('rex'));
  os.clickPet('rex');
  os.clickPet('rex');
  assert.equal(os.cameraFollowPetId, null);
  assert.equal(os.getFollowedPet(), undefined);
});

test('clicking another pet moves the follow to it', () => {
  const os = new OfficeState(layoutWithPets('rex', 'tom'));
  os.clickPet('rex');
  os.clickPet('tom');
  assert.equal(os.cameraFollowPetId, 'tom');
  assert.equal(os.getFollowedPet()?.id, 'tom');
});

test('following a pet ends any agent selection and agent follow', () => {
  const os = new OfficeState(layoutWithPets('rex'));
  os.addAgent(1);
  os.selectedAgentId = 1;
  os.cameraFollowId = 1;
  os.clickPet('rex');
  assert.equal(os.selectedAgentId, null);
  assert.equal(os.cameraFollowId, null);
  assert.equal(os.cameraFollowPetId, 'rex');
});

test('clicking an unknown pet id changes nothing', () => {
  const os = new OfficeState(layoutWithPets('rex'));
  os.addAgent(1);
  os.selectedAgentId = 1;
  os.cameraFollowId = 1;
  os.clickPet('ghost');
  assert.equal(os.selectedAgentId, 1);
  assert.equal(os.cameraFollowId, 1);
  assert.equal(os.cameraFollowPetId, null);
});

test('removing the followed pet ends the follow; removing another pet does not', () => {
  const os = new OfficeState(layoutWithPets('rex', 'tom'));
  os.clickPet('rex');
  os.removePet('tom');
  assert.equal(os.cameraFollowPetId, 'rex');
  os.removePet('rex');
  assert.equal(os.cameraFollowPetId, null);
  assert.equal(os.getFollowedPet(), undefined);
});

test('a layout rebuild without the followed pet ends the follow; one that keeps it does not', () => {
  const os = new OfficeState(layoutWithPets('rex', 'tom'));
  os.clickPet('rex');
  os.rebuildFromLayout(layoutWithPets('rex'));
  assert.equal(os.cameraFollowPetId, 'rex');
  os.rebuildFromLayout(layoutWithPets('tom'));
  assert.equal(os.cameraFollowPetId, null);
});

test('a follow puts its Pet or Character at the canvas center at every zoom', () => {
  const os = new OfficeState(layoutWithPets('rex'));
  os.addAgent(1);
  os.clickPet('rex');
  const layout = os.getLayout();
  const focuses = { pet: os.getFollowedPet()!, character: os.characters.get(1)! };
  // An odd canvas size exercises the floor() in the map offset.
  const canvas = { width: 1001, height: 677 };
  for (const [name, focus] of Object.entries(focuses)) {
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom++) {
      const pan = centeringPan(layout, focus, zoom);
      const { offsetX, offsetY } = mapOffset(
        canvas.width,
        canvas.height,
        layout.cols,
        layout.rows,
        zoom,
        pan.x,
        pan.y,
      );
      const dx = offsetX + focus.x * zoom - canvas.width / 2;
      const dy = offsetY + focus.y * zoom - canvas.height / 2;
      assert.ok(Math.abs(dx) <= 1, `${name} is ${dx}px off center horizontally at zoom ${zoom}`);
      assert.ok(Math.abs(dy) <= 1, `${name} is ${dy}px off center vertically at zoom ${zoom}`);
    }
  }
});
