# dsh-plugin-trellis-workflow

Trellis workflow enforcement for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

## The gap it closes

Trellis classifies dsh as a **class-2 pull-based** platform and ships
`hasHooks: false`: it writes skills and scripts, but no SessionStart and no
UserPromptSubmit hook. Consequences on dsh:

- nothing reminds the agent that a Trellis task workflow is in force, so it is
  skipped unless the user names a skill;
- `trellis-start` is a user-invocable skill that never fires on its own.

This plugin supplies the missing channel with dsh-native mechanisms, no hooks
required:

| Missing hook | Mechanism used here |
| --- | --- |
| SessionStart | `agent/created` + `agent/inbox/inserted` listeners refresh state |
| UserPromptSubmit breadcrumb | a `systemPrompt.context` contribution whose `text` is a function, re-evaluated on every model step |

## Behaviour

- Resolves the Trellis project root by walking up from `session.header.cwd` and
  confirming containment through the composed filesystem service. A workspace
  with no `.trellis/` gets **no injection at all**.
- Reads the session-scoped active-task pointer from
  `.trellis/.runtime/sessions/<sessionId>.json`, then the task's `task.json`.
- Contributes one state block per step: `task_active` (with task path and
  status) / `no_task` (with the `trellis-start` entry gate) / `task_error` /
  `unknown`. It contributes nothing until the first measurement completes,
  rather than inventing a status.
- State is keyed per session, so concurrent sessions cannot cross-contaminate.

## Install

From npm:

```sh
dsh plugin --profile web add dsh-plugin-trellis-workflow
```

Local development checkout (pnpm records an absolute `file:` spec and links the
directory, so edits to `src/index.js` are visible immediately; restart the
profile to reload the module):

Development mount from a local checkout (pnpm links or copies the directory;
`file:` copies, `link:` symlinks):

```sh
dsh plugin --profile <name> add /absolute/path/to/trellis-workflow
```

The command needs no profile file edit: it writes the dependency, appends the
package to `dsh.profile.bundles`, and the boot merges this package's
`cordis.patch.yml`. Restart the profile afterwards — Node caches imported
modules, so editing `src/index.js` also requires a restart.

## Configuration

Row config, set in the composition rather than through a settings page:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the row mounted but contributes nothing |
| `contextOrder` | `900` | position among prompt runtime contexts; built-ins sit at 110/115/120 |

## Licence

MIT
