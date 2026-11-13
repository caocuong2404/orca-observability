// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('serves an empty audit snapshot and clears cleanly', async () => {
  const host = mockHost({ storage: {}, settings: { captureOutput: false } })
  const worker = await mountWorker(main, { host })
  const snap = await worker.request('audit.snapshot')
  assert.deepEqual(snap.events, [])
  assert.equal(typeof snap.stats.total, 'number')
  assert.deepEqual(await worker.request('audit.clear'), { ok: true })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
