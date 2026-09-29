import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../../helpers/mock-claude';
import { expectSingleAgentOverlay, getOverlayByAgentId } from '../../../helpers/office';
import {
  getPixelAgentsFrame,
  openPixelAgentsPanel,
  reloadPixelAgentsWebview,
} from '../../../helpers/webview';

const NICKNAME = 'Ada Lovelace';

test.describe('Hooks ON / nicknames', () => {
  test('a nickname typed in the + Agent menu names the terminal and the character @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('arming the mock to keep its session open for the whole test');
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('nicknamed launch').holdOpenFor(60_000).build(),
    );

    narrator.step('reaching the nickname field from the keyboard alone');
    const agentButton = frame.locator('button', { hasText: '+ Agent' });
    const nicknameField = frame.getByRole('textbox', { name: 'Agent nickname' });
    await agentButton.focus();
    await expect(nicknameField).toBeVisible();
    await agentButton.press('Tab');
    await expect(nicknameField).toBeFocused();
    narrator.check('focusing + Agent opens its menu, and Tab lands in the nickname field');
    await nicknameField.press('Escape');
    await expect(nicknameField).toBeHidden();
    await expect(agentButton).toBeFocused();
    narrator.check('Escape closes the menu and hands focus back to + Agent');

    narrator.step(`typing "${NICKNAME}" into the optional nickname field of the + Agent menu`);
    await agentButton.hover();
    await expect(nicknameField).toBeVisible();
    await nicknameField.fill(NICKNAME);
    // The "+ Agent" click takes the typed nickname with it.
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);

    await openPixelAgentsPanel(window);
    let panelFrame = await getPixelAgentsFrame(window);
    const id = await expectSingleAgentOverlay(panelFrame);
    await expect(getOverlayByAgentId(panelFrame, id)).toContainText(NICKNAME);
    narrator.check(`the character's label leads with "${NICKNAME}"`);

    await expect(window.getByText(NICKNAME, { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    narrator.check(`the terminal tab is named "${NICKNAME}"`);

    narrator.step('reloading the webview: the restore brings the nickname back');
    panelFrame = await reloadPixelAgentsWebview(window);
    await expect(getOverlayByAgentId(panelFrame, id)).toContainText(NICKNAME, {
      timeout: 15_000,
    });
    narrator.check('the nickname survived the webview reload');
  });
});
