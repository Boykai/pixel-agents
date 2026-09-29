import type { TokenUsageSample } from '../../../../../core/src/provider.js';

/** Model id Claude Code writes on records it fabricates itself (API errors,
 *  interrupts). They carry no real usage. */
const SYNTHETIC_MODEL = '<synthetic>';

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Token usage from one Claude Code transcript record.
 *
 * Only top-level `assistant` records count, main chain and sidechain alike:
 * a lead's sidechain records are its sub-agents' turns, used by the same
 * session. Claude writes one record per content block and repeats the
 * message's usage on each, so every sample carries `message.id` for the
 * runtime's dedupe. All-zero usage is Claude's placeholder on synthetic
 * records, not a real turn, and is dropped.
 */
export function extractClaudeTokenUsage(record: unknown): TokenUsageSample | undefined {
  const entry = objectValue(record);
  if (entry?.type !== 'assistant') return undefined;
  const message = objectValue(entry.message);
  if (!message || message.model === SYNTHETIC_MODEL) return undefined;
  const usage = objectValue(message.usage);
  if (!usage) return undefined;
  const sample: TokenUsageSample = { kind: 'delta' };
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = tokenCount(usage.cache_read_input_tokens);
  if (!inputTokens && !outputTokens && !cacheCreationInputTokens && !cacheReadInputTokens) {
    return undefined;
  }
  if (inputTokens !== undefined) sample.inputTokens = inputTokens;
  if (outputTokens !== undefined) sample.outputTokens = outputTokens;
  if (cacheCreationInputTokens !== undefined) {
    sample.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  if (cacheReadInputTokens !== undefined) sample.cacheReadInputTokens = cacheReadInputTokens;
  if (typeof message.id === 'string' && message.id) sample.messageId = message.id;
  if (typeof message.model === 'string' && message.model) sample.model = message.model;
  return sample;
}
