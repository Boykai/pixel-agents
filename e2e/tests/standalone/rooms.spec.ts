import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import {
  enterEditMode,
  generateRoomFromToolbar,
  paintTile,
  readFurnitureCount,
  saveLayout,
} from '../../helpers/editor';
import { buildSeedLayout } from '../../helpers/layout-seed';
import { openSettingsModal } from '../../helpers/webview';

interface ExportedLayout {
  version: number;
  cols: number;
  rows: number;
  furniture: Array<{ uid: string; type: string; col: number; row: number }>;
  areaTiles?: Array<string | null>;
  carpetTiles?: Array<unknown>;
}

async function importLayout(page: Page, layout: unknown): Promise<void> {
  const modal = await openSettingsModal(page);
  await page.setInputFiles('input[type="file"]', {
    name: 'rooms-layout.json',
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

test.describe('Standalone / Generate Room', () => {
  test('preserves existing data through prepend expansion, atomic Undo/Redo, and saved Reset @area:standalone', async ({
    page,
    standalone,
  }, testInfo) => {
    await standalone.drainMessages();
    const seed = buildSeedLayout({
      cols: 10,
      rows: 10,
      areas: [{ label: 'Original', color: '#4287f5' }],
      areaTiles: [{ col: 4, row: 4, label: 'Original' }],
      carpetTiles: [{ col: 3, row: 3, variant: 0 }],
    });
    seed.furniture = [
      { uid: 'anchor-seat', type: 'CUSHIONED_CHAIR_BACK', col: 4, row: 4 },
      ...Array.from({ length: 10 }, (_, row) => ({ uid: `east-${row}`, type: 'POT', col: 9, row })),
      ...Array.from({ length: 9 }, (_, col) => ({ uid: `south-${col}`, type: 'POT', col, row: 9 })),
    ];
    await importLayout(page, seed);
    const original = await exportLayout(page);
    await enterEditMode(page.mainFrame());
    await generateRoomFromToolbar(page.mainFrame());
    const generated = await exportLayout(page);
    const anchor = generated.furniture.find((item) => item.uid === 'anchor-seat')!;
    const dx = anchor.col - 4;
    const dy = anchor.row - 4;
    expect(dx >= 0 && dy >= 0 && dx + dy > 0).toBe(true);
    expect(generated.furniture.slice(0, original.furniture.length)).toEqual(
      original.furniture.map((item) => ({ ...item, col: item.col + dx, row: item.row + dy })),
    );
    expect(generated.areaTiles?.[(4 + dy) * generated.cols + 4 + dx]).toBe('Original');
    expect(generated.carpetTiles?.[(3 + dy) * generated.cols + 3 + dx]).toEqual(
      original.carpetTiles?.[33],
    );
    await page.screenshot({ path: testInfo.outputPath('generated-room-desktop.png') });

    const decoration = generated.furniture
      .slice(original.furniture.length)
      .find((item) => item.type === 'POT');
    expect(decoration).toBeDefined();
    await page.getByTitle('Place furniture', { exact: true }).click();
    await paintTile(page.mainFrame(), decoration!.col, decoration!.row);
    await page.keyboard.press('Delete');
    await expect
      .poll(() => readFurnitureCount(page.mainFrame()))
      .toBe(generated.furniture.length - 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await exportLayout(page)).toEqual(generated);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await exportLayout(page)).toEqual(original);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(await exportLayout(page)).toEqual(generated);
    await saveLayout(page.mainFrame());

    await generateRoomFromToolbar(page.mainFrame());
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    expect(await exportLayout(page)).toEqual(generated);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  });

  test('saved rooms survive browser reload and export/import as ordinary layout data @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await enterEditMode(page.mainFrame());
    await generateRoomFromToolbar(page.mainFrame());
    const generated = await exportLayout(page);
    await saveLayout(page.mainFrame());
    const layoutPath = path.join(standalone.tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(() =>
        fs.existsSync(layoutPath) ? JSON.parse(fs.readFileSync(layoutPath, 'utf8')) : null,
      )
      .toEqual(generated);

    await page.reload();
    await expect.poll(() => readFurnitureCount(page.mainFrame())).toBe(generated.furniture.length);
    expect(await exportLayout(page)).toEqual(generated);
    await importLayout(page, buildSeedLayout());
    expect(await readFurnitureCount(page.mainFrame())).toBe(0);
    await importLayout(page, generated);
    expect(await exportLayout(page)).toEqual(generated);
    expect(generated.version).toBe(1);
    expect(generated).not.toHaveProperty('rooms');
  });

  test('explains no-op failures and supports keyboard generation in a narrow window @area:standalone', async ({
    page,
    standalone,
  }, testInfo) => {
    await standalone.drainMessages();
    await page.setViewportSize({ width: 360, height: 640 });
    await importLayout(page, buildSeedLayout({ floorTile: 255 }));
    const empty = await exportLayout(page);
    await enterEditMode(page.mainFrame());
    await page.getByRole('button', { name: 'Generate Room', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('No existing walkable floor');
    expect(await exportLayout(page)).toEqual(empty);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

    await importLayout(page, buildSeedLayout({ cols: 64, rows: 64 }));
    const full = await exportLayout(page);
    await page.getByRole('button', { name: 'Generate Room', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('No safe furnished room fits');
    expect(await exportLayout(page)).toEqual(full);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

    await importLayout(page, buildSeedLayout({ cols: 5, rows: 5 }));
    const button = page.getByRole('button', { name: 'Generate Room', exact: true });
    await button.focus();
    await button.press('Enter');
    await expect.poll(() => readFurnitureCount(page.mainFrame())).toBeGreaterThan(0);
    const feedback = page.getByRole('status').filter({ hasText: /^Added / });
    await expect(feedback).toBeVisible();
    for (const locator of [button, feedback]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    }
    await page.screenshot({ path: testInfo.outputPath('generated-room-narrow.png') });
  });
});
