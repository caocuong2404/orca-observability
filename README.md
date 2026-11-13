# Observability for Orca

An audit trail for your Orca workspace, in the sidebar. Observability records what
happens across every terminal and agent — streamed live into a filterable feed.

## What it captures

| Kind | Source | Detail |
| --- | --- | --- |
| Output | Polls `orca terminal list` + cursor reads for every terminal on every host | New output lines since the last poll, chunked, with title, worktree and agent identity |
| Sent | `terminal.send` hook | Text Orca, the CLI or a plugin sent to a terminal (a person typing is never hooked) |
| Prompt | `agent.prompt.before` hook | Prompts submitted to agents |
| Tool | `agent.tool.before` / `agent.tool.after` hooks | Agent tool calls with inputs and outputs |
| Agent | `agent.status.changed` event | Agent state transitions (working, blocked, waiting, done) |
| Workspace | `workspace.created` / `removed` / `changed` events | Workspace lifecycle |

The worker keeps the last N events (Settings → Observability, default 500) in memory
and mirrors a snapshot plus per-terminal output cursors to plugin storage, so the
feed survives worker restarts without replaying output.

Output capture shells out to the `orca` CLI bundled with the app (`terminal list`,
`terminal read --cursor`). If the CLI cannot be found, the worker falls back to
host calls, which only see the focused workspace's terminals and any terminal that
appears through hooks; the panel notes the degraded mode.

## Install

```
orca plugin install caocuong2404/orca-observability
```

Or from source: Settings → Plugins → Development folders → this folder.

## Settings

- **Terminal output poll interval** — seconds between output sweeps (default 3).
- **Capture terminal output** — turn off to record only commands, prompts, tools and
  lifecycle events.
- **Audit feed size** — max buffered events (default 500).
- **Output lines per event** — burst chunking (default 200).

## Commands

- `Observability: Clear audit feed` — empties the feed and the stored snapshot.

## Honest limitations

- Output capture uses `terminal read`, which returns accumulated output as
  escape-stripped text. TUI repaints (spinners, progress bars) appear as stacked
  fragments, and output produced between polls can be missed if it exceeds the
  retained window or the per-poll page budget.
- Human keystrokes typed directly into a terminal are not visible to Orca's hook
  surface; only text sent through Orca (CLI, plugins, agent prompts) is recorded.
  For keystroke-level auditing of every command a shell runs, pair this with a
  shell-level recorder.
- In fallback mode (no `orca` CLI reachable) output capture only covers the
  focused workspace's terminals plus terminals seen through hooks.

## Develop

```
orca plugin validate .
orca plugin test .
orca plugin check .
orca plugin dev watch . --check --shot ./.orca/shots --json
```

No build step: `.ts`/`.tsx` files load as written. Types regenerate with
`orca plugin types .` into `.orca/types/` (gitignored).
