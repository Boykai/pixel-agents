import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/copilot';
import {
  closeAchievementGallery,
  countAchievementSnapshots,
  expectGalleryUnlocked,
  openAchievementGallery,
  readAchievementPopupLog,
  readAchievementUnlockedIds,
  readStoredAchievementPopups,
  readUnlockedInFile,
} from '../../helpers/achievements';
import { copilotScenario } from '../../helpers/mock-copilot';
import { expectOverlayVisible } from '../../helpers/office';
import { getSettingChecked, setSettings } from '../../helpers/webview';

const UNLOCK_TIMEOUT_MS = 15_000;
const NARROW_VIEWPORT = { width: 360, height: 640 };

async function waitForOffice(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
}

/** How far the document can scroll sideways, and how far it has. */
function readHorizontalScroll(page: Page): Promise<{ overflow: number; offset: number }> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return {
      overflow: root.scrollWidth - root.clientWidth,
      offset: root.scrollLeft + document.body.scrollLeft,
    };
  });
}

/**
 * Achievements on the standalone surface, earned by an observed GitHub Copilot
 * session: the first Agent unlocks First Agent with a popup, progress lives in
 * ~/.pixel-agents/achievements.json (so a fresh server keeps it and never
 * announces it again), and the per-namespace "Achievement popups" setting
 * silences the popup without losing the unlock.
 */
test.describe('Standalone / Achievements', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('the first Agent unlocks First Agent with a popup, and a server restart keeps it without announcing it again @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    let open = await openAchievementGallery(page);
    await expectGalleryUnlocked(open.gallery, []);
    await closeAchievementGallery(open);

    const mock = await copilot('achievements-first');
    await mock.run(copilotScenario().toolStart('read-1', 'view', { path: 'first.ts' }));
    const popup = page.getByTestId('achievement-popup');
    await expect(popup).toContainText('First Agent', { timeout: UNLOCK_TIMEOUT_MS });
    await expect(popup).toContainText('Achievement unlocked');
    await expectOverlayVisible(page, 'Reading first.ts');
    // The popup leaves by itself.
    await expect(popup).toHaveCount(0, { timeout: UNLOCK_TIMEOUT_MS });
    expect(await readAchievementPopupLog(page)).toEqual(['first_agent']);
    expect(await readAchievementUnlockedIds(page)).toEqual(['first_agent']);

    open = await openAchievementGallery(page);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    // Escape closes the gallery and nothing beneath it: Settings stays open.
    await page.keyboard.press('Escape');
    await expect(open.gallery).toBeHidden();
    await expect(open.settings).toBeVisible();
    await open.settings.getByRole('button', { name: 'x', exact: true }).click();
    await expect(open.settings).toBeHidden();
    expect(readUnlockedInFile(standalone.tmpHome)).toEqual(['first_agent']);

    // A fresh server over the same HOME restores the session, and with it the
    // Achievement: the snapshot carries it, and nothing is announced again.
    await standalone.stopHost();
    await standalone.startHost();
    await page.reload();
    await waitForOffice(page);
    await expect.poll(() => countAchievementSnapshots(page)).toBeGreaterThan(0);
    await mock.run(
      copilotScenario()
        .toolComplete('read-1')
        .toolStart('read-2', 'view', { path: 'after-restart.ts' }),
    );
    await expectOverlayVisible(page, 'Reading after-restart.ts');
    open = await openAchievementGallery(page);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    await closeAchievementGallery(open);
    expect(await readAchievementUnlockedIds(page)).toEqual([]);
    expect(await readAchievementPopupLog(page)).toEqual([]);
    await expect(popup).toHaveCount(0);
  });

  test('with Achievement popups off an unlock shows no popup but reaches the gallery, and the setting survives a reload @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      watchAllSessions: false,
      achievementPopups: false,
    });
    await expect
      .poll(() => readStoredAchievementPopups(standalone.tmpHome, 'standalone'))
      .toBe(false);
    // Per namespace: the VS Code surface keeps its own setting.
    expect(readStoredAchievementPopups(standalone.tmpHome, 'vscode')).not.toBe(false);

    const mock = await copilot('achievements-quiet');
    await mock.run(copilotScenario().toolStart('read-1', 'view', { path: 'quiet.ts' }));
    await expectOverlayVisible(page, 'Reading quiet.ts');
    // The unlock reaches the office; only its popup is suppressed.
    await expect
      .poll(() => readAchievementUnlockedIds(page), { timeout: UNLOCK_TIMEOUT_MS })
      .toEqual(['first_agent']);
    expect(await readAchievementPopupLog(page)).toEqual([]);
    await expect(page.getByTestId('achievement-popup')).toHaveCount(0);
    let open = await openAchievementGallery(page);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    await closeAchievementGallery(open);

    await page.reload();
    await waitForOffice(page);
    expect(await getSettingChecked(page, 'Achievement Popups')).toBe(false);

    // A narrow window: the gallery fits, and nothing scrolls sideways.
    await page.setViewportSize(NARROW_VIEWPORT);
    open = await openAchievementGallery(page);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    const box = await open.gallery.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW_VIEWPORT.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(NARROW_VIEWPORT.height);
    expect(await readHorizontalScroll(page)).toEqual({ overflow: 0, offset: 0 });
    await closeAchievementGallery(open);
    expect(await readHorizontalScroll(page)).toEqual({ overflow: 0, offset: 0 });
  });
});
