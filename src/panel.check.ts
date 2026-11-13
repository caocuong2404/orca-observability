// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed plugin storage so check shows the populated state too.
import { defineCheck } from 'orca/testing'

const seededEvent = {
  id: 1,
  ts: Date.now(),
  kind: 'send',
  title: 'send → term_demo: pnpm test',
  terminalId: 'term_demo',
  detail: { text: 'pnpm test' }
}

export default defineCheck({
  fresh: {},
  populated: {
    storage: {
      'audit.snapshot.v1': { events: [seededEvent], nextId: 2 }
    }
  }
})
