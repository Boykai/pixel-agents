import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZOOM_MAX, ZOOM_MIN } from '../../core/src/constants.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { getHooksEnabled, readConfig, setHooksEnabled } from '../src/configPersistence.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { copilotProvider } from '../src/providers/hook/copilot/copilot.js';
import type { AgentState } from '../src/types.js';

/** Let the setHooksEnabled dispatch's async chain (side effect →
 *  areHooksInstalled → persist → send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/**
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting $HOME to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.stubEnv('COPILOT_HOME', path.join(tempHome, '.copilot'));

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── setZoom ──────────────────────────────────────────────────

  describe('setZoom', () => {
    const settingsLoaded = () => {
      sent = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      return sent.find((m) => m.type === 'settingsLoaded') as { zoom?: unknown } | undefined;
    };

    it('persists an integer zoom to the standalone namespace only', () => {
      handleClientMessage({ type: 'setZoom', zoom: 4 }, (m) => sent.push(m), ctx);

      const cfg = readConfig();
      expect(cfg.standalone.zoom).toBe(4);
      expect(cfg.vscode.zoom).toBeUndefined();
      // Persisting is silent: no reply to the sender.
      expect(sent).toHaveLength(0);
    });

    it('clamps an out-of-range integer to the shared bounds', () => {
      handleClientMessage({ type: 'setZoom', zoom: 999 }, (m) => sent.push(m), ctx);
      expect(readConfig().standalone.zoom).toBe(ZOOM_MAX);

      handleClientMessage({ type: 'setZoom', zoom: 0 }, (m) => sent.push(m), ctx);
      expect(readConfig().standalone.zoom).toBe(ZOOM_MIN);
    });

    it('ignores a non-integer or missing zoom and keeps the stored value', () => {
      handleClientMessage({ type: 'setZoom', zoom: 3 }, (m) => sent.push(m), ctx);
      for (const zoom of [2.5, '5', null, undefined, Number.NaN]) {
        handleClientMessage({ type: 'setZoom', zoom }, (m) => sent.push(m), ctx);
      }
      handleClientMessage({ type: 'setZoom' }, (m) => sent.push(m), ctx);

      expect(readConfig().standalone.zoom).toBe(3);
    });

    it('settingsLoaded omits zoom until one is stored, then carries it', () => {
      const before = settingsLoaded();
      expect(before).toBeDefined();
      expect(before && 'zoom' in before).toBe(false);

      handleClientMessage({ type: 'setZoom', zoom: 7 }, (m) => sent.push(m), ctx);

      expect(settingsLoaded()?.zoom).toBe(7);
    });
  });

  // ── setMoodBubbles ───────────────────────────────────────────

  describe('setMoodBubbles', () => {
    it('defaults to on in the settingsLoaded handshake', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const settings = sent.find((m) => m.type === 'settingsLoaded');
      expect(settings?.moodBubbles).toBe(true);
    });

    it('persists the toggle per namespace and reports it on the next handshake', () => {
      handleClientMessage({ type: 'setMoodBubbles', enabled: false }, (m) => sent.push(m), ctx);

      expect(readConfig().standalone.moodBubbles).toBe(false);
      expect(readConfig().vscode.moodBubbles).toBe(true);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      const settings = sent.find((m) => m.type === 'settingsLoaded');
      expect(settings?.moodBubbles).toBe(false);
    });

    // The webview's stressed rule skips tools that legitimately wait on the
    // user; it learns their names from the provider, never from a UI list.
    it("sends each provider's permission-exempt tools in providerCapabilities", () => {
      ctx.activeProviders = [claudeProvider, copilotProvider];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const caps = sent.filter((m) => m.type === 'providerCapabilities');
      const exempt = Object.fromEntries(caps.map((m) => [m.providerId, m.permissionExemptTools]));
      expect(exempt.claude).toEqual(expect.arrayContaining(['AskUserQuestion']));
      expect(exempt.copilot).toEqual(expect.arrayContaining(['ask_user']));
    });
  });

  // ── hooksStatus (actual install state, not the hooksEnabled setting) ──

  describe('hooksStatus', () => {
    it('webviewReady reports installed: false when no hooks are in settings.json', async () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      // The provider check is async; the message lands after the sync handshake.
      await new Promise((r) => setTimeout(r, 0));

      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
        canManage: false,
      });
    });

    it('setHooksEnabled reports the actual outcome after the side effect settles', async () => {
      let sideEffectRan = false;
      ctx.privileged = true;
      ctx.onSetHooksEnabled = async () => {
        sideEffectRan = true;
      };
      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(true);
      // The side effect installed nothing (stub), so the truthful answer is false
      // even though the user just toggled the setting ON.
      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
        error: 'Hooks could not be installed. Check the server log and retry.',
      });
    });
  });

  // ── setHooksEnabled: preference vs reality ───────────────────

  describe('setHooksEnabled persistence', () => {
    /** Put our command on every installed event, as a real install would. */
    function seedInstalledHooks(): void {
      const command = `node "${path.join(tempHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
      const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
      fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
        }),
      );
    }

    // THE stranding bug: the preference was written BEFORE the uninstall, so a
    // failed removal left the entries on disk and still firing while the
    // persisted hooks-off made the next startup skip the consent/install path
    // entirely — never asked again, no route left to remove them.
    it('does not persist hooks-off when the uninstall failed', async () => {
      seedInstalledHooks();
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: settings.json still carries our entries */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: false },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      // The preference still says ON, so the next startup re-runs the install
      // path and the user keeps a way to turn hooks off.
      expect(getHooksEnabled('claude')).toBe(true);
      // ...and the checkbox is told the truth: they are still installed.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
        error: 'Hooks could not be removed. Check the server log and retry.',
      });
    });

    // The mirror case: an install that did not happen must not persist ON.
    it('does not persist hooks-on when the install failed', async () => {
      setHooksEnabled('claude', false);
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays empty */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
    });

    // The happy path still persists, or the toggle would do nothing at all.
    it('persists the preference when the outcome matches the request', async () => {
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => seedInstalledHooks();

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // A non-local client (LAN peer, rebound page) never reaches the side effect
    // at all: granting consent to modify ~/.claude/settings.json is not a
    // decision a remote peer gets to make. See httpServerWs.test.ts.
    it('ignores the toggle entirely when the client is not privileged', async () => {
      let sideEffectRan = false;
      ctx.privileged = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(getHooksEnabled('claude')).toBe(true);
      // It still hears the truth, so a LAN viewer's checkbox shows reality
      // rather than appearing to have worked.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
        canManage: false,
      });
    });

    it('reports installer errors without changing preference and clears them after a successful retry', async () => {
      setHooksEnabled('claude', false);
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        throw new Error('Installation denied by filesystem permissions');
      };
      const toggle = () =>
        handleClientMessage(
          { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
          (m) => sent.push(m),
          ctx,
        );
      toggle();
      await settle();
      expect(getHooksEnabled('claude')).toBe(false);
      expect(sent.at(-1)).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
        canManage: true,
        error: 'Installation denied by filesystem permissions',
      });
      ctx.onSetHooksEnabled = () => seedInstalledHooks();
      toggle();
      await settle();
      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.at(-1)).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: true });
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('replays agent activity after layoutLoaded so it lands on real characters', () => {
      // Two things at once, both invisible to the helper's own unit tests:
      // that handleWebviewReady calls the replay at all, and that it runs AFTER
      // layoutLoaded. The characters the replay targets only exist once the
      // layout flush creates them, so an earlier replay is silently dropped and
      // a reconnecting client shows a working agent as Idle.
      store.set(1, createTestAgent({ id: 1, isWaiting: true }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iLayout = types.indexOf('layoutLoaded');
      const iStatus = types.indexOf('agentStatus');

      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iStatus).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeLessThan(iStatus);

      expect(sent[iStatus]).toMatchObject({ type: 'agentStatus', id: 1, status: 'waiting' });
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: saveAgentSeats palette sync', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-seats-'));
    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    ctx = freshCtx();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('syncs in-range palette/hueShift onto the matching AgentState', () => {
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2, palette: 0, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: {
          '1': { palette: 4, hueShift: 120, seatId: 'seat-a' },
          '2': { palette: 2, hueShift: 60, seatId: 'seat-b' },
        },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(4);
    expect(store.get(1)?.hueShift).toBe(120);
    expect(store.get(2)?.palette).toBe(2);
    expect(store.get(2)?.hueShift).toBe(60);
  });

  it('drops an out-of-range palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 1, hueShift: 10 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 99, hueShift: 50, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(1);
    // hueShift 50 is in range → still synced.
    expect(store.get(1)?.hueShift).toBe(50);
  });

  it('drops a negative hue shift and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 30 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2, hueShift: -5, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    // palette 2 is in range → synced.
    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.hueShift).toBe(30);
  });

  it('drops a non-integer palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 5, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2.5, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(5);
    expect(store.get(1)?.hueShift).toBe(90);
  });

  it('accepts the upper hue boundary (360) and lower palette boundary (0)', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 0, hueShift: 360, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(0);
    expect(store.get(1)?.hueShift).toBe(360);
  });

  it('silently skips seat entries for unknown agent ids', () => {
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '999': { palette: 3, hueShift: 100, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(999)).toBeUndefined();
  });

  it('accepts palette 7 when the cache has 8 character sprites', () => {
    // The guard reads ctx.cache?.characters?.characters.length instead
    // of hardcoding PALETTE_COUNT. With 8 sprites, palette 7 is valid.
    const cache: AssetCache = {
      characters: {
        characters: [
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
        ],
      },
      pets: null,
      floorTiles: null,
      wallTiles: null,
      carpetTiles: null,
      furniture: null,
      defaultLayout: null,
    };
    ctx = freshCtx(cache);
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 7, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(7);
    // palette 8 is still out of range for 8 sprites → dropped.
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 8, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );
    expect(store.get(1)?.palette).toBe(7);
  });

  it('rebroadcasts an appearance change to every client and persists it', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 0 }));
    broadcasts = [];

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 3, hueShift: 45, seatId: 'seat-a' } },
      },
      (m) => sent.push(m),
      ctx,
    );

    // Through the store, which reaches every connected client (the sender too),
    // never through the sender's own reply channel.
    expect(broadcasts).toEqual([{ type: 'agentAppearance', id: 1, palette: 3, hueShift: 45 }]);
    expect(sent).toEqual([]);
    const reloaded = new FileStateAdapter({ namespace: 'standalone' });
    expect(reloaded.loadAgents().find((agent) => agent.id === 1)).toMatchObject({
      palette: 3,
      hueShift: 45,
    });
    expect(reloaded.loadSeats()['1']).toEqual({ palette: 3, hueShift: 45, seatId: 'seat-a' });
  });

  it('does not rebroadcast a seat move that keeps the same costume', () => {
    store.set(1, createTestAgent({ id: 1, palette: 2, hueShift: 30 }));
    broadcasts = [];

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2, hueShift: 30, seatId: 'seat-b' } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(broadcasts).toEqual([]);
    expect(new FileStateAdapter({ namespace: 'standalone' }).loadSeats()['1']?.seatId).toBe(
      'seat-b',
    );
  });
});

describe('clientMessageHandler: nicknames', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function dispatch(message: Record<string, unknown>): void {
    handleClientMessage(message, (m) => sent.push(m), ctx);
  }

  function existingAgentsMessage(): Record<string, unknown> | undefined {
    sent = [];
    dispatch({ type: 'webviewReady' });
    return sent.find((m) => m.type === 'existingAgents');
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-nick-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.stubEnv('COPILOT_HOME', path.join(tempHome, '.copilot'));

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    ctx = { store, cache: null };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('renames an agent for every client and remembers it for the session', () => {
    store.set(1, createTestAgent({ id: 1, providerId: 'copilot', palette: 2, hueShift: 30 }));
    broadcasts = [];

    dispatch({ type: 'setAgentNickname', id: 1, nickname: '  Ada\tLovelace ' });

    expect(store.get(1)?.nickname).toBe('Ada Lovelace');
    expect(broadcasts).toEqual([{ type: 'agentMetadata', id: 1, nickname: 'Ada Lovelace' }]);
    const reloaded = new FileStateAdapter({ namespace: 'standalone' });
    expect(reloaded.loadAgents().find((agent) => agent.id === 1)?.nickname).toBe('Ada Lovelace');
    const book = reloaded.loadNicknameBook();
    expect(book.sessions).toEqual({ 'copilot:sess-1': 'Ada Lovelace' });
    expect(book.profiles).toEqual([{ nickname: 'Ada Lovelace', palette: 2, hueShift: 30 }]);
  });

  it('clears the nickname with an empty string', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 0 }));
    dispatch({ type: 'setAgentNickname', id: 1, nickname: 'Ada' });
    broadcasts = [];

    dispatch({ type: 'setAgentNickname', id: 1, nickname: '' });

    expect(store.get(1)?.nickname).toBeUndefined();
    expect(broadcasts).toEqual([{ type: 'agentMetadata', id: 1, nickname: '' }]);
    const reloaded = new FileStateAdapter({ namespace: 'standalone' });
    expect(reloaded.loadAgents().find((agent) => agent.id === 1)?.nickname).toBeUndefined();
    // The session forgets it; the nickname's look stays for the next agent that takes it.
    expect(reloaded.loadNicknameBook().sessions).toEqual({});
    expect(existingAgentsMessage()?.nicknames).toEqual({});
  });

  it('ignores a rename for a missing or unknown agent id', () => {
    store.set(1, createTestAgent({ id: 1 }));
    broadcasts = [];

    dispatch({ type: 'setAgentNickname', id: '1', nickname: 'Ada' });
    dispatch({ type: 'setAgentNickname', id: 99, nickname: 'Ada' });

    expect(store.get(1)?.nickname).toBeUndefined();
    expect(broadcasts).toEqual([]);
  });

  it('webviewReady carries nicknames and offers a never-seated agent its remembered seat', () => {
    store.set(1, createTestAgent({ id: 1, nickname: 'Ada', preferredSeatId: 'seat-z' }));
    store.set(2, createTestAgent({ id: 2, sessionId: 'sess-2' }));

    const existing = existingAgentsMessage() as {
      nicknames: Record<string, string>;
      agentMeta: Record<string, { seatId?: string }>;
    };

    expect(existing.nicknames).toEqual({ 1: 'Ada' });
    expect(existing.agentMeta[1].seatId).toBe('seat-z');
    expect(existing.agentMeta[2].seatId).toBeUndefined();
  });

  it('a saved seat wins over the seat remembered for the nickname', () => {
    store.set(1, createTestAgent({ id: 1, nickname: 'Ada', preferredSeatId: 'seat-z' }));
    new FileStateAdapter({ namespace: 'standalone' }).saveSeats({ '1': { seatId: 'seat-a' } });

    const existing = existingAgentsMessage() as {
      agentMeta: Record<string, { seatId?: string }>;
    };

    expect(existing.agentMeta[1].seatId).toBe('seat-a');
  });
});
