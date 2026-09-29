import type { TokenUsageSample } from '../../../../../core/src/provider.js';

/** session.shutdown `tokenDetails` keys → Token usage fields. `input` is the
 *  uncached input (the model metrics' inputTokens = input + cache_read +
 *  cache_write), matching Claude's `input_tokens`. */
const SHUTDOWN_TOKEN_FIELDS = {
  input: 'inputTokens',
  output: 'outputTokens',
  cache_write: 'cacheCreationInputTokens',
  cache_read: 'cacheReadInputTokens',
} as const;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function modelName(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function modelOnly(model: string | undefined): TokenUsageSample | undefined {
  return model ? { kind: 'delta', model } : undefined;
}

/**
 * Token usage from one persisted Copilot session event.
 *
 * What events.jsonl really holds: `session.usage_checkpoint` (cumulative
 * premium requests + nano AIU) and `session.shutdown` (the same totals plus
 * session-wide token counts). Per-call `assistant.usage` and
 * `session.usage_info` are ephemeral — never written to disk — so tokens are
 * known only once a run has shut down. Both totals are whole-session and
 * survive resume, so each REPLACES the previous one; a checkpoint after a
 * resume therefore drops the previous shutdown's (now stale) tokens rather
 * than showing them as current. The model comes from session.start/resume,
 * session.model_change and each reply's `assistant.message`. Child-scoped
 * records (outer `agentId`) never carry session totals, and their model is
 * the child's, so they are ignored.
 */
export function extractCopilotTokenUsage(record: unknown): TokenUsageSample | undefined {
  const event = objectValue(record);
  if (!event || event.agentId !== undefined) return undefined;
  const data = objectValue(event.data);
  if (!data) return undefined;
  switch (event.type) {
    case 'session.start':
    case 'session.resume':
      return modelOnly(modelName(data.selectedModel));
    case 'session.model_change':
      return modelOnly(modelName(data.newModel));
    case 'assistant.message':
      // The model that produced this reply. It is written on every reply, so
      // even a bounded tail read finds the current model.
      return modelOnly(modelName(data.model));
    case 'session.usage_checkpoint':
    case 'session.shutdown': {
      const sample: TokenUsageSample = { kind: 'total' };
      const premiumRequests = amount(data.totalPremiumRequests);
      const nanoAiu = amount(data.totalNanoAiu);
      if (premiumRequests !== undefined) sample.premiumRequests = premiumRequests;
      if (nanoAiu !== undefined) sample.nanoAiu = nanoAiu;
      const model = event.type === 'session.shutdown' ? modelName(data.currentModel) : undefined;
      if (event.type === 'session.shutdown') {
        const details = objectValue(data.tokenDetails);
        for (const [key, field] of Object.entries(SHUTDOWN_TOKEN_FIELDS)) {
          const count = amount(objectValue(details?.[key])?.tokenCount);
          if (count !== undefined && Number.isSafeInteger(count)) sample[field] = count;
        }
      }
      const hasNumbers = Object.keys(sample).length > 1;
      if (!hasNumbers) return modelOnly(model);
      if (model) sample.model = model;
      return sample;
    }
    default:
      return undefined;
  }
}
