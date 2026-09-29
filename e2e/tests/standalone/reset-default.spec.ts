import type { Page } from '@playwright/test';
import fs from 'node:fs';

import { expect, test } from '../../fixtures/standalone';
import { enterEditMode, readFurnitureCount } from '../../helpers/editor';
import { buildSeedLayout } from '../../helpers/layout-seed';
import { openSettingsModal } from '../../helpers/webview';

interface ExportedLayout {
  version: number;
  cols: number;
  rows: number;
  furniture: Array<{ uid: string; type: string; col: number; row: number }>;
}

async function importLayout(page: Page, layout: unknown): Promise<void> {
  const modal = await openSettingsModal(page);
  await page.setInputFiles('input[type="file"]', {
    name: 'reset-default-layout.json',
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

const openConfirm = (page: Page) =>
  page.getByRole('button', { name: 'Reset to Default', exact: true }).click();

test.describe('Standalone / Reset to Default', () => {
  test('restores the bundled layout only after both confirmations, and Undo puts the office back @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    // A fresh standalone home has no layout.json, so what loads IS the bundled default.
    const bundledDefault = await exportLayout(page);
    expect(bundledDefault.furniture.length).toBeGreaterThan(0);

    const mine = buildSeedLayout({ cols: 12, rows: 12 });
    // A Sign on a Draw layer goes through Reset and Undo like any other item.
    const sign = {
      uid: 'mine-sign',
      type: 'PIXEL_TEXT',
      col: 4,
      row: 4,
      zLayer: 1,
      text: { value: 'Hello', color: '#FFFFFF', size: '3x5', scale: 1 },
    };
    mine.furniture = [{ uid: 'mine-1', type: 'POT', col: 2, row: 2 }, sign];
    await importLayout(page, mine);
    const imported = await exportLayout(page);
    expect(imported).not.toEqual(bundledDefault);
    expect(imported.furniture).toContainEqual(expect.objectContaining(sign));

    await enterEditMode(page.mainFrame());

    // Step 1 dismissed → nothing happened.
    await openConfirm(page);
    await expect(page.getByRole('alertdialog')).toContainText('Reset this office to the default?');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await exportLayout(page)).toEqual(imported);

    // Step 2 dismissed → still nothing happened.
    await openConfirm(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('this replaces your office');
    await page.getByRole('button', { name: 'Keep my office', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await exportLayout(page)).toEqual(imported);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

    // Escape backs out of the second step too.
    await openConfirm(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await exportLayout(page)).toEqual(imported);

    // Both confirmations → the bundled default replaces the office in one undo step.
    await openConfirm(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Reset office', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect
      .poll(() => readFurnitureCount(page.mainFrame()))
      .toBe(bundledDefault.furniture.length);
    expect(await exportLayout(page)).toEqual(bundledDefault);
    await expect(page.getByRole('status').filter({ hasText: /^Office reset/ })).toBeVisible();

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await exportLayout(page)).toEqual(imported);
  });
});
