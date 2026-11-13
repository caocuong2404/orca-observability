// Observability worker: tails every Orca terminal's output and records audit events
// from hooks (terminal.send, agent.prompt/tool) and workspace/agent lifecycle events.
//
// Output capture prefers the bundled `orca` CLI (`terminal list` + cursor reads),
// which sees every terminal on every workspace. When the CLI is unavailable it
// falls back to host calls (`workspace.readContext` + `terminal.read`), which only
// covers the focused workspace and terminals seen through hooks.
//
// State lives in memory; a compact snapshot is mirrored to orca.storage so a worker
// restart does not lose the recent feed. Output cursors persist too, so restarts
// resume where they left off instead of replaying history.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AuditEvent, AuditStats } from './protocol'

const execFileAsync = promisify(execFile)

const SNAPSHOT_KEY = 'audit.snapshot.v1'
const CURSORS_KEY = 'audit.cursors.v1'
const MAX_DETAIL_CHARS = 4000
const CLI_TIMEOUT_MS = 15000
const CLI_LIMIT = 500
const CLI_MAX_PAGES = 4
const POLL_CONCURRENCY = 4

type Settings = {
  pollSeconds: number
  captureOutput: boolean
  maxEvents: number
  outputChunkLines: number
}

type TailState = { lines: string[] }

type CliTerminal = {
  handle: string
  title?: string
  worktreePath?: string
  worktreeId?: string
  branch?: string
  agentIdentity?: string
  tabTitle?: string
}

type CliRead = {
  tail?: string[]
  nextCursor?: unknown
  latestCursor?: unknown
  limited?: boolean
  truncated?: boolean
  status?: string
}

const state = {
  events: [] as AuditEvent[],
  // Host-mode line tails, keyed by terminal id.
  tails: new Map<string, TailState>(),
  // Terminal metadata learned from either capture path.
  terminalIndex: new Map<
    string,
    { title: string; sessionTitle?: string; workspaceId: string | null; path?: string }
  >(),
  // CLI cursor per terminal handle.
  cursors: new Map<string, unknown>(),
  cursorsDirty: false,
  nextId: 1,
  settings: {
    pollSeconds: 3,
    captureOutput: true,
    maxEvents: 500,
    outputChunkLines: 200,
  } as Settings,
  timer: null as ReturnType<typeof setInterval> | null,
  persistTimer: null as ReturnType<typeof setTimeout> | null,
  statusTimer: null as ReturnType<typeof setInterval> | null,
  dirty: false,
  mode: 'unknown' as 'unknown' | 'cli' | 'host',
  cliBin: null as string | null,
  cliWarned: false,
}

function clip(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function summarize(value: unknown): string {
  if (value instanceof Error) {
    return clip(`${value.name}: ${value.message}`, 200)
  }
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    return clip(s ?? String(value), 200)
  } catch {
    return String(value)
  }
}

// ---------- settings and persistence ----------

async function loadSettings(orca: OrcaWorkerApi): Promise<void> {
  const raw = await orca.settings.get()
  const num = (k: keyof Settings, d: number) =>
    typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? (raw[k] as number) : d
  state.settings = {
    pollSeconds: Math.min(60, Math.max(1, num('pollSeconds', 3))),
    captureOutput: raw.captureOutput !== false,
    maxEvents: Math.min(5000, Math.max(50, Math.round(num('maxEvents', 500)))),
    outputChunkLines: Math.min(1000, Math.max(20, Math.round(num('outputChunkLines', 200)))),
  }
}

async function restoreSnapshot(orca: OrcaWorkerApi): Promise<void> {
  const [snap, cursors] = await Promise.all([
    orca.storage.get(SNAPSHOT_KEY),
    orca.storage.get(CURSORS_KEY),
  ])
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
    const s = snap as { events?: AuditEvent[]; nextId?: number }
    if (Array.isArray(s.events)) {
      state.events = s.events.filter(
        (e) => e && typeof e.id === 'number' && typeof e.ts === 'number'
      )
      state.nextId = typeof s.nextId === 'number' ? s.nextId + 1 : state.events.length + 1
    }
  }
  if (cursors && typeof cursors === 'object' && !Array.isArray(cursors)) {
    for (const [k, v] of Object.entries(cursors as Record<string, unknown>)) {
      if (v !== null && v !== undefined) state.cursors.set(k, v)
    }
  }
}

let persistChain: Promise<void> = Promise.resolve()
function persist(orca: OrcaWorkerApi): void {
  if (state.persistTimer) return
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null
    if (!state.dirty && !state.cursorsDirty) return
    const snapshot = state.dirty
      ? { events: state.events.slice(-state.settings.maxEvents), nextId: state.nextId }
      : null
    const cursors = state.cursorsDirty
      ? Object.fromEntries(state.cursors)
      : null
    state.dirty = false
    state.cursorsDirty = false
    persistChain = persistChain.then(async () => {
      try {
        if (snapshot) await orca.storage.set(SNAPSHOT_KEY, snapshot)
        if (cursors) await orca.storage.set(CURSORS_KEY, cursors)
      } catch {
        /* storage is best-effort */
      }
    })
  }, 5000)
}

// ---------- events ----------

function pushEvents(orca: OrcaWorkerApi, batch: AuditEvent[]): void {
  if (!batch.length) return
  state.events.push(...batch)
  const cap = state.settings.maxEvents
  if (state.events.length > cap) state.events.splice(0, state.events.length - cap)
  state.dirty = true
  persist(orca)
  orca.panels.post('audit.events', { events: batch.slice(-50) })
  void updateStatusBar(orca)
}

async function updateStatusBar(orca: OrcaWorkerApi): Promise<void> {
  const byKind = countByKind()
  const parts: string[] = []
  if (byKind.send) parts.push(`${byKind.send} sent`)
  if (byKind.prompt) parts.push(`${byKind.prompt} prompts`)
  if (byKind.tool) parts.push(`${byKind.tool} tools`)
  if (byKind.output) parts.push(`${byKind.output} output`)
  const text = parts.length ? parts.join(' · ') : 'audit'
  try {
    await orca.host.call('statusBar.update', {
      id: 'audit-count',
      text: clip(text, 60),
      tooltip: `Observability: ${state.events.length} events buffered`,
    })
  } catch {
    /* status bar is best-effort */
  }
}

function countByKind(): Partial<Record<AuditEvent['kind'], number>> {
  const out: Partial<Record<AuditEvent['kind'], number>> = {}
  for (const e of state.events) out[e.kind] = (out[e.kind] ?? 0) + 1
  return out
}

function makeEvent(
  kind: AuditEvent['kind'],
  title: string,
  extra: Partial<AuditEvent> = {}
): AuditEvent {
  return { id: state.nextId++, ts: Date.now(), kind, title, ...extra }
}

function terminalMeta(terminalId: string | undefined) {
  if (!terminalId) return {}
  const idx = state.terminalIndex.get(terminalId)
  return {
    terminalId,
    terminalTitle: idx?.title || undefined,
    sessionTitle: idx?.sessionTitle || undefined,
    workspaceId: idx?.workspaceId ?? null,
  }
}

/** Short display label for a terminal: its title when known, else the id. */
function terminalLabel(terminalId: string): string {
  return state.terminalIndex.get(terminalId)?.title || terminalId
}

function rememberTerminal(
  id: string,
  info: { title?: string; sessionTitle?: string; workspaceId?: string | null; path?: string }
): void {
  const prev = state.terminalIndex.get(id)
  state.terminalIndex.set(id, {
    title: info.title ?? prev?.title ?? '',
    sessionTitle: info.sessionTitle ?? prev?.sessionTitle,
    workspaceId: info.workspaceId ?? prev?.workspaceId ?? null,
    path: info.path ?? prev?.path,
  })
}

// ---------- CLI capture ----------

function orcaBinCandidates(): string[] {
  const home = homedir()
  const env = [
    process.env.ORCA_CLI,
    process.env.ORCA_BIN,
    process.env.ORCA_EXECUTABLE,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [
    ...env,
    'orca',
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    join(home, 'Applications/Orca.app/Contents/Resources/bin/orca'),
  ]
}

async function resolveOrcaBin(): Promise<string | null> {
  if (state.cliBin) return state.cliBin
  for (const bin of orcaBinCandidates()) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 })
      state.cliBin = bin
      return bin
    } catch {
      /* try next */
    }
  }
  return null
}

async function cliJson<T>(bin: string, args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync(bin, [...args, '--json'], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    const parsed = JSON.parse(stdout) as { ok?: boolean; result?: T }
    return parsed.ok ? (parsed.result ?? null) : null
  } catch {
    return null
  }
}

function chunkEvents(
  orca: OrcaWorkerApi,
  terminal: { handle: string; title?: string },
  fresh: string[],
  meta: Record<string, unknown>
): AuditEvent[] {
  const chunk = state.settings.outputChunkLines
  const out: AuditEvent[] = []
  const title = terminal.title || terminal.handle
  for (let i = 0; i < fresh.length; i += chunk) {
    const part = fresh.slice(i, i + chunk)
    out.push(
      makeEvent('output', `${title}: ${part.length} new line${part.length === 1 ? '' : 's'}`, {
        ...terminalMeta(terminal.handle),
        detail: {
          lines: part,
          ...meta,
          part: Math.floor(i / chunk) + 1,
          parts: Math.ceil(fresh.length / chunk),
        },
      })
    )
  }
  return out
}

type VisualLayout = { root?: unknown }

/** Maps terminal handle -> its tab's title by walking the visual layout tree.
 *  Nodes with a `tabs` array recurse per tab (each tab's own title wins);
 *  nodes with a `handle` record the current tab title. */
function tabTitlesFromLayouts(layouts: VisualLayout[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (node: unknown, tabTitle: string): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, tabTitle)
      return
    }
    const n = node as Record<string, unknown>
    if (Array.isArray(n.tabs)) {
      for (const t of n.tabs) {
        walk(t, typeof (t as { title?: unknown }).title === 'string'
          ? ((t as { title: string }).title)
          : tabTitle)
      }
      return
    }
    if (typeof n.handle === 'string' && tabTitle) out.set(n.handle, tabTitle)
    walk(n.panes, tabTitle)
    walk(n.children, tabTitle)
  }
  for (const layout of layouts ?? []) walk(layout.root, '')
  return out
}

async function pollCli(orca: OrcaWorkerApi, bin: string): Promise<void> {
  const list = await cliJson<{
    terminals?: CliTerminal[]
    visualLayouts?: VisualLayout[]
  }>(bin, ['terminal', 'list', '--limit', '200', '--include-visual-layouts'])
  if (!list?.terminals) {
    if (!state.cliWarned) {
      state.cliWarned = true
      orca.log('orca terminal list failed; retrying next poll')
    }
    return
  }
  state.cliWarned = false
  const tabTitles = tabTitlesFromLayouts(list.visualLayouts)
  const terminals = list.terminals.filter((t) => t.handle)
  for (const t of terminals) t.tabTitle = tabTitles.get(t.handle)
  const seen = new Set(terminals.map((t) => t.handle))

  // Forget terminals that disappeared.
  for (const h of [...state.cursors.keys()]) {
    if (!seen.has(h)) {
      state.cursors.delete(h)
      state.cursorsDirty = true
    }
  }

  const freshByTerminal = new Map<string, string[]>()
  const metaByTerminal = new Map<string, Record<string, unknown>>()

  // Read each terminal's new output since its stored cursor.
  const queue = [...terminals]
  const workers = Array.from({ length: Math.min(POLL_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const t = queue.shift()
      if (!t) return
      rememberTerminal(t.handle, {
        title: t.title,
        sessionTitle: t.tabTitle,
        workspaceId: t.worktreeId ?? null,
        path: t.worktreePath,
      })
      const cursor = state.cursors.get(t.handle)
      if (cursor === undefined) {
        // First sight: baseline at the end of retained output, no replay.
        const first = await cliJson<{ terminal?: CliRead }>(bin, [
          'terminal', 'read', '--terminal', t.handle, '--limit', '1',
        ])
        const term = first?.terminal
        if (term?.latestCursor !== undefined && term?.latestCursor !== null) {
          state.cursors.set(t.handle, term.latestCursor)
          state.cursorsDirty = true
        }
        continue
      }
      const allLines: string[] = []
      let cur: unknown = cursor
      let meta: Record<string, unknown> = {}
      for (let page = 0; page < CLI_MAX_PAGES; page++) {
        const res = await cliJson<{ terminal?: CliRead }>(bin, [
          'terminal', 'read', '--terminal', t.handle,
          '--cursor', String(cur), '--limit', String(CLI_LIMIT),
        ])
        const term = res?.terminal
        if (!term) break
        meta = {
          truncated: term.truncated === true,
          status: term.status,
          agentIdentity: t.agentIdentity,
          branch: t.branch,
        }
        if (Array.isArray(term.tail)) allLines.push(...term.tail)
        const next = term.nextCursor
        if (next === undefined || next === null) break
        if (term.limited === true && next !== term.latestCursor && page + 1 < CLI_MAX_PAGES) {
          cur = next
          continue
        }
        state.cursors.set(t.handle, next)
        state.cursorsDirty = true
        break
      }
      if (allLines.length) {
        freshByTerminal.set(t.handle, allLines)
        metaByTerminal.set(t.handle, meta)
      }
    }
  })
  await Promise.all(workers)

  const batch: AuditEvent[] = []
  for (const t of terminals) {
    const fresh = freshByTerminal.get(t.handle)
    if (!fresh?.length) continue
    batch.push(
      ...chunkEvents(orca, t, fresh, metaByTerminal.get(t.handle) ?? {})
    )
  }
  pushEvents(orca, batch)
}

// ---------- host-API fallback capture ----------

function diffTail(prev: string[], lines: string[]): { fresh: string[]; realigned: boolean } {
  if (!prev.length) return { fresh: [], realigned: false }
  const p = prev.length
  const l = lines.length
  outer: for (let o = Math.min(l - p, l); o >= 0; o--) {
    if (lines[o] !== prev[0]) continue
    for (let i = 1; i < p; i++) {
      if (lines[o + i] !== prev[i]) continue outer
    }
    return { fresh: lines.slice(o + p), realigned: false }
  }
  for (let d = 1; d < p; d++) {
    const keep = p - d
    if (keep <= 0) break
    let ok = true
    for (let i = 0; i < keep; i++) {
      if (lines[i] !== prev[d + i]) {
        ok = false
        break
      }
    }
    if (ok) return { fresh: lines.slice(keep), realigned: d > 0 }
  }
  return { fresh: lines, realigned: true }
}

async function hostRead(orca: OrcaWorkerApi, terminalId: string) {
  const call = orca.host.call as unknown as (
    m: string,
    p?: unknown
  ) => Promise<unknown>
  return (await call.call(orca.host, 'terminal.read', {
    terminalId,
    maxLines: 2000,
  })) as { lines?: string[]; truncated?: boolean }
}

async function pollHost(orca: OrcaWorkerApi): Promise<void> {
  // Focused workspace context gives the terminals Orca currently shows.
  const ids = new Set(state.terminalIndex.keys())
  try {
    const ctx = await orca.host.call('workspace.readContext')
    const terms = ctx?.terminals ?? []
    for (const t of terms) {
      ids.add(t.id)
      rememberTerminal(t.id, { title: t.title })
    }
  } catch {
    /* no focused workspace */
  }
  const batch: AuditEvent[] = []
  for (const id of ids) {
    let read
    try {
      read = await hostRead(orca, id)
    } catch {
      continue
    }
    const lines = read.lines ?? []
    const prev = state.tails.get(id)
    if (!prev) {
      state.tails.set(id, { lines: lines.slice(-2000) })
      continue
    }
    const { fresh, realigned } = diffTail(prev.lines, lines)
    state.tails.set(id, { lines: lines.slice(-2000) })
    if (!fresh.length) continue
    const idx = state.terminalIndex.get(id)
    batch.push(
      ...chunkEvents(orca, { handle: id, title: idx?.title }, fresh, {
        truncated: read.truncated === true,
        realigned,
        degraded: true,
      })
    )
  }
  pushEvents(orca, batch)
}

async function pollTerminals(orca: OrcaWorkerApi): Promise<void> {
  if (!state.settings.captureOutput) return
  if (state.mode === 'unknown') {
    const bin = await resolveOrcaBin()
    state.mode = bin ? 'cli' : 'host'
    orca.log(`output capture mode: ${state.mode}${bin ? ` (${bin})` : ''}`)
  }
  if (state.mode === 'cli' && state.cliBin) {
    await pollCli(orca, state.cliBin)
  } else {
    await pollHost(orca)
  }
}

// ---------- hooks and lifecycle events ----------

function hookPassthrough<H extends Parameters<OrcaWorkerApi['hooks']['on']>[0]>(
  orca: OrcaWorkerApi,
  hook: H,
  record: (event: unknown) => void
): void {
  orca.hooks.on(hook, (event, next) => {
    try {
      record(event)
    } catch {
      /* auditing must never break the action */
    }
    return next(event)
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  const boot = async () => {
    await loadSettings(orca)
    await restoreSnapshot(orca)
    orca.log(`observability worker started (api ${orca.api.major}.${orca.api.minor})`)
    if (state.timer) clearInterval(state.timer)
    state.timer = setInterval(() => {
      void pollTerminals(orca).catch((e) => orca.log(`poll error: ${summarize(e)}`))
    }, state.settings.pollSeconds * 1000)
    state.timer.unref?.()
    void pollTerminals(orca)
    void updateStatusBar(orca)
  }
  void boot()

  // Observe-only hooks: record, then always pass the action through.
  hookPassthrough(orca, 'terminal.send', (event) => {
    const e = event as { terminalId: string; text: string; enter: boolean; inputKind: string }
    rememberTerminal(e.terminalId, {})
    pushEvents(orca, [
      makeEvent('send', `send → ${terminalLabel(e.terminalId)}: ${clip(e.text.replace(/\n/g, ' '), 120)}`, {
        ...terminalMeta(e.terminalId),
        detail: { text: clip(e.text), enter: e.enter, inputKind: e.inputKind },
      }),
    ])
  })

  hookPassthrough(orca, 'agent.prompt.before', (event) => {
    const e = event as { agent: string | null; terminalId: string; prompt: string; inputKind: string }
    rememberTerminal(e.terminalId, {})
    pushEvents(orca, [
      makeEvent('prompt', `prompt → ${e.agent ?? 'agent'}: ${clip(e.prompt.replace(/\n/g, ' '), 120)}`, {
        ...terminalMeta(e.terminalId),
        detail: { agent: e.agent, prompt: clip(e.prompt), inputKind: e.inputKind },
      }),
    ])
  })

  hookPassthrough(orca, 'agent.tool.before', (event) => {
    const e = event as { agent: string; terminalId?: string; tool: string; input: unknown; callId?: string; workspaceId: string | null }
    if (e.terminalId) rememberTerminal(e.terminalId, {})
    pushEvents(orca, [
      makeEvent('tool', `tool ${e.tool} (${e.agent})`, {
        ...terminalMeta(e.terminalId),
        workspaceId: e.workspaceId,
        detail: { agent: e.agent, tool: e.tool, phase: 'before', input: safeJson(e.input), callId: e.callId },
      }),
    ])
  })

  hookPassthrough(orca, 'agent.tool.after', (event) => {
    const e = event as { agent: string; terminalId?: string; tool: string; input: unknown; callId?: string; output?: unknown; workspaceId: string | null }
    if (e.terminalId) rememberTerminal(e.terminalId, {})
    pushEvents(orca, [
      makeEvent('tool', `tool ${e.tool} done (${e.agent})`, {
        ...terminalMeta(e.terminalId),
        workspaceId: e.workspaceId,
        detail: { agent: e.agent, tool: e.tool, phase: 'after', input: safeJson(e.input), output: safeJson(e.output), callId: e.callId },
      }),
    ])
  })

  orca.events.on('workspace.created', (p) => {
    pushEvents(orca, [
      makeEvent('workspace', `workspace created: ${p.name ?? p.path}`, {
        workspaceId: p.workspaceId,
        detail: { kind: p.kind, path: p.path, branch: p.branch },
      }),
    ])
  })
  orca.events.on('workspace.removed', (p) => {
    pushEvents(orca, [
      makeEvent('workspace', `workspace removed: ${p.path}`, {
        workspaceId: p.workspaceId,
        detail: { kind: p.kind, path: p.path },
      }),
    ])
  })
  orca.events.on('agent.status.changed', (p) => {
    if (p.terminalId) rememberTerminal(p.terminalId, { workspaceId: p.workspaceId })
    pushEvents(orca, [
      makeEvent('agent', `agent ${p.state}: ${p.title ?? p.paneKey}`, {
        terminalId: p.terminalId,
        workspaceId: p.workspaceId,
        detail: {
          paneKey: p.paneKey, state: p.state, title: p.title,
          mainAgent: p.mainAgent ?? null,
        },
      }),
    ])
  })
  // Terminal opens/closes change the focused workspace's terminal set; poll soon
  // after so new terminals are picked up without waiting a full interval.
  let changedTimer: ReturnType<typeof setTimeout> | null = null
  orca.events.on('workspace.changed', (p) => {
    for (const t of p.context?.terminals ?? []) {
      rememberTerminal(t.id, { title: t.title })
    }
    if (changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      void pollTerminals(orca).catch(() => {})
    }, 800)
  })

  // Palette command: clear the feed.
  orca.commands.register('observability.clear', async () => {
    state.events = []
    state.dirty = true
    await persistChain
    try {
      await orca.storage.delete(SNAPSHOT_KEY)
    } catch { /* best-effort */ }
    orca.panels.post('audit.cleared', {})
    void updateStatusBar(orca)
    return 'Observability feed cleared'
  })

  // Panel requests.
  orca.panels.handle('audit.snapshot', async (input) => {
    const limit = input?.limit
    const cap = Math.min(state.settings.maxEvents, Math.max(1, limit ?? state.settings.maxEvents))
    // Fill in terminal titles learned after the event was recorded. Undefined
    // fields are dropped: the bridge rejects non-JSON values.
    const events = state.events.slice(-cap).map((e) => {
      const idx = e.terminalId ? state.terminalIndex.get(e.terminalId) : undefined
      const out: AuditEvent = { ...e }
      if (idx) {
        if (!out.terminalTitle && idx.title) out.terminalTitle = idx.title
        if (!out.sessionTitle && idx.sessionTitle) out.sessionTitle = idx.sessionTitle
        if (out.workspaceId == null && idx.workspaceId != null) {
          out.workspaceId = idx.workspaceId
        }
      }
      for (const k of Object.keys(out) as (keyof AuditEvent)[]) {
        if (out[k] === undefined) delete out[k]
      }
      return out
    })
    const stats: AuditStats = {
      total: state.events.length,
      byKind: countByKind(),
      terminals: state.terminalIndex.size,
      workspaces: 0,
      degraded: state.mode === 'host',
    }
    try {
      const wss = (await orca.host.call('workspace.list')) as {
        workspaces?: unknown[]
      }
      stats.workspaces = wss.workspaces?.length ?? 0
    } catch { /* ignore */ }
    return { events, stats }
  })

  orca.panels.handle('audit.clear', async () => {
    state.events = []
    state.dirty = true
    orca.panels.post('audit.cleared', {})
    return { ok: true as const }
  })

  // Keep the status bar honest on a slow tick even when idle.
  state.statusTimer = setInterval(() => void updateStatusBar(orca), 60000)
  state.statusTimer.unref?.()
}

export function deactivate(): void {
  if (state.timer) clearInterval(state.timer)
  if (state.persistTimer) clearTimeout(state.persistTimer)
  if (state.statusTimer) clearInterval(state.statusTimer)
  state.timer = null
  state.persistTimer = null
  state.statusTimer = null
  state.tails.clear()
  state.terminalIndex.clear()
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const s = JSON.stringify(value)
    if (s === undefined) return String(value)
    return s.length > MAX_DETAIL_CHARS ? s.slice(0, MAX_DETAIL_CHARS) + '…' : JSON.parse(s)
  } catch {
    return clip(String(value))
  }
}
