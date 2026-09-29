import { expect, test } from '../../../fixtures/pixel-agents';
import {
  closeAchievementGallery,
  countAchievementSnapshots,
  expectGalleryUnlocked,
  openAchievementGallery,
  readAchievementPopupLog,
  readAchievementUnlockedIds,
  readStoredAchievementPopups,
  readUnlockedInFile,
} from '../../../helpers/achievements';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { expectOverlayCount } from '../../../helpers/office';
import {
  getPixelAgentsFrame,
  getSettingChecked,
  openPixelAgentsPanel,
  reloadPixelAgentsWebview,
  setSettings,
} from '../../../helpers/webview';

const UNLOCK_TIMEOUT_MS = 15_000;

test.describe('Achievements', () => {
  test('the first agent unlocks First Agent with a popup, and the gallery and Achievement popups off survive a webview reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, tmpHome, mockLogFile, narrator } = pixelAgents;
    let frame = pixelAgents.frame;

    narrator.step('launching the first agent: First Agent should unlock');
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);
    await expectOverlayCount(frame, 1);
    await expect
      .poll(() => readAchievementPopupLog(frame), { timeout: UNLOCK_TIMEOUT_MS })
      .toEqual(['first_agent']);
    expect(await readAchievementUnlockedIds(frame)).toEqual(['first_agent']);
    expect(readUnlockedInFile(tmpHome)).toEqual(['first_agent']);
    narrator.check('the First Agent popup showed once, and achievements.json records it');

    narrator.step('opening Settings → Achievements');
    let open = await openAchievementGallery(frame);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    await closeAchievementGallery(open);
    narrator.check('the gallery shows First Agent unlocked');

    narrator.step('turning Achievement popups OFF in Settings');
    await setSettings(frame, { achievementPopups: false });
    await expect.poll(() => readStoredAchievementPopups(tmpHome, 'vscode')).toBe(false);
    // Per namespace: the standalone surface keeps its own setting.
    expect(readStoredAchievementPopups(tmpHome, 'standalone')).not.toBe(false);

    narrator.step('reloading the webview to force a fresh settingsLoaded and achievementsLoaded');
    frame = await reloadPixelAgentsWebview(window);
    // The snapshot arrives with webviewReady, before the gallery asks for one.
    await expect
      .poll(() => countAchievementSnapshots(frame), { timeout: UNLOCK_TIMEOUT_MS })
      .toBeGreaterThan(0);
    expect(await getSettingChecked(frame, 'Achievement Popups')).toBe(false);
    open = await openAchievementGallery(frame);
    await expectGalleryUnlocked(open.gallery, ['first_agent']);
    await closeAchievementGallery(open);
    // A reconnect never announces an unlock again.
    expect(await readAchievementUnlockedIds(frame)).toEqual([]);
    expect(await readAchievementPopupLog(frame)).toEqual([]);
    narrator.check('popups stay off, and the gallery still shows First Agent after the reload');
  });
});
