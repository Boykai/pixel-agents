import type { Frame, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

type MoodSurface = Frame | Page;

/** One request to show a Mood bubble, as the `moodLog` e2e hook recorded it. */
export interface MoodLogEntry {
  id: number;
  mood: 'happy' | 'error' | 'stressed';
  at: number;
  /** False when the office suppressed it: Mood bubbles off, or the character hidden. */
  shown: boolean;
  isSubagent: boolean;
}

interface MoodHooksWindow extends Window {
  __pixelAgentsTestHooks?: {
    moodLog?: MoodLogEntry[];
    getMoodBubbles?: () => boolean;
    messageLog?: Array<{ type: string; id?: number; toolId?: string; isError?: boolean }>;
  };
}

/** Every Mood the office was asked to show since the page loaded. A Mood bubble
 *  lives a few seconds, so specs assert on this history rather than a snapshot. */
export async function readMoodLog(surface: MoodSurface): Promise<MoodLogEntry[]> {
  return surface.evaluate(() => (window as MoodHooksWindow).__pixelAgentsTestHooks?.moodLog ?? []);
}

/** The Mood bubbles setting the office is actually applying. */
export async function readMoodBubblesApplied(surface: MoodSurface): Promise<boolean | null> {
  return surface.evaluate(
    () => (window as MoodHooksWindow).__pixelAgentsTestHooks?.getMoodBubbles?.() ?? null,
  );
}

/** How many tool completions carrying the tool-failure signal reached the webview. */
export async function countFailedToolDones(surface: MoodSurface): Promise<number> {
  return surface.evaluate(
    () =>
      ((window as MoodHooksWindow).__pixelAgentsTestHooks?.messageLog ?? []).filter(
        (m) => (m.type === 'agentToolDone' || m.type === 'subagentToolDone') && m.isError === true,
      ).length,
  );
}

/** The Mood bubbles setting persisted for one adapter namespace in config.json. */
export function readStoredMoodBubbles(
  tmpHome: string,
  namespace: 'vscode' | 'standalone',
): unknown {
  const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    return config[namespace]?.moodBubbles;
  } catch {
    return undefined;
  }
}
