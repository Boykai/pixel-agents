import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { openSettingsModal } from './webview';

type AchievementSurface = Frame | Page;

const GALLERY_TIMEOUT_MS = 15_000;

interface AchievementHooksWindow extends Window {
  __pixelAgentsTestHooks?: {
    achievementPopupLog?: Array<{ id: string; at: number }>;
    messageLog?: Array<{ type: string; id?: unknown }>;
  };
}

/** Every Achievement popup the office put on screen since the page loaded, in
 *  order. A popup lives a few seconds, so specs assert on this history. */
export async function readAchievementPopupLog(surface: AchievementSurface): Promise<string[]> {
  return surface.evaluate(() =>
    ((window as AchievementHooksWindow).__pixelAgentsTestHooks?.achievementPopupLog ?? []).map(
      (entry) => entry.id,
    ),
  );
}

/** The ids of every `achievementUnlocked` message the webview received. */
export async function readAchievementUnlockedIds(surface: AchievementSurface): Promise<string[]> {
  return surface.evaluate(() =>
    ((window as AchievementHooksWindow).__pixelAgentsTestHooks?.messageLog ?? [])
      .filter((m) => m.type === 'achievementUnlocked')
      .map((m) => String(m.id)),
  );
}

/** How many `achievementsLoaded` snapshots the webview received. */
export async function countAchievementSnapshots(surface: AchievementSurface): Promise<number> {
  return surface.evaluate(
    () =>
      ((window as AchievementHooksWindow).__pixelAgentsTestHooks?.messageLog ?? []).filter(
        (m) => m.type === 'achievementsLoaded',
      ).length,
  );
}

export interface OpenAchievementGallery {
  settings: Locator;
  gallery: Locator;
}

/** Open Settings, then the Achievement gallery over it. */
export async function openAchievementGallery(
  surface: AchievementSurface,
): Promise<OpenAchievementGallery> {
  const settings = await openSettingsModal(surface);
  await settings.getByRole('button', { name: 'Achievements', exact: true }).click();
  const gallery = surface
    .locator('div.fixed')
    .filter({ has: surface.getByTestId('achievement-count') });
  await expect(gallery).toBeVisible({ timeout: GALLERY_TIMEOUT_MS });
  await expect(gallery).toContainText('Global across all projects');
  return { settings, gallery };
}

/** Close the gallery with its x, then Settings beneath it. */
export async function closeAchievementGallery({
  settings,
  gallery,
}: OpenAchievementGallery): Promise<void> {
  await gallery.getByRole('button', { name: 'x', exact: true }).click();
  await expect(gallery).toBeHidden({ timeout: GALLERY_TIMEOUT_MS });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'x', exact: true }).click();
  await expect(settings).toBeHidden({ timeout: GALLERY_TIMEOUT_MS });
}

export function getAchievementRow(gallery: Locator, id: string): Locator {
  return gallery.locator(`[data-testid="achievement-row"][data-achievement-id="${id}"]`);
}

/** The gallery shows `unlocked` of every defined Achievement, and exactly
 *  `unlockedIds` marked unlocked. */
export async function expectGalleryUnlocked(
  gallery: Locator,
  unlockedIds: readonly string[],
): Promise<void> {
  const rows = gallery.getByTestId('achievement-row');
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);
  await expect(gallery.getByTestId('achievement-count')).toHaveText(
    `${unlockedIds.length}/${total}`,
    { timeout: GALLERY_TIMEOUT_MS },
  );
  await expect(
    gallery.locator('[data-testid="achievement-row"][data-unlocked="true"]'),
  ).toHaveCount(unlockedIds.length);
  for (const id of unlockedIds) {
    await expect(getAchievementRow(gallery, id)).toHaveAttribute('data-unlocked', 'true');
  }
}

/** The Achievement popups setting persisted for one adapter namespace in config.json. */
export function readStoredAchievementPopups(
  tmpHome: string,
  namespace: 'vscode' | 'standalone',
): unknown {
  const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    return config[namespace]?.achievementPopups;
  } catch {
    return undefined;
  }
}

/** The ids `~/.pixel-agents/achievements.json` records as unlocked. */
export function readUnlockedInFile(tmpHome: string): string[] {
  const filePath = path.join(tmpHome, '.pixel-agents', 'achievements.json');
  try {
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      achievements?: Record<string, { unlocked?: unknown } | undefined>;
    };
    return Object.entries(file.achievements ?? {})
      .filter(([, record]) => record?.unlocked === true)
      .map(([id]) => id)
      .sort();
  } catch {
    return [];
  }
}
