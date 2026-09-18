/**
 * Smoke test.
 *
 * Guards two things that a boot test alone would only catch after a restart:
 * that the module loads, and that the prompt context is registered through the
 * injection callback rather than straight from apply(). Registering from
 * apply() files the contribution into the profile row's own scope, which an
 * agent never merges — the plugin then activates, logs nothing, and injects
 * nothing.
 */
import assert from 'node:assert/strict'
import { apply, default as plugin, inject, name } from '../src/index.js'

assert.equal(typeof apply, 'function', 'apply must be exported as a function')
assert.equal(name, 'trellis-workflow', 'plugin name')
assert.deepEqual(inject, {}, 'no hard service dependencies')
assert.deepEqual(
  Object.keys(plugin).sort(),
  ['apply', 'inject', 'name'],
  'default export mirrors the named exports',
)

/** A context that records what the plugin asks of it. */
function harnessCtx(options = {}) {
  const seen = {
    injected: [],
    registeredContexts: [],
    subscribedEvents: [],
    effects: 0,
  }
  const contextRegistration = {
    context(definition) {
      seen.registeredContexts.push(definition)
      return () => {}
    },
  }
  const ctx = {
    get: (service) => (options.services?.[service] ?? (service === 'systemPrompt' ? contextRegistration : undefined)),
    on: (event, listener) => { seen.subscribedEvents.push(event); return () => {} },
    effect: (fn) => { seen.effects += 1; const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    inject: (services, callback) => {
      seen.injected.push(services.slice())
      // Mirror the runtime: the callback receives a scope where the injected
      // services are guaranteed present.
      const scope = { systemPrompt: options.scopeSystemPrompt ?? contextRegistration }
      return callback(scope)
    },
    logger: { warn: (message) => seen.registeredContexts.push({ warning: message }) },
  }
  return { ctx, seen }
}

// 1. Registration happens through inject(), and nowhere else.
{
  const { ctx, seen } = harnessCtx()
  apply(ctx, { enabled: true, contextOrder: 900 })

  assert.deepEqual(seen.injected, [['systemPrompt']], 'injects systemPrompt before registering')
  assert.equal(seen.registeredContexts.length, 1, 'registers exactly one prompt context')
  const definition = seen.registeredContexts[0]
  assert.equal(definition.name, 'trellis:workflow-state', 'context name')
  assert.equal(definition.order, 900, 'configured order is honoured')
  assert.equal(typeof definition.text, 'function', 'text is a function so it re-evaluates per step')
}

// 2. A non-finite order would make the real registry throw, so config must be typed.
{
  const { ctx, seen } = harnessCtx()
  apply(ctx, { contextOrder: 'not-a-number' })
  assert.equal(seen.registeredContexts[0].order, 900, 'falls back to the default order')
}

// 3. enabled: false contributes nothing at all.
{
  const { ctx, seen } = harnessCtx()
  apply(ctx, { enabled: false })
  assert.deepEqual(seen.injected, [], 'disabled plugin does not even inject')
  assert.equal(seen.registeredContexts.length, 0, 'disabled plugin registers nothing')
}

// 4. The text builder stays silent until it has a measurement to report.
{
  const { ctx, seen } = harnessCtx()
  apply(ctx, {})
  const definition = seen.registeredContexts[0]
  assert.equal(definition.text({}), '', 'no agent in the assembly renders nothing')
  assert.equal(
    definition.text({ agent: { id: 's1', session: { id: 's1' } } }),
    '',
    'a session without a usable cwd renders nothing',
  )

  // Measurement is asynchronous, but the missing-fs path resolves
  // synchronously, so an fs-less deployment renders immediately. Assert what
  // it actually produces: a status line with no project, which is the
  // documented degradation rather than silence.
  const { ctx: noFsCtx, seen: noFsSeen } = harnessCtx()
  apply(noFsCtx, {})
  const degraded = noFsSeen.registeredContexts[0].text({
    agent: { id: 's1', session: { id: 's1', header: { cwd: '/tmp' } } },
  })
  assert.match(degraded, /status=unknown/, 'an unmeasurable deployment reports unknown, not a silent no-op')
  assert.match(degraded, /^\[trellis-workflow-state\]\nproject=\/tmp\n/, 'the degraded block still names the workspace')

  // And a real measurement (async) must resolve to a rendered block. Give the
  // refresh a void turn to complete, then read the same context again.
  await new Promise((resolve) => setImmediate(resolve))
  const { ctx: withFsCtx, seen: withFsSeen } = harnessCtx({
    services: {
      fs: {
        async resolve(path) { return { targetKey: path, displayPath: path } },
        contains: () => true,
        async stat() { return undefined },
      },
    },
  })
  apply(withFsCtx, {})
  const withFsDefinition = withFsSeen.registeredContexts[0]
  withFsDefinition.text({ agent: { id: 's1', session: { id: 's1', header: { cwd: '/tmp' } } } })
  await new Promise((resolve) => setImmediate(resolve))
  const absent = withFsDefinition.text({ agent: { id: 's1', session: { id: 's1', header: { cwd: '/tmp' } } } })
  assert.equal(absent, '', 'a workspace with no .trellis/ contributes nothing, even once measured')
}

// 5. Lifecycle events are subscribed for refresh, and subscription is optional.
{
  const { ctx, seen } = harnessCtx()
  apply(ctx, {})
  for (const event of ['agent/created', 'agent/inbox/inserted', 'agent/pre-step']) {
    assert.ok(seen.subscribedEvents.includes(event), `subscribes ${event}`)
  }
}

// 6. A context without systemPrompt must degrade, not throw.
{
  const calls = []
  const bare = {
    get: () => undefined,
    on: () => () => {},
    effect: (fn) => { calls.push(fn); return () => {} },
    inject: () => { calls.push('inject') },
    logger: { warn: (m) => calls.push(m) },
  }
  assert.doesNotThrow(() => apply(bare, undefined), 'a service-less context must not throw at mount')
}

// 7. The pointer lookup must survive Trellis's platform prefix. Trellis names
// the file after its own context key (`<platform>_<session id>`), so on dsh it
// is `dsh_session-<uuid>.json` -- not `session-<uuid>.json`. A regression here
// is invisible until a real restart, which is how it reached a live session.
// Mirrors the real shape: the dsh session id already starts with `session-`,
// so Trellis's `<platform>_<id>` key renders as `dsh_session-<uuid>.json`.
const SID = 'session-39abd896-1548-46aa-bc36-457d61d7af6f'
for (const pointerName of ['dsh_' + SID + '.json', SID + '.json']) {
  const files = new Map([
    ['/proj/.trellis/.runtime/sessions/' + pointerName, JSON.stringify({
      platform: 'dsh',
      current_task: '.trellis/tasks/09-18-example',
    })],
    ['/proj/.trellis/tasks/09-18-example/task.json', JSON.stringify({ status: 'in_progress' })],
  ])
  const dirs = new Set([
    '/proj/.trellis',
    '/proj/.trellis/.runtime',
    '/proj/.trellis/.runtime/sessions',
    '/proj/.trellis/tasks',
    '/proj/.trellis/tasks/09-18-example',
  ])
  const fakeFs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    contains: (parent, child) => child.targetKey.startsWith(parent.targetKey),
    async stat(target) {
      if (dirs.has(target.targetKey)) return { version: 'v', type: 'directory' }
      if (files.has(target.targetKey)) return { version: 'v', type: 'file' }
      return undefined
    },
    async listDir(target) {
      const prefix = target.targetKey.replace(/\/+$/, '') + '/'
      const out = []
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.includes('/')) continue
        out.push({ name: rest, type: 'file', target: { targetKey: key, displayPath: key } })
      }
      return out
    },
    async readText(target) {
      const text = files.get(target.targetKey)
      if (text === undefined) throw new Error('ENOENT ' + target.targetKey)
      return text
    },
  }

  const { ctx, seen } = harnessCtx({ services: { fs: fakeFs } })
  apply(ctx, {})
  const render = seen.registeredContexts[0]
  const assemble = { agent: { id: SID, session: { id: SID, header: { cwd: '/proj' } } } }
  render.text(assemble)                 // primes the async refresh
  await new Promise((resolve) => setImmediate(resolve))
  const rendered = render.text(assemble)

  assert.match(rendered, /status=task_active/, pointerName + ': an active task must be reported')
  assert.match(rendered, /task=\.trellis\/tasks\/09-18-example/, pointerName + ': the task path must be reported')
  assert.match(rendered, /task_status=in_progress/, pointerName + ': the task status must be reported')
}

// 8. A workspace whose ancestor has .trellis/ must not be adopted. The
// containment check is what keeps unrelated projects clean.
{
  const parentDirs = new Set(['/work/.trellis'])
  const walkFs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    contains: (parent, child) => child.targetKey.startsWith(parent.targetKey),
    async stat(target) {
      if (parentDirs.has(target.targetKey)) return { version: 'v', type: 'directory' }
      return undefined
    },
    async listDir() { return [] },
    async readText() { throw new Error('ENOENT') },
  }
  const { ctx, seen } = harnessCtx({ services: { fs: walkFs } })
  apply(ctx, {})
  const render = seen.registeredContexts[0]
  const assemble = { agent: { id: 's2', session: { id: 's2', header: { cwd: '/work/unrelated' } } } }
  render.text(assemble)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(render.text(assemble), '', 'an unrelated workspace must stay untouched')
}

console.log('smoke: ok')
