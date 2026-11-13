// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const SNAP = {
  events: [
    {
      id: 1,
      ts: Date.now(),
      kind: 'send',
      title: 'send → term_1: echo hi',
      terminalId: 'term_1',
      detail: { text: 'echo hi' }
    }
  ],
  stats: { total: 1, byKind: { send: 1 }, terminals: 1, workspaces: 1 }
}

test('shows the audit feed from the worker snapshot', async () => {
  const host = mockHost({
    requests: {
      'audit.snapshot': () => SNAP,
      'audit.clear': () => ({ ok: true })
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  const item = view.find({ type: 'ListItem' })
  assert.ok(item)
  assert.equal((item?.props as { title?: string }).title, 'send → term_1: echo hi')
  await view.press({ text: 'Clear' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
