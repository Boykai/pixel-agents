import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// agentManager.ts imports `vscode`, which only exists inside the extension host.
vi.mock('vscode', () => ({ window: {}, workspace: { workspaceFolders: [] } }));

import { sendLayout } from '../../adapters/vscode/agentManager.js';
import { AchievementTracker } from '../src/achievements.js';
import type { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { writeLayoutToFile } from '../src/layoutPersistence.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';

/**
 * Interior Decorator counts furniture the user places. Both surfaces share
 * ~/.pixel-agents/layout.json, so a Sign or a generated room saved by one
 * surface reaches the other only when its page reloads. Its handshake must
 * treat that furniture as already placed, or the page's next save hands the
 * other surface's work to this one's progress.
 */

type Furniture = Record<string, unknown> & { uid: string };

/** A Sign: furniture of type PIXEL_TEXT carrying its text. */
const sign = (uid: string): Furniture => ({
  uid,
  type: 'PIXEL_TEXT',
  col: 1,
  row: 1,
  zLayer: 1,
  text: { value: 'SHIP IT', size: '5x7', scale: 1 },
});

/** A generated room: roomGeneration.ts mints one crypto.randomUUID() per piece. */
const generatedRoom = (): Furniture[] =>
  Array.from({ length: 24 }, (_, i) => ({
    uid: randomUUID(),
    type: i % 2 === 0 ? 'DESK' : 'CHAIR',
    col: i % 6,
    row: 3 + Math.floor(i / 6),
  }));

const office = (furniture: Furniture[]) => ({
  version: 1,
  cols: 12,
  rows: 12,
  tiles: [],
  furniture,
});

let tempHome: string;
let store: AgentStateStore;
let tracker: AchievementTracker | undefined;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-decorator-handshake-'));
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
  vi.stubEnv('HOME', tempHome);
  vi.stubEnv('USERPROFILE', tempHome);
  vi.stubEnv('COPILOT_HOME', path.join(tempHome, '.copilot'));
  store = new AgentStateStore();
});

afterEach(() => {
  tracker?.dispose();
  tracker = undefined;
  store.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** The other surface's process writes the shared layout: no listener here sees it. */
function saveFromOtherSurface(layout: object): void {
  const layoutFile = path.join(tempHome, '.pixel-agents', 'layout.json');
  fs.mkdirSync(path.dirname(layoutFile), { recursive: true });
  fs.writeFileSync(layoutFile, JSON.stringify(layout));
}

interface Surface {
  namespace: 'vscode' | 'standalone';
  /** This surface's page (re)loads; returns the layout it was sent. `seed`
   *  false replays the handshake as it was before it seeded the tracker. */
  handshake(seed: boolean): unknown;
  /** The page saves the user's own edit back. */
  save(layout: object): void;
}

const vscodeSurface: Surface = {
  namespace: 'vscode',
  handshake(seed) {
    const webview = { postMessage: vi.fn() };
    // PixelAgentsViewProvider.seedSentLayout is exactly this callback.
    sendLayout(
      webview as unknown as Parameters<typeof sendLayout>[0],
      null,
      seed ? (layout) => tracker?.seedLayout(layout) : undefined,
    );
    return (webview.postMessage.mock.calls[0]?.[0] as { layout?: unknown } | undefined)?.layout;
  },
  // PixelAgentsViewProvider's saveLayout branch for a non-imported save.
  save: (layout) => writeLayoutToFile(layout as Record<string, unknown>, 'edit'),
};

function standaloneContext() {
  store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
  const runtime = {
    achievements: tracker,
    watchAllSessions: { current: false },
    getProviders: () => [claudeProvider],
    setHooksEnabled: () => {},
    restoreExternalAgents: () => {},
  } as unknown as AgentRuntime;
  return { store, cache: null, runtime };
}

const standaloneSurface: Surface = {
  namespace: 'standalone',
  handshake(seed) {
    // handleWebviewReady always seeds, so the unseeded control skips the handshake.
    if (!seed) return undefined;
    const sent: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), standaloneContext());
    return sent.find((m) => m.type === 'layoutLoaded')?.layout;
  },
  save(layout) {
    handleClientMessage({ type: 'saveLayout', layout }, () => {}, standaloneContext());
  },
};

describe.each([
  { surface: vscodeSurface, other: 'standalone' },
  { surface: standaloneSurface, other: 'VS Code' },
])(
  'Interior Decorator across surfaces: $surface.namespace shows what $other saved',
  ({ surface }) => {
    it.each([
      { seed: true, expected: { current: 1, unlocked: false } },
      // Control: the same save without the handshake's seed counts the other
      // surface's Sign and whole room (26 pieces; progress caps at the target),
      // so the case above proves the seed.
      { seed: false, expected: { current: 20, unlocked: true } },
    ])(
      'a Sign and a generated room add no progress after a reload (seed: $seed)',
      ({ seed, expected }) => {
        saveFromOtherSurface(office([sign('f-1-sign')]));
        tracker = new AchievementTracker(store, () => undefined, {
          namespace: surface.namespace,
          filePath: path.join(tempHome, 'achievements.json'),
        });

        const shared = office([sign('f-1-sign'), sign('f-2-sign'), ...generatedRoom()]);
        saveFromOtherSurface(shared);
        const sent = surface.handshake(seed);
        if (seed) expect(sent).toEqual(shared);

        // The user places one more Sign on this surface, and its page saves.
        surface.save({ ...shared, furniture: [...shared.furniture, sign('f-3-sign')] });

        expect(tracker.snapshot().find((p) => p.id === 'decorator')).toMatchObject(expected);
      },
    );
  },
);
