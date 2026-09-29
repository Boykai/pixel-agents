// webview-ui/src/office/engine/existingAgents.ts
//
// Pure reconciliation for the `existingAgents` restore message. Extracted from
// useExtensionMessages so it can be unit-tested without React (mirrors
// officeCanvasCursor.ts). The deliberate e2e-over-unit policy forbids unit
// tests against the React message handler itself.
//
// The webview must handle BOTH orders in which the two restore messages arrive:
//   - existingAgents before layoutLoaded → buffer, flush on the next layoutLoaded
//   - layoutLoaded before existingAgents → layout + seats already built, add now
// Depending on layoutLoaded always arriving last stranded restored agents on any
// surface that sends layout first (e.g. the VS Code no-assets path), issue #334.

/** Per-agent seat metadata carried by the existingAgents message. */
export interface ExistingAgentMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

/** An agent buffered until the layout (and its seats) has been built. */
export interface PendingAgent {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  folderName?: string;
  sessionName?: string;
  /** '' = the snapshot says this agent has no nickname (clears a stale one). */
  nickname?: string;
  isHeadless?: boolean;
  providerId?: string;
  observation?: 'known' | 'unknown';
}

/** Minimal structural view of OfficeState this reconciler needs. */
export interface ExistingAgentsOffice {
  characters: { has: (id: number) => boolean };
  addAgent: (
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
    nearAgentId?: number,
    sessionName?: string,
  ) => void;
  setHeadless: (id: number, headless: boolean) => void;
  setAgentMetadata?: (
    id: number,
    metadata: {
      providerId?: string;
      observation?: 'known' | 'unknown';
      folderName?: string;
      sessionName?: string;
      nickname?: string;
    },
  ) => void;
  setAgentAppearance?: (id: number, palette: number, hueShift: number) => boolean;
}

export function reconcileAgentMetadata(
  office: ExistingAgentsOffice,
  pendingAgents: PendingAgent[],
  id: number,
  metadata: Pick<PendingAgent, 'folderName' | 'sessionName' | 'nickname'>,
): void {
  office.setAgentMetadata?.(id, metadata);
  const pending = pendingAgents.find((agent) => agent.id === id);
  if (!pending) return;
  if (metadata.folderName !== undefined) pending.folderName = metadata.folderName;
  if (metadata.sessionName !== undefined) pending.sessionName = metadata.sessionName;
  if (metadata.nickname !== undefined) pending.nickname = metadata.nickname;
}

/** Apply a costume change to an agent, or to its buffered entry if the layout
 *  has not been built yet (the flush then creates it already dressed). */
export function reconcileAgentAppearance(
  office: ExistingAgentsOffice,
  pendingAgents: PendingAgent[],
  id: number,
  palette: number,
  hueShift: number,
): void {
  office.setAgentAppearance?.(id, palette, hueShift);
  const pending = pendingAgents.find((agent) => agent.id === id);
  if (!pending) return;
  pending.palette = palette;
  pending.hueShift = hueShift;
}

/**
 * Reconcile an `existingAgents` payload into the office. When the layout is
 * already built, agents are added immediately (skipping the matrix spawn effect,
 * as restored agents do) unless they already exist; otherwise they are pushed
 * onto `pending` to be flushed by the next `layoutLoaded`. Returns true if any
 * agent was added directly, so the caller can persist seat assignments.
 */
export function reconcileExistingAgents(
  os: ExistingAgentsOffice,
  incoming: number[],
  meta: Record<number, ExistingAgentMeta>,
  folderNames: Record<number, string>,
  layoutReady: boolean,
  pending: PendingAgent[],
  headlessAgents: Record<number, boolean> = {},
  sessionNames: Record<number, string> = {},
  providerIds: Record<number, string> = {},
  observations: Record<number, 'known' | 'unknown'> = {},
  nicknames?: Record<number, string>,
): boolean {
  let addedDirectly = false;
  for (const id of incoming) {
    const m = meta[id];
    const p: PendingAgent = {
      id,
      palette: m?.palette,
      hueShift: m?.hueShift,
      seatId: m?.seatId,
      folderName: folderNames[id],
      sessionName: sessionNames[id],
      isHeadless: headlessAgents[id] === true,
      ...(providerIds[id] !== undefined ? { providerId: providerIds[id] } : {}),
      ...(observations[id] !== undefined ? { observation: observations[id] } : {}),
      // A snapshot that carries nicknames is authoritative: absent = none.
      ...(nicknames ? { nickname: nicknames[id] ?? '' } : {}),
    };
    if (layoutReady) {
      if (!os.characters.has(p.id)) {
        os.addAgent(
          p.id,
          p.palette,
          p.hueShift,
          p.seatId,
          true,
          p.folderName,
          undefined,
          p.sessionName,
        );
        if (p.isHeadless) os.setHeadless(p.id, true);
        addedDirectly = true;
      } else if (p.palette !== undefined) {
        // Reconnect: a costume changed while this client was away.
        os.setAgentAppearance?.(p.id, p.palette, p.hueShift ?? 0);
      }
      os.setAgentMetadata?.(p.id, p);
    } else {
      pending.push(p);
    }
  }
  return addedDirectly;
}
