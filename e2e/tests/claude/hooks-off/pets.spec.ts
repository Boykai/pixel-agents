import type { Frame, Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import { reloadPixelAgentsWebview } from '../../../helpers/webview';

/**
 * e2e coverage for the animated pet system.
 *
 * Pets render only on the canvas (no DOM nodes) and the heart bubble is pure
 * runtime state that is never persisted, so the live assertions read pet state
 * through `window.__pixelAgentsTestHooks.getPets()` / `.petClick()` — the same
 * state-driving approach `selectAgent` uses for characters (see
 * webview-ui/src/testHooks.ts and the comment on closeAgentFromOverlay in
 * e2e/helpers/office.ts). Pets spawn at a random walkable tile, so tests never
 * compute screen coordinates; they read pet ids/state back instead.
 *
 * Placement itself goes through the REAL UI path: clicking the Pets-tab
 * carousel button → onPetToggle → handlePetToggle → applyEdit. Only the
 * canvas-only interactions (hit-test geometry of getPetAt) are bypassed.
 *
 * These tests have no hook dependency; they live under hooks-off purely
 * because that is the lighter fixture path (no hook-server wait).
 */

interface PetSnapshot {
  id: string;
  name: string;
  petType: number;
  state: 'idle' | 'walk' | 'follow' | 'approach' | 'sit' | 'sleep' | 'flee';
  x: number;
  y: number;
  bubbleType: 'heart' | null;
}

interface CameraFollow {
  agentId: number | null;
  petId: string | null;
}

interface PetTestHooks {
  getPets?: () => PetSnapshot[];
  petClick?: (petId: string) => void;
  getCameraFollow?: () => CameraFollow;
  messageLog?: Array<{ type: string }>;
}

type PetWindow = Window & { __pixelAgentsTestHooks?: PetTestHooks };

const PETS_CAROUSEL = '[data-testid="pets-carousel"]';

/**
 * Dismiss the first-run tooltips ("Hooks Installed", "Updated to vN")
 * that overlay the top toolbar and would otherwise intercept the Layout click.
 * Mirrors the layout-editor smoke test in hooks-on/lifecycle.spec.ts.
 */
async function dismissFirstRunTooltips(frame: Frame): Promise<void> {
  for (const tooltipText of ['Hooks Installed', 'Updated to v']) {
    const tooltip = frame.locator('div', { hasText: tooltipText }).first();
    if (await tooltip.isVisible().catch(() => false)) {
      const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
    }
  }
}

/** Enter edit mode and open the Pets tab; returns the carousel locator. */
async function openPetsTab(frame: Frame): Promise<Locator> {
  await dismissFirstRunTooltips(frame);
  await frame.locator('button[title="Edit office layout"]').click();
  await frame.locator('button[title="Place pets"]').click();
  const carousel = frame.locator(PETS_CAROUSEL);
  await expect(carousel).toBeVisible({ timeout: 15_000 });
  return carousel;
}

/** Point-in-time snapshot of every live pet, read from the test hook. */
async function readPets(frame: Frame): Promise<PetSnapshot[]> {
  return frame.evaluate(() => {
    const w = window as PetWindow;
    return w.__pixelAgentsTestHooks?.getPets?.() ?? [];
  });
}

/** Click a pet exactly as a canvas click would: toggles its heart bubble and the camera follow. */
async function petClick(frame: Frame, petId: string): Promise<void> {
  await frame.evaluate((id) => {
    (window as PetWindow).__pixelAgentsTestHooks?.petClick?.(id);
  }, petId);
}

/** What the camera is following right now (agent id or pet id), read from the test hook. */
async function readCameraFollow(frame: Frame): Promise<CameraFollow | null> {
  return frame.evaluate(
    () => (window as PetWindow).__pixelAgentsTestHooks?.getCameraFollow?.() ?? null,
  );
}

test.describe('Pets', () => {
  test('pet sprites load, broadcast, and expose manifest names in the editor @area:pets', async ({
    pixelAgents,
  }) => {
    const { frame, narrator } = pixelAgents;

    // The petSpritesLoaded broadcast is sent once after webviewReady. Proven
    // delivered via the message log (records every received message type).
    narrator.step('waiting for the pet sprites to broadcast to the webview');
    await frame.waitForFunction(() => {
      const w = window as PetWindow;
      const log = w.__pixelAgentsTestHooks?.messageLog ?? [];
      return log.some((m) => m.type === 'petSpritesLoaded');
    });
    narrator.check('petSpritesLoaded reached the client — pet assets delivered');

    // The two bundled pets (claudio, gitcat) render as carousel thumbnails in
    // alphabetical order, each titled with its manifest `name`. Asserting the
    // count + both names covers "loaded" and "manifest names" together.
    narrator.step('opening the layout editor → Pets tab');
    const carousel = await openPetsTab(frame);
    await expect(carousel.locator('button')).toHaveCount(2);
    narrator.check('carousel has exactly 2 pet thumbnails');
    await expect(carousel.locator('button[title="Claudio"]')).toBeVisible();
    await expect(carousel.locator('button[title="Gitcat"]')).toBeVisible();
    narrator.check('thumbnails titled "Claudio" and "Gitcat" — manifest names surfaced');
  });

  test('placing a pet toggles it on/off and persists across a panel reload @area:pets', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, narrator } = pixelAgents;

    narrator.step('opening the layout editor → Pets tab');
    const carousel = await openPetsTab(frame);
    const claudio = carousel.locator('button[title="Claudio"]');
    const gitcat = carousel.locator('button[title="Gitcat"]');

    // Toggle ON: clicking the carousel button drives the real placement path.
    narrator.step('clicking Claudio — placing the pet');
    await claudio.click();
    await frame.waitForFunction(() => {
      const pets = (window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? [];
      return pets.length === 1 && pets[0]?.petType === 0;
    });
    narrator.check('one pet on the canvas (getPets → 1, petType claudio)');

    // Toggle OFF: clicking the same (now-active) button removes it.
    narrator.step('clicking Claudio again — removing the pet');
    await claudio.click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 0,
    );
    narrator.check('canvas empty again (getPets → 0)');

    // Place both pets, then persist via the EditActionBar Save button.
    narrator.step('placing both pets — Claudio, then Gitcat');
    await claudio.click();
    await frame.waitForFunction(
      () =>
        ((globalThis as unknown as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length ===
        1,
    );
    await gitcat.click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
    );
    narrator.check('two pets on the canvas (getPets → 2)');

    narrator.step('clicking Save — persisting the layout to disk');
    const saveBtn = frame.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // The save round-trips through layoutPersistence to ~/.pixel-agents/layout.json
    // (under the fixture's isolated HOME). Pets are opaque pass-through server-side.
    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return -1;
          try {
            const parsed = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as {
              pets?: unknown[];
            };
            return Array.isArray(parsed.pets) ? parsed.pets.length : -1;
          } catch {
            return -1;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    narrator.check('~/.pixel-agents/layout.json contains 2 pets');

    // Reload the webview and confirm the pets rehydrate from disk. (Hiding the
    // panel would keep the same webview: it retains its context when hidden.)
    narrator.step('reloading the webview — pets must rehydrate from disk');
    const freshFrame = await reloadPixelAgentsWebview(window);
    await freshFrame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
      undefined,
      { timeout: 15_000 },
    );
    narrator.check('fresh webview shows 2 pets again — persisted across the reload');
  });

  test('clicking a pet shows a heart bubble that auto-dismisses and dismisses on re-click @area:pets', async ({
    pixelAgents,
  }) => {
    // `window` stays un-destructured here so the waitForFunction callbacks'
    // `window` keeps resolving to the DOM global for TypeScript.
    const { frame, narrator } = pixelAgents;

    // Place one pet through the editor, then read its id back (spawn tile is
    // random, so the id is the only stable handle).
    narrator.step('placing one pet (Claudio) via the editor');
    const carousel = await openPetsTab(frame);
    await carousel.locator('button[title="Claudio"]').click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 1,
    );
    const pets = await readPets(frame);
    const petId = pets[0]!.id;
    narrator.check('pet placed (getPets → 1)');

    // Click → heart bubble appears.
    narrator.step('clicking the pet — heart bubble should appear');
    await petClick(frame, petId);
    await frame.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);
    narrator.check('heart bubble showing (bubbleType = heart)');

    // It auto-dismisses after WAITING_BUBBLE_DURATION_SEC (2s); the rAF loop
    // nulls bubbleType once the timer elapses. Timeout sits above 2s.
    narrator.step('waiting for the 2s auto-dismiss timer, no clicks');
    await frame.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 6_000 },
    );
    narrator.check('bubble auto-dismissed on its own (bubbleType = null)');

    // The 1s assertion below completes before the 2s auto-dismiss timer, so
    // a cleared bubble can only be the click-dismiss path.
    narrator.step('clicking again — heart bubble re-appears');
    await petClick(frame, petId);
    await frame.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);
    narrator.check('heart bubble showing again');

    narrator.step('clicking while showing — must dismiss fast, not wait out the 2s timer');
    await petClick(frame, petId);
    await frame.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 1_000 },
    );
    narrator.check('bubble cleared within 1s of the click — fast-dismiss path confirmed');
  });

  test('clicking a pet makes the camera follow it; a wheel pan or the editor ends the follow @area:pets', async ({
    pixelAgents,
  }) => {
    // `window` stays un-destructured (the VS Code page is `page`) so the
    // waitForFunction callbacks' `window` keeps resolving to the DOM global.
    const { frame, window: page, narrator } = pixelAgents;

    narrator.step('placing one pet (Claudio) via the editor');
    const carousel = await openPetsTab(frame);
    await carousel.locator('button[title="Claudio"]').click();
    await frame.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 1,
    );
    const petId = (await readPets(frame))[0]!.id;
    narrator.check('pet placed (getPets → 1)');

    // Following is a view-mode interaction: the editor ends any follow on entry.
    narrator.step('closing the layout editor');
    await frame.locator('button[title="Edit office layout"]').click();
    await expect(carousel).toBeHidden();
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId: null });
    narrator.check('editor closed, camera following nothing');

    narrator.step('clicking the pet — the camera should follow it');
    await petClick(frame, petId);
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId });
    narrator.check('camera following the pet (cameraFollowPetId = its id)');

    narrator.step('clicking the same pet again — the follow toggles off');
    await petClick(frame, petId);
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId: null });
    narrator.check('follow toggled off');

    narrator.step('following the pet again, then panning with the mouse wheel over the office');
    await petClick(frame, petId);
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId });
    await frame.locator('canvas').first().hover();
    await page.mouse.wheel(0, 120);
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId: null });
    narrator.check('the wheel pan ended the follow');

    narrator.step('following the pet again, then opening the layout editor');
    await petClick(frame, petId);
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId });
    await frame.locator('button[title="Edit office layout"]').click();
    await expect.poll(() => readCameraFollow(frame)).toEqual({ agentId: null, petId: null });
    narrator.check('entering the editor ended the follow');
  });
});
