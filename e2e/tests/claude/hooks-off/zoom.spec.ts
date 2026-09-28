import { expect, test } from '../../../fixtures/pixel-agents';
import { openSettingsModal, reloadPixelAgentsWebview, togglePanel } from '../../../helpers/webview';
import { readStoredZoom, readZoom, TILE_SIZE_PX } from '../../../helpers/zoom';

// Without retainContextWhenHidden VS Code disposes a hidden webview shortly
// after the panel hides; wait past that before checking the frame survived.
const PANEL_HIDDEN_SETTLE_MS = 2_000;

/**
 * Zoom persistence and panel retention on the VS Code surface (ported from
 * hootbu/pixel-agents). The zoom is saved per adapter namespace in
 * ~/.pixel-agents/config.json and comes back with the next settingsLoaded; the
 * view is registered with retainContextWhenHidden, so hiding the panel keeps
 * the webview's React state instead of rebuilding it.
 */
test.describe('Zoom / VS Code', () => {
  test('a hidden panel keeps its webview and the zoom survives a webview reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, frame, tmpHome, narrator } = pixelAgents;

    const initial = await readZoom(frame);
    if (initial === null) throw new Error('the getZoom e2e hook is not registered');

    narrator.step('zooming in once with the office zoom control');
    await frame.getByRole('button', { name: 'Zoom in (Ctrl+Scroll)' }).click();
    const zoomed = initial + 1;
    await expect.poll(() => readZoom(frame)).toBe(zoomed);
    await expect(frame.getByText(`${zoomed * TILE_SIZE_PX}px`, { exact: true })).toBeVisible();
    await expect.poll(() => readStoredZoom(tmpHome, 'vscode')).toBe(zoomed);
    narrator.check(`the office shows ${zoomed * TILE_SIZE_PX}px tiles, saved to config.json`);

    narrator.step('opening Settings, then hiding and re-showing the panel');
    const modal = await openSettingsModal(frame);
    await togglePanel(window);
    await expect(window.locator('.part.panel').first()).toBeHidden();
    await window.waitForTimeout(PANEL_HIDDEN_SETTLE_MS);
    expect(frame.isDetached()).toBe(false);
    await togglePanel(window);
    await expect(modal).toBeVisible();
    narrator.check('same webview: the Settings modal is still open after the panel was hidden');

    await modal.getByRole('button', { name: 'x', exact: true }).click();
    await expect(modal).toBeHidden();

    narrator.step('reloading the webview: the zoom must come back from config.json');
    const reloaded = await reloadPixelAgentsWebview(window);
    await expect.poll(() => readZoom(reloaded)).toBe(zoomed);
    expect(readStoredZoom(tmpHome, 'standalone')).toBeUndefined();
    narrator.check(`the fresh webview restored ${zoomed * TILE_SIZE_PX}px tiles`);
  });
});
