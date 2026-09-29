import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  enterEditMode,
  type PlacedFurnitureSnapshot,
  paintTile,
  readFurniture,
  saveLayout,
} from '../../../helpers/editor';
import { buildSeedLayout } from '../../../helpers/layout-seed';
import { reloadPixelAgentsWebview } from '../../../helpers/webview';

/**
 * Signs (pixel-text Furniture) and Draw layers on the VS Code surface, ported
 * from hootbu/pixel-agents. Both ride on PlacedFurniture (`text`, `zLayer`) in
 * the opaque layout: the editor writes them, the extension's saveLayout path
 * stores layout.json raw, and a reloaded webview restores them. Canvas-only
 * state is read through the getFurniture test hook (webview-ui/src/testHooks.ts).
 *
 * hooks-off lane: the layout editor has no hook dependency.
 */

const SIGN = { value: 'Ship it', color: '#FFFFFF', size: '3x5', scale: 1 };

function readSavedFurniture(tmpHome: string): PlacedFurnitureSnapshot[] | null {
  const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');
  if (!fs.existsSync(layoutPath)) return null;
  return (
    JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as { furniture: PlacedFurnitureSnapshot[] }
  ).furniture;
}

test.describe('Signs and Draw layers', () => {
  // A small all-floor layout, so the Sign lands on a free floor tile.
  test.use({ seedLayout: buildSeedLayout({ cols: 12, rows: 12 }) });

  test('a placed Sign and its Draw layer survive save and a webview reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, frame, tmpHome, narrator } = pixelAgents;

    narrator.step('placing a Sign from the Decor palette and typing its text');
    await enterEditMode(frame);
    await frame.locator('button[title="Place furniture"]').click();
    await frame.getByRole('button', { name: 'Decor', exact: true }).click();
    await frame.locator('[title="Sign"]').click();
    await paintTile(frame, 4, 4);
    await frame.getByLabel('Sign text', { exact: true }).fill(SIGN.value);
    await frame.locator('button[title="Place sign"]').click();
    await expect
      .poll(() => readFurniture(frame))
      .toEqual([expect.objectContaining({ type: 'PIXEL_TEXT', col: 4, row: 4, text: SIGN })]);
    narrator.check('the layout holds one Sign reading "Ship it"');

    narrator.step('selecting the Sign and bringing it forward one Draw layer');
    await frame.locator('[title="Sign"]').click();
    await paintTile(frame, 4, 4);
    await frame.locator('button[title="Bring forward"]').click();
    await expect.poll(async () => (await readFurniture(frame))[0]?.zLayer).toBe(1);
    narrator.check('the Sign is on Draw layer +1');

    narrator.step('saving the layout');
    await saveLayout(frame);
    await expect
      .poll(() => readSavedFurniture(tmpHome))
      .toEqual([expect.objectContaining({ type: 'PIXEL_TEXT', text: SIGN, zLayer: 1 })]);
    narrator.check('layout.json stores the Sign text and its Draw layer');

    narrator.step('reloading the webview: the Sign must come back from layout.json');
    const reloaded = await reloadPixelAgentsWebview(window);
    await expect
      .poll(() => readFurniture(reloaded))
      .toEqual([
        expect.objectContaining({ type: 'PIXEL_TEXT', col: 4, row: 4, text: SIGN, zLayer: 1 }),
      ]);
    narrator.check('the fresh webview restored the Sign with its text and Draw layer');
  });
});
