import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import {
  enterEditMode,
  type PlacedFurnitureSnapshot,
  paintTile,
  readFurniture,
  saveLayout,
} from '../../helpers/editor';
import { buildSeedLayout } from '../../helpers/layout-seed';
import { openSettingsModal } from '../../helpers/webview';

/**
 * Signs (pixel-text Furniture) and Draw layers on the standalone surface, ported
 * from hootbu/pixel-agents. Both ride on PlacedFurniture (`text`, `zLayer`) inside
 * the opaque layout, so the server stores them raw: what this proves is that the
 * editor writes them, a save persists them, and a fresh page restores them.
 */

interface ExportedLayout {
  furniture: PlacedFurnitureSnapshot[];
}

async function importLayout(page: Page, layout: unknown): Promise<void> {
  const modal = await openSettingsModal(page);
  await page.setInputFiles('input[type="file"]', {
    name: 'signs-layout.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(layout)),
  });
  await expect(modal).toBeHidden();
}

async function exportLayout(page: Page): Promise<ExportedLayout> {
  const modal = await openSettingsModal(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal.getByRole('button', { name: 'Export Layout', exact: true }).click(),
  ]);
  const file = await download.path();
  if (!file) throw new Error('Layout export did not produce a file');
  await expect(modal).toBeHidden();
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ExportedLayout;
}

const HELLO = { value: 'Hello', color: '#FFFFFF', size: '3x5', scale: 1 };
const STANDUP = { value: 'Standup 10am', color: '#00CCCC', size: '5x7', scale: 2 };

test.describe('Standalone / Signs and Draw layers', () => {
  test('a Sign keeps its text and Draw layer through undo, save, reload and export @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await importLayout(page, buildSeedLayout({ cols: 16, rows: 12 }));
    const frame = page.mainFrame();
    const signText = page.getByLabel('Sign text', { exact: true });

    await enterEditMode(frame);
    await page.getByTitle('Place furniture', { exact: true }).click();
    await page.getByRole('button', { name: 'Decor', exact: true }).click();
    await page.getByTitle('Sign', { exact: true }).click();

    // Placing a Sign opens the Sign editor instead of dropping an empty item.
    await paintTile(frame, 4, 4);
    await expect(page.getByText('New Sign', { exact: true })).toBeVisible();
    await expect(signText).toBeFocused();
    await expect(page.getByTitle('Place sign', { exact: true })).toBeDisabled();
    await signText.fill(HELLO.value);
    await expect(page.getByText('Size: 2 x 1 tiles', { exact: true })).toBeVisible();
    await page.getByTitle('Place sign', { exact: true }).click();
    await expect(signText).toBeHidden();
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ type: 'PIXEL_TEXT', col: 4, row: 4, text: HELLO })]);

    // Deselect the palette item, then select the placed Sign and edit it.
    await page.getByTitle('Sign', { exact: true }).click();
    await paintTile(frame, 4, 4);
    await page.getByTitle('Edit sign text', { exact: true }).click();
    await expect(page.getByText('Edit Sign', { exact: true })).toBeVisible();
    await expect(signText).toHaveValue(HELLO.value);
    await signText.fill(`${STANDUP.value}!`);
    await page.getByTitle('5x7 pixel font', { exact: true }).click();
    await page.getByTitle('Pixel scale 2x', { exact: true }).click();
    await page.getByTitle('Cyan', { exact: true }).click();
    // Keys typed into the dialog stay there: Delete and Backspace edit the text,
    // they don't delete the selected Sign.
    await signText.press('End');
    await signText.press('Delete');
    await signText.press('Backspace');
    await expect(signText).toHaveValue(STANDUP.value);
    await page.getByTitle('Update sign', { exact: true }).click();
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ uid: expect.any(String), text: STANDUP })]);
    const [sign] = await readFurniture(frame);
    expect(sign.zLayer).toBeUndefined();

    await page.getByTitle('Bring forward', { exact: true }).click();
    await expect.poll(async () => (await readFurniture(frame))[0]?.zLayer).toBe(1);
    await expect(page.getByText('Layer +1', { exact: true })).toBeVisible();

    // Undo/Redo step through the Draw layer change and the text edit.
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await undo.click();
    await expect.poll(async () => (await readFurniture(frame))[0]?.zLayer).toBeUndefined();
    await undo.click();
    await expect.poll(async () => (await readFurniture(frame))[0]?.text).toEqual(HELLO);
    await redo.click();
    await redo.click();
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ uid: sign.uid, text: STANDUP, zLayer: 1 })]);

    await saveLayout(frame);
    const layoutPath = path.join(standalone.tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(() =>
        fs.existsSync(layoutPath)
          ? (JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as ExportedLayout).furniture
          : null,
      )
      .toEqual([expect.objectContaining({ uid: sign.uid, text: STANDUP, zLayer: 1 })]);

    // A fresh page restores the Sign from the server's layout.json.
    await page.reload();
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ uid: sign.uid, text: STANDUP, zLayer: 1 })]);

    // Export carries both fields, and importing that file brings them back.
    const exported = await exportLayout(page);
    expect(exported.furniture).toEqual([
      expect.objectContaining({ uid: sign.uid, text: STANDUP, zLayer: 1 }),
    ]);
    await importLayout(page, buildSeedLayout({ cols: 16, rows: 12 }));
    await expect.poll(() => readFurniture(frame)).toEqual([]);
    await importLayout(page, exported);
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ uid: sign.uid, text: STANDUP, zLayer: 1 })]);
  });
});
