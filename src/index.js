/**
 * Trellis workflow enforcement for the DeepSeek Harness (dsh).
 *
 * Trellis classifies dsh as a "class-2 pull-based" platform with
 * `hasHooks: false`: it ships skills and scripts, but no SessionStart and no
 * UserPromptSubmit hook. Nothing therefore reminds the agent that a Trellis
 * task workflow is in force, and `trellis-start` — a user-invocable skill —
 * never fires on its own, so the workflow is skipped unless the user names it.
 *
 * This plugin supplies the missing per-turn channel with dsh-native
 * mechanisms: a `systemPrompt.context` contribution whose `text` is a
 * function (re-evaluated on every assembly, i.e. every model step), plus an
 * async state refresh driven by agent lifecycle events. A workspace that is
 * not Trellis-managed receives no contribution at all.
 *
 * @module dsh-plugin-trellis-workflow
 */

/** Cordis plugin name. Matches the composition row id and the package name. */
export const name = 'trellis-workflow'

/**
 * No hard dependencies: every service is read optionally so a deployment
 * missing one degrades with a log line instead of parking this row forever.
 */
export const inject = {}

/**
 * Resolve the project root that owns `<workspace>/.trellis`, walking up from
 * the session workspace. Containment is decided by the composed filesystem
 * service rather than by string prefixes, so a symlinked or aliased
 * workspace still resolves correctly, and a workspace whose ancestor happens
 * to contain a `.trellis/` is not mistaken for a Trellis project.
 *
 * @returns the project root path, or undefined when the workspace is not
 * Trellis-managed.
 */
async function findProjectRoot(fs, cwd) {
  let workspace
  try {
    workspace = await fs.resolve(cwd)
  } catch {
    return undefined
  }

  let current = cwd
  for (let depth = 0; depth < 24; depth += 1) {
    const trellis = current + '/.trellis'
    let dir
    try {
      dir = await fs.resolve(trellis, { cwd })
    } catch {
      return undefined
    }
    if (!fs.contains(workspace, dir)) return undefined
    let info
    try {
      info = await fs.stat(dir)
    } catch {
      return undefined
    }
    if (info !== undefined && info.type === 'directory') return current

    const parent = current.replace(/\/+$/, '').replace(/\/[^/]*$/, '')
    if (parent === '' || parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Read the session-scoped active-task pointer, or undefined.
 *
 * Trellis names the file after its own context key, which is
 * `<platform>_<session id>` (see `_context_key` in the project's
 * `common/active_task.py`) -- on dsh that is `dsh_session-<uuid>.json`, not
 * `session-<uuid>.json`. The platform segment is Trellis's business, not this
 * plugin's, so match any prefix rather than hard-coding one; fall back to the
 * bare name for projects written by an older Trellis.
 */
async function readPointer(fs, root, sessionId) {
  const dir = root + '/.trellis/.runtime/sessions'
  let entries
  try {
    entries = await fs.listDir(await fs.resolve(dir))
  } catch {
    return undefined
  }

  const exact = sessionId + '.json'
  const suffixed = '_' + sessionId + '.json'
  let chosen
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (entry.name === exact) { chosen = entry; break }
    if (entry.name.endsWith(suffixed)) chosen = chosen ?? entry
  }
  if (chosen === undefined) return undefined

  try {
    const text = await fs.readText(chosen.target ?? (await fs.resolve(dir + '/' + chosen.name)))
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Render the per-step state block.
 *
 * The entry gate is the part that replaces the missing SessionStart hook: with
 * no active task, any non-trivial coding request must route through
 * `trellis-start` before product code is touched. Pure questions, small talk,
 * and read-only lookups are explicitly out of scope so ordinary conversation
 * does not get a workflow lecture.
 */
function buildText(state) {
  const lines = ['[trellis-workflow-state]']
  lines.push('project=' + state.root)

  if (state.phase === 'active') {
    lines.push('status=task_active')
    lines.push('task=' + state.taskRef)
    lines.push('task_status=' + state.taskStatus)
    lines.push('')
    lines.push('强制路由：本任务处于 Trellis 任务流程中。')
    lines.push('- 动手改代码前：先加载 trellis-before-dev，读 .trellis/spec/ 对应层规范。')
    lines.push('- 改完代码：走 trellis-check。')
    lines.push('- 收尾：走 trellis-finish-work 归档任务并写 journal。')
  } else if (state.phase === 'error') {
    lines.push('status=task_error')
    lines.push('active task 记录不可读，或指向的任务目录已不存在。继续前先修复。')
  } else if (state.phase === 'none') {
    lines.push('status=no_task')
    lines.push('')
    lines.push('强制路由：当用户提出非平凡的功能开发、缺陷修复或重构时，第一步先加载')
    lines.push('trellis-start 技能（.dsh/skills/trellis-start/SKILL.md），由它决定走')
    lines.push('trellis-brainstorm（需求不清）还是直接建任务。纯问答、闲聊、只读查询')
    lines.push('不需要走这个流程。')
  } else if (state.phase === 'unreadable') {
    lines.push('status=unknown')
    lines.push('状态读取失败（缺少 fs 服务或指针损坏），按未初始化项目处理。')
  } else {
    lines.push('status=loading')
  }

  lines.push('')
  lines.push('状态来源=dsh 主机侧缓存。确切当前态：')
  lines.push('  python3 ./.trellis/scripts/task.py current --source')
  lines.push('本平台没有 SessionStart / UserPromptSubmit hook，此块即官方面包屑的等价物。')
  return lines.join('\n')
}

export function apply(ctx, config) {
  const settings = config ?? {}
  if (settings.enabled === false) return
  const contextOrder = typeof settings.contextOrder === 'number' ? settings.contextOrder : 900

  const states = new Map()
  const reading = new Set()

  function targetOf(agent) {
    const session = agent?.session
    const sessionId = session?.id ?? agent?.id
    const cwd = session?.header?.cwd
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || cwd === '') return undefined
    return { sessionId: sessionId, cwd: cwd }
  }

  async function refresh(sessionId, cwd) {
    const fs = ctx.get('fs')
    if (fs === undefined) {
      // Still name the session's workspace: an unknown status is more useful
      // next to the directory it applies to than next to nothing.
      states.set(sessionId, { phase: 'unreadable', root: cwd, taskRef: '', taskStatus: '' })
      return
    }

    const root = await findProjectRoot(fs, cwd)
    if (root === undefined) {
      states.set(sessionId, { phase: 'absent', root: cwd, taskRef: '', taskStatus: '' })
      return
    }

    const pointer = await readPointer(fs, root, sessionId)
    const taskRef = typeof pointer?.current_task === 'string' ? pointer.current_task : ''
    if (taskRef === '') {
      states.set(sessionId, { phase: 'none', root: root, taskRef: '', taskStatus: '' })
      return
    }

    try {
      const taskJson = await fs.readText(await fs.resolve(root + '/' + taskRef + '/task.json'))
      const parsed = JSON.parse(taskJson)
      const status = typeof parsed?.status === 'string' ? parsed.status : ''
      states.set(sessionId, { phase: 'active', root: root, taskRef: taskRef, taskStatus: status })
    } catch {
      states.set(sessionId, { phase: 'error', root: root, taskRef: taskRef, taskStatus: '' })
    }
  }

  /** Measure once per session; later calls reuse the cached phase. */
  function ensure(sessionId, cwd) {
    const current = states.get(sessionId)
    if (current !== undefined && current.phase !== 'loading') return
    if (reading.has(sessionId)) return
    reading.add(sessionId)
    void refresh(sessionId, cwd)
      .catch((error) => {
        if (typeof ctx.logger?.warn === 'function') {
          ctx.logger.warn('trellis-workflow: refresh failed: ' + String(error))
        }
        states.set(sessionId, { phase: 'unreadable', root: cwd, taskRef: '', taskStatus: '' })
      })
      .finally(() => { reading.delete(sessionId) })
  }

  /** Re-measure after a moment the pointer can have moved. */
  function invalidate(sessionId, cwd) {
    reading.delete(sessionId)
    reading.add(sessionId)
    void refresh(sessionId, cwd)
      .catch(() => {})
      .finally(() => { reading.delete(sessionId) })
  }

  // Register through the injection callback, never straight from apply().
  //
  // `systemPrompt.context()` files the contribution into the layer of the
  // CALLING context's scope (see ScopedLayers.effect), and an agent assembles
  // its prompt by merging the global layer plus the layers along its own
  // scope-parent chain. A profile-row plugin's own context is not on that
  // chain, so registering during apply() stores the contribution where the
  // agent never looks -- the plugin activates, logs nothing, and injects
  // nothing. Injecting the service instead hands back a context already
  // scoped for each agent, which is how dsh's own sandbox/approval policy
  // contexts reach a prompt.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'trellis:workflow-state',
      order: contextOrder,
      text: function (assemble) {
        const target = targetOf(assemble?.agent)
        if (target === undefined) return ''
        ensure(target.sessionId, target.cwd)
        const state = states.get(target.sessionId)
        // Not measured yet: contribute nothing rather than a stale or
        // invented status. The next step renders the real value.
        if (state === undefined || state.phase === 'absent' || state.phase === 'loading') return ''
        return buildText(state)
      },
    })
  })

  // Session start and each new user message are the only two moments the
  // pointer can have moved; both are event-shaped on this platform.
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const target = targetOf(payload?.agent)
    if (target !== undefined) invalidate(target.sessionId, target.cwd)
  }), 'trellis:workflow-state agent/created')

  ctx.effect(() => ctx.on('agent/inbox/inserted', (payload) => {
    const target = targetOf(payload?.agent)
    if (target !== undefined) invalidate(target.sessionId, target.cwd)
  }), 'trellis:workflow-state agent/inbox/inserted')

  // Defensive: a turn can also begin from steering or a resumed log, so
  // re-measure before each step. Never awaited — a breadcrumb must not delay
  // or reject a step.
  ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => {
    try {
      const target = targetOf(payload?.agent)
      if (target !== undefined) invalidate(target.sessionId, target.cwd)
    } catch {
      /* never block a step on workflow bookkeeping */
    }
    return next()
  }), 'trellis:workflow-state agent/pre-step')

  ctx.effect(() => () => { states.clear(); reading.clear() }, 'trellis:workflow-state teardown')
}

export default { name, inject, apply }
