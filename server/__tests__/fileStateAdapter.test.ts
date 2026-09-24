import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';

// Mock os.homedir() so the adapter resolves to an isolated temp dir on every
// platform. Overriding process.env.HOME is not portable: os.homedir() reads
// USERPROFILE on Windows, so a HOME-only override would still hit the real
// home directory.
let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

// Must import AFTER mock setup.
const { FileStateAdapter } = await import('../src/fileStateAdapter.js');
const { getHooksEnabled, setHooksEnabled } = await import('../src/configPersistence.js');

describe('FileStateAdapter', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-adapter-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Settings (shared config.json, per-namespace section) ────

  it('returns defaults when config file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('pixel-agents.soundEnabled', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.watchAllSessions', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', 'x')).toBe('');
  });

  it('round-trips each namespaced setting key (hooksEnabled moved to the per-provider map)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });

    adapter.setSetting('pixel-agents.soundEnabled', false);
    adapter.setSetting('pixel-agents.lastSeenVersion', '1.3');
    adapter.setSetting('pixel-agents.alwaysShowLabels', true);
    adapter.setSetting('pixel-agents.watchAllSessions', true);
    adapter.setSetting('pixel-agents.hooksInfoShown', true);

    expect(adapter.getSetting('pixel-agents.soundEnabled', true)).toBe(false);
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', '')).toBe('1.3');
    expect(adapter.getSetting('pixel-agents.alwaysShowLabels', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.watchAllSessions', false)).toBe(true);
    expect(adapter.getSetting('pixel-agents.hooksInfoShown', false)).toBe(true);

    // hooksEnabled is deliberately NOT an adapter key any more: it is
    // per-provider and machine-global, so the adapter ignores it and the
    // per-provider accessors own it.
    adapter.setSetting('pixel-agents.hooksEnabled', false);
    expect(adapter.getSetting('pixel-agents.hooksEnabled', true)).toBe(true);
    setHooksEnabled('claude', false);
    expect(getHooksEnabled('claude')).toBe(false);
  });

  it('vscode and standalone namespaces are isolated in config.json', () => {
    const vscode = new FileStateAdapter({ namespace: 'vscode' });
    const standalone = new FileStateAdapter({ namespace: 'standalone' });

    vscode.setSetting('pixel-agents.watchAllSessions', true);
    standalone.setSetting('pixel-agents.watchAllSessions', false);

    expect(vscode.getSetting('pixel-agents.watchAllSessions', null)).toBe(true);
    expect(standalone.getSetting('pixel-agents.watchAllSessions', null)).toBe(false);

    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(parsed.vscode.watchAllSessions).toBe(true);
    expect(parsed.standalone.watchAllSessions).toBe(false);
  });

  it('ignores unknown setting keys (returns default, does not write)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('pixel-agents.unknownKey', 'fallback')).toBe('fallback');
    adapter.setSetting('pixel-agents.unknownKey', 'ignored');
    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('accepts setting keys with or without the pixel-agents. prefix', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('pixel-agents.soundEnabled', false);
    expect(adapter.getSetting('soundEnabled', true)).toBe(false);
    adapter.setSetting('lastSeenVersion', '1.0');
    expect(adapter.getSetting('pixel-agents.lastSeenVersion', '')).toBe('1.0');
  });

  it('persists settings under namespace in config.json with clean field names', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('pixel-agents.soundEnabled', false);
    const configPath = path.join(tempHome, '.pixel-agents', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.standalone.soundEnabled).toBe(false);
    expect(parsed.standalone['pixel-agents.soundEnabled']).toBeUndefined();
  });

  // ── Per-namespace state file (agents + seats) ───────────────

  it('retains excluded providers and their seats when a selected provider saves or closes', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const claude: PersistedAgent = {
      id: 4,
      providerId: 'claude',
      terminalName: '',
      jsonlFile: 'claude.jsonl',
      projectDir: '',
    };
    const copilot: PersistedAgent = {
      id: 8,
      providerId: 'copilot',
      terminalName: '',
      jsonlFile: 'events.jsonl',
      projectDir: '',
    };
    adapter.saveAgents([claude, copilot]);
    adapter.saveSeats({ 4: { seatId: 'claude-seat' }, 8: { seatId: 'copilot-seat' } });
    adapter.setActiveProviders(['copilot']);
    adapter.saveAgents([{ ...copilot, sessionName: 'renamed' }]);
    adapter.saveSeats({ 8: { seatId: 'new-seat' } });
    expect(adapter.loadAgents()).toEqual([claude, { ...copilot, sessionName: 'renamed' }]);
    expect(adapter.loadSeats()).toEqual({
      4: { seatId: 'claude-seat' },
      8: { seatId: 'new-seat' },
    });

    adapter.saveAgents([]);
    adapter.saveSeats({});
    expect(adapter.loadAgents()).toEqual([claude]);
    expect(adapter.loadSeats()).toEqual({ 4: { seatId: 'claude-seat' } });

    adapter.setActiveProviders(['claude', 'copilot']);
    adapter.saveAgents([]);
    adapter.saveSeats({});
    expect(adapter.loadAgents()).toEqual([]);
    expect(adapter.loadSeats()).toEqual({});
  });

  it('refuses a numeric ID collision with an excluded provider', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const excluded: PersistedAgent = {
      id: 4,
      providerId: 'claude',
      terminalName: '',
      jsonlFile: 'claude.jsonl',
      projectDir: '',
    };
    adapter.saveAgents([excluded]);
    adapter.setActiveProviders(['copilot']);
    adapter.saveAgents([{ ...excluded, providerId: 'copilot', jsonlFile: 'events.jsonl' }]);
    expect(adapter.loadAgents()).toEqual([excluded]);
  });

  it('returns empty arrays/objects when state file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.loadAgents()).toEqual([]);
    expect(adapter.loadSeats()).toEqual({});
  });

  it('round-trips agents to the namespace-specific state file', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const agents: PersistedAgent[] = [
      {
        id: 1,
        sessionId: 'sess-1',
        terminalName: 'Claude Code #1',
        jsonlFile: '/tmp/sess-1.jsonl',
        projectDir: '/tmp/proj',
      },
    ];
    adapter.saveAgents(agents);
    expect(adapter.loadAgents()).toEqual(
      agents.map((agent) => ({ ...agent, providerId: 'claude' })),
    );
  });

  it('writes state at ~/.pixel-agents/<namespace>-state.json', () => {
    const adapter = new FileStateAdapter({ namespace: 'vscode' });
    adapter.saveSeats({ '1': { palette: 2, hueShift: 45 } });
    const stateFile = path.join(tempHome, '.pixel-agents', 'vscode-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('vscode and standalone state files are independent', () => {
    const vscode = new FileStateAdapter({ namespace: 'vscode' });
    const standalone = new FileStateAdapter({ namespace: 'standalone' });
    const agentVs: PersistedAgent[] = [
      { id: 1, terminalName: 'A', jsonlFile: '/a.jsonl', projectDir: '/proj' },
    ];
    const agentSa: PersistedAgent[] = [
      { id: 9, terminalName: '', jsonlFile: '/b.jsonl', projectDir: '/proj' },
    ];
    vscode.saveAgents(agentVs);
    standalone.saveAgents(agentSa);
    expect(vscode.loadAgents()).toEqual(
      agentVs.map((agent) => ({ ...agent, providerId: 'claude' })),
    );
    expect(standalone.loadAgents()).toEqual(
      agentSa.map((agent) => ({ ...agent, providerId: 'claude' })),
    );
  });

  it('preserves seats when saving agents (and vice versa)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveSeats({ '1': { palette: 3 } });
    adapter.saveAgents([{ id: 1, terminalName: 'x', jsonlFile: '/x.jsonl', projectDir: '/tmp' }]);
    expect(adapter.loadSeats()).toEqual({ '1': { palette: 3 } });
    expect(adapter.loadAgents()).toHaveLength(1);
  });
});
