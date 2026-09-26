import { expect, it } from 'vitest';

import { UNDO_STACK_MAX_SIZE } from '../src/constants.js';
import { expandLayout, paintTile } from '../src/office/editor/editorActions.js';
import { EditorState } from '../src/office/editor/editorState.js';
import { TileType } from '../src/office/types.js';
import { emptyLayout } from './roomFixtures.js';

it('captures layout offsets by value and restores an expansion in one undo/redo', () => {
  const state = new EditorState();
  const original = emptyLayout();
  const expanded = expandLayout(expandLayout(original, 'left')!.layout, 'up')!.layout;
  state.pushUndo(original);
  state.gridOffset = { col: 1, row: 1 };
  const before = state.popUndo()!;
  state.pushRedo(expanded);
  expect(before.layout).toBe(original);
  expect(state.restoreOffset(before)).toEqual({ col: -1, row: -1 });
  const after = state.popRedo()!;
  state.pushUndo(original);
  expect(after.layout).toBe(expanded);
  expect(state.restoreOffset(after)).toEqual({ col: 1, row: 1 });
  expect(state.undoStack).toHaveLength(1);
});

it('ordinary edits between expansions restore their own coordinate frame', () => {
  const state = new EditorState();
  const base = emptyLayout();
  state.pushUndo(base);
  const left = expandLayout(base, 'left')!.layout;
  state.gridOffset = { col: 1, row: 0 };
  state.pushUndo(left);
  const painted = paintTile(left, 3, 3, TileType.FLOOR_1);
  state.pushUndo(painted);
  state.gridOffset = { col: 1, row: 1 };
  const previous = state.popUndo()!;
  expect(previous.layout).toBe(painted);
  expect(state.restoreOffset(previous)).toEqual({ col: 0, row: -1 });
  expect(state.restoreOffset(state.popUndo()!)).toEqual({ col: 0, row: 0 });
  expect(state.restoreOffset(state.popUndo()!)).toEqual({ col: -1, row: 0 });
});

it('a saved checkpoint retains its origin across Reset and a replacement resets the basis', () => {
  const state = new EditorState();
  state.gridOffset = { col: 3, row: 2 };
  const saved = state.snapshot(emptyLayout());
  state.gridOffset.col += 5;
  state.gridOffset.row += 4;
  state.pushUndo(emptyLayout());
  expect(saved.offset).toEqual({ col: 3, row: 2 });
  expect(state.restoreOffset(saved)).toEqual({ col: -5, row: -4 });
  state.reset();
  expect(state.gridOffset).toEqual(saved.offset);
  expect(state.undoStack).toHaveLength(0);
  state.resetHistory();
  expect(state.gridOffset).toEqual({ col: 0, row: 0 });
  expect(state.redoStack).toHaveLength(0);
});

it('keeps the existing history limit and redo clearing', () => {
  const state = new EditorState();
  const layout = emptyLayout();
  for (let i = 0; i < UNDO_STACK_MAX_SIZE + 1; i++) {
    state.gridOffset = { col: i, row: 0 };
    state.pushUndo(layout);
    state.pushRedo(layout);
  }
  expect(state.undoStack).toHaveLength(UNDO_STACK_MAX_SIZE);
  expect(state.redoStack).toHaveLength(UNDO_STACK_MAX_SIZE);
  expect(state.undoStack[0].offset.col).toBe(1);
  state.clearRedo();
  expect(state.popRedo()).toBeNull();
});
