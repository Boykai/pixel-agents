# Boykai/pixel-agents: feature comparison

This fork of [pixel-agents-hq/pixel-agents][base] (the **base**) imports the features of the
community fork [hootbu/pixel-agents][hootbu] (**hootbu**) and adds GitHub Copilot support and room
generation. The imported features were rebuilt on the base's current architecture, not copied
over, so they also work in the standalone browser app and with GitHub Copilot agents.

The comparison covers base [v1.4.1][base-v141], which this fork builds on; hootbu's `main` at
[a6c4d85][hootbu-v130], hootbu's own release 1.3.0; and this fork's `main`. hootbu forked from the
base on 2026-02-21, at [13d2c17][hootbu-fork-point], before the base's own v1.3.0 and v1.4
releases.

✅ available · ➖ partial or different · ❌ not available. PR links point to this fork.

### Imported from hootbu

| Feature                                    | Base                  | hootbu                   | This fork    | What this fork ships                                                                                                                                                 |
| ------------------------------------------ | --------------------- | ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity panel (hootbu: Tasks)             | ❌                    | ✅                       | ✅ [#8][pr8] | Every agent with its Sub-agents and Teammates nested underneath. Click a row to select and follow its Character                                                      |
| VS Code status bar shortcuts               | ❌                    | ✅                       | ✅ [#8][pr8] | **Agent** launches an agent. **Activity** opens the same list as a live Quick Pick: picking an agent focuses its terminal, or selects its Character when it has none |
| Token usage dashboard                      | ❌                    | ✅                       | ✅ [#4][pr4] | Per-agent rows and office-wide totals: tokens for Claude Code, premium requests for Copilot. Read from transcripts, never estimated                                  |
| Agent nicknames                            | ❌                    | ➖ at launch only        | ✅ [#7][pr7] | Name an agent at launch, or rename any agent later, including adopted and Copilot App sessions                                                                       |
| Costumes                                   | ❌                    | ✅                       | ✅ [#7][pr7] | Pick one of six characters and a hue per agent. Launching under a nickname you used before brings back its costume and seat                                          |
| Pixel text signs                           | ❌                    | ✅                       | ✅ [#5][pr5] | Signs on floors or walls, with a color, 3×5 or 5×7 glyphs and a pixel scale. Edits are undoable                                                                      |
| Draw layers                                | ❌                    | ➖ bring-to-front toggle | ✅ [#5][pr5] | **Forward** and **Backward** move any furniture through nine layers, −4 to +4                                                                                        |
| Mood reactions                             | ❌                    | ✅                       | ✅ [#6][pr6] | Happy, error and stressed bubbles. Errors come from a new tool-failure signal that both providers report. Can be turned off                                          |
| Achievements                               | ❌                    | ✅                       | ✅ [#9][pr9] | The same eight, kept in one record across projects, windows and surfaces. Popups can be turned off                                                                   |
| Pet behaviors                              | ➖ wander, trail, pet | ✅                       | ✅ [#3][pr3] | Pets also sit beside inactive agents, nap and scurry away from active ones                                                                                           |
| Pet camera follow                          | ❌                    | ✅                       | ✅ [#3][pr3] | Click a pet to have the camera follow it                                                                                                                             |
| Remembered zoom                            | ❌                    | ✅                       | ✅ [#2][pr2] | Whole-step zoom, remembered separately for VS Code and the standalone browser                                                                                        |
| VS Code panel keeps its state while hidden | ❌                    | ✅                       | ✅ [#2][pr2] | The panel no longer reloads when you switch away and back                                                                                                            |

[#10][pr10] verified the imported features together and fixed the interactions between them.

### Not imported from hootbu

| hootbu feature                                                          | Why it was not imported                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Permission mode prompt on every launch ([61bcec1][hootbu-61bcec1])      | The base's **+ Agent** menu already offers a **Skip permissions mode** launch                                                        |
| Adaptive status timers and early completion ([a4ca7f4][hootbu-a4ca7f4]) | Hooks mode reports permission requests and turn ends directly. Without hooks, the base's fixed timers still apply                    |
| Cats and dogs managed in Settings                                       | The provenance of their sprites could not be verified. Their behaviors were ported to the base's pets, which you place in the editor |
| Seat Mode toggle                                                        | The base already reassigns seats: click a Character, then a free seat                                                                |
| 1 px zoom steps                                                         | Zoom moves in whole steps so the pixel art stays crisp                                                                               |

### Added by this fork

| Feature                           | PR                    | Details                                                                                                                                                                                       |
| --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot support            | [#1][pr1]             | Tracks Copilot CLI sessions and observes local Copilot App sessions through their transcripts, with optional hooks you consent to. See [Copilot compatibility](docs/copilot-compatibility.md) |
| Mixed offices                     | [#1][pr1]             | Claude Code and Copilot agents share one office, each with its own discovery, consent and hooks                                                                                               |
| Copilot in every imported feature | [#2][pr2]–[#10][pr10] | The Activity panel, token usage, nicknames, costumes, mood reactions and achievements all count Copilot agents                                                                                |
| Generate Room                     | [#1][pr1]             | One click in the Layout editor adds a furnished workspace, meeting room or lounge, with an interior of 6 to 15 tiles on each side, connected to the office as one undoable edit               |
| Reset to Default                  | [#1][pr1]             | Restores the layout Pixel Agents ships with, after two confirmations. Undo brings your office back                                                                                            |
| Agent details                     | [#1][pr1]             | Labels show each agent's nickname or project. Hover or select a Character for its activity, session, role, source and context usage                                                           |
| Unknown agents stay hidden        | [#1][pr1]             | An agent whose current activity can't be established is hidden until it is observed again, instead of being shown as a guessed Idle                                                           |

### In the base, missing from hootbu

hootbu forked before these base features landed. This fork inherits all of them:

- The standalone browser app (`npx pixel-agents`), which shows the same office as VS Code
- Hooks mode, for instant activity detection
- Claude Agent Teams, with Lead and Teammate Characters, team roles and team lifecycle. hootbu shows spawned background agents, but has no team model
- A context gauge on every agent
- Carpets and workspace Areas
- Pets placed in the layout editor, and external character, pet and furniture packs
- Headless agents drawn as ghosts
- Running the VS Code extension and standalone servers side by side, the AsyncAPI protocol contract, and the Playwright e2e suite

## Using this fork

This fork doesn't publish packages. The Marketplace, Open VSX and npm links further down install the
base's releases, which have none of the features above. Build this fork from source instead, with
Node.js 20 or later:

```bash
git clone https://github.com/Boykai/pixel-agents.git
cd pixel-agents
npm install
npm run build
node dist/cli.js --providers claude,copilot
```

The last command starts the standalone browser app for Claude Code and GitHub Copilot, and prints its
URL. For VS Code, press **F5** to launch the Extension Development Host, or
[package and install a `.vsix`](CONTRIBUTING.md#build-and-install-the-packaged-extension-locally).

[base]: https://github.com/pixel-agents-hq/pixel-agents
[base-v141]: https://github.com/pixel-agents-hq/pixel-agents/releases/tag/v1.4.1
[hootbu]: https://github.com/hootbu/pixel-agents
[hootbu-v130]: https://github.com/hootbu/pixel-agents/commit/a6c4d85
[hootbu-fork-point]: https://github.com/pixel-agents-hq/pixel-agents/commit/13d2c17
[hootbu-61bcec1]: https://github.com/hootbu/pixel-agents/commit/61bcec1
[hootbu-a4ca7f4]: https://github.com/hootbu/pixel-agents/commit/a4ca7f4
[pr1]: https://github.com/Boykai/pixel-agents/pull/1
[pr2]: https://github.com/Boykai/pixel-agents/pull/2
[pr3]: https://github.com/Boykai/pixel-agents/pull/3
[pr4]: https://github.com/Boykai/pixel-agents/pull/4
[pr5]: https://github.com/Boykai/pixel-agents/pull/5
[pr6]: https://github.com/Boykai/pixel-agents/pull/6
[pr7]: https://github.com/Boykai/pixel-agents/pull/7
[pr8]: https://github.com/Boykai/pixel-agents/pull/8
[pr9]: https://github.com/Boykai/pixel-agents/pull/9
[pr10]: https://github.com/Boykai/pixel-agents/pull/10

---

<h1 align="center">
  <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">
    <img src="webview-ui/public/banner.png" alt="Pixel Agents">
  </a>
</h1>

<h2 align="center">The most playful way to orchestrate your agents</h2>

<div align="center">

[![version](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fversion.json)](https://github.com/pixel-agents-hq/pixel-agents/releases)
[![marketplaces](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Finstalls.json)](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents)
[![npm downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fpablodelucca%2F3cd28398fa4a2c0a636e1d51d41aee39%2Fraw%2Fnpm-downloads.json)](https://www.npmjs.com/package/pixel-agents)
[![stars](https://img.shields.io/github/stars/pixel-agents-hq/pixel-agents?logo=github&color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/stargazers)
[![license](https://img.shields.io/github/license/pixel-agents-hq/pixel-agents?color=0183ff&style=flat)](https://github.com/pixel-agents-hq/pixel-agents/blob/main/LICENSE)
[![discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white&style=flat)](https://discord.gg/Yk7jXebv9H)

</div>

<div align="center">
<a href="https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents">🛒 VS Code Marketplace</a> • <a href="https://open-vsx.org/extension/pablodelucca/pixel-agents">🛒 Open VSX</a> • <a href="https://www.npmjs.com/package/pixel-agents">📦 npm</a> • <a href="https://discord.gg/Yk7jXebv9H">👾 Discord</a> • <a href="https://github.com/pixel-agents-hq/pixel-agents/discussions">💬 Discussions</a> • <a href="CONTRIBUTING.md">🤝 Contributing</a> • <a href="CHANGELOG.md">📋 Changelog</a>
</div>

<br/>

Pixel Agents turns the AI coding agents running in your terminals into animated pixel-art characters working in a tiny office. They walk to their desks, sit down, type when they're editing files, read when they're searching, and flag you visually when they're stuck waiting for input.

It ships in two forms from the same codebase:

- **VS Code extension** — [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) and [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents). Agents launch into VS Code terminals; characters render in the panel area.
- **Standalone CLI** — `npx pixel-agents` starts a local server and serves the same office as a browser app, useful for tmux, remote, and non-VS Code workflows.

The architecture is agent-agnostic and editor-agnostic: a typed `HookProvider` interface defines the integration boundary. Claude Code and local GitHub Copilot sessions can share an office; Codex, Gemini, Cursor, and others are on the roadmap.

![Pixel Agents screenshot](webview-ui/public/office.png)

## Features

- **One agent, one character** — tracked Claude Code and GitHub Copilot sessions get their own animated characters
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Activity panel** — the toolbar's **Activity** panel lists what every agent is doing right now, with its sub-agents and teammates nested underneath; click a row to select and follow that character. In VS Code, the status bar's **Agent** and **Activity** shortcuts launch an agent and open the same list as a live Quick Pick
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor. **Generate Room** adds a furnished workspace, meeting room, or lounge in one click, and **Reset to Default** brings back the bundled office
- **Agent details** — each character's label shows its nickname or project, with a context gauge underneath. Hover or select a character for its activity, project, session, role, source (Claude Code or GitHub Copilot), and context usage, plus **Rename** and **Costume** buttons
- **Signs and draw layers** — put pixel-text signs on the floor or walls, and move any furniture forward or backward in draw order
- **Office pets** — pets wander, trail nearby characters, sit beside inactive agents, nap, and scurry away from active ones; click one to have the camera follow it
- **Speech bubbles** — visual indicators when an agent is waiting for input or awaiting permission
- **Token usage** — the toolbar's **Usage** panel shows each agent's recorded usage and the office-wide totals: input/output/cache tokens for Claude Code, premium requests for GitHub Copilot (tokens only once a Copilot session reports them). Read straight from the transcripts, never estimated or priced
- **Mood bubbles** — characters react to their own work: an error bubble when a tool fails, a happy one when a turn ends cleanly, a stressed one under rapid-fire or long-running tools (for Claude Code and GitHub Copilot; can be turned off in Settings)
- **Achievements** — eight milestones, from your first agent to a million tokens, unlocked by live Claude Code and GitHub Copilot activity and kept in one record across every project, window, and surface. A popup announces each unlock (can be turned off in Settings); **Settings → Achievements** shows your progress
- **Sound notifications** — optional chimes when an agent finishes its turn or requests permission
- **Sub-agents and Agent Teams** — see ephemeral sub-agents and persistent Claude teammates as separate characters, including team roles and lifecycle changes
- **Headless ghosts** — in VS Code, agents with no terminal to focus, such as sessions adopted from outside, can be drawn as translucent ghosts (**Settings → Display Headless as Ghosts**)
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Remembered zoom** — whole-step zoom keeps the pixel art crisp and is remembered separately for VS Code and the standalone browser; the VS Code panel keeps its state while hidden
- **Shared layout and assets** — import/export layouts and load external character, pet, and furniture packs
- **Areas** — paint named areas onto the office, map workspace folders to them, and new agents sit inside the areas mapped to their folder
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).
- **Nicknames and costumes** — name an agent in the VS Code **+ Agent** menu, or rename any agent (adopted Claude and GitHub Copilot sessions included) from its label. Give it a different character and hue in the **Costume** panel. The office remembers nicknames, and launching a new agent under a nickname you used before brings back that nickname's costume and seat.

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Where This Is Going

The vision is: play a game, build a product. Two goals follow from it: to build a familiar, intuitive interface for running and orchestrating a lot of agents; and to make the hours you spend doing it feel less like administration and more like play.

Roughly three stages get there:

1. **Everywhere, with everything.** Today it's local Claude Code and GitHub Copilot sessions in VS Code or the browser. It should be whatever agent you run, wherever you work. A new CLI is a subdirectory, not a rewrite — this is where help is most useful right now.
2. **Actually a game.** Health bars for rate limits and token budgets. Scores for whatever you care about. Furniture that _does_ things. Offices you open like save files, one per project.
3. **Expand the orchestration frontier.** Orchestrator characters. Form a team by dragging a box around them. Hand work between agents. Point them at a board and let them pick up tasks themselves.

Most of this is still ahead. See [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for what's open, and [CONTRIBUTING.md](CONTRIBUTING.md) to jump in.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) installed and configured; local Copilot App transcripts can also be observed
- **VS Code extension:** VS Code 1.105.0 or later
- **Standalone CLI:** Node.js 20 or later
- Windows, Linux, or macOS

## Getting Started

### VS Code extension

1. Install Pixel Agents from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) or [Open VSX](https://open-vsx.org/extension/pablodelucca/pixel-agents).
2. Open the **Pixel Agents** panel beside the terminal.
3. Click **+ Agent** to launch Claude Code. In a multi-root workspace, select the folder first.

To use Claude with `--dangerously-skip-permissions`, hover over **+ Agent** to find the **Skip permissions mode** button. Only use this when you accept the security implications.

Pixel Agents also detects Claude sessions started outside the extension. Turn on **Settings → Watch All Sessions** to include sessions from other workspaces.

For Copilot, set `pixel-agents.providers` to `["copilot"]` or `["claude", "copilot"]`.
Set `pixel-agents.launchProvider` to choose which CLI **+ Agent** launches.
Copilot launches require the `copilot` executable on PATH; observing existing
local App sessions does not. Claude's permission-bypass option is not applied to Copilot.

### Standalone CLI

Run Pixel Agents from the workspace whose Claude sessions you want to see:

```bash
cd /path/to/your/project
npx pixel-agents
```

The CLI chooses a free local port and prints the URL. Standalone does not launch Claude for you; start Claude Code in a terminal for the same workspace. To install the command globally instead:

```bash
npm install --global pixel-agents
pixel-agents
```

Use a fixed address or port when needed:

```bash
pixel-agents --port 3100
pixel-agents --host 127.0.0.1 --port 3100
pixel-agents --help
```

Select Copilot or a mixed office explicitly (the default remains Claude):

```bash
pixel-agents --provider copilot
pixel-agents --providers claude,copilot
pixel-agents --providers all
```

Copilot discovery reads `~/.copilot/session-state/` (or `COPILOT_HOME/session-state/`).
Enable **Watch All Sessions** to include other workspaces. Only newly observed
activity adopts an untracked session; saved history alone does not. A tracked
session with insufficient evidence is hidden until its activity is known, not shown as a guessed Idle.
Remote/cloud sessions without local events are not visible.

Copilot hooks require separate consent and install only an owned
`~/.copilot/hooks/pixel-agents.json` file (under `COPILOT_HOME` when configured).
The hooks observe activity and never approve or deny permission requests.
An older transcript-only Copilot consent record does not authorize this install.
See [Copilot compatibility](docs/copilot-compatibility.md) for status semantics,
capability limits, and why App-local navigation and passive SDK attachment are
not inferred from CLI session IDs.

The default bind address is `127.0.0.1`. Binding to `0.0.0.0` exposes the UI and WebSocket to the local network; do this only on a trusted network.

Open the URL the CLI prints - it carries a `?token=` for this session. Any browser can watch the office without it, but installing or removing hooks (which edits your agent tool's own settings file, like the `~/.claude/settings.json`) is only offered to a session that has the token, so an untokened client on the network cannot approve it. Open the bare address instead and the hooks toggle in Settings is refused, and reports the actual install state rather than appearing to work.

Treat that URL as a secret: the token is a bearer capability, not proof of being local. Whoever holds it can approve the hook install from anywhere the server is reachable — so don't paste the URL into a shared channel, and note that it also lands in your browser history and (unredacted) in the server's own request log.

### Running the extension and standalone together

The extension and standalone CLI can run at the same time. Each server registers under `~/.pixel-agents/servers/`; the hook script sends events to all active registrations. VS Code and standalone keep separate agents, seats, and settings while using the shared office layout.

Stop a standalone server with **Ctrl+C**. It removes only its own registration.

Hook installations and consent are shared across adapters. Removing the VS Code
extension retains them, because the extension cannot prove that standalone or
another installation no longer needs them. To remove the shared hooks, disable
each provider in Pixel Agents Settings before uninstalling.

## Customizing the Office

Click **Layout** to edit the office:

- Paint floor patterns and walls, with color and contrast controls.
- Click **Generate Room** to add a furnished workspace, meeting room, or lounge. Its interior is randomly 6 to 15 tiles on each side, it connects to existing floor through an opening, and it expands the grid when there's no free space inside. The whole room is one undoable edit, and everything in it stays editable.
- Click **Reset to Default** to replace the office with the layout Pixel Agents ships with. It asks twice before discarding your layout, and **Undo** brings it back.
- Place, rotate, recolor, select, and remove furniture.
- Add pixel-text **Signs** from the Decor tab (they can hang on walls), and use **Forward** / **Backward** to change a selected item's draw layer.
- Paint auto-tiling carpets and customize their main and accent colors.
- Add animated pets. Pets wander, trail nearby characters, sit beside inactive agents, nap (look for the "z"), and scurry away from active ones. Click a pet in the office to give it a heart and have the camera follow it; click it again, pan, or click empty space to stop following.
- Create named **Areas**, paint their tiles, and assign workspace folders to them.
- Undo/redo changes, then import or export the complete layout as JSON.

Layouts can grow to 64×64 tiles by clicking the ghost border outside the current grid.

Zoom with the **+** / **−** buttons or **Ctrl+scroll**. Zoom moves in whole steps so the pixel art stays crisp, and the label shows the current tile size in pixels (for example `32px`). Your zoom level is remembered, separately for VS Code and the standalone browser.

### Office assets

Bundled furniture, floors, walls, carpets, characters, and pets live under `webview-ui/public/assets/`. Furniture manifests describe sprites, rotation groups, state groups, and animation frames.

Use **Settings → Add Asset Directory** to load external characters, pets, and furniture. See [docs/external-assets.md](docs/external-assets.md) for furniture directory structure and manifest details. The visual asset manager at `scripts/asset-manager.html` helps create furniture manifests.

## How It Works

Pixel Agents uses two complementary detection paths:

- **Hooks mode** (default) — a hook script receives Claude events such as `SessionStart`, `PreToolUse`, `PermissionRequest`, and `Stop`. It discovers active Pixel Agents servers and sends authenticated events to each one.
- **Heuristic mode** (fallback) — when hooks are unavailable, the runtime infers agent status by scanning Claude's JSONL session transcripts under `~/.claude/projects/`. Transcripts are also read in hooks mode for details not present in an event.

The Claude provider normalizes both sources into a shared `AgentEvent` model. `AgentRuntime` updates the central state store, and the active transport sends typed messages to the React webview. The office renders through Canvas 2D with pathfinding and character state machines.

Copilot uses its own consented observational hooks and `events.jsonl` reducer.
Tool and child identities are merged across sources, and long-running tools do
not become permission waits merely because they are quiet. Copilot's model-step
`assistant.turn_end` and the App's recurring `sessionEnd` are not treated as
session termination. Agents with insufficient evidence are hidden until their activity is known.

Pixel Agents does not modify Claude Code. Its hook configuration and persistent data live under `~/.claude/` and `~/.pixel-agents/` respectively.

### Architecture

One `AgentRuntime` can track multiple providers in the same office. Each provider
owns an isolated parser, session router, discovery cursors, dismissals, and child
watchers; agent IDs and the aggregation store remain shared. Adapters use
`startDiscovery(workspacePaths)` to keep enumerating all selected providers, even
when no session directories exist at startup. Saved Copilot history is not
automatically adopted: files present at startup require observed growth. Newly
appearing files can be adopted from their first batch when bounded recovery proves
active work, without needing a second write or heartbeat. Already-tracked
sessions recover from a bounded transcript tail, with an explicit **unknown**
observation when that tail cannot establish current activity. Provider IDs survive
persistence and accompany agent snapshots and tool capabilities on the wire.
Selecting only some providers preserves other providers' persisted agents and seats;
their numeric IDs stay reserved until those providers are enabled again.

- **`core/`** — provider, adapter, transport, schema, and AsyncAPI message contracts with no runtime side effects.
- **`server/`** — shared Fastify server, agent runtime, persistence, Claude and Copilot providers, transcript scanning, and standalone CLI.
- **`adapters/vscode/`** — the VS Code adapter: terminal, persistence, and webview bridge.
- **`webview-ui/`** — React 19, Vite, Canvas 2D, and adapter-specific transports for VS Code and browser WebSocket clients.

The extension and CLI are bundled with esbuild; the webview is built with Vite. Unit tests use Vitest and Node's test runner, and end-to-end coverage uses Playwright against VS Code and standalone.

## Development

```bash
git clone https://github.com/Boykai/pixel-agents.git
cd pixel-agents
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host. To run the standalone bundle built from source:

```bash
node dist/cli.js
node dist/cli.js --providers claude,copilot
```

Common checks:

```bash
npm run check-types
npm run lint
npm test
npm run e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [e2e/README.md](e2e/README.md) for the end-to-end suite.

### Hosted Test Reports

Build the combined Allure report locally and stage it for Vercel:

```bash
npm run test
npm run e2e
npm run e2e -- --attach-videos-on-success
npm run vercel:prepare
```

Use `npm run test:report` to build the combined report without preparing the Vercel output, then `npm run test:report:open` to serve it locally.

The staged output serves the combined `e2e`, `server`, and `webview` Allure report at `/reports/allure/`; it does not include a standalone webview preview. GitHub Actions creates a Vercel Preview deployment only for same-repository pull requests targeting `main`. The deploy job expects `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets and skips fork pull requests.

## Troubleshooting

- **Standalone will not start:** verify Node.js 20+, omit `--port` to choose a free port, or select another fixed port.
- **An agent is missing:** confirm that its provider's **Instant Detection (Hooks)** setting is on (for example **Settings → Claude Code — Instant Detection (Hooks)**) and that the session belongs to the current workspace. Enable **Watch All Sessions** if needed. For Copilot, check that the standalone CLI was started with `--provider copilot` or `--providers claude,copilot`, or that `pixel-agents.providers` includes `"copilot"` in VS Code.
- **The UI looks disconnected:** open **Settings → Debug View** to inspect the server connection, transcript path, and latest agent data.
- **Extension and standalone are both running:** this is supported. Current versions create separate files under `~/.pixel-agents/servers/`; stopping one does not remove the other.

## Community & Contributing

Join the [Discord](https://discord.gg/Yk7jXebv9H) to chat with other users and follow development. Use [Issues](https://github.com/pixel-agents-hq/pixel-agents/issues) to report bugs or request features, and [Discussions](https://github.com/pixel-agents-hq/pixel-agents/discussions) for questions and ideas.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## Star History

<a href="https://www.star-history.com/?repos=pixel-agents-hq%2Fpixel-agents&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&theme=dark&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=pixel-agents-hq/pixel-agents&type=date&legend=bottom-right&sealed_token=Vn3YGMuZ_HFZAf56zIUQGCBJDYtDq38sOReKlcxWklxR_ilwVLynb7CPraf5uPhnAU7fwHXXoO88tzLkq9tpEYIExl4N8tcXOmu0ehAXPu5DdXNwjixYsxb00LSfeJ25f_jLkcZcTpRKLKYOb9p4_dR1jjAyrWDs7aicdbqejaDtLcVyj-oSoKkBfrS5" />
 </picture>
</a>

## Credits

Several features were ported from the community fork [hootbu/pixel-agents](https://github.com/hootbu/pixel-agents) (MIT, © 2026 Hootbu). The [feature comparison](#imported-from-hootbu) at the top of this file shows how each one differs from hootbu's version:

- Activity panel and VS Code shortcuts
- Token usage dashboard
- Agent nicknames and costumes
- Pixel text signs and draw layers
- Mood reactions
- Pet behaviors and pet camera follow
- Zoom persistence and panel retention
- Achievements

## License

Pixel Agents is available under the [MIT License](LICENSE).
