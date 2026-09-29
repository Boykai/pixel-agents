import type { AgentUsage } from '../../../core/src/messages.js';
import { normalizeProjectName } from '../../../core/src/normalizeProjectName.js';
import {
  TOKEN_USAGE_BAR_BG,
  TOKEN_USAGE_CACHE_READ_COLOR,
  TOKEN_USAGE_CACHE_WRITE_COLOR,
  TOKEN_USAGE_INPUT_COLOR,
  TOKEN_USAGE_MIN_SEGMENT_PERCENT,
  TOKEN_USAGE_OUTPUT_COLOR,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { Button } from './ui/Button.js';

// Ported from hootbu/pixel-agents' UsagePanel. Each figure is the one the
// agent's CLI recorded: tokens where the transcript states them (Claude, and
// Copilot once a run has shut down), premium requests + nano AIU for Copilot.

interface UsagePanelProps {
  agents: number[];
  agentUsage: Record<number, AgentUsage>;
  officeState: OfficeState;
  onClose: () => void;
}

interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const SEGMENTS = [
  { key: 'input', label: 'Input', color: TOKEN_USAGE_INPUT_COLOR },
  { key: 'output', label: 'Output', color: TOKEN_USAGE_OUTPUT_COLOR },
  { key: 'cacheWrite', label: 'Cache W', color: TOKEN_USAGE_CACHE_WRITE_COLOR },
  { key: 'cacheRead', label: 'Cache R', color: TOKEN_USAGE_CACHE_READ_COLOR },
] as const;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Premium requests can be fractional (model multipliers below 1). */
function formatRequests(n: number): string {
  return String(Number(n.toFixed(2)));
}

function tokenCounts(usage: AgentUsage): TokenCounts | undefined {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheCreationInputTokens === undefined &&
    usage.cacheReadInputTokens === undefined
  ) {
    return undefined;
  }
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheWrite: usage.cacheCreationInputTokens ?? 0,
    cacheRead: usage.cacheReadInputTokens ?? 0,
  };
}

function totalOf(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheWrite + counts.cacheRead;
}

function shortModel(model: string | undefined): string {
  return model ? model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : '';
}

function TokenBar({ counts }: { counts: TokenCounts }) {
  const total = totalOf(counts);
  if (total === 0) return null;
  return (
    <div className="flex h-6 mt-4 overflow-hidden" style={{ background: TOKEN_USAGE_BAR_BG }}>
      {SEGMENTS.map(({ key, color }) => {
        const percent = (counts[key] / total) * 100;
        if (percent < TOKEN_USAGE_MIN_SEGMENT_PERCENT) return null;
        return (
          <div
            key={key}
            className="opacity-80"
            style={{ width: `${percent}%`, background: color }}
          />
        );
      })}
    </div>
  );
}

function TokenDetail({ label, value, color }: { label: string; value: number; color: string }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center gap-6 text-sm">
      <span className="w-6 h-6 shrink-0 opacity-80" style={{ background: color }} />
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto text-text">{formatCount(value)}</span>
    </div>
  );
}

function SinceTracked() {
  return (
    <span
      className="text-2xs text-text-muted"
      title="History could not be read, so this counts only usage seen since tracking started"
    >
      since tracked
    </span>
  );
}

function PremiumRequestRows({
  premiumRequests,
  nanoAiu,
}: {
  premiumRequests?: number;
  nanoAiu?: number;
}) {
  return (
    <>
      {premiumRequests !== undefined && (
        <div className="flex justify-between items-baseline text-sm">
          <span className="text-text-muted">Premium requests</span>
          <span className="text-text" data-testid="usage-premium-requests">
            {formatRequests(premiumRequests)}
          </span>
        </div>
      )}
      {nanoAiu !== undefined && (
        <div className="flex justify-between items-baseline text-sm">
          <span className="text-text-muted">nano AIU</span>
          <span className="text-text">{formatCount(nanoAiu)}</span>
        </div>
      )}
    </>
  );
}

interface GrandTotals {
  tokens?: TokenCounts;
  premiumRequests?: number;
  nanoAiu?: number;
  sinceTracked: boolean;
}

/** Sums each unit only over the agents that report it. */
function grandTotals(usages: AgentUsage[]): GrandTotals {
  const totals: GrandTotals = { sinceTracked: false };
  for (const usage of usages) {
    const counts = tokenCounts(usage);
    if (counts) {
      const tokens = (totals.tokens ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
      tokens.input += counts.input;
      tokens.output += counts.output;
      tokens.cacheWrite += counts.cacheWrite;
      tokens.cacheRead += counts.cacheRead;
    }
    if (usage.premiumRequests !== undefined) {
      totals.premiumRequests = (totals.premiumRequests ?? 0) + usage.premiumRequests;
    }
    if (usage.nanoAiu !== undefined) totals.nanoAiu = (totals.nanoAiu ?? 0) + usage.nanoAiu;
    if (usage.sinceTracked) totals.sinceTracked = true;
  }
  return totals;
}

export function UsagePanel({ agents, agentUsage, officeState, onClose }: UsagePanelProps) {
  const rows = agents.filter((id) => agentUsage[id]);
  const {
    tokens: grandTokens,
    premiumRequests: grandPremiumRequests,
    nanoAiu: grandNanoAiu,
    sinceTracked: anySinceTracked,
  } = grandTotals(rows.map((id) => agentUsage[id]));
  const hasGrandTotals =
    grandTokens !== undefined || grandPremiumRequests !== undefined || grandNanoAiu !== undefined;

  return (
    <section
      aria-label="Token usage"
      data-testid="usage-panel"
      className="absolute top-8 right-8 z-20 w-[min(310px,calc(100%-16px))] max-h-[calc(100%-96px)] overflow-y-auto pixel-panel pixel-scrollbar pb-4"
    >
      <div className="flex items-center justify-between py-4 px-12 border-b border-border mb-4">
        <span className="text-accent-bright text-lg">Token usage</span>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close token usage">
          x
        </Button>
      </div>

      {rows.length === 0 && (
        <div className="py-12 px-14 text-base text-text-muted text-center">No usage data</div>
      )}

      {hasGrandTotals && (
        <div className="px-12 pt-2 pb-8 flex flex-col gap-2" data-testid="usage-totals">
          {grandTokens && (
            <>
              <div className="flex justify-between items-baseline">
                <span className="text-base text-text">Total</span>
                <span className="text-lg text-accent-bright" data-testid="usage-total-tokens">
                  {formatCount(totalOf(grandTokens))}
                </span>
              </div>
              <TokenBar counts={grandTokens} />
              <div className="grid grid-cols-2 gap-x-14 gap-y-2 pt-6">
                {SEGMENTS.map(({ key, label, color }) => (
                  <TokenDetail key={key} label={label} value={grandTokens[key]} color={color} />
                ))}
              </div>
            </>
          )}
          <PremiumRequestRows premiumRequests={grandPremiumRequests} nanoAiu={grandNanoAiu} />
          {anySinceTracked && <SinceTracked />}
        </div>
      )}

      {rows.length > 0 && <div className="h-1 bg-border mt-2 mb-4" />}

      {rows.map((id) => {
        const usage = agentUsage[id];
        const ch = officeState.characters.get(id);
        const name =
          ch?.agentName || ch?.sessionName || normalizeProjectName(ch?.folderName) || `Agent ${id}`;
        const counts = tokenCounts(usage);
        const hasRequests = usage.premiumRequests !== undefined || usage.nanoAiu !== undefined;
        return (
          <div key={id} className="py-4 px-12" data-testid="usage-agent-row" data-agent-id={id}>
            <div className="flex justify-between items-center gap-8">
              <span className="text-base text-text truncate">{name}</span>
              <span className="text-sm text-text-muted shrink-0" data-testid="usage-model">
                {shortModel(usage.model)}
              </span>
            </div>
            {counts && (
              <>
                <TokenBar counts={counts} />
                <div className="flex justify-between pt-4 text-sm text-text-muted">
                  <span>
                    <span className="opacity-80" style={{ color: TOKEN_USAGE_INPUT_COLOR }}>
                      In{' '}
                    </span>
                    {formatCount(counts.input)}
                  </span>
                  <span>
                    <span className="opacity-80" style={{ color: TOKEN_USAGE_OUTPUT_COLOR }}>
                      Out{' '}
                    </span>
                    {formatCount(counts.output)}
                  </span>
                  <span className="text-accent-bright" data-testid="usage-agent-tokens">
                    {formatCount(totalOf(counts))}
                  </span>
                </div>
              </>
            )}
            {hasRequests && (
              <div className="pt-4">
                <PremiumRequestRows
                  premiumRequests={usage.premiumRequests}
                  nanoAiu={usage.nanoAiu}
                />
              </div>
            )}
            {!counts && !hasRequests && !usage.sinceTracked && (
              <div className="pt-2 text-sm text-text-muted">—</div>
            )}
            {usage.sinceTracked && <SinceTracked />}
          </div>
        );
      })}
    </section>
  );
}
