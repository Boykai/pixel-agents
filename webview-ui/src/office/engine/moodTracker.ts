/**
 * Mood reactions: which transient Mood a character should show, derived purely
 * from the ServerMessage stream every provider already produces. DOM-free, so
 * the Node test runner drives it directly.
 *
 * Triggers and thresholds are ported from hootbu/pixel-agents (d0843a9, MIT),
 * where the extension host posted mood events from the Claude transcript
 * parser. Deriving them from the protocol instead keeps provider knowledge out
 * of the UI, so they work for every provider on both surfaces:
 *
 * - error:    a tool finished with the tool-failure signal (`isError`).
 * - happy:    a turn ended Done after at least one fresh tool and no failures.
 * - stressed: MOOD_STRESSED_RAPID_COUNT fresh tool starts inside
 *             MOOD_STRESSED_RAPID_THRESHOLD_MS, or one tool running past
 *             MOOD_STRESSED_TOOL_DURATION_MS (checked by `tick`). The running
 *             clock only counts while the character is visibly working: a
 *             permission prompt, a question to the user or an unknown
 *             observation pauses it, and resuming restarts it. Tools that
 *             legitimately wait (spawns, questions to the user) never count.
 *
 * Replayed snapshot messages (`replay: true`, sent when a client connects)
 * restore state but never trigger a Mood.
 */
import type {
  AgentToolStart,
  ServerMessage,
  SubagentToolStart,
} from '../../../../core/src/messages.js';
import {
  MOOD_STRESSED_RAPID_COUNT,
  MOOD_STRESSED_RAPID_THRESHOLD_MS,
  MOOD_STRESSED_TOOL_DURATION_MS,
} from '../../constants.js';
import type { Character } from '../types.js';
import { Mood } from '../types.js';

/** A Mood to show on agent `id`, or on the Sub-agent its tool `parentToolId` spawned. */
export interface MoodTrigger {
  id: number;
  parentToolId?: string;
  mood: Mood;
}

export interface MoodTrackerOptions {
  /** True for tools that legitimately wait — on a Sub-agent or on the user —
   *  so a long run never makes their character stressed. */
  isWaitingTool?: (msg: AgentToolStart | SubagentToolStart) => boolean;
}

interface ToolClock {
  /** When the clock last (re)started. */
  since: number;
  /** A tool stresses its character at most once. */
  reported: boolean;
}

/** Mood state shared by agents and their Sub-agents. */
interface Actor {
  /** Fresh tool starts inside the rapid-fire window. */
  recentStarts: number[];
  /** Running tools that can become long-running, by toolId. */
  clocks: Map<string, ToolClock>;
  /** A permission prompt is up on this character. */
  blocked: boolean;
  /** Visibly working: clocks only advance while live. */
  live: boolean;
}

interface AgentMood extends Actor {
  status: 'active' | 'done' | 'input';
  observed: boolean;
  inTurn: boolean;
  hadTools: boolean;
  failures: number;
  /** Started, unfinished tool ids: a re-sent start is not a new start. */
  known: Set<string>;
  /** Background spawn tool ids: they and their Sub-agents outlive a turn end. */
  background: Set<string>;
  /** Sub-agent actors, by the spawning tool's id. */
  subs: Map<string, Actor>;
}

function newActor(): Actor {
  return { recentStarts: [], clocks: new Map(), blocked: false, live: false };
}

function newAgent(): AgentMood {
  return {
    ...newActor(),
    status: 'done',
    observed: true,
    inTurn: false,
    hadTools: false,
    failures: 0,
    known: new Set(),
    background: new Set(),
    subs: new Map(),
  };
}

/** Records a fresh tool start; true when it completes a rapid-fire burst. */
function completesBurst(actor: Actor, now: number): boolean {
  actor.recentStarts = actor.recentStarts.filter((t) => now - t < MOOD_STRESSED_RAPID_THRESHOLD_MS);
  actor.recentStarts.push(now);
  if (actor.recentStarts.length < MOOD_STRESSED_RAPID_COUNT) return false;
  actor.recentStarts = [];
  return true;
}

/** A clock only measures visible work, so it restarts whenever work resumes. */
function setLive(actor: Actor, live: boolean, now: number): void {
  if (live && !actor.live) {
    for (const clock of actor.clocks.values()) clock.since = now;
  }
  actor.live = live;
}

/** Marks every tool that just crossed the long-running threshold; true when any did. */
function crossedThreshold(actor: Actor, now: number): boolean {
  let crossed = false;
  for (const clock of actor.clocks.values()) {
    if (!clock.reported && now - clock.since >= MOOD_STRESSED_TOOL_DURATION_MS) {
      clock.reported = true;
      crossed = true;
    }
  }
  return crossed;
}

export class MoodTracker {
  private readonly agents = new Map<number, AgentMood>();
  private readonly isWaitingTool: (msg: AgentToolStart | SubagentToolStart) => boolean;

  constructor(options: MoodTrackerOptions = {}) {
    this.isWaitingTool = options.isWaitingTool ?? (() => false);
  }

  /** Feed one ServerMessage received at `now` (ms); returns the Moods it triggers. */
  handleMessage(msg: ServerMessage, now: number): MoodTrigger[] {
    const triggers: MoodTrigger[] = [];
    let agent: AgentMood | undefined;
    switch (msg.type) {
      case 'agentCreated': {
        agent = this.agent(msg.id);
        if (msg.observation !== undefined) agent.observed = msg.observation === 'known';
        break;
      }
      case 'existingAgents': {
        for (const id of msg.agents) {
          const existing = this.agent(id);
          const observation = msg.observations?.[id];
          if (observation !== undefined) existing.observed = observation === 'known';
          this.sync(existing, now);
        }
        break;
      }
      case 'agentClosed':
        this.agents.delete(msg.id);
        break;
      case 'agentObservation': {
        agent = this.agent(msg.id);
        agent.observed = msg.observation === 'known';
        if (!agent.observed) agent.blocked = false;
        break;
      }
      case 'agentStatus': {
        agent = this.agent(msg.id);
        if (msg.status === 'unknown') {
          agent.observed = false;
          agent.blocked = false;
          break;
        }
        agent.observed = true;
        if (msg.status === 'active') {
          agent.status = 'active';
          if (!agent.inTurn) this.beginTurn(agent);
        } else if (msg.awaitingInput === true) {
          // Mid-turn question to the user: the turn is not over.
          agent.status = 'input';
        } else {
          if (msg.replay !== true && agent.inTurn && agent.hadTools && agent.failures === 0) {
            triggers.push({ id: msg.id, mood: Mood.HAPPY });
          }
          agent.status = 'done';
          agent.inTurn = false;
          agent.recentStarts = [];
          this.clearForeground(agent);
        }
        break;
      }
      case 'agentToolStart': {
        agent = this.agent(msg.id);
        agent.observed = true;
        agent.status = 'active';
        if (msg.permissionActive !== true) agent.blocked = false;
        if (msg.runInBackground === true) {
          agent.background.add(msg.toolId);
          agent.clocks.delete(msg.toolId);
        }
        // Turn-end and reconnect re-sends repeat a live tool's start.
        if (agent.known.has(msg.toolId)) break;
        agent.known.add(msg.toolId);
        if (!agent.inTurn) this.beginTurn(agent);
        if (msg.replay !== true) {
          agent.hadTools = true;
          if (completesBurst(agent, now)) triggers.push({ id: msg.id, mood: Mood.STRESSED });
        }
        if (
          msg.runInBackground !== true &&
          msg.isTeammateSpawn !== true &&
          !this.isWaitingTool(msg)
        ) {
          agent.clocks.set(msg.toolId, { since: now, reported: false });
        }
        break;
      }
      case 'agentToolDone': {
        agent = this.agent(msg.id);
        agent.clocks.delete(msg.toolId);
        agent.known.delete(msg.toolId);
        if (msg.isError === true) {
          agent.failures++;
          triggers.push({ id: msg.id, mood: Mood.ERROR });
        }
        break;
      }
      case 'agentToolsClear': {
        agent = this.agent(msg.id);
        agent.blocked = false;
        this.clearForeground(agent);
        break;
      }
      case 'agentToolPermission': {
        agent = this.agent(msg.id);
        if (msg.replay === true && !agent.observed) break;
        agent.observed = true;
        agent.blocked = true;
        break;
      }
      case 'agentToolPermissionClear': {
        agent = this.agent(msg.id);
        if (msg.parentToolId !== undefined) {
          const sub = agent.subs.get(msg.parentToolId);
          if (sub) sub.blocked = false;
        } else {
          agent.blocked = false;
          for (const sub of agent.subs.values()) sub.blocked = false;
        }
        break;
      }
      case 'subagentToolStart': {
        agent = this.agent(msg.id);
        // A Sub-agent whose spawn this client never saw start is a watched
        // background spawn: it outlives the parent's turn.
        if (!agent.known.has(msg.parentToolId)) agent.background.add(msg.parentToolId);
        const sub = this.sub(agent, msg.parentToolId);
        if (sub.clocks.has(msg.toolId)) break;
        if (completesBurst(sub, now)) {
          triggers.push({ id: msg.id, parentToolId: msg.parentToolId, mood: Mood.STRESSED });
        }
        if (!this.isWaitingTool(msg)) {
          sub.clocks.set(msg.toolId, { since: now, reported: false });
        }
        break;
      }
      case 'subagentToolDone': {
        agent = this.agent(msg.id);
        agent.subs.get(msg.parentToolId)?.clocks.delete(msg.toolId);
        if (msg.isError === true) {
          agent.failures++;
          triggers.push({ id: msg.id, parentToolId: msg.parentToolId, mood: Mood.ERROR });
        }
        break;
      }
      case 'subagentToolPermission': {
        agent = this.agent(msg.id);
        this.sub(agent, msg.parentToolId).blocked = true;
        break;
      }
      case 'subagentClear': {
        agent = this.agent(msg.id);
        agent.subs.delete(msg.parentToolId);
        agent.background.delete(msg.parentToolId);
        agent.known.delete(msg.parentToolId);
        break;
      }
      default:
        break;
    }
    if (agent) this.sync(agent, now);
    return triggers;
  }

  /** Long-running check, called on a fixed cadence: one stressed per character per tick. */
  tick(now: number): MoodTrigger[] {
    const triggers: MoodTrigger[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.live && crossedThreshold(agent, now)) triggers.push({ id, mood: Mood.STRESSED });
      for (const [parentToolId, sub] of agent.subs) {
        if (sub.live && crossedThreshold(sub, now)) {
          triggers.push({ id, parentToolId, mood: Mood.STRESSED });
        }
      }
    }
    return triggers;
  }

  private agent(id: number): AgentMood {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = newAgent();
      this.agents.set(id, agent);
    }
    return agent;
  }

  private sub(agent: AgentMood, parentToolId: string): Actor {
    let sub = agent.subs.get(parentToolId);
    if (!sub) {
      sub = newActor();
      agent.subs.set(parentToolId, sub);
    }
    return sub;
  }

  private beginTurn(agent: AgentMood): void {
    agent.inTurn = true;
    agent.hadTools = false;
    agent.failures = 0;
  }

  /** Turn end: foreground tools and their Sub-agents are gone; background spawns stay. */
  private clearForeground(agent: AgentMood): void {
    for (const toolId of agent.known) {
      if (!agent.background.has(toolId)) agent.known.delete(toolId);
    }
    agent.clocks.clear();
    for (const parentToolId of agent.subs.keys()) {
      if (!agent.background.has(parentToolId)) agent.subs.delete(parentToolId);
    }
  }

  private sync(agent: AgentMood, now: number): void {
    setLive(agent, agent.observed && agent.status === 'active' && !agent.blocked, now);
    for (const sub of agent.subs.values()) setLive(sub, agent.observed && !sub.blocked, now);
  }
}

/** A permission prompt or a Done checkmark outranks a Mood bubble. */
export function isMoodBubbleCovered(
  ch: Pick<Character, 'bubbleType' | 'waitingAwaitingInput'>,
): boolean {
  return (
    ch.bubbleType === 'permission' || (ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput)
  );
}

/** Counts a shown Mood bubble down; its clock pauses while a priority bubble covers it. */
export function advanceMoodBubble(
  ch: Pick<Character, 'moodType' | 'moodTimer' | 'bubbleType' | 'waitingAwaitingInput'>,
  dt: number,
): void {
  if (!ch.moodType || isMoodBubbleCovered(ch)) return;
  const remaining = (ch.moodTimer ?? 0) - dt;
  if (remaining <= 0) {
    ch.moodType = null;
    ch.moodTimer = 0;
  } else {
    ch.moodTimer = remaining;
  }
}
