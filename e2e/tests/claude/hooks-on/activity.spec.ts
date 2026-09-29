import type { Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { preToolUseBash, sessionStartStartup } from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { getOverlayByText } from '../../../helpers/office';
import { buildAssistantToolUseRecord, buildUserToolResultRecord } from '../../../helpers/team';
import {
  getPixelAgentsFrame,
  openPixelAgentsPanel,
  runCommand,
  setSettings,
} from '../../../helpers/webview';

const QUICK_PICK_TITLE = 'Pixel Agents: Activity';

function getQuickPickRows(window: Page) {
  return window.locator('.quick-input-widget .quick-input-list .monaco-list-row');
}

test.describe('Hooks ON / Activity shortcuts', () => {
  test('status bar shortcuts launch an agent and open a live Activity Quick Pick @area:cross-cutting', async ({
    pixelAgents,
  }, testInfo) => {
    const { window, frame, tmpHome, workspaceDir, mockLogFile, narrator } = pixelAgents;
    const statusBar = window.locator('.part.statusbar');
    // VS Code puts the accessible name on both the item and its label.
    const newAgentItem = statusBar.locator('[aria-label="Pixel Agents: New Agent"]').first();
    const activityItem = statusBar.locator('[aria-label="Pixel Agents: Show Activity"]').first();
    await expect(newAgentItem).toBeVisible();
    await expect(newAgentItem).toContainText('Agent');
    await expect(activityItem).toBeVisible();
    await expect(activityItem).toContainText('Activity');
    narrator.check('"Agent" and "Activity" shortcuts are in the status bar');

    narrator.step('enabling Watch All Sessions so a headless session is adopted later');
    await setSettings(frame, { watchAllSessions: true });
    await waitForClaudeHookSetup(tmpHome);

    narrator.step('arming the mock: a Task subtask at t+2.5s, its result at t+15s');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('status bar launched agent with a subtask')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-activity-survey', 'Task', {
            description: 'Survey the office',
          }),
        )
        .at(15_000)
        .appendJsonl(buildUserToolResultRecord('toolu-activity-survey'))
        .holdOpenFor(60_000)
        .build(),
    );
    narrator.step('clicking the status bar "Agent" shortcut');
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile, () => newAgentItem.click());
    await expect(window.getByText(/Claude Code #\d+/).first()).toBeVisible({ timeout: 15_000 });
    narrator.check('a "Claude Code #N" terminal launched from the status bar');

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expect(getOverlayByText(panelFrame, 'Subtask: Survey the office').first()).toBeVisible({
      timeout: 15_000,
    });

    narrator.step('clicking the status bar "Activity" shortcut');
    await activityItem.click();
    const quickInput = window.locator('.quick-input-widget');
    await expect(quickInput.locator('.quick-input-title')).toHaveText(QUICK_PICK_TITLE);
    const rows = getQuickPickRows(window);
    const agentRow = rows.filter({ hasText: /Claude Code #\d+/ });
    const subagentRow = rows.filter({ hasText: 'Sub-agent of' });
    await expect(agentRow).toHaveCount(1);
    await expect(agentRow).toContainText('Subtask: Survey the office');
    await expect(subagentRow).toHaveCount(1);
    await expect(subagentRow).toContainText('Survey the office');
    await expect(subagentRow).toContainText('Thinking…');
    await testInfo.attach('activity-quick-pick', {
      body: await window.screenshot(),
      contentType: 'image/png',
    });
    narrator.check('the Quick Pick lists the agent and its sub-agent with their activity');

    // The list is live: the Task's result retires the Sub-agent while it's open.
    narrator.step('waiting for the t+15s tool_result to retire the sub-agent row');
    await expect(subagentRow).toHaveCount(0, { timeout: 30_000 });
    await expect(quickInput.locator('.quick-input-title')).toHaveText(QUICK_PICK_TITLE);
    await expect(agentRow).toHaveCount(1);
    await expect(agentRow).not.toContainText('Subtask:');
    narrator.check('the open Quick Pick dropped the sub-agent row on its own');
    await window.keyboard.press('Escape');
    await expect(quickInput).toBeHidden();

    narrator.step('adopting an external session, which has no terminal');
    const sessionId = 'activity-external-session';
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      sessionId,
      scenario: claudeScenario('external session picked from the Activity Quick Pick')
        .at(200)
        .emitHook(
          sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
            string,
            unknown
          >,
        )
        .at(700)
        .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
        .holdOpenFor(30_000)
        .build(),
    });
    const externalOverlay = getOverlayByText(panelFrame, 'Running: npm test').first();
    await expect(externalOverlay).toBeVisible({ timeout: 15_000 });
    const externalId = await externalOverlay.getAttribute('data-agent-id');

    // A headless Agent has no terminal to focus, so picking it selects its
    // Character in the office instead.
    narrator.step('opening the Activity Quick Pick from the command palette');
    await runCommand(window, 'Pixel Agents: Show Activity', 3, { opensQuickPick: true });
    await expect(quickInput.locator('.quick-input-title')).toHaveText(QUICK_PICK_TITLE);
    const headlessRow = rows.filter({ hasText: 'Headless' });
    await expect(headlessRow).toHaveCount(1);
    await expect(headlessRow).toContainText('Running: npm test');
    await headlessRow.click();
    await expect(quickInput).toBeHidden();
    const details = (await getPixelAgentsFrame(window)).getByRole('region', {
      name: 'Agent details',
    });
    await expect(details).toHaveAttribute('data-agent-id', externalId ?? '');
    await expect(details).toContainText('Running: npm test');
    narrator.check('picking the headless agent selected its character in the office');
  });
});
