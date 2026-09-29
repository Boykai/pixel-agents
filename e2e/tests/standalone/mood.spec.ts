import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/copilot';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnMockClaudeProcess,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { copilotScenario } from '../../helpers/mock-copilot';
import {
  countFailedToolDones,
  type MoodLogEntry,
  readMoodBubblesApplied,
  readMoodLog,
  readStoredMoodBubbles,
} from '../../helpers/mood';
import { expectOverlayVisible } from '../../helpers/office';
import {
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolErrorRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';
import { getSettingChecked, setSettings } from '../../helpers/webview';

const MOOD_TIMEOUT_MS = 15_000;

/** The Moods shown so far, in order, as [mood, shown] pairs. */
async function moods(page: Page): Promise<Array<[MoodLogEntry['mood'], boolean]>> {
  return (await readMoodLog(page)).map((entry) => [entry.mood, entry.shown]);
}

/**
 * Mood bubbles on the standalone surface: a character reacts to the
 * tool-failure signal (error) and to a clean turn ending Done (happy), for
 * both providers, and the per-namespace setting turns the reactions off.
 */
test.describe('Standalone / Mood bubbles (Claude hooks)', () => {
  test.use({ seedHooksEnabled: true });

  test('a Claude tool that fails (PostToolUseFailure) shows the error Mood and a clean turn shows happy @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    // The mock runs every hook through the INSTALLED hook script.
    await waitForClaudeHookSetup(standalone.tmpHome);

    const sessionId = randomUUID();
    const hook = {
      session_id: sessionId,
      cwd: standalone.workspaceDir,
      transcript_path: '{{transcriptPath}}',
    };
    const failing = { command: 'npm test' };
    const reading = { file_path: path.join(standalone.workspaceDir, 'happy.ts') };
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mood-claude-hooks')
        .at(0)
        .emitHook({ ...hook, hook_event_name: 'SessionStart', source: 'startup' })
        // Turn 1: the tool fails.
        .at(0)
        .appendJsonl(buildAssistantToolUseRecord('toolu-mood-fail', 'Bash', failing))
        .at(0)
        .emitHook({
          ...hook,
          hook_event_name: 'PreToolUse',
          tool_use_id: 'toolu-mood-fail',
          tool_name: 'Bash',
          tool_input: failing,
        })
        .at(2_000)
        .appendJsonl(buildUserToolErrorRecord('toolu-mood-fail'))
        .at(2_000)
        .emitHook({
          ...hook,
          hook_event_name: 'PostToolUseFailure',
          tool_use_id: 'toolu-mood-fail',
          tool_name: 'Bash',
          tool_input: failing,
          error: 'Exit code 1',
        })
        .at(3_000)
        .emitHook({ ...hook, hook_event_name: 'Stop' })
        .at(3_000)
        .appendJsonl(buildTurnDurationRecord())
        // Turn 2: a clean tool, long enough for its overlay to be observed.
        .at(6_000)
        .appendJsonl(buildAssistantToolUseRecord('toolu-mood-read', 'Read', reading))
        .at(6_000)
        .emitHook({
          ...hook,
          hook_event_name: 'PreToolUse',
          tool_use_id: 'toolu-mood-read',
          tool_name: 'Read',
          tool_input: reading,
        })
        .at(10_000)
        .appendJsonl(buildUserToolResultRecord('toolu-mood-read'))
        .at(10_000)
        .emitHook({
          ...hook,
          hook_event_name: 'PostToolUse',
          tool_use_id: 'toolu-mood-read',
          tool_name: 'Read',
          tool_input: reading,
        })
        .at(11_000)
        .emitHook({ ...hook, hook_event_name: 'Stop' })
        .at(11_000)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(60_000)
        .build(),
    );
    const claude = spawnMockClaudeProcess({
      homeDir: standalone.tmpHome,
      workspaceDir: standalone.workspaceDir,
      sessionId,
    });
    try {
      await expect.poll(() => moods(page), { timeout: MOOD_TIMEOUT_MS }).toEqual([['error', true]]);

      // Turn 2 started, so turn 1's end has been applied: a failed turn is never happy.
      await expectOverlayVisible(page, 'Reading happy.ts');
      expect(await moods(page)).toEqual([['error', true]]);

      await expect
        .poll(() => moods(page), { timeout: MOOD_TIMEOUT_MS })
        .toEqual([
          ['error', true],
          ['happy', true],
        ]);
      // The hook and the transcript both saw the failure; it is signalled once.
      expect(await countFailedToolDones(page)).toBe(1);
      expect((await readMoodLog(page)).every((entry) => !entry.isSubagent)).toBe(true);
    } catch (error) {
      throw new Error(`${String(error)}\nmock-claude:\n${claude.logs()}`);
    } finally {
      await claude.stop();
    }
  });
});

test.describe('Standalone / Mood bubbles (GitHub Copilot)', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('a Copilot tool that fails shows the error Mood and a clean interaction shows happy @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const sessionId = 'copilot-mood';
    const mock = await copilot(sessionId);

    await mock.run(copilotScenario().toolStart('failing', 'powershell', { command: 'npm test' }));
    await expectOverlayVisible(page, 'Running: npm test');
    await mock.run(copilotScenario().toolFailed('failing'));
    await expect.poll(() => moods(page), { timeout: MOOD_TIMEOUT_MS }).toEqual([['error', true]]);

    await mock.run(copilotScenario().interactionDone(sessionId));
    // Idle means the interaction's end has been applied: one with a failure is never happy.
    await expectOverlayVisible(page, 'Idle');
    expect(await moods(page)).toEqual([['error', true]]);

    await mock.run(copilotScenario().toolStart('reading', 'view', { path: 'happy.ts' }));
    await expectOverlayVisible(page, 'Reading happy.ts');
    await mock.run(copilotScenario().toolComplete('reading').interactionDone(sessionId));
    await expect
      .poll(() => moods(page), { timeout: MOOD_TIMEOUT_MS })
      .toEqual([
        ['error', true],
        ['happy', true],
      ]);
    expect(await countFailedToolDones(page)).toBe(1);
  });

  test('with Mood bubbles off a failed tool shows no Mood, and the setting survives a reload @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      watchAllSessions: false,
      moodBubbles: false,
    });
    await expect.poll(() => readMoodBubblesApplied(page)).toBe(false);
    await expect.poll(() => readStoredMoodBubbles(standalone.tmpHome, 'standalone')).toBe(false);
    // Per namespace: the VS Code surface keeps its own setting.
    expect(readStoredMoodBubbles(standalone.tmpHome, 'vscode')).not.toBe(false);

    const mock = await copilot('copilot-mood-off');
    await mock.run(copilotScenario().toolStart('failing', 'powershell', { command: 'npm test' }));
    await expectOverlayVisible(page, 'Running: npm test');
    await mock.run(copilotScenario().toolFailed('failing'));
    // The failure still reaches the office; only its Mood bubble is suppressed.
    await expect.poll(() => countFailedToolDones(page), { timeout: MOOD_TIMEOUT_MS }).toBe(1);
    expect(await moods(page)).toEqual([['error', false]]);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readMoodBubblesApplied(page)).toBe(false);
    expect(await getSettingChecked(page, 'Mood Bubbles')).toBe(false);
  });
});
