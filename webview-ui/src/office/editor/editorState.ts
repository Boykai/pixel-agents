import type { ColorValue } from '../../components/ui/types.js';
import {
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  DEFAULT_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  UNDO_STACK_MAX_SIZE,
} from '../../constants.js';
import type { OfficeLayout, TileType as TileTypeVal } from '../types.js';
import { EditTool, TileType } from '../types.js';

export interface GridOffset {
  col: number;
  row: number;
}

export interface EditorSnapshot {
  layout: OfficeLayout;
  offset: GridOffset;
}

export class EditorState {
  isEditMode = false;
  activeTool: EditTool = EditTool.SELECT;
  selectedTileType: TileTypeVal = TileType.FLOOR_1;
  selectedFurnitureType = ''; // asset ID, set when catalog loads

  // Floor color settings (applied to new tiles when painting)
  floorColor: ColorValue = { ...DEFAULT_FLOOR_COLOR };

  // Wall color settings (applied to new wall tiles when painting)
  wallColor: ColorValue = { ...DEFAULT_WALL_COLOR };

  // Selected wall set index (0-based, indexes into loaded wall sets)
  selectedWallSet = 0;

  // Tracks toggle direction during wall drag (true=adding walls, false=removing, null=undecided)
  wallDragAdding: boolean | null = null;

  // Picked furniture color (copied by pick tool, applied on placement)
  pickedFurnitureColor: ColorValue | null = null;

  // Ghost preview position
  ghostCol = -1;
  ghostRow = -1;
  ghostValid = false;

  // Selection
  selectedFurnitureUid: string | null = null;

  // Mouse drag state (tile paint)
  isDragging = false;

  // Undo / Redo stacks
  undoStack: EditorSnapshot[] = [];
  redoStack: EditorSnapshot[] = [];
  gridOffset: GridOffset = { col: 0, row: 0 };

  // Dirty flag — true when layout differs from last save
  isDirty = false;

  // Drag-to-move state
  dragUid: string | null = null;
  dragStartCol = 0;
  dragStartRow = 0;
  dragOffsetCol = 0;
  dragOffsetRow = 0;
  isDragMoving = false;

  // ── Carpet editor state ──────────────────────────────────────────
  /** Currently selected carpet variant for paint. */
  carpetVariant = 0;
  /** Main color applied by the carpet paint tool. */
  carpetColor: ColorValue = { ...CARPET_DEFAULT_COLOR };
  /** Accent color applied by the carpet paint tool. */
  carpetAccentColor: ColorValue = { ...CARPET_DEFAULT_ACCENT_COLOR };
  /** Stroke direction: true=erase, false=paint, null=stroke not yet started. */
  carpetDragErasing: boolean | null = null;
  /** Layout snapshot at the start of the current carpet stroke (one undo entry per stroke). */
  carpetStrokeInitialLayout: OfficeLayout | null = null;

  // ── Area editor state ────────────────────────────────────────────
  /** Which Area label is the AREA_PAINT tool currently painting. */
  selectedAreaLabel: string | null = null;
  /** First tile of an area drag sets direction: true=erase same label, false=paint. */
  areaDragErasing: boolean | null = null;

  // ── Sign editor state (ported from hootbu/pixel-agents (MIT) 69c433f) ──
  /** Tile a new Sign is placed on once the Sign editor confirms its text. */
  pendingSignPlacement: { col: number; row: number } | null = null;
  /** Placed Sign whose text the Sign editor is changing. */
  editingSignUid: string | null = null;

  /** Whether the Sign editor dialog is open (it owns the keyboard while it is). */
  isSignEditorOpen(): boolean {
    return this.pendingSignPlacement !== null || this.editingSignUid !== null;
  }

  clearSignEditor(): void {
    this.pendingSignPlacement = null;
    this.editingSignUid = null;
  }

  snapshot(layout: OfficeLayout): EditorSnapshot {
    return { layout, offset: { ...this.gridOffset } };
  }

  restoreOffset(snapshot: EditorSnapshot): GridOffset {
    const shift = {
      col: snapshot.offset.col - this.gridOffset.col,
      row: snapshot.offset.row - this.gridOffset.row,
    };
    this.gridOffset = { ...snapshot.offset };
    return shift;
  }

  resetHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.gridOffset = { col: 0, row: 0 };
    this.carpetStrokeInitialLayout = null;
  }

  pushUndo(layout: OfficeLayout): void {
    this.undoStack.push(this.snapshot(layout));
    // Limit undo stack size
    if (this.undoStack.length > UNDO_STACK_MAX_SIZE) {
      this.undoStack.shift();
    }
  }

  popUndo(): EditorSnapshot | null {
    return this.undoStack.pop() || null;
  }

  pushRedo(layout: OfficeLayout): void {
    this.redoStack.push(this.snapshot(layout));
    if (this.redoStack.length > UNDO_STACK_MAX_SIZE) {
      this.redoStack.shift();
    }
  }

  popRedo(): EditorSnapshot | null {
    return this.redoStack.pop() || null;
  }

  clearRedo(): void {
    this.redoStack = [];
  }

  clearSelection(): void {
    this.selectedFurnitureUid = null;
    this.editingSignUid = null;
  }

  clearGhost(): void {
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
  }

  startDrag(
    uid: string,
    startCol: number,
    startRow: number,
    offsetCol: number,
    offsetRow: number,
  ): void {
    this.dragUid = uid;
    this.dragStartCol = startCol;
    this.dragStartRow = startRow;
    this.dragOffsetCol = offsetCol;
    this.dragOffsetRow = offsetRow;
    this.isDragMoving = false;
  }

  clearDrag(): void {
    this.dragUid = null;
    this.isDragMoving = false;
  }

  reset(): void {
    this.activeTool = EditTool.SELECT;
    this.selectedFurnitureUid = null;
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
    this.isDragging = false;
    this.wallDragAdding = null;
    this.undoStack = [];
    this.redoStack = [];
    this.isDirty = false;
    this.dragUid = null;
    this.isDragMoving = false;
    this.carpetVariant = 0;
    this.carpetColor = { ...CARPET_DEFAULT_COLOR };
    this.carpetAccentColor = { ...CARPET_DEFAULT_ACCENT_COLOR };
    this.carpetDragErasing = null;
    this.carpetStrokeInitialLayout = null;
    this.selectedAreaLabel = null;
    this.areaDragErasing = null;
    this.clearSignEditor();
  }
}
