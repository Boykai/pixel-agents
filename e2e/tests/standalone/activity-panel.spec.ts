import { spawn } from 'node:child_process';
import path from 'node:path';

import { expect, test } from '../../fixtures/copilot';
import {
  expectActivityRows,
  getActivityPanel,
  getActivityRows,
  getActivityToggle,
  openActivityPanel,
} from '../../helpers/activity';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { copilotScenario } from '../../helpers/mock-copilot';
import { buildAssistantToolUseRecord } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

test.describe('Standalone / Activity panel', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('lists Copilot agents with nested sub-agents and live activity, and selects on click @area:standalone', async ({
    page,
    copilot,
  }, testInfo) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const panel = await openActivityPanel(page);
    await expect(panel).toContainText('No active agents');

    const lead = await copilot('activity-lead', 'example/Laughingman');
    await lead.run(
      copilotScenario()
        .append('session.title_changed', { title: 'Port the activity panel' })
        .toolStart('read-1', 'view', { path: 'panel.ts' }),
    );
    await expectActivityRows(page, [
      { kind: 'agent', label: 'Port the activity panel', activity: 'Reading panel.ts' },
    ]);

    // A background spawn is a Sub-agent: it nests under its Agent with its own activity.
    await lead.run(
      copilotScenario()
        .toolComplete('read-1')
        .toolStart('spawn', 'task', { description: 'Research project labels' })
        .subagentStart('child', {
          toolCallId: 'spawn',
          agentName: 'general-purpose',
          agentDisplayName: 'Research',
          agentType: 'general-purpose',
          executionMode: 'background',
        })
        .append(
          'tool.execution_start',
          { toolCallId: 'child-read', toolName: 'view', arguments: { path: 'labels.ts' } },
          { agentId: 'child' },
        ),
    );
    await expectActivityRows(page, [
      {
        kind: 'agent',
        label: 'Port the activity panel',
        activity: 'Subtask: Research project labels',
      },
      { kind: 'subagent', label: 'Research project labels', activity: 'Reading labels.ts' },
    ]);

    // Between tools a running Sub-agent is thinking, not idle.
    await lead.run(
      copilotScenario().append(
        'tool.execution_complete',
        { toolCallId: 'child-read', success: true },
        { agentId: 'child' },
      ),
    );
    await expectActivityRows(page, [
      {
        kind: 'agent',
        label: 'Port the activity panel',
        activity: 'Subtask: Research project labels',
      },
      { kind: 'subagent', label: 'Research project labels', activity: 'Thinking…' },
    ]);

    // A session that opens on a question isn't discovered, so it reads a file first.
    const asker = await copilot('activity-question');
    await asker.run(
      copilotScenario()
        .append('session.title_changed', { title: 'Pick a fixture' })
        .toolStart('look', 'view', { path: 'fixtures.ts' }),
    );
    await expectActivityRows(page, [
      {
        kind: 'agent',
        label: 'Port the activity panel',
        activity: 'Subtask: Research project labels',
      },
      { kind: 'subagent', label: 'Research project labels', activity: 'Thinking…' },
      { kind: 'agent', label: 'Pick a fixture', activity: 'Reading fixtures.ts' },
    ]);
    await asker.run(
      copilotScenario()
        .toolComplete('look')
        .toolStart('question', 'ask_user', { question: 'Which fixture should run?' }),
    );
    await expectActivityRows(page, [
      {
        kind: 'agent',
        label: 'Port the activity panel',
        activity: 'Subtask: Research project labels',
      },
      { kind: 'subagent', label: 'Research project labels', activity: 'Thinking…' },
      { kind: 'agent', label: 'Pick a fixture', activity: 'Waiting for input' },
    ]);
    await testInfo.attach('activity-panel', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // Clicking a row selects its Character, as clicking the Character does.
    const subRow = getActivityRows(page).and(page.locator('[data-kind="subagent"]'));
    await subRow.click();
    await expect(subRow).toHaveAttribute('aria-current', 'true');
    const details = page.getByRole('region', { name: 'Agent details' });
    await expect(details).toHaveAttribute('data-agent-id', '-1');
    await expect(details).toContainText('Sub-agent');

    await panel.getByRole('button', { name: 'Close activity' }).click();
    await expect(getActivityPanel(page)).toHaveCount(0);
    await expect(getActivityToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Standalone / Activity panel with mixed providers', () => {
  test.use({ provider: 'claude,copilot', seedHooksEnabled: true });

  test('lists Claude and Copilot agents side by side with a Claude sub-agent @area:standalone', async ({
    page,
    standalone,
    copilot,
  }) => {
    const sessionId = '8f7e6d5c-4b3a-4291-8a7b-6c5d4e3f2a1b';
    const readPath = path.join(standalone.workspaceDir, 'claude-only.ts');
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('activity panel mixed providers')
        .at(0)
        .emitHook({
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          cwd: standalone.workspaceDir,
          transcript_path: '{{transcriptPath}}',
          source: 'startup',
        })
        .at(0)
        .emitHook({
          hook_event_name: 'PreToolUse',
          session_id: sessionId,
          cwd: standalone.workspaceDir,
          transcript_path: '{{transcriptPath}}',
          tool_use_id: 'toolu-activity-read',
          tool_name: 'Read',
          tool_input: { file_path: readPath },
        })
        // Task spawns reach the office through the transcript, which a
        // hook-adopted session is watched from its end at adoption.
        .at(3_000)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-activity-survey', 'Task', {
            description: 'Survey the office',
          }),
        )
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
      await openActivityPanel(page);
      await expectActivityRows(page, [
        { kind: 'agent', label: expect.any(String), activity: 'Subtask: Survey the office' },
        { kind: 'subagent', label: 'Survey the office', activity: 'Thinking…' },
      ]);

      const mock = await copilot('activity-mixed-copilot');
      await mock.run(
        copilotScenario()
          .append('session.title_changed', { title: 'Review Copilot rows' })
          .toolStart('read-1', 'view', { path: 'copilot-only.ts' }),
      );
      await expectActivityRows(page, [
        { kind: 'agent', label: expect.any(String), activity: 'Subtask: Survey the office' },
        { kind: 'subagent', label: 'Survey the office', activity: 'Thinking…' },
        { kind: 'agent', label: 'Review Copilot rows', activity: 'Reading copilot-only.ts' },
      ]);
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
