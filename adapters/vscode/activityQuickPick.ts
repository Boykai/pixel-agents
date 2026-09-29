import * as vscode from 'vscode';

import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import type {
  ActivityProviderInfo,
  ActivityQuickPickRow,
  ActivityTracker,
} from './activityQuickPickRows.js';
import {
  activityQuickPickItem,
  activityQuickPickNotice,
  buildActivityQuickPickRows,
} from './activityQuickPickRows.js';
import {
  ACTIVITY_QUICK_PICK_EMPTY,
  ACTIVITY_QUICK_PICK_OPEN_OFFICE,
  ACTIVITY_QUICK_PICK_OPEN_OFFICE_DETAIL,
  ACTIVITY_QUICK_PICK_PLACEHOLDER,
  ACTIVITY_QUICK_PICK_REFRESH_MS,
  ACTIVITY_QUICK_PICK_TITLE,
} from './constants.js';

/** What the Activity Quick Pick reads and drives (PixelAgentsViewProvider). */
export interface ActivitySource {
  readonly store: AgentStateStore;
  /** Fed every store broadcast from activation on, before any Quick Pick listens. */
  readonly activityTracker: ActivityTracker;
  readonly activityProviders: readonly ActivityProviderInfo[];
  /** Agent restore and session discovery have run (they start with the office's first load). */
  readonly discoveryStarted: boolean;
  /** Focus the Agent's terminal, or select its Character when it has none. */
  showAgent(agentId: number): void;
  /** Open the Pixel Agents panel. */
  openOffice(): void;
}

interface ActivityPickItem extends vscode.QuickPickItem {
  readonly row?: ActivityQuickPickRow;
  readonly opensOffice?: boolean;
}

const REFRESH_EVENTS = ['agentAdded', 'agentRemoved', 'agentUpdated', 'broadcast'] as const;

/**
 * Open the live Activity list. While open it rebuilds from the store after every
 * store event, keeping the highlighted row. Accepting a row shows that Agent.
 */
export function showActivityQuickPick(source: ActivitySource): void {
  const quickPick = vscode.window.createQuickPick<ActivityPickItem>();
  quickPick.title = ACTIVITY_QUICK_PICK_TITLE;
  quickPick.placeholder = ACTIVITY_QUICK_PICK_PLACEHOLDER;
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.keepScrollPosition = true;

  let shown: string | undefined;
  const refresh = (): void => {
    const rows = buildActivityQuickPickRows(
      source.store,
      source.activityTracker,
      source.activityProviders,
    );
    const notice = activityQuickPickNotice(rows.length, source.discoveryStarted);
    // Most broadcasts (context and token usage among them) change no row; leave the list be.
    const signature = JSON.stringify({ rows, notice });
    if (signature === shown) return;
    shown = signature;
    const activeKey = quickPick.activeItems[0]?.row?.key;
    const items: ActivityPickItem[] = rows.map((row) => ({ ...activityQuickPickItem(row), row }));
    if (notice === 'openOffice') {
      items.push({
        label: ACTIVITY_QUICK_PICK_OPEN_OFFICE,
        detail: ACTIVITY_QUICK_PICK_OPEN_OFFICE_DETAIL,
        opensOffice: true,
      });
    } else if (notice === 'empty') {
      items.push({ label: ACTIVITY_QUICK_PICK_EMPTY });
    }
    quickPick.items = items;
    const active = items.find((item) => item.row !== undefined && item.row.key === activeKey);
    if (active) quickPick.activeItems = [active];
  };

  let pending: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    pending ??= setTimeout(() => {
      pending = undefined;
      refresh();
    }, ACTIVITY_QUICK_PICK_REFRESH_MS);
  };
  for (const event of REFRESH_EVENTS) source.store.on(event, scheduleRefresh);

  quickPick.onDidAccept(() => {
    const item = quickPick.selectedItems[0];
    quickPick.hide();
    if (item?.row) source.showAgent(item.row.agentId);
    else if (item?.opensOffice) source.openOffice();
  });
  quickPick.onDidHide(() => {
    for (const event of REFRESH_EVENTS) source.store.off(event, scheduleRefresh);
    if (pending !== undefined) clearTimeout(pending);
    quickPick.dispose();
  });
  refresh();
  quickPick.show();
}
