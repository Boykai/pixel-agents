import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/copilot';
import { enterEditMode, paintTile } from '../../helpers/editor';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { copilotScenario } from '../../helpers/mock-copilot';
import {
  isCostumePanelCovered,
  openAgentDetails,
  openCostumePanel,
  readCharacterLook,
  renameAgent,
} from '../../helpers/nicknames';
import {
  expectOverlayCount,
  expectOverlayVisible,
  getAgentOverlays,
  getOverlayByAgentId,
  getOverlayByText,
  readAgentOverlayIds,
} from '../../helpers/office';
import type { StandaloneSession } from '../../helpers/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';

/** A Claude session driven through the standalone hook endpoint (POSTing hooks
 *  is the standalone surface's process boundary; see e2e/README.md). */
async function startClaudeAgent(
  page: Page,
  standalone: StandaloneSession,
  sessionId: string,
  file: string,
): Promise<number> {
  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(sessionId, standalone.workspaceDir),
  );
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(standalone.workspaceDir, file) },
  });
  await expectOverlayCount(page, 1);
  await expectOverlayVisible(page, `Reading ${file}`);
  const [id] = await readAgentOverlayIds(page);
  if (id === undefined) throw new Error('the Claude agent has no overlay');
  return id;
}

async function waitForOffice(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
}

test.describe('Standalone / nicknames and costumes', () => {
  test('a renamed agent keeps its nickname across a reload until it is cleared @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const id = await startClaudeAgent(page, standalone, 'standalone-nickname', 'notes.ts');
    const overlay = getOverlayByAgentId(page, id);
    const projectLabel = (await overlay.innerText()).trim();
    expect(projectLabel).not.toBe('');

    await renameAgent(page, id, 'Ada');
    await expect(overlay).toContainText('Ada');
    // The project stays on the label, beneath the nickname.
    await expect(overlay).toContainText(projectLabel);

    await page.reload();
    await waitForOffice(page);
    await expect(overlay).toContainText('Ada');
    const details = await openAgentDetails(page, id);
    await expect(details.getByRole('heading', { level: 2 })).toHaveText('Ada');

    // An empty nickname clears it: the label is the project alone again.
    await renameAgent(page, id, '');
    await expect(overlay).not.toContainText('Ada');
    await page.reload();
    await waitForOffice(page);
    await expect(overlay).toHaveText(projectLabel);
  });

  test('a costume change reaches a second client and outlives a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const id = await startClaudeAgent(page, standalone, 'standalone-costume', 'styles.ts');

    const second = await page.context().newPage();
    try {
      await second.addInitScript(() => {
        (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
      });
      await second.goto(page.url());
      await waitForOffice(second);
      await expectOverlayCount(second, 1);
      const before = await readCharacterLook(second, id);
      if (!before) throw new Error('the second client has no character for the agent');

      const panel = await openCostumePanel(page, id);
      const paletteCount = await panel.getByRole('button', { name: /^Costume \d+$/ }).count();
      expect(paletteCount).toBeGreaterThan(1);
      const palette = (before.palette + 1) % paletteCount;
      await panel.getByRole('button', { name: `Costume ${palette + 1}`, exact: true }).click();
      await panel.getByRole('slider', { name: 'Hue shift' }).fill('90');
      await expect(panel).toContainText('90°');
      const look = { palette, hueShift: 90 };
      await expect.poll(() => readCharacterLook(page, id)).toEqual(look);
      await expect.poll(() => readCharacterLook(second, id), { timeout: 15_000 }).toEqual(look);

      // The panel's nickname field saves on Enter, and every client sees it.
      // Escape first cancels an unsaved edit, and only then closes the panel.
      const nicknameField = panel.getByRole('textbox');
      await nicknameField.fill('Ivy');
      await nicknameField.press('Enter');
      await expect(getOverlayByAgentId(second, id)).toContainText('Ivy', { timeout: 15_000 });
      await nicknameField.fill('Unsaved');
      await nicknameField.press('Escape');
      await expect(nicknameField).toHaveValue('Ivy');
      await expect(panel).toBeVisible();
      await nicknameField.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(getOverlayByAgentId(page, id)).toContainText('Ivy');
      await expect(getOverlayByAgentId(page, id)).not.toContainText('Unsaved');

      await second.reload();
      await waitForOffice(second);
      await expect.poll(() => readCharacterLook(second, id), { timeout: 15_000 }).toEqual(look);
      await expect(getOverlayByAgentId(second, id)).toContainText('Ivy');
    } finally {
      await second.close();
    }
  });

  test('a modal over the Costume panel covers it and keeps Escape from closing it @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const id = await startClaudeAgent(page, standalone, 'standalone-costume-modal', 'panel.ts');
    const panel = await openCostumePanel(page, id);

    const settings = await openSettingsModal(page);
    await expect.poll(() => isCostumePanelCovered(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await settings.getByRole('button', { name: 'x', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(panel).toBeVisible();

    // Uncovered, the panel takes Escape again.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('Escape closes one surface per press, topmost first: Sign editor, Costume panel, reset confirmation @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const id = await startClaudeAgent(page, standalone, 'standalone-escape-order', 'order.ts');
    const frame = page.mainFrame();

    await enterEditMode(frame);
    const resetButton = page.getByRole('button', { name: 'Reset to Default', exact: true });
    const resetConfirm = page.getByRole('alertdialog', {
      name: 'Reset office to the default layout',
    });
    await resetButton.click();
    await expect(resetConfirm).toBeVisible();
    await page.getByTitle('Place furniture', { exact: true }).click();
    await page.getByRole('button', { name: 'Decor', exact: true }).click();
    await page.getByTitle('Sign', { exact: true }).click();
    // Opened after the prompt, the panel listens after it too: the order below
    // must come from the stacking, not from which surface listened first.
    const panel = await openCostumePanel(page, id);

    // A Sign on an open floor tile of the bundled default layout opens the Sign
    // editor over both.
    const signText = page.getByLabel('Sign text', { exact: true });
    await paintTile(frame, 12, 17);
    await expect(signText).toBeFocused();
    await expect.poll(() => isCostumePanelCovered(page)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(signText).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(resetConfirm).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(resetConfirm).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(resetConfirm).toHaveCount(0);
    // The prompt took that press: the editor itself stays open.
    await expect(resetButton).toBeVisible();
  });
});

test.describe('Standalone / Copilot nicknames', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('an observed Copilot session can be renamed, and keeps the nickname across a server restart @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const title = 'Refactor the session router';
    const mock = await copilot('copilot-nickname', 'example/Laughingman');
    await mock.run(
      copilotScenario()
        .append('session.title_changed', { title })
        .toolStart('read-1', 'view', { path: 'router.ts' }),
    );
    await expectOverlayVisible(page, 'Reading router.ts');
    const [id] = await readAgentOverlayIds(page);
    if (id === undefined) throw new Error('the Copilot agent has no overlay');

    await renameAgent(page, id, 'Scout');
    const overlay = getOverlayByAgentId(page, id);
    await expect(overlay).toContainText('Scout');
    await expect(overlay).toContainText('Laughingman');
    // The nickname heads the details; the session title stays beneath it.
    const details = await openAgentDetails(page, id);
    await expect(details.getByRole('heading', { level: 2 })).toHaveText('Scout');
    await expect(details).toContainText(title);
    await details.getByRole('button', { name: 'Hide agent details' }).click();
    await expect(details).toHaveCount(0);

    // The Usage panel names the agent's row by its nickname too.
    await mock.run(
      copilotScenario().append('session.usage_checkpoint', {
        totalPremiumRequests: 1,
        totalNanoAiu: 25_000,
      }),
    );
    await page.getByRole('button', { name: 'Usage', exact: true }).click();
    const usageRow = page.getByTestId('usage-agent-row');
    await expect(usageRow).toHaveCount(1);
    await expect(usageRow).toContainText('Scout');
    await page.getByRole('button', { name: 'Close token usage' }).click();
    await expect(page.getByTestId('usage-panel')).toHaveCount(0);

    // A fresh server restores the observed session with its nickname, and its
    // next activity lands on the same named character.
    await standalone.stopHost();
    await standalone.startHost();
    await page.reload();
    await waitForOffice(page);
    await expectOverlayCount(page, 1);
    await expect(getAgentOverlays(page).first()).toContainText('Scout');
    await mock.run(
      copilotScenario()
        .toolComplete('read-1')
        .toolStart('read-2', 'view', { path: 'after-restart.ts' }),
    );
    await expectOverlayVisible(page, 'Reading after-restart.ts');
    await expectOverlayCount(page, 1);
    await expect(getOverlayByText(page, 'Reading after-restart.ts')).toContainText('Scout');
  });
});
