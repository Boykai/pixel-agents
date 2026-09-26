import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import type { TranscriptSnapshot } from '../../../../../core/src/provider.js';
import { AgentStateStore } from '../../../agentStateStore.js';
import type { AgentState } from '../../../types.js';
import type { CopilotActivity, CopilotRecordOptions } from './eventReducer.js';
import {
  getCopilotActivity,
  getCopilotSnapshot,
  markCopilotObservationUnknown,
  objectValue,
  processCopilotRecord,
  resetCopilotObservation,
} from './eventReducer.js';

const DEFAULT_RECOVERY_BYTES = 256 * 1024;
const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECOVERY_RECORDS = 2000;
const MAX_RECOVERY_RECORDS = 10000;

/**
 * HookProvider.recoverTranscript seam. The full applyCopilotRecovery API also
 * preserves tools, requests and children when the caller owns an AgentState.
 */
export function recoverCopilotTranscript(
  lines: readonly string[],
  complete: boolean,
): TranscriptSnapshot {
  let start = lines.length;
  let bytes = 0;
  while (start > 0 && lines.length - start < DEFAULT_RECOVERY_RECORDS) {
    const line = lines[start - 1];
    if (line.length > DEFAULT_RECOVERY_BYTES) break;
    const length = Buffer.byteLength(line);
    if (bytes + length > DEFAULT_RECOVERY_BYTES) break;
    bytes += length;
    start--;
  }
  const recovery: CopilotRecovery = {
    records: [],
    fileOffset: 0,
    lineBuffer: '',
    available: true,
    complete: complete && start === 0,
    lastGapIndex: 0,
  };
  for (let index = start; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try {
      const record = objectValue(JSON.parse(lines[index]));
      if (record) recovery.records.push(record);
      else {
        recovery.complete = false;
        recovery.lastGapIndex = recovery.records.length;
      }
    } catch {
      recovery.complete = false;
      recovery.lastGapIndex = recovery.records.length;
    }
  }
  const agent: AgentState = {
    id: 0,
    sessionId: '',
    providerId: 'copilot',
    isExternal: true,
    projectDir: '',
    jsonlFile: '',
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
    maxContextTokens: 0,
  };
  const store = new AgentStateStore();
  try {
    applyCopilotRecovery(recovery, agent.id, agent, store, new Map(), new Map());
    const snapshot = getCopilotSnapshot(agent);
    const status =
      snapshot.activity === 'input'
        ? 'waiting'
        : snapshot.activity === 'done'
          ? 'idle'
          : snapshot.activity === 'active'
            ? 'active'
            : undefined;
    // The minimal core snapshot cannot express a permission request. Do not
    // misrepresent one as done or input; the full runtime recovery retains it.
    return {
      observation: status === undefined ? 'unknown' : 'known',
      ...(status ? { status } : {}),
      ...snapshot.context,
    };
  } finally {
    store.dispose();
  }
}

export interface CopilotRecovery {
  records: Record<string, unknown>[];
  /** Snapshot byte offset. Resume tailing here, carrying lineBuffer unchanged. */
  fileOffset: number;
  lineBuffer: string;
  complete: boolean;
  available: boolean;
  /** A malformed line after a checkpoint invalidates that checkpoint. */
  lastGapIndex?: number;
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

/** Read-only, bounded tail recovery. No SDK session resume or settings writes. */
export function readCopilotRecovery(
  file: string,
  options: { maxBytes?: number; maxRecords?: number } = {},
): CopilotRecovery {
  const maxBytes = bounded(options.maxBytes, DEFAULT_RECOVERY_BYTES, MAX_RECOVERY_BYTES);
  const maxRecords = bounded(options.maxRecords, DEFAULT_RECOVERY_RECORDS, MAX_RECOVERY_RECORDS);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, start + count);
      if (!read) break;
      count += read;
    }
    let content = buffer.subarray(0, count).toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      // The prefix of an oversized unfinished line is unavailable. Carry an
      // invalid JSON prefix so its future suffix cannot masquerade as a record.
      content = firstNewline < 0 ? '\0' : content.slice(firstNewline + 1);
    }
    const lines = content.split('\n');
    const lineBuffer = lines.pop() ?? '';
    let complete = start === 0 && count === buffer.length && lines.length <= maxRecords;
    const records: Record<string, unknown>[] = [];
    let lastGapIndex = 0;
    for (const line of lines.slice(-maxRecords)) {
      if (!line.trim()) continue;
      try {
        const record = objectValue(JSON.parse(line));
        if (record) records.push(record);
        else {
          complete = false;
          lastGapIndex = records.length;
        }
      } catch {
        complete = false;
        lastGapIndex = records.length;
      }
    }
    return {
      records,
      fileOffset: start + count,
      lineBuffer,
      complete,
      available: true,
      lastGapIndex,
    };
  } catch {
    return { records: [], fileOffset: 0, lineBuffer: '', complete: false, available: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Hydrate before announcing the agent. A truncated suffix cannot prove there
 * were no outstanding requests/children before it, unless an aggregate idle
 * checkpoint supplies that fact. The runtime separately decides liveness.
 */
export function applyCopilotRecovery(
  recovery: CopilotRecovery,
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  options: CopilotRecordOptions = {},
): CopilotActivity {
  resetCopilotObservation(agent);
  let anchored = recovery.complete;
  for (const [index, record] of recovery.records.entries()) {
    processCopilotRecord(agentId, record, agent, agents, waitingTimers, permissionTimers, {
      ...options,
      replay: true,
    });
    if (
      record.type === 'session.idle' &&
      record.agentId === undefined &&
      objectValue(record.data) &&
      index >= (recovery.lastGapIndex ?? 0)
    ) {
      anchored = true;
    }
  }
  if (!anchored) markCopilotObservationUnknown(agent);
  if (recovery.available) {
    agent.fileOffset = recovery.fileOffset;
    agent.lineBuffer = recovery.lineBuffer;
  }
  return getCopilotActivity(agent);
}
