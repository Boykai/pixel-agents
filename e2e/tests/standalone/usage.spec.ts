import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/copilot';
import type { StandaloneContext } from '../../fixtures/standalone';
import {
  applyMockHomeEnv,
  arrangeNextClaudeInvocation,
  claudeScenario,
  type ClaudeMockScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { copilotScenario } from '../../helpers/mock-copilot';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

async function openUsagePanel(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  const panel = page.getByTestId('usage-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** A Claude session outside any terminal: the mock runner writes its own
 *  transcript and runs the installed hook script, as the real CLI does. */
async function startClaude(
  standalone: StandaloneContext,
  sessionId: string,
  scenario: ClaudeMockScenario,
): Promise<{ logs(): string; stop(): Promise<void> }> {
  await arrangeNextClaudeInvocation(standalone.tmpHome, scenario);
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, '..', '..', 'fixtures', 'mock-claude-runner.cjs'),
      '--session-id',
      sessionId,
    ],
    {
      cwd: standalone.workspaceDir,
      env: applyMockHomeEnv(process.env, standalone.tmpHome),
      stdio: 'pipe',
    },
  );
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });
  return {
    logs: () => logs,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    },
  };
}

/** One content block of a Claude reply. Claude Code writes a record per block,
 *  and every record repeats the whole message's usage. */
function claudeReply(
  messageId: string,
  block: Record<string, unknown>,
  usage: Record<string, number>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: messageId,
      model: CLAUDE_MODEL,
      role: 'assistant',
      content: [block],
      usage,
    },
  };
}

test.describe('Standalone / Token usage', () => {
  test.use({ seedHooksEnabled: true });

  test('the Usage panel totals Claude tokens, counting each message once @area:standalone', async ({
    page,
    standalone,
  }, testInfo) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    await waitForClaudeHookSetup(standalone.tmpHome);
    const panel = await openUsagePanel(page);
    await expect(panel).toContainText('No usage data');

    const sessionId = '5a7c3e21-9b4d-4f6a-8c2e-1d3f5a7b9c0e';
    const filePath = path.join(standalone.workspaceDir, 'usage.ts');
    const hook = {
      session_id: sessionId,
      cwd: standalone.workspaceDir,
      transcript_path: '{{transcriptPath}}',
    };
    // 3 + 100 + 500 + 20 = 623 tokens, written twice (text + tool_use block).
    const firstUsage = {
      input_tokens: 3,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 500,
      output_tokens: 20,
    };
    // 5 + 0 + 200 + 30 = 235 tokens.
    const secondUsage = {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
      output_tokens: 30,
    };
    const read = {
      tool_use_id: 'toolu_usage',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    };
    const claude = await startClaude(
      standalone,
      sessionId,
      claudeScenario('token-usage')
        .at(0)
        .emitHook({ ...hook, hook_event_name: 'SessionStart', source: 'startup' })
        .at(0)
        .appendJsonl(claudeReply('msg_usage_1', { type: 'text', text: 'Reading.' }, firstUsage))
        .at(0)
        .appendJsonl(
          claudeReply(
            'msg_usage_1',
            { type: 'tool_use', id: read.tool_use_id, name: 'Read', input: read.tool_input },
            firstUsage,
          ),
        )
        .at(0)
        .emitHook({ ...hook, ...read, hook_event_name: 'PreToolUse' })
        .at(1_000)
        .appendJsonl({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: read.tool_use_id, content: 'ok' }],
          },
        })
        .at(1_000)
        .emitHook({ ...hook, ...read, hook_event_name: 'PostToolUse' })
        .at(1_000)
        .appendJsonl(claudeReply('msg_usage_2', { type: 'text', text: 'Done.' }, secondUsage))
        .at(1_000)
        .emitHook({ ...hook, hook_event_name: 'Stop' })
        .holdOpenFor(60_000)
        .build(),
    );
    try {
      await expectOverlayCount(page, 1);
      // 623 + 235. Counting every record would show 1.5K.
      const totals = panel.getByTestId('usage-totals');
      await expect(totals.getByTestId('usage-total-tokens')).toHaveText('858');
      const row = panel.getByTestId('usage-agent-row');
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('usage-model')).toHaveText('sonnet-4-5');
      await expect(row.getByTestId('usage-agent-tokens')).toHaveText('858');
      await expect(panel.getByTestId('usage-premium-requests')).toHaveCount(0);
      await expect(panel).not.toContainText('since tracked');
      await testInfo.attach('usage-panel-claude', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

      // A reloaded page gets the totals from the handshake, not from new records.
      await page.reload();
      await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({
        timeout: 30_000,
      });
      const reopened = await openUsagePanel(page);
      await expect(
        reopened.getByTestId('usage-totals').getByTestId('usage-total-tokens'),
      ).toHaveText('858');
    } catch (error) {
      throw new Error(`${String(error)}\nmock-claude:\n${claude.logs()}`);
    } finally {
      await claude.stop();
    }
  });
});

test.describe('Standalone / Token usage (Copilot)', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('the Usage panel shows Copilot premium requests, and tokens only once a run reports them @area:standalone', async ({
    page,
    copilot,
  }, testInfo) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: false });
    const panel = await openUsagePanel(page);
    await expect(panel).toContainText('No usage data');

    const mock = await copilot('copilot-usage');
    await mock.run(
      copilotScenario()
        .append('session.model_change', { previousModel: 'claude-sonnet-4.5', newModel: 'gpt-5' })
        .toolStart('read-usage', 'view', { path: 'usage.ts' }),
    );
    await expectOverlayVisible(page, 'Reading usage.ts');
    await mock.run(
      copilotScenario()
        .toolComplete('read-usage')
        .append('assistant.message', { content: 'Done.', model: 'gpt-5' })
        .append('session.usage_checkpoint', { totalPremiumRequests: 1, totalNanoAiu: 25_000 }),
    );
    const totals = panel.getByTestId('usage-totals');
    const row = panel.getByTestId('usage-agent-row');
    await expect(totals.getByTestId('usage-premium-requests')).toHaveText('1');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('usage-model')).toHaveText('gpt-5');
    // Checkpoints carry no token counts, and none are made up.
    await expect(panel.getByTestId('usage-total-tokens')).toHaveCount(0);

    // Checkpoints are cumulative: the newest replaces the last (not 3.5).
    await mock.run(
      copilotScenario().append('session.usage_checkpoint', {
        totalPremiumRequests: 2.5,
        totalNanoAiu: 60_000,
      }),
    );
    await expect(totals.getByTestId('usage-premium-requests')).toHaveText('2.5');
    await expect(totals).toContainText('60.0K');

    // A shutdown states the session's tokens: 1,200 + 300 + 700 + 5,000.
    await mock.run(
      copilotScenario().append('session.shutdown', {
        totalPremiumRequests: 2.5,
        totalNanoAiu: 60_000,
        currentModel: 'gpt-5',
        tokenDetails: {
          input: { tokenCount: 1_200 },
          output: { tokenCount: 300 },
          cache_write: { tokenCount: 700 },
          cache_read: { tokenCount: 5_000 },
        },
      }),
    );
    await expect(totals.getByTestId('usage-total-tokens')).toHaveText('7.2K');
    await expect(totals.getByTestId('usage-premium-requests')).toHaveText('2.5');
    await testInfo.attach('usage-panel-copilot', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
