import { expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: { showWarningMessage: vi.fn() } }));
vi.mock('../../../server/src/layoutPersistence.js', () => ({
  readLayoutFromFile: vi.fn(),
  writeLayoutToFile: vi.fn(),
}));

import type { StateAdapter } from '../../../core/src/adapter.js';
import type { PersistedAgent } from '../../../core/src/schemas.js';
import { migrateAgentIdentity } from '../../../server/src/agentMigration.js';
import { migrateVsCodeState } from '../migrateVsCodeState.js';

it('normalizes provider identity before verifying and clearing legacy agent state', () => {
  const legacy: PersistedAgent[] = [
    {
      id: 1,
      terminalName: 'Claude Code #1',
      jsonlFile: 'C:\\projects\\session.jsonl',
      projectDir: 'C:\\projects',
      sessionId: 'session',
    },
  ];
  let saved: PersistedAgent[] = [];
  const update = vi.fn();
  const context = {
    globalState: { get: () => undefined },
    workspaceState: {
      get: (key: string) => (key === 'pixel-agents.agents' ? legacy : undefined),
      update,
    },
  } as unknown as Parameters<typeof migrateVsCodeState>[0];
  const adapter = {
    saveAgents: (agents: PersistedAgent[]) => {
      saved = agents;
    },
    loadAgents: () => saved.map(migrateAgentIdentity),
  } as unknown as StateAdapter;

  migrateVsCodeState(context, adapter);
  expect(saved).toEqual([{ ...legacy[0], providerId: 'claude' }]);
  expect(update).toHaveBeenCalledWith('pixel-agents.agents', undefined);
  expect(legacy[0].providerId).toBeUndefined();
});
