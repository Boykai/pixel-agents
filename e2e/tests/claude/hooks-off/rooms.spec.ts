import { expect, test } from '../../../fixtures/pixel-agents';
import {
  enterEditMode,
  generateRoomFromToolbar,
  readFurnitureCount,
  saveLayout,
} from '../../../helpers/editor';
import { buildSeedLayout } from '../../../helpers/layout-seed';
import { closeBottomPanel, getPixelAgentsFrame, reopenBottomPanel } from '../../../helpers/webview';

test.describe('Generate Room / VS Code', () => {
  test.use({ seedLayout: buildSeedLayout({ cols: 10, rows: 10 }) });

  test('adds a furnished room with single-step Undo/Redo and survives panel reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, window, narrator } = pixelAgents;
    narrator.step('opening Layout and generating one furnished room');
    await enterEditMode(frame);
    expect(await readFurnitureCount(frame)).toBe(0);
    await generateRoomFromToolbar(frame);
    const count = await readFurnitureCount(frame);
    narrator.check('the generated room is furnished and reports success');

    narrator.step('undoing the complete room, then restoring that exact edit');
    await frame.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => readFurnitureCount(frame)).toBe(0);
    await frame.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(() => readFurnitureCount(frame)).toBe(count);
    await saveLayout(frame);

    narrator.step('reopening the panel to verify the saved room');
    await closeBottomPanel(window);
    await reopenBottomPanel(window);
    const restored = await getPixelAgentsFrame(window);
    await expect.poll(() => readFurnitureCount(restored)).toBe(count);
    narrator.check('the room survives the VS Code panel lifecycle');
  });
});
