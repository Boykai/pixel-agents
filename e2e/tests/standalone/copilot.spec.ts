import { spawn } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '../../fixtures/copilot';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { copilotScenario } from '../../helpers/mock-copilot';
import {
  expectOverlayCount,
  expectOverlayVisible,
  getAgentOverlays,
  getOverlayByText,
} from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

test.describe('Standalone / Copilot transcript observation', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('discovers new same-workspace sessions after empty boot and restores active labels on reload @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    await page.waitForTimeout(1_100);
    await expectOverlayCount(page, 0);

    const first = await copilot('copilot-new-first');
    await first.run(copilotScenario().toolStart('read-1', 'view', { path: 'first.ts' }));
    await expectOverlayVisible(page, 'Reading first.ts');
    const second = await copilot('copilot-new-second');
    await second.run(copilotScenario().toolStart('read-1', 'view', { path: 'second.ts' }));
    await expectOverlayCount(page, 2);
    await expectOverlayVisible(page, 'Reading second.ts');

    await page.reload();
    await expectOverlayCount(page, 2);
    await expectOverlayVisible(page, 'Reading first.ts');
    await expectOverlayVisible(page, 'Reading second.ts');
    await first.run(
      copilotScenario()
        .toolComplete('read-1')
        .toolStart('read-2', 'view', { path: 'after-reload.ts' }),
    );
    await expectOverlayVisible(page, 'Reading after-reload.ts');
    await expectOverlayVisible(page, 'Reading second.ts');
  });

  test('model-step completion and long tools do not invent approval waits; input and interaction completion stay distinct @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const sessionId = 'copilot-interaction';
    const mock = await copilot(sessionId);
    await mock.run(
      copilotScenario()
        .toolStart('long-tool', 'powershell', { command: 'fixture-long-task' })
        .append('assistant.turn_end'),
    );
    await expectOverlayVisible(page, 'Running: fixture-long-task');
    // Cross Claude's seven-second permission heuristic. Silence is not a
    // Copilot permission request, and model-step end is not interaction end.
    await page.waitForTimeout(8_500);
    await expectOverlayVisible(page, 'Running: fixture-long-task');
    await expect(getOverlayByText(page, 'Needs approval')).toHaveCount(0);

    await mock.run(
      copilotScenario()
        .toolComplete('long-tool')
        .toolStart('question', 'ask_user', { question: 'Which fixture should run?' }),
    );
    await expectOverlayVisible(page, 'Waiting for input');
    await mock.run(copilotScenario().toolComplete('question').interactionDone(sessionId));
    // Done temporarily shows a canvas checkmark; after it fades, the regular
    // Idle label returns, not the persistent Waiting for input label.
    await expectOverlayVisible(page, 'Idle');
    await expect(getOverlayByText(page, 'Waiting for input')).toHaveCount(0);
    await expectOverlayCount(page, 1);

    await mock.run(copilotScenario().toolStart('next-turn', 'view', { path: 'resumed.ts' }));
    await expectOverlayVisible(page, 'Reading resumed.ts');
  });

  test('recurring transcript sessionEnd hooks never remove a live agent @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const sessionId = 'copilot-recurring-end';
    const mock = await copilot(sessionId);
    await mock.run(copilotScenario().toolStart('live-tool', 'view', { path: 'still-active.ts' }));
    await expectOverlayVisible(page, 'Reading still-active.ts');
    for (let index = 0; index < 3; index++) {
      await mock.run(
        copilotScenario().append('hook.start', {
          hookType: 'sessionEnd',
          input: { sessionId },
        }),
      );
      // Let each append cross the polling boundary before asserting retention.
      await page.waitForTimeout(750);
      await expectOverlayCount(page, 1);
      await expectOverlayVisible(page, 'Reading still-active.ts');
    }
    await mock.run(
      copilotScenario()
        .toolComplete('live-tool')
        .toolStart('later-tool', 'view', { path: 'after-recurring-end.ts' }),
    );
    await expectOverlayVisible(page, 'Reading after-recurring-end.ts');
  });
});

test.describe('Standalone / mixed providers', () => {
  test.use({ provider: 'claude,copilot', seedHooksEnabled: true });

  test('colliding Claude and Copilot session and tool IDs remain separate @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const sessionId = '12345678-1234-4234-8234-123456789abc';
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('mixed-provider-collision')
        .at(0)
        .emitHook({
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          cwd: standalone.workspaceDir,
          transcript_path: '{{transcriptPath}}',
          source: 'startup',
        })
        .at(0)
        .appendJsonl({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'same-tool',
                name: 'Read',
                input: { file_path: path.join(standalone.workspaceDir, 'claude-only.ts') },
              },
            ],
          },
        })
        // Keep Claude's intentional silence-based permission heuristic out of
        // this identity assertion; Copilot still exercises transcript adoption.
        .at(0)
        .emitHook({
          hook_event_name: 'PreToolUse',
          session_id: sessionId,
          cwd: standalone.workspaceDir,
          transcript_path: '{{transcriptPath}}',
          tool_use_id: 'same-tool',
          tool_name: 'Read',
          tool_input: { file_path: path.join(standalone.workspaceDir, 'claude-only.ts') },
        })
        .holdOpenFor(60_000)
        .build(),
    );
    const claude = spawn(
      process.execPath,
      [
        path.join(__dirname, '..', '..', 'fixtures', 'mock-claude-runner.cjs'),
        '--session-id',
        sessionId,
      ],
      {
        cwd: standalone.workspaceDir,
        env: {
          ...process.env,
          HOME: standalone.tmpHome,
          USERPROFILE: standalone.tmpHome,
          COPILOT_HOME: path.join(standalone.tmpHome, '.copilot'),
        },
        stdio: 'pipe',
      },
    );
    let logs = '';
    claude.stdout.on('data', (chunk) => {
      logs += chunk.toString();
    });
    claude.stderr.on('data', (chunk) => {
      logs += chunk.toString();
    });
    try {
      await expectOverlayVisible(page, 'Reading claude-only.ts');
      const mock = await copilot(sessionId);
      await mock.run(copilotScenario().toolStart('same-tool', 'view', { path: 'copilot-only.ts' }));
      await expectOverlayCount(page, 2);
      await expectOverlayVisible(page, 'Reading copilot-only.ts');
      const claudeOverlay = getOverlayByText(page, 'Reading claude-only.ts');
      const copilotOverlay = getOverlayByText(page, 'Reading copilot-only.ts');
      expect(await claudeOverlay.getAttribute('data-agent-id')).not.toBe(
        await copilotOverlay.getAttribute('data-agent-id'),
      );

      await mock.run(copilotScenario().toolComplete('same-tool').interactionDone(sessionId));
      await expectOverlayVisible(page, 'Idle');
      await expectOverlayVisible(page, 'Reading claude-only.ts');
      await expectOverlayCount(page, 2);
    } catch (error) {
      throw new Error(`${String(error)}\nmock-claude:\n${logs}`);
    } finally {
      if (claude.exitCode === null && claude.signalCode === null) {
        const exited = new Promise<void>((resolve) => claude.once('exit', () => resolve()));
        claude.kill();
        await exited;
      }
    }
  });
});

test.describe('Standalone / Copilot installed hooks', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: true });

  test('the mock executes installed observational hooks into the browser @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const mock = await copilot('copilot-installed-hooks');
    await mock.run(
      copilotScenario()
        .emitHook('sessionStart', { source: 'startup' })
        .emitHook('preToolUse', { toolCallId: 'hook-tool', toolName: 'view' }),
    );
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Reading');
    await mock.run(
      copilotScenario()
        .emitHook('postToolUse', { toolCallId: 'hook-tool', toolName: 'view' })
        .emitHook('notification', { notification_type: 'elicitation_dialog' }),
    );
    await expectOverlayVisible(page, 'Waiting for input');
    await expect(getAgentOverlays(page)).toHaveCount(1);
  });
});
