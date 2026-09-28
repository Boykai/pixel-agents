import { expect, test } from '../../fixtures/standalone';
import { readStoredZoom, readZoom, TILE_SIZE_PX, ZOOM_SAVE_SETTLE_MS } from '../../helpers/zoom';

test.describe('Standalone / Zoom', () => {
  test('the zoom level persists across a page reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const initial = await readZoom(page);
    if (initial === null) throw new Error('the getZoom e2e hook is not registered');
    // The mount-time default is never written back: only a user zoom persists.
    expect(readStoredZoom(standalone.tmpHome, 'standalone')).toBeUndefined();

    await page.getByRole('button', { name: 'Zoom in (Ctrl+Scroll)' }).click();
    const zoomed = initial + 1;
    await expect.poll(() => readZoom(page)).toBe(zoomed);
    await expect(page.getByText(`${zoomed * TILE_SIZE_PX}px`, { exact: true })).toBeVisible();
    await expect.poll(() => readStoredZoom(standalone.tmpHome, 'standalone')).toBe(zoomed);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readZoom(page)).toBe(zoomed);

    // Settle before the negative checks: the reloaded page's default zoom must
    // not overwrite the stored level, and nothing leaks into the VS Code namespace.
    await page.waitForTimeout(ZOOM_SAVE_SETTLE_MS);
    expect(readStoredZoom(standalone.tmpHome, 'standalone')).toBe(zoomed);
    expect(readStoredZoom(standalone.tmpHome, 'vscode')).toBeUndefined();
  });
});
