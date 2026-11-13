# Observability — Design Notes

> Temporary draft. Will be improved later.

Local audit trail for everything happening in Orca terminals, agents, and
workspaces. Runs as a trusted-worker Orca plugin; no external service, no
network calls, all state stays on the user's machine.

## Goals

- Record terminal output, sent text, agent prompts, tool calls, agent status
  changes, and workspace lifecycle events.
- Show them in a native Orca sidebar panel with search, filtering, and a
  resizable feed/detail layout.
- Survive restarts without replaying old output (cursor persistence).
- Never block or alter the audited action — hooks are observe-only.

## Architecture

```
Orca app
├── Worker (src/worker.ts, trusted-worker profile)
│   ├── Hooks: terminal.send, agent.prompt.before,
│   │          agent.tool.before/after
│   ├── Events: workspace.created/removed/changed,
│   │           agent.status.changed
│   ├── Poller: shells out to bundled `orca` CLI
│   │   ├── terminal list --include-visual-layouts  (all workspaces)
│   │   └── terminal read --cursor <c>             (incremental output)
│   └── Storage: bounded in-memory ring + persisted
│       snapshot via plugin storage:own
│
└── Panel (src/panel.html, sandboxed-ui)
    ├── Vanilla JS + vendored Prism (bash highlighting)
    ├── orca.plugin.request('audit.snapshot') / on('audit.events')
    ├── orca.storage for feed height persistence
    └── Flex layout: feed (resizable) / drag handle / detail (flex:1)
```

## Key decisions

- **CLI over host API for output capture.** Host API 1.4 has no
  `terminal.list`; the bundled `orca` CLI exposes every terminal on every
  workspace with cursor-precise reads. Falls back to host calls
  (focused workspace + hook-seen terminals) when the CLI is unreachable,
  flagged as `degraded` in stats.
- **Session labels via visual layouts.** `--include-visual-layouts` returns
  the tab/pane tree; a recursive walker maps each terminal handle to its tab
  title (e.g. "Check current terminal process using on…"). Stored as
  `sessionTitle`, displayed with priority sessionTitle → terminalTitle → id.
- **HTML panel instead of components panel.** The components API could not
  provide a pinned detail pane, drag resizing, or independent scroll regions.
  The sandboxed HTML frame supports relative script tags, so Prism is vendored
  in `src/vendor/` — no CDN, no npm, works offline.
- **Bounded feed.** Events kept in a ring buffer (default 500, configurable),
  latest 100 rendered newest-first. Persistence stores the snapshot so a
  worker restart resumes mid-feed rather than replaying cursors.
- **Observe-only hooks.** Every hook handler records and passes the event
  through unchanged; auditing can never alter terminal or agent behavior.

## Event model

`AuditEvent`: `id`, `ts`, `kind` (output|send|prompt|tool|agent|workspace),
`title`, `terminalId`, `terminalTitle`, `sessionTitle`, `workspaceId`,
`detail`. Panel requests are typed in `src/protocol.ts`.

## Known limitations

- Direct human keystrokes are never hooked — only Orca-originated sends,
  agent prompts/tools, and output are captured. For per-command shell
  auditing (preexec/precmd → SQLite) see the companion `orca-audit` tool.
- Output is escape-stripped accumulated text; TUI repaints arrive as
  fragments.
- Prism only covers bash/shell syntax; other detail kinds render plain.

## Future improvements

- Command-level capture (exit codes, durations, foreground process) via
  optional zsh hooks, unified into the same feed.
- `--screen` mode for clean TUI frames instead of scrollback fragments.
- Export audit feed (JSON/SQLite) for offline analysis.
- Per-terminal filtering and pause/resume per session.
- More Prism languages or a theme closer to Orca's terminal palette.
