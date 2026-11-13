// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

/** One audited observation. `kind` groups it for filters and stats. */
export type AuditEvent = {
  id: number
  /** Unix milliseconds. */
  ts: number
  kind:
    | 'output' // new terminal output lines
    | 'send' // text Orca/CLI/plugin sent to a terminal
    | 'prompt' // prompt submitted to an agent
    | 'tool' // agent tool call (before/after)
    | 'agent' // agent status transition
    | 'workspace' // workspace created/removed/changed
  /** Short one-line summary for the feed. */
  title: string
  /** Terminal the event belongs to, when known. */
  terminalId?: string
  terminalTitle?: string
  /** Tab/session label for the terminal, when known. */
  sessionTitle?: string
  workspaceId?: string | null
  /** Structured detail rendered under the event. */
  detail?: Record<string, unknown>
}

export type AuditStats = {
  total: number
  byKind: Partial<Record<AuditEvent['kind'], number>>
  terminals: number
  workspaces: number
  /** True when the host lacks terminal.list, so output capture is degraded. */
  degraded?: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** The recent audit feed plus stats. */
    'audit.snapshot': {
      input: { limit?: number } | undefined
      output: { events: AuditEvent[]; stats: AuditStats }
    }
    /** Drops the in-memory feed and persisted snapshot. */
    'audit.clear': { input: undefined; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** Posted after new events land; `events` is the appended batch (newest last). */
    'audit.events': { events: AuditEvent[] }
    /** Posted when the feed was cleared. */
    'audit.cleared': Record<string, never>
  }
}
