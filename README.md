# dsh-plugin-trellis-workflow

Trellis workflow enforcement for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): per-turn workflow state injection plus a `trellis-start` entry gate, replacing the session-start and user-prompt hooks dsh does not ship.

## The gap it closes

Trellis classifies dsh as a **class-2 pull-based** platform and ships `hasHooks: false`. It writes skills and scripts, but no SessionStart hook and no UserPromptSubmit hook. On dsh that means:

- nothing reminds the agent that a Trellis task workflow is in force, so the workflow is skipped unless the user names a skill;
- `trellis-start` is a user-invocable skill that never fires on its own.

Trellis's own generated `.dsh/DSH.md` says as much: *"no session-start hook auto-injects workflow context, so the agent loads the Trellis skills on demand."*

This plugin supplies the missing channel with **dsh-native mechanisms — no hooks required**:

| Missing Trellis channel | Mechanism used here |
| --- | --- |
| SessionStart context injection | `agent/created` and `agent/inbox/inserted` listeners refresh state |
| UserPromptSubmit breadcrumb | a `systemPrompt.context` contribution whose `text` is a function, re-evaluated on every model step |
| Entry routing to `trellis-start` | the rendered state block itself, gated on `no_task` |

## Behaviour

- **Project-aware.** Resolves the Trellis project root by walking up from `session.header.cwd`, confirming directory containment through the composed filesystem service. A workspace with no `.trellis/` gets **no injection at all**, so unrelated projects are untouched.
- **Read-only.** Reads the session-scoped active-task pointer at `.trellis/.runtime/sessions/<sessionId>.json`, then that task's `task.json`. It never writes to `.trellis/` and never runs shell commands.
- **States.** Contributes one block per step: `task_active` (task path and status), `no_task` (the `trellis-start` entry gate), `task_error` (unreadable pointer), `unknown` (state could not be measured). It contributes **nothing** until the first measurement completes rather than inventing a status.
- **Session-isolated.** State is keyed per session, so concurrent sessions cannot cross-contaminate.
- **Cheap.** One cached lookup per session, refreshed when the pointer can have moved (session start, a new user message, or the step before a model call).

The rendered block looks like this:

```
[trellis-workflow-state]
project=/path/to/trellis-project
status=task_active
task=.trellis/tasks/09-18-example
task_status=in_progress

强制路由：本任务处于 Trellis 任务流程中。
- 动手改代码前：先加载 trellis-before-dev，读 .trellis/spec/ 对应层规范。
- 改完代码：走 trellis-check。
- 收尾：走 trellis-finish-work 归档任务并写 journal。

状态来源=dsh 主机侧缓存。确切当前态：
  python3 ./.trellis/scripts/task.py current --source
本平台没有 SessionStart / UserPromptSubmit hook，此块即官方面包屑的等价物。
```

The routing text is written in Chinese to match the target project's convention; the rest of the block is language-neutral.

## Requirements

- dsh with the `systemPrompt` service composed (present in the shipped base bundle)
- A Trellis-managed workspace (a project containing `.trellis/`)
- Node.js >= 20

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-trellis-workflow
```

No profile file edit is needed. The command writes the dependency, appends the package to `dsh.profile.bundles`, and the profile boot merges this package's `cordis.patch.yml` as one `insert`.

Restart the profile afterwards. Node caches imported modules, so a restart is also required after editing `src/index.js`.

## Configuration

Row config is set in the composition, not through a settings page:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the row mounted but contributes nothing |
| `contextOrder` | `900` | position among prompt runtime contexts; dsh's built-ins sit at 110 / 115 / 120, so this block renders after the sandbox, approval, and delegation notices. Must be a finite number. |

To override, patch the row in the profile's own `cordis.patch.yml`:

```yaml
- id: trellis-workflow
  config:
    contextOrder: 950
```

## Uninstall

```sh
dsh plugin --profile <profile> remove dsh-plugin-trellis-workflow
```

## Development

```sh
git clone git@github.com:elmersky/dsh-plugin-trellis-workflow.git
cd dsh-plugin-trellis-workflow
npm test                                  # smoke test
npm publish --dry-run                     # inspect the publish payload
```

Mount a checkout directly into a profile. pnpm records an absolute `file:` spec and links the directory, so edits to `src/index.js` are visible to the profile immediately — a restart is still needed to reload the module:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-trellis-workflow
```

Verify what actually composed:

```sh
dsh --profile <profile> --dump-config | grep -A4 trellis-workflow
```

Expect a `# == dsh-plugin-trellis-workflow` layer marker and exactly one `trellis-workflow` row. Two rows mean a stale hand-written mount line is still present alongside this bundle.

### Package layout and why it is shaped this way

`package.json` declares `dsh.bundle.patch`, which is what makes this package a profile **bundle** rather than a plain dependency. The same declaration serves both the npm install and the local `file:` install, so publishing changes only the dependency spec — never the composition.

The row id equals the package name on purpose: the row resolves its module by package name through the profile's `node_modules`, so keeping the two identical makes the composed row and the dependency line correspond at a glance.

## Status

`0.1.0` — first release. Verified: composition resolves, the module loads, and the behaviour above is exercised by `test/smoke.js` plus the runtime contracts of `systemPrompt.context` and `assemble.agent.session`. Not yet verified on a public registry install; see the repository issues for tracking.

## Licence

MIT
