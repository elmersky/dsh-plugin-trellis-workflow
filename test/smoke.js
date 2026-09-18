/** Smoke test: the module loads and it degrades instead of throwing. */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../src/index.js'

assert.equal(typeof apply, 'function', 'apply must be exported as a function')
assert.equal(name, 'trellis-workflow', 'plugin name')
assert.deepEqual(inject, {}, 'no hard service dependencies')

// The plugin must tolerate a context with none of the services it prefers:
// a deployment missing them should degrade, not throw at mount.
const calls = []
const fakeCtx = {
  get: () => undefined,
  on: () => () => {},
  effect: (fn) => { calls.push(fn); return () => {} },
  logger: { warn: (m) => calls.push(m) },
}
apply(fakeCtx, undefined)
assert.ok(calls.some((c) => typeof c === 'string' && c.includes('systemPrompt')), 'warns when systemPrompt is absent')

console.log('smoke: ok')
