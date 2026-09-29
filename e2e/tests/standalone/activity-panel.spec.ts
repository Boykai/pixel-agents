import type { Page } from '@playwright/test';
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
import { enterEditMode } from '../../helpers/editor';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { copilotScenario } from '../../helpers/mock-copilot';
import { openAgentDetails, renameAgent } from '../../helpers/nicknames';
import { buildAssistantToolUseRecord } from '../../helpers/team';
import { openSettingsModal, setSettings } from '../../helpers/webview';

const NARROW_VIEWPORT = { width: 360, height: 640 };

type Box = { x: number; y: number; width: number; height: number };

function expectInsideNarrowViewport(box: Box | null): asserts box is Box {
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW_VIEWPORT.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(NARROW_VIEWPORT.height);
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The toolbar buttons the "Updated to vX" notice covers, by label. */
async function toolbarButtonsUnderNotice(page: Page): Promise<string[]> {
  const noticeBox = await page.getByTestId('whats-new-notice').boundingBox();
  if (!noticeBox) return ['(no notice)'];
  const covered: string[] = [];
  for (const button of await page.getByTestId('bottom-toolbar').getByRole('button').all()) {
    const box = await button.boundingBox();
    if (!box || overlaps(noticeBox, box)) covered.push((await button.textContent()) ?? '');
  }
  return covered;
}

/** scrollLeft/scrollTop of every box that could scroll the office sideways. */
function readScrollOffsets(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const appRoot = document.querySelector('[data-testid="bottom-toolbar"]')?.parentElement;
    return [
      document.scrollingElement,
      document.body,
      document.getElementById('root'),
      appRoot,
    ].flatMap((el) => (el ? [el.scrollLeft, el.scrollTop] : [Number.NaN, Number.NaN]));
  });
}

test.describe('Standalone / Activity panel', () => {
  test.use({ provider: 'copilot', seedHooksEnabled: false });

  test('lists Copilot agents with nested sub-agents and live activity, selects on click, and names rows by nickname @area:standalone', async ({
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

    // Layout mode takes the panel's corner: the panel steps aside, its toggle
    // can't be flipped unseen, and the panel returns when editing ends.
    const activityToggle = getActivityToggle(page);
    await enterEditMode(page.mainFrame());
    await expect(getActivityPanel(page)).toHaveCount(0);
    await expect(activityToggle).toBeDisabled();
    await expect(activityToggle).toHaveAttribute('aria-pressed', 'false');
    await page.locator('button[title="Edit office layout"]').click();
    await expect(getActivityPanel(page)).toBeVisible();
    await expect(activityToggle).toBeEnabled();
    await expect(activityToggle).toHaveAttribute('aria-pressed', 'true');

    // A row goes by the Agent's Nickname, as its Character does; clearing the
    // Nickname brings the session title back.
    const leadId = Number(await getActivityRows(page).first().getAttribute('data-agent-id'));
    await renameAgent(page, leadId, 'Scout');
    await expectActivityRows(page, [
      { kind: 'agent', label: 'Scout', activity: 'Subtask: Research project labels' },
      { kind: 'subagent', label: 'Research project labels', activity: 'Thinking…' },
      { kind: 'agent', label: 'Pick a fixture', activity: 'Waiting for input' },
    ]);
    // So do the Sub-agent's details, in their Parent fact.
    await subRow.click();
    const subDetails = await openAgentDetails(page, -1);
    await expect(
      subDetails.locator('dt', { hasText: 'Parent' }).locator('xpath=following-sibling::dd[1]'),
    ).toHaveText('Scout');
    await renameAgent(page, leadId, '');
    await expectActivityRows(page, [
      {
        kind: 'agent',
        label: 'Port the activity panel',
        activity: 'Subtask: Research project labels',
      },
      { kind: 'subagent', label: 'Research project labels', activity: 'Thinking…' },
      { kind: 'agent', label: 'Pick a fixture', activity: 'Waiting for input' },
    ]);

    await panel.getByRole('button', { name: 'Close activity' }).click();
    await expect(getActivityPanel(page)).toHaveCount(0);
    await expect(getActivityToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps the toolbar and panel inside a narrow window after Settings @area:standalone', async ({
    page,
    copilot,
  }, testInfo) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    const agent = await copilot('activity-narrow');
    await agent.run(
      copilotScenario()
        .append('session.title_changed', { title: 'Fit a narrow window' })
        .toolStart('read-1', 'view', { path: 'narrow.ts' }),
    );
    const panel = await openActivityPanel(page);
    await expectActivityRows(page, [
      { kind: 'agent', label: 'Fit a narrow window', activity: 'Reading narrow.ts' },
    ]);

    // The toolbar's buttons don't fit on one row here. An overflowing toolbar
    // let clicking Settings scroll the whole office sideways; it wraps instead.
    const modal = await openSettingsModal(page);
    await modal.getByRole('button', { name: 'x', exact: true }).click();
    await expect(modal).toBeHidden();
    expect(await readScrollOffsets(page)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const toolbar = page.getByTestId('bottom-toolbar');
    const buttons = await toolbar.getByRole('button').all();
    // Layout, Activity, Usage and Settings at least.
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of buttons) {
      await button.focus();
      expectInsideNarrowViewport(await button.boundingBox());
    }
    expect(await readScrollOffsets(page)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    // The panel stacks above the wrapped toolbar, which stays clear of the
    // version label in the other corner.
    const toolbarBox = await toolbar.boundingBox();
    expectInsideNarrowViewport(toolbarBox);
    const panelBox = await panel.boundingBox();
    expectInsideNarrowViewport(panelBox);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(toolbarBox.y);
    const versionLabelBox = await page.getByText(/^v\d+\.\d+$/).boundingBox();
    expectInsideNarrowViewport(versionLabelBox);
    expect(overlaps(toolbarBox, versionLabelBox)).toBe(false);
    await testInfo.attach('activity-panel-narrow', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });

  test('keeps the version notice clear of the toolbar buttons as the window narrows @area:standalone', async ({
    page,
    standalone,
  }, testInfo) => {
    await standalone.drainMessages();
    // A fresh HOME has never seen this version, so the notice shows for its
    // first 20 s. It rests 42px up in the bottom-right corner, and has to
    // stack above the toolbar wherever a narrower window brings the two
    // together: a single-row toolbar at mid widths as well as a wrapped one.
    const notice = page.getByTestId('whats-new-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Updated to v');
    const toolbarButtons = page.getByTestId('bottom-toolbar').getByRole('button');
    // Layout, Activity, Usage and Settings at least.
    expect(await toolbarButtons.count()).toBeGreaterThanOrEqual(4);

    const { height } = page.viewportSize()!;
    await expect
      .poll(async () => {
        const box = await notice.boundingBox();
        return box && Math.round(height - (box.y + box.height));
      })
      .toBe(42);
    expect(await toolbarButtonsUnderNotice(page)).toEqual([]);

    for (const width of [720, 600, 480, NARROW_VIEWPORT.width]) {
      await page.setViewportSize({ width, height: NARROW_VIEWPORT.height });
      await expect
        .poll(() => toolbarButtonsUnderNotice(page), { message: `notice at ${width}px wide` })
        .toEqual([]);
    }
    expectInsideNarrowViewport(await notice.boundingBox());
    await testInfo.attach('version-notice-narrow', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
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
