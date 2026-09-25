import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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
import { openSettingsModal, setSettings } from '../../helpers/webview';

test.describe('Standalone / Copilot transcript observation', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('Settings reports a refused Copilot hook install and clears the error after retry @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const hookFile = path.join(standalone.tmpHome, '.copilot', 'hooks', 'pixel-agents.json');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    const foreignConfig = JSON.stringify({ version: 1, hooks: {} });
    fs.writeFileSync(hookFile, foreignConfig);
    const settings = await openSettingsModal(page);
    const checkbox = settings.getByRole('button', {
      name: 'GitHub Copilot CLI — Instant Detection (Hooks)',
    });
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
    await settings.getByRole('button', { name: 'Install hooks', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText(
      'Refusing to modify unowned Copilot hooks',
    );
    await expect(checkbox.locator('span').last()).toBeEmpty();
    expect(fs.readFileSync(hookFile, 'utf8')).toBe(foreignConfig);

    // Remove only the foreign fixture we created, then retry through the same open Settings.
    fs.unlinkSync(hookFile);
    await checkbox.click();
    await settings.getByRole('button', { name: 'Install hooks', exact: true }).click();
    await expect(checkbox.locator('span').last()).toHaveText('x');
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(settings).toContainText(
      'Installed. Event delivery depends on the running session.',
    );
    expect(fs.existsSync(hookFile)).toBe(true);
  });

  test('compact labels reveal one readable hover inspector with keyboard and narrow-screen support @area:standalone', async ({
    page,
    copilot,
  }, testInfo) => {
    await page.setViewportSize({ width: 660, height: 520 });
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const title =
      'Investigate session discovery and provide clear progress for the GitHub Copilot application';
    const first = await copilot('hover-first', 'pixel-agents-hq/pixel-agents');
    await first.run(
      copilotScenario()
        .append('session.title_changed', { title })
        .toolStart('reading', 'view', { path: 'hover-first.ts' }),
    );
    await expectOverlayVisible(page, 'Reading hover-first.ts');
    const second = await copilot('hover-second', 'pixel-agents-hq/pixel-agents');
    await second.run(
      copilotScenario()
        .append('session.title_changed', { title: 'Review the second session' })
        .toolStart('reading', 'view', { path: 'hover-second.ts' }),
    );
    await expectOverlayCount(page, 2);

    const details = page.getByRole('region', { name: 'Agent details' });
    await expect(details).toHaveCount(0);
    await expect(getAgentOverlays(page)).not.toContainText(['GitHub Copilot CLI']);
    const projectName = 'pixel-agents';
    await expect(getAgentOverlays(page)).toHaveText([projectName, projectName]);
    const firstLabel = page.getByRole('button', {
      name: `Inspect ${projectName}: ${title}`,
      exact: true,
    });
    await firstLabel.hover();
    await expect(details).toHaveCount(1);
    await expect(details).toContainText(title);
    await expect(details).toContainText('Reading hover-first.ts');
    await expect(details).toContainText('GitHub Copilot CLI');
    await expect(details).toHaveCSS('background-color', 'rgb(30, 30, 46)');
    await details.hover();
    await page.waitForTimeout(600);
    await expect(details).toBeVisible();
    await testInfo.attach('hover-details-desktop', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);

    await page
      .getByRole('button', {
        name: `Inspect ${projectName}: Review the second session`,
        exact: true,
      })
      .hover();
    await expect(details).toHaveCount(1);
    await expect(details).toContainText('Reading hover-second.ts');
    await page.mouse.move(650, 510);
    await expect(details).toHaveCount(0);

    await firstLabel.focus();
    await expect(details).toBeVisible();
    await page.setViewportSize({ width: 360, height: 520 });
    await expect
      .poll(async () => {
        const box = await details.boundingBox();
        return (
          !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 360 && box.y + box.height <= 520
        );
      })
      .toBe(true);
    await testInfo.attach('hover-details-narrow', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await details.getByRole('button', { name: 'Hide agent details' }).click();
    await expect(details).toHaveCount(0);
    await expectOverlayCount(page, 2);
    await first.run(copilotScenario().toolComplete('reading').interactionDone('hover-first'));
    await expectOverlayVisible(page, 'Idle');
    await expect(getAgentOverlays(page)).toHaveText([projectName, projectName]);
    await page.reload();
    await expect(getAgentOverlays(page)).toHaveText([projectName, projectName]);
  });

  test('sub-agents inherit project labels while live activity remains in hover details @area:standalone', async ({
    page,
    copilot,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const mock = await copilot('project-child', 'example/Laughingman');
    await mock.run(
      copilotScenario()
        .toolStart('spawn', 'task', { description: 'Research project labels' })
        .subagentStart('child', {
          toolCallId: 'spawn',
          agentName: 'general-purpose',
          agentDisplayName: 'Research',
          agentType: 'general-purpose',
          executionMode: 'background',
        }),
    );
    await expectOverlayCount(page, 2);
    await mock.run(
      copilotScenario().append(
        'tool.execution_start',
        {
          toolCallId: 'child-read',
          toolName: 'view',
          arguments: { path: 'labels.ts' },
        },
        { agentId: 'child' },
      ),
    );
    await expect(getAgentOverlays(page)).toHaveText(['Laughingman', 'Laughingman']);
    await page.locator('[data-agent-id="-1"] .agent-label-inspect').focus();
    const details = page.getByRole('region', { name: 'Agent details' });
    await expect(details).toContainText('Laughingman');
    await expect(details).toContainText('Reading labels.ts');
    await expect(details).toContainText('Sub-agent');
    await expect(getAgentOverlays(page)).toHaveText(['Laughingman', 'Laughingman']);
  });

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
