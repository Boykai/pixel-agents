# GitHub Copilot compatibility

Pixel Agents observes Copilot sessions; it does not own or resume an adopted
session, answer its questions, or approve its tools. Copilot and Claude are
different providers, not interchangeable event formats.

## Evidence and support boundaries

The local Copilot App used during development reported `copilotVersion: "0.0.0"`
in its transcript. That value is not a meaningful minimum supported version.
No independent `copilot` executable was available on the development machine's
PATH. Official documentation establishes candidate capabilities, but does not
prove that every App release includes them.

| Source                    | What it establishes                                                          | What it does not establish                                          |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Local `events.jsonl`      | Recorded tool activity, interaction boundaries and explicit child identities | A process is still running merely because its transcript exists     |
| `workspace.yaml`          | CLI-provided session title and repository/workspace metadata                 | An authoritative App-local project or session identifier            |
| Copilot hooks             | Events supported by the installed CLI and its enabled/trusted hooks          | That an already-running App process will load newly installed hooks |
| SDK event interfaces      | Possible live context, permission, input and child-task telemetry            | Passive attachment to arbitrary App sessions                        |
| Documented App deep links | Navigation with the correct App or GitHub task ID                            | That a CLI session UUID can be substituted for an App ID            |

Local file discovery cannot observe a session running exclusively on another
host or in the cloud. A remote observation bridge must be explicitly supported,
authenticated and enabled before those sessions can be claimed as tracked.

## Implemented coverage

| Capability                         | Copilot behavior                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed offices                      | Claude and Copilot have independent session identities, discovery, tool classifications and consent in both surfaces.                                     |
| Local discovery                    | New first-batch activity is detected even after an empty startup. Existing saved history is baselined rather than imported wholesale.                     |
| Activity and requests              | Explicit tool, input and permission evidence is reduced together across hooks and transcripts. Silence never establishes a Copilot permission wait.       |
| Children                           | Unnamed work remains a Sub-agent; positively named background work becomes a Teammate. Child activity and completion are routed separately from the lead. |
| Recovery                           | Bounded tail reads hydrate current state without replaying historical notifications. Incomplete evidence produces Unknown.                                |
| Labels                             | CLI-provided repository/workspace and session titles are used, including observed title changes. No guessed App IDs or metadata mapping files are used.   |
| VS Code launch                     | The selected provider owns the command and expected transcript path. Copilot uses a fresh UUID with `--session-id` and requires its executable on PATH.   |
| Context                            | An explicit occupancy/limit snapshot is supported when emitted. The observed App did not supply it; billing totals are not a substitute.                  |
| App navigation and remote sessions | Unavailable without an authoritative supported identity/observation interface. No SDK resume or private database workaround is used.                      |

This is source-based capability coverage, not a claim that every installed App
version emits every event. Existing CLI/App processes may need a user-initiated
restart to load newly consented hooks; Pixel Agents never restarts them.

Copilot terminals launched by Pixel Agents are linked through their allocated
session UUID. Other Copilot sessions are observed as external agents: a terminal
name or focus alone cannot establish which transcript it owns.

## Transcript semantics

These distinctions are essential to avoid false status and missing characters:

- `assistant.turn_end` is an individual model-step boundary, not necessarily
  completion of a user request. One observed session had 15 user messages but
  approximately 690 model turns.
- `hook.start` with `hookType: "agentStop"` supplies an interaction-completion
  signal. Later activity can start another interaction; completion is not
  session deletion.
- `hook.start` with `hookType: "sessionEnd"` occurred repeatedly within the same
  live App session. It must **not** despawn the session. The matching name in
  official hook documentation is not proof of matching App transcript semantics.
- An outer `agentId` scopes a record to a child instance. Child tool/turn records
  must not change the lead's activity.
- `subagent.started`/`completed` supply an explicit spawning tool-call ID and
  child identity. Display names and agent types are not unique identities.
- `session.usage_checkpoint` contains spend/checkpoint information, not a current
  context-window percentage. Do not sum it into a context gauge.
- Context gauges require an explicit current occupancy and a valid token limit.
  Missing telemetry is unavailable, not zero and not a guessed model limit.

Fixtures must contain synthetic values matching the observed structure, never
copied prompts, code, credentials, or user transcripts.

## Consent and safety

Earlier experimental builds reported Copilot hooks as installed even though
installation was a no-op. They could persist a `granted` consent record without
writing a hook. That legacy record does **not** authorize the new real hook
installation. Copilot hook consent is scoped to
`copilot-observation-hooks-v1`; existing Claude consent is unchanged.

Observational hooks must not return tool permission decisions. A
`permissionRequest` hook means permission is being evaluated, not necessarily
that the user is being prompted. Long tool execution or silence is not proof of
a permission wait.

Do not automatically resume sessions to inspect them, restart active App
sessions to load integrations, read private App databases, or guess deep links.
Saved history stays out of the office unless explicitly tracked. When current
state cannot be established, the correct observation is unknown.

## Advanced live bridge

Current official SDK source exposes richer telemetry and experimental host-bound
CLI extension interfaces. An opt-in bridge is a planned capability, **not a
verified external-App attachment mechanism**. It must remain disabled/unavailable
until a compatible released interface and the installed App's support are
established. Hook/transcript monitoring must not depend on it.

Specifically, `joinSession()` in a CLI-hosted extension and `resumeSession()` on
an SDK client do not establish a general observation-only connection to an
already-running App session. Runtime IDs, App-local IDs and GitHub task IDs remain
separate.

## References

- [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Hook setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [CLI commands](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions)
- [Extension tutorial](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- [App deep links](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links)
- [SDK session events](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
- [SDK extension API](https://github.com/github/copilot-sdk/blob/main/nodejs/src/extension.ts)

SDK `main` and online documentation can be newer than a released CLI/App. Tests
and a compatibility matrix for actual installed versions are required before
claiming parity.
