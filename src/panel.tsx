// Observability panel: live audit feed of terminal output, sends, prompts,
// tool calls and lifecycle events, streamed from the plugin worker.
import {
  atom,
  Badge,
  Box,
  Button,
  Code,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  Select,
  Separator,
  Slider,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import type { AuditEvent, AuditStats } from './protocol'

const events = atom<AuditEvent[]>([])
const stats = atom<AuditStats | null>(null)
const loading = atom(true)
const kindFilter = atom('kind', 'all', { persist: 'plugin' })
const search = atom('search', '', { persist: 'plugin' })
const selectedId = atom<number | null>(null)
const contentHeight = atom('contentHeight', 560, { persist: 'plugin' })

const KIND_LABEL: Record<AuditEvent['kind'], string> = {
  output: 'Output',
  send: 'Sent',
  prompt: 'Prompt',
  tool: 'Tool',
  agent: 'Agent',
  workspace: 'Workspace',
}

const KIND_TONE: Record<AuditEvent['kind'], 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  output: 'neutral',
  send: 'accent',
  prompt: 'warning',
  tool: 'accent',
  agent: 'success',
  workspace: 'neutral',
}

function timeOf(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false })
  } catch {
    return String(ts)
  }
}

function matches(e: AuditEvent, kind: string, q: string): boolean {
  if (kind !== 'all' && e.kind !== kind) return false
  if (!q) return true
  const hay = `${e.title} ${e.terminalTitle ?? ''} ${e.terminalId ?? ''} ${JSON.stringify(e.detail ?? {})}`
  return hay.toLowerCase().includes(q.toLowerCase())
}

function detailLines(e: AuditEvent): string {
  const d = e.detail
  if (!d) return ''
  if (Array.isArray(d.lines)) return (d.lines as string[]).join('\n')
  return JSON.stringify(d, null, 2)
}

async function refresh(): Promise<void> {
  const answer = await plugin.request('audit.snapshot', { limit: 500 })
  set(events, answer.events)
  set(stats, answer.stats)
  set(loading, false)
}

async function clear(): Promise<void> {
  await plugin.request('audit.clear')
  set(events, [])
  set(stats, null)
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('audit.events', (payload) => {
      update(events, (list) => {
        const seen = new Set(list.map((e) => e.id))
        const fresh = payload.events.filter((e) => !seen.has(e.id))
        return fresh.length ? [...list, ...fresh].slice(-500) : list
      })
      set(loading, false)
    }),
    plugin.on('audit.cleared', () => {
      set(events, [])
    })
  )
  void refresh().catch(() => set(loading, false))
}

export default function Panel() {
  const list = read(events)
  const s = read(stats)
  const kind = read(kindFilter)
  const q = read(search)
  const selId = read(selectedId)
  const isLoading = read(loading)
  const cHeight = read(contentHeight)
  // One control sizes the whole feed + detail block; the detail pane keeps a
  // fixed 200px and the feed takes the rest.
  const DETAIL_H = 200
  const fHeight = Math.max(200, cHeight - DETAIL_H)

  const filtered = list.filter((e) => matches(e, kind, q))
  const selected = filtered.find((e) => e.id === selId) ?? filtered[filtered.length - 1]

  const counts = s?.byKind ?? {}
  const summary = [
    counts.send ? `${counts.send} sent` : null,
    counts.prompt ? `${counts.prompt} prompts` : null,
    counts.tool ? `${counts.tool} tools` : null,
    counts.output ? `${counts.output} output` : null,
    counts.agent ? `${counts.agent} agent` : null,
    counts.workspace ? `${counts.workspace} ws` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Box direction="column" gap="md">
      <Row justify="between">
        <Heading>Observability</Heading>
        <Row gap="xs">
          {s ? <Badge tone="accent">{s.total}</Badge> : null}
          <Button variant="ghost" onPress={clear}>
            Clear
          </Button>
        </Row>
      </Row>

      {s?.degraded ? (
        <Text size="xs" muted>
          Output capture is in fallback mode: the orca CLI was not reachable, so only the
          focused workspace's terminals are tailed. Commands, prompts, tools and lifecycle
          events are still recorded.
        </Text>
      ) : null}

      <Row gap="xs">
        <Box grow>
          <Select
            label="Filter by kind"
            labelHidden
            value={kind}
            onChange={(v) => set(kindFilter, v)}
            options={[
              { value: 'all', label: 'All events' },
              ...(['output', 'send', 'prompt', 'tool', 'agent', 'workspace'] as const).map(
                (k) => ({ value: k, label: KIND_LABEL[k] })
              ),
            ]}
          />
        </Box>
        <Box grow>
          <Input
            label="Search audit feed"
            labelHidden
            placeholder="Search…"
            value={q}
            onChange={(v) => set(search, v)}
          />
        </Box>
      </Row>

      {summary ? (
        <Text size="xs" muted>
          {summary}
          {s ? ` · ${s.terminals} terminals · ${s.workspaces} workspaces` : ''}
        </Text>
      ) : null}

      <Collapsible title="Layout" description="Resize the feed and detail panes">
        <Slider
          label="Content height"
          value={cHeight}
          min={420}
          max={900}
          step={20}
          showValue
          onChange={(v) => set(contentHeight, v)}
        />
      </Collapsible>

      <Separator />

      {isLoading && list.length === 0 ? (
        <Row justify="center">
          <Spinner label="Loading audit feed" />
        </Row>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={list.length === 0 ? 'No audit events yet' : 'Nothing matches'}
          description={
            list.length === 0
              ? 'Events appear as Orca sends text to terminals, agents run tools, and terminal output streams in.'
              : 'Try a different filter or search.'
          }
          icon="activity"
        />
      ) : (
        <>
          <Box height={fHeight} scroll="y" minHeight={0}>
            <List label="Audit events">
              {filtered.slice(-100).map((e) => (
                <ListItem
                  key={e.id}
                  title={e.title}
                  description={`${timeOf(e.ts)}${e.terminalTitle ? ` · ${e.terminalTitle}` : ''}`}
                  icon={e.kind === 'output' ? 'terminal' : e.kind === 'tool' ? 'wrench' : 'activity'}
                  current={selected?.id === e.id}
                  onPress={() => set(selectedId, e.id)}
                />
              ))}
            </List>
          </Box>
          {selected ? (
            <>
              <Separator />
              <Box
                height={DETAIL_H}
                scroll="y"
                background="card"
                border
                radius="md"
                padding="sm"
              >
                <Stack gap="xs">
                  <Text weight="medium" truncate>
                    {selected.title}
                  </Text>
                  <Row gap="xs">
                    <Badge tone={KIND_TONE[selected.kind]}>{KIND_LABEL[selected.kind]}</Badge>
                    <Text size="xs" muted>
                      {new Date(selected.ts).toLocaleString()}
                      {selected.terminalId ? ` · ${selected.terminalId}` : ''}
                    </Text>
                  </Row>
                  <Code block>{detailLines(selected) || '(no detail)'}</Code>
                </Stack>
              </Box>
            </>
          ) : null}
        </>
      )}
    </Box>
  )
}
