import type { PersistedAgent } from '../../core/src/schemas.js';

const COPILOT_TRANSCRIPT =
  /(?:^|\/)session-state\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events\.jsonl$/i;

/** Only verified path shape repairs the pre-provider `events` identity bug. */
export function migrateAgentIdentity(agent: PersistedAgent): PersistedAgent {
  const file = agent.jsonlFile.replace(/\\/g, '/');
  const copilot = COPILOT_TRANSCRIPT.exec(file);
  if (copilot && (!agent.providerId || agent.providerId === 'copilot')) {
    return { ...agent, providerId: 'copilot', sessionId: copilot[1] };
  }
  if (agent.providerId) return agent;
  if (/(?:^|\/)events\.jsonl$/i.test(file)) {
    console.warn(
      '[Pixel Agents] Cannot infer provider for persisted events.jsonl; leaving identity unresolved',
    );
    return { ...agent, observation: 'unknown' };
  }
  return { ...agent, providerId: 'claude' };
}
