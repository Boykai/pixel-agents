import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** The Activity panel reads the same in a VS Code webview (Frame) and a standalone page (Page). */
type ActivitySurface = Frame | Page;

const ACTIVITY_TIMEOUT_MS = 15_000;

/** One Activity panel row as the user reads it. */
interface ActivityRowSnapshot {
  kind: string;
  label: string;
  activity: string;
}

/** An expected row. `label` may be an asymmetric matcher such as expect.any(String). */
type ExpectedActivityRow = Omit<ActivityRowSnapshot, 'label'> & { label: unknown };

export function getActivityToggle(surface: ActivitySurface): Locator {
  return surface.getByRole('button', { name: 'Activity', exact: true });
}

export function getActivityPanel(surface: ActivitySurface): Locator {
  return surface.getByRole('region', { name: 'Activity', exact: true });
}

export function getActivityRows(surface: ActivitySurface): Locator {
  return getActivityPanel(surface).locator('[data-testid="activity-row"]');
}

/** Open the Activity panel from the bottom toolbar. */
export async function openActivityPanel(surface: ActivitySurface): Promise<Locator> {
  const toggle = getActivityToggle(surface);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = getActivityPanel(surface);
  await expect(panel).toBeVisible();
  return panel;
}

/** Every row in panel order. A row's title is "<label>: <activity>". */
function readActivityRows(surface: ActivitySurface): Promise<ActivityRowSnapshot[]> {
  return getActivityRows(surface).evaluateAll((rows) =>
    rows.map((row) => {
      const activity = row.getAttribute('data-activity') ?? '';
      const title = row.getAttribute('title') ?? '';
      const suffix = `: ${activity}`;
      return {
        kind: row.getAttribute('data-kind') ?? '',
        label: title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
        activity,
      };
    }),
  );
}

/** Wait until the panel lists exactly these rows, in this order. */
export async function expectActivityRows(
  surface: ActivitySurface,
  expected: ExpectedActivityRow[],
  timeout = ACTIVITY_TIMEOUT_MS,
): Promise<void> {
  await expect
    .poll(() => readActivityRows(surface), {
      message: 'Expected the Activity panel rows',
      timeout,
    })
    .toEqual(expected);
}
