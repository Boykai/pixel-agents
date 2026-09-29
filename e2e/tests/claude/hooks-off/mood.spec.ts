import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../../helpers/mock-claude';
import {
  countFailedToolDones,
  readMoodBubblesApplied,
  readMoodLog,
  readStoredMoodBubbles,
} from '../../../helpers/mood';
import {
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolErrorRecord,
} from '../../../helpers/team';
import {
  getPixelAgentsFrame,
  getSettingChecked,
  openPixelAgentsPanel,
  reloadPixelAgentsWebview,
  setSettings,
} from '../../../helpers/webview';

const MOOD_TIMEOUT_MS = 15_000;

test.describe('Hooks OFF / Mood bubbles', () => {
  test('a failed transcript tool shows the error Mood, and Mood bubbles off survives a webview reload @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { window, tmpHome, mockLogFile, narrator } = pixelAgents;
    let frame = pixelAgents.frame;

    narrator.step('turning hooks OFF: the failure must come from the transcript alone');
    await setSettings(frame, { hooksEnabled: false });

    narrator.step(
      'scripting the mock: a Bash tool_use, an is_error tool_result, then turn_duration',
    );
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('mood error hooks off')
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-mood-fail', 'Bash', { command: 'npm test' }),
        )
        .at(7_000)
        .appendJsonl(buildUserToolErrorRecord('toolu-mood-fail'))
        // Well after the failure, so the turn end is never read in the same batch.
        .at(9_500)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(30_000)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    frame = await getPixelAgentsFrame(window);

    await expect
      .poll(async () => (await readMoodLog(frame)).map((entry) => [entry.mood, entry.shown]), {
        timeout: MOOD_TIMEOUT_MS,
      })
      .toEqual([['error', true]]);
    expect(await countFailedToolDones(frame)).toBe(1);
    narrator.check('the failed tool_result showed the error Mood bubble, once');

    narrator.step('turning Mood bubbles OFF in Settings');
    await setSettings(frame, { moodBubbles: false });
    await expect.poll(() => readMoodBubblesApplied(frame)).toBe(false);
    await expect.poll(() => readStoredMoodBubbles(tmpHome, 'vscode')).toBe(false);
    // Per namespace: the standalone surface keeps its own setting.
    expect(readStoredMoodBubbles(tmpHome, 'standalone')).not.toBe(false);

    narrator.step('reloading the webview to force a fresh settingsLoaded');
    frame = await reloadPixelAgentsWebview(window);
    await expect.poll(() => readMoodBubblesApplied(frame)).toBe(false);
    expect(await getSettingChecked(frame, 'Mood Bubbles')).toBe(false);
    narrator.check('Mood bubbles are still off after the reload');
  });
});
