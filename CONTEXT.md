# Pixel Agents

Pixel Agents turns AI coding sessions into animated characters in a pixel-art office. This glossary is the canonical language for contributors and integrators; end-user docs may simplify it but must never contradict it.

## Hosts & Adapters

**Host**:
The machine Pixel Agents runs on — a laptop, a phone, a VPS, a Raspberry Pi. The office is the same on every host, and can be reached from another device.
_Avoid_: platform, environment, server (that's the runtime process)

**Adapter**:
The integration that connects one editor or application — VS Code, standalone, a macOS app, and the like — to Pixel Agents. An adapter composes the runtime and the office UI, and binds them to that environment's terminals, storage, and conventions. One adapter per editor or application; VS Code and standalone are the two today.
_Avoid_: host (that's the machine it runs on), surface, flavor, platform, edition

**Standalone**:
The adapter that serves the office to a browser from a local server, independent of any editor.
_Avoid_: CLI (that's the entry command, not the adapter), browser mode

## Agents & Teams

**Agent**:
An AI coding session tracked by Pixel Agents, whether spawned from the office or adopted from an external terminal.
_Avoid_: bot, terminal (as a synonym), session (as a synonym)

**Headless agent**:
An agent with no terminal — a non-interactive run adopted from outside the office, for example. A full citizen: it has a seat and can be selected, but there is no terminal to focus. Agents it spawns are sub-agents or teammates like anyone else's. Optionally drawn as a Ghost.

**Character**:
The animated pixel-art figure representing an agent in the office. An agent has a status and a session; its character has a position and an animation state.
_Avoid_: avatar, sprite (a sprite is the image asset, not the figure)

**Ghost**:
A character drawn translucent because its agent is headless — the visual shorthand for "nothing to focus here". Opt-in: off unless the user turns on "Display Headless as Ghosts", and never used in adapters without terminals, where every agent would qualify and the cue would say nothing. Teammates and sub-agents are never ghosts; clicking one reaches its lead's or parent's terminal.
_Avoid_: faded, dimmed, transparent, inactive (that's a status)

**Sub-agent**:
An unnamed piece of delegated work spawned by an agent, visualized with its own character near its parent — around it, not in a seat. Not an Agent (no session of its own) and not a Teammate (no name). It exists only for the duration of its task, which may outlive the parent's turn. Having no name is what makes it a sub-agent.
_Avoid_: subtask (UI label prefix only)

**Team**:
A Lead plus the Teammates it spawned. A team exists because a teammate was spawned — whether or not the CLI recorded one. A CLI's team registry is evidence of a team, never its definition.

**Lead**:
The agent that spawned a Team's teammates. An agent becomes a lead the moment it spawns its first teammate.
_Avoid_: parent (that's the sub-agent relationship), orchestrator

**Teammate**:
A named agent spawned by another agent — the name is what makes it a teammate. Its spawner is its Lead, and together they form a Team. Every teammate has its own transcript and sits in a seat; it may or may not have its own session or terminal — how it runs never changes what it is.
_Avoid_: inline teammate, tmux teammate, session teammate (former run-style distinctions; a teammate's run style is a property, not an identity)

## Agent Lifecycle

**Launch**:
Start a new agent from the office.
_Avoid_: spawn (that's the character-level visual event), create

**Adopt**:
Begin tracking a session that was started outside the office. An adopted agent is a full citizen.
_Avoid_: import, attach

**Spawn / Despawn**:
The character-level visual event: a character materializing into or dissolving out of the office. An agent is launched or adopted; its character spawns.

**Dismiss**:
Remove an agent from the office by user choice, without judging its session. A dismissed session is not re-adopted.
_Avoid_: close, delete

**Orphaned**:
An agent whose transcript has been deleted, so the session it represents no longer exists. The office removes orphaned agents automatically.
_Avoid_: stale (implies inactivity or age, which never removes an agent), dead, ended

## Interaction

**Select**:
Mark a character as the current subject in the office (the white outline). Selection is what seat reassignment operates on.
_Avoid_: focus (reserved for terminals), highlight

**Follow**:
The camera tracking the selected character or a clicked Pet — never both: following one ends following the other. Ends on manual pan or deselection (for a Pet: clicking it again or clicking empty space); a Pet follow also ends when the Layout editor opens.
_Avoid_: track

**Focus**:
Bring an agent's terminal to the front. Reserved exclusively for terminals — never the in-office highlight.

## First Run

**Intro**:
The four-step first-run tour the Greeter speaks: welcome, Claude Code, hooks consent, all set. The hooks consent ask is one step of it, not a separate dialog.
_Avoid_: onboarding, tutorial, wizard, consent modal

**Greeter**:
The character that speaks the Intro. Not an agent and not a Pet: it has no session, takes no seat, never wanders, and exists exactly as long as the Intro is open.
_Avoid_: mascot, tutorial character

## Agent Status

**Active**:
An agent that is executing its turn.
_Avoid_: busy, working, running

**Inactive**:
An agent that is not executing. Comes in exactly three forms: done, waiting for input, or permission request.
_Avoid_: waiting (the wire protocol's historical umbrella term), idle

**Done**:
The inactive form where the agent finished its turn and nothing is pending.

**Waiting for input**:
The inactive form where the agent asked the user something and is blocked on a reply.

**Permission request**:
The inactive form where the agent is blocked until the user approves a tool use. Unlike the other two forms, it can occur mid-turn.

**Activity label**:
The human-readable line describing what an agent is doing right now (e.g. "Reading foo.ts"), shown in its hover/focus details. The compact label above the character shows the normalized project name instead.
_Avoid_: status text, tool status

**Speech bubble**:
The indicator above a character announcing a form of inactivity: "…" for a permission request (stays until resolved), a checkmark for a finished turn (fades on its own).
_Avoid_: bubble alone when ambiguous, notification

**Mood**:
A character's short-lived reaction to its own recent work: error when one of its tools fails, happy when a turn that used tools ends done with no tool failure, stressed when it starts tools in rapid succession or one tool keeps running. Derived in the office UI from the protocol alone, so every provider gets it; never persisted.
_Avoid_: emotion, emote, status (a mood is not a form of inactivity)

**Mood bubble**:
The small icon above a character showing its current mood, gone after a few seconds. It shares the speech bubble's slot and yields to it: a permission request or a done checkmark covers it. The "Mood bubbles" setting turns them off per adapter.
_Avoid_: emoji, speech bubble (that one announces inactivity)

**Context gauge**:
The small bar under an agent's activity label showing how full its context window is. Every agent has one once it has taken a turn; sub-agents never do, having no session of their own. It reads the newest turn, so it falls when a session compacts or clears — it is a level, not a total.
_Avoid_: fuel gauge, health bar, token gauge (tokens are the unit, context is the thing)

**Token usage**:
What an agent's session has used so far, in the units its CLI records: input, output, cache-write and cache-read tokens for Claude Code; premium requests and nano AIU for GitHub Copilot. Copilot writes token counts only when a run shuts down, and its next checkpoint carries none, so its tokens show only from a shutdown until the next checkpoint. A running total, unlike the context gauge (a level); `/clear` starts a new session, which restarts it at zero. Never estimated or priced. A total the runtime could not read back to the session's start is labelled **since tracked**.
_Avoid_: context usage (that is the context gauge), cost, spend, billing

**Usage panel**:
The panel opened from the toolbar's "Usage" button, listing every agent's token usage and the office-wide totals.
_Avoid_: dashboard, stats panel

## Office & Layout

**Office**:
The whole simulated world: the layout plus its inhabitants — characters and pets — and their live state.
_Avoid_: map, scene, room, level

**Layout**:
The office's spatial arrangement: the tile grid, floors, walls, carpets, areas, and furniture. It is the part of the office that the editor edits and that can be exported and shared.
_Avoid_: floor plan, blueprint, map

**Default layout**:
The layout bundled with the build, used for a first run and restored on demand by Reset to Default
in the Layout toolbar. That action discards the whole office in one undoable edit, so it is behind
two confirmations; it is distinct from Reset, which only reverts to the last save.
_Avoid_: factory layout, stock layout

**Room**:
A furnished floor rectangle bounded by walls and connected to existing floor through an opening.
Generate Room adds one room from the Layout toolbar; its interior is 5 to 8 tiles on each side,
with walls outside those dimensions. Rooms are ordinary editable tiles and furniture, not
persisted entities or Areas. Open floor space can also receive a room attachment.

**Tile**:
One cell of the office grid.

**Floor**:
The walkable surface of a tile, painted with a pattern and color.

**Wall**:
A blocking tile that visually connects to adjacent walls.

**Carpet**:
A decorative layer painted over floor tiles.

**Area**:
A named region of tiles. Areas exist so workspace folders can be mapped to them.
_Avoid_: zone, region

**Area mapping**:
The assignment of a workspace folder to one or more areas. Many folders may share an area. Agents launched from a folder prefer seats inside any of its areas.

**Furniture**:
A placeable item in the layout — desks, chairs, storage, electronics, decor.
_Avoid_: object, prop, item

**Desk**:
Furniture that seats face and that hosts surface items. An agent's character sitting at its desk is the visual expression of being active.

**Sign**:
Furniture that shows a line of pixel text. The text, its color, glyph size, and pixel scale live on the placed item, and its sprite and footprint derive from them, so a longer text takes more tiles. Unlike other floor furniture, a sign may also hang on a wall. It is placed and edited through the Sign editor in the Layout editor.
_Avoid_: label (that's the Activity label or a character's name label), text furniture, banner

**Draw layer**:
A per-furniture depth adjustment from −4 to +4. Each step moves the item one tile row forward or backward in draw order, on top of the default depth rules (footprint, chairs, surface items, background tiles, walls). Whatever sits on a desk moves with the desk's layer. Layer 0 is the default and leaves the order unchanged.
_Avoid_: z-index, z-order, layer (unqualified; carpets are a layer too)

**Seat**:
A sittable spot the office derives from chair furniture, assignable to exactly one agent.
_Avoid_: chair (that's the furniture), workstation

**Chair**:
The furniture category whose items create seats. Every footprint tile of a chair yields one seat.

**Seat assignment**:
Which agent owns which seat. Persisted, and changeable by selecting a character and clicking a free seat.

**Pet**:
An animated creature that lives in the office and belongs to no agent. Purely decorative: it wanders like a character, trails a nearby one for a while, sits beside the characters of inactive agents, naps, and scurries away from those of active agents. Placed with the Layout editor; clicking one shows a heart and makes the camera Follow it. (The code calls the trailing FOLLOW; in prose, Follow always means the camera.)
_Avoid_: mascot, animal

**Wander**:
The stroll a character takes away from its seat while its agent is done. Characters whose agents are waiting for input or awaiting a permission stay seated.
_Avoid_: roam, patrol

## Activity Detection

**Hook**:
A push notification an AI tool sends about its own session activity, delivered to Pixel Agents as it happens.

**Transcript**:
The append-only record of a session. Read in both detection modes for tool content.
_Avoid_: JSONL (Claude's file format, not the concept), log

**Hooks mode**:
The preferred detection mode, in which agent status is driven by hooks.

**Heuristic mode**:
The fallback detection mode, in which agent status is inferred from transcript activity, timers, and silence.
_Avoid_: file fallback, transcript mode, polling mode

## Integration Boundary

**Provider**:
The integration that connects one coding-agent CLI — Claude Code, Codex, Pi, Antigravity, OpenClaw, and the like — to Pixel Agents. A provider normalizes its CLI's raw activity into agent events and knows how to install that CLI's hooks. One provider per CLI; Claude Code is the reference implementation.
_Avoid_: plugin, connector

**Agent event**:
The canonical, CLI-agnostic description of something happening in a session: a tool started, a turn ended, a teammate went idle. Providers produce agent events; everything downstream consumes only these, never CLI-specific names.
_Avoid_: hook event (the raw, CLI-specific payload before a provider normalizes it)

**Tool failure**:
A tool call that ran and reported that it failed. The provider flags it on the tool's end event, so everything downstream counts it once, on the character that ran the tool (the agent or its sub-agent). It drives the error mood.
_Avoid_: tool error (ambiguous with a tool that never ran), crash

**Runtime**:
The adapter-independent core that tracks agents and drives the office. It is a separate thing from the adapters that compose it, the providers that feed it, and the office UI it serves.
_Avoid_: server, backend

**Transport**:
The channel carrying protocol messages between the office UI and the runtime. The protocol is identical on every adapter; only the wire differs.
_Avoid_: connection, socket

**Protocol**:
The message contract between the office UI and the runtime, shared by every adapter and defined in a single source of truth.
_Avoid_: API
