import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { getOverlayByAgentId } from './office';

/** Nickname + Costume helpers. They work against a VS Code webview frame and a
 *  standalone page alike, and drive the same controls a user would: the
 *  character's details (opened from its label) and the Costume panel. */
type Surface = Frame | Page;

const NICKNAME_TIMEOUT_MS = 15_000;

interface LookHooksWindow extends Window {
  __pixelAgentsTestHooks?: {
    getCharacters?: () => Array<{ id: number; palette: number; hueShift: number }>;
  };
}

/** Open an agent's details from its label, the way keyboard users do. */
export async function openAgentDetails(surface: Surface, agentId: number): Promise<Locator> {
  const label = getOverlayByAgentId(surface, agentId).locator('.agent-label-inspect');
  await expect(label).toBeVisible({ timeout: NICKNAME_TIMEOUT_MS });
  await label.focus();
  const details = surface.getByRole('region', { name: 'Agent details' });
  await expect(details).toHaveAttribute('data-agent-id', String(agentId));
  return details;
}

/** Rename an agent through its details' Rename button; '' clears the nickname. */
export async function renameAgent(
  surface: Surface,
  agentId: number,
  nickname: string,
): Promise<void> {
  const details = await openAgentDetails(surface, agentId);
  await details.getByRole('button', { name: 'Rename', exact: true }).click();
  const input = details.getByRole('textbox', { name: 'Nickname' });
  await input.fill(nickname);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

/** Open the Costume panel for an agent from its details. */
export async function openCostumePanel(surface: Surface, agentId: number): Promise<Locator> {
  const details = await openAgentDetails(surface, agentId);
  await details.getByRole('button', { name: 'Costume', exact: true }).click();
  const panel = surface.getByRole('region', { name: 'Costume', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

/** A character's worn costume, read through the e2e hooks (canvas-only state). */
export async function readCharacterLook(
  surface: Surface,
  agentId: number,
): Promise<{ palette: number; hueShift: number } | null> {
  return surface.evaluate((id) => {
    const characters = (window as LookHooksWindow).__pixelAgentsTestHooks?.getCharacters?.() ?? [];
    const ch = characters.find((entry) => entry.id === id);
    return ch ? { palette: ch.palette, hueShift: ch.hueShift } : null;
  }, agentId);
}
