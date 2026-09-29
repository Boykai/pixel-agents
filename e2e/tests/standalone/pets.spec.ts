import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { enterEditMode } from '../../helpers/editor';

/**
 * Pet camera follow on the standalone surface. The VS Code spec
 * (claude/hooks-off/pets.spec.ts) also covers the re-click toggle and the editor
 * ending a follow; this one proves the same SPA behaves the same over the
 * WebSocket transport.
 *
 * Pets are canvas-only and spawn on a random tile, so the pet is clicked and
 * the follow target read through the e2e test hooks (see webview-ui/src/testHooks.ts).
 */

interface CameraFollow {
  agentId: number | null;
  petId: string | null;
}

type PetHooksWindow = Window & {
  __pixelAgentsTestHooks?: {
    getPets?: () => Array<{ id: string }>;
    petClick?: (petId: string) => void;
    getCameraFollow?: () => CameraFollow;
  };
};

async function readPetIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as PetHooksWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).map((p) => p.id),
  );
}

async function petClick(page: Page, petId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as PetHooksWindow).__pixelAgentsTestHooks?.petClick?.(id);
  }, petId);
}

async function readCameraFollow(page: Page): Promise<CameraFollow | null> {
  return page.evaluate(
    () => (window as PetHooksWindow).__pixelAgentsTestHooks?.getCameraFollow?.() ?? null,
  );
}

test.describe('Standalone / Pets', () => {
  test('clicking a pet makes the camera follow it; a wheel pan ends the follow @area:pets', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await enterEditMode(page.mainFrame());
    await page.locator('button[title="Place pets"]').click();
    const carousel = page.locator('[data-testid="pets-carousel"]');
    await carousel.locator('button[title="Claudio"]').click();
    await expect.poll(() => readPetIds(page)).toHaveLength(1);
    const [petId] = await readPetIds(page);
    // Following is a view-mode interaction: close the editor first.
    await page.locator('button[title="Edit office layout"]').click();
    await expect(carousel).toBeHidden();
    await expect.poll(() => readCameraFollow(page)).toEqual({ agentId: null, petId: null });

    await petClick(page, petId!);
    await expect.poll(() => readCameraFollow(page)).toEqual({ agentId: null, petId });

    await page.locator('canvas').first().hover();
    // Hovering alone must not end the follow; only the wheel pan below does.
    expect(await readCameraFollow(page)).toEqual({ agentId: null, petId });
    await page.mouse.wheel(0, 120);
    await expect.poll(() => readCameraFollow(page)).toEqual({ agentId: null, petId: null });
  });
});
