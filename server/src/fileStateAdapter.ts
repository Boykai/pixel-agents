/**
 * FileStateAdapter: shared StateAdapter implementation for both VS Code and standalone.
 *
 * Settings (per adapter namespace) persist to
 *   ~/.pixel-agents/config.json  under keys "vscode" or "standalone".
 *
 * Agents + seats (per adapter) persist to
 *   ~/.pixel-agents/<namespace>-state.json
 * alongside the nickname memory (a `nicknames` section; see nicknames.ts).
 *
 * Runtime visibility (which agents show in the office) is scope-controlled by the
 * runtime scanner + Watch All Sessions toggle, not by persistence. Both adapters
 * can observe the same ~/.claude/projects/ filesystem; each keeps its own local
 * agent IDs and seat mappings.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { NicknameBook, PersistedAgent } from '../../core/src/schemas.js';
import { migrateAgentIdentity } from './agentMigration.js';
import type { AdapterSettingKey, AdapterSettings, ConfigNamespace } from './configPersistence.js';
import { ADAPTER_SETTING_KEYS, readConfig, writeConfig } from './configPersistence.js';
import { LAYOUT_FILE_DIR } from './constants.js';
import { parseNicknameBook } from './nicknames.js';

const ADAPTER_SETTING_KEY_SET: ReadonlySet<string> = new Set(ADAPTER_SETTING_KEYS);

/** Strip leading "pixel-agents." prefix to match AdapterSettings field names. */
function settingNameOf(key: string): AdapterSettingKey | null {
  const bare = key.startsWith('pixel-agents.') ? key.slice('pixel-agents.'.length) : key;
  return ADAPTER_SETTING_KEY_SET.has(bare) ? (bare as AdapterSettingKey) : null;
}

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  /** Written only once a nickname exists, so the file is unchanged for everyone else. */
  nicknames?: NicknameBook;
}

const EMPTY_STATE: AdapterState = { agents: [], seats: {} };

export interface FileStateAdapterOptions {
  namespace: ConfigNamespace;
}

export class FileStateAdapter implements StateAdapter {
  private readonly namespace: ConfigNamespace;
  private readonly stateFilePath: string;
  private activeProviders: ReadonlySet<string> | undefined;

  constructor(options: FileStateAdapterOptions) {
    this.namespace = options.namespace;
    this.stateFilePath = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      `${options.namespace}-state.json`,
    );
  }

  // ── Settings (shared config.json, per-namespace section) ────

  getSetting<T>(key: string, defaultValue: T): T {
    const field = settingNameOf(key);
    if (!field) return defaultValue;
    const config = readConfig();
    // Optional settings (zoom) read as absent until first written.
    const value = config[this.namespace][field];
    return value === undefined ? defaultValue : (value as unknown as T);
  }

  setSetting<T>(key: string, value: T): void {
    const field = settingNameOf(key);
    if (!field) return;
    const config = readConfig();
    // Narrow by field to keep the union-safe write. Each entry is a boolean, string, number, or
    // (areaMappings) a record; readConfig re-validates every field on the next read.
    (config[this.namespace] as unknown as Record<string, unknown>)[field] = value;
    writeConfig(config);
  }

  // ── Agents + seats (adapter-scoped file) ────────────────────

  setActiveProviders(providerIds: readonly string[]): void {
    this.activeProviders = new Set(providerIds);
  }

  private isOutsideProviderScope(agent: PersistedAgent): boolean {
    if (!this.activeProviders) return false;
    const providerId = migrateAgentIdentity(agent).providerId;
    return providerId === undefined || !this.activeProviders.has(providerId);
  }

  loadAgents(): PersistedAgent[] {
    return this.readState().agents.map(migrateAgentIdentity);
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readState();
    const retained = state.agents.filter((agent) => this.isOutsideProviderScope(agent));
    const retainedIds = new Set(retained.map((agent) => agent.id));
    const selected = agents.filter((agent) => !this.isOutsideProviderScope(agent));
    if (selected.some((agent) => retainedIds.has(agent.id))) {
      console.error('[Pixel Agents] Refusing to overwrite an excluded provider agent ID');
      return;
    }
    state.agents = [...retained, ...selected];
    this.writeState(state);
  }

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }> {
    return this.readState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void {
    const state = this.readState();
    const retainedSeats: AdapterState['seats'] = {};
    for (const agent of state.agents) {
      if (this.isOutsideProviderScope(agent) && state.seats[agent.id]) {
        retainedSeats[agent.id] = state.seats[agent.id];
      }
    }
    state.seats = { ...seats, ...retainedSeats };
    this.writeState(state);
  }

  // ── Nickname memory (same file; outlives the agents it names) ──

  loadNicknameBook(): NicknameBook {
    return parseNicknameBook(this.readState().nicknames);
  }

  saveNicknameBook(book: NicknameBook): void {
    const state = this.readState();
    state.nicknames = book;
    this.writeState(state);
  }

  // ── Internal state-file I/O ─────────────────────────────────

  private readState(): AdapterState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { agents: [], seats: {} };
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      const state: AdapterState = {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
        seats:
          parsed.seats && typeof parsed.seats === 'object'
            ? (parsed.seats as AdapterState['seats'])
            : {},
      };
      // Carried through every read-modify-write so agent and seat saves keep it.
      if (parsed.nicknames !== undefined) state.nicknames = parseNicknameBook(parsed.nicknames);
      return state;
    } catch (err) {
      console.error('[Pixel Agents] Failed to read adapter state:', err);
      return { ...EMPTY_STATE };
    }
  }

  private writeState(state: AdapterState): void {
    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const { nicknames, ...rest } = state;
      const hasNicknames =
        nicknames !== undefined &&
        (nicknames.profiles.length > 0 || Object.keys(nicknames.sessions).length > 0);
      const json = JSON.stringify(hasNicknames ? { ...rest, nicknames } : rest, null, 2);
      const tmpPath = this.stateFilePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write adapter state:', err);
    }
  }
}

// Re-export for callers that want to construct AdapterSettings defaults directly.
/** @public */
export type { AdapterSettings, ConfigNamespace };
