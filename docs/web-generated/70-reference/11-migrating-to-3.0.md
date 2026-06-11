---
status: current
last_verified: 2026-06-11
release: v3.0.0
title: "Migrating to 3.0 (GA)"
audience: [plugin-authors, tool-authors]
purpose: "What changes for the 3.0.0 GA cutover: register() is removed (declare commandSpecs), apiVersion is mandatory, and cli.recipe is removed."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/tools/compatibility.ts
  - packages/cli/src/bootstrap/register-tools.ts
related-docs:
  - ../50-extend/06-full-tool-plugins.md
  - ../../decisions/ADR-0027-ga-parity-cutover.md
---
# Migrating to 3.0 (GA)

**3.0.0 is the tool-plugin parity cutover.** The privileged first-party paths the
2.x ladder built *alongside* the parity planes are removed, so a tool behaves
identically whether it ships bundled, is installed from npm, or lives in a project
([ADR-0027](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/docs/decisions/ADR-0027-ga-parity-cutover.md)). The breaking changes
are mostly **author-facing**; the one config-facing break is the removal of
`cli.recipe`.

> **Most CLI users: nothing changes.** Every command, flag, `--json` shape
> (the 2.12.0 `CommandOutcome`), exit code, dashboard, and session shape is
> byte-identical to 2.13.0. Projects that still set `cli.recipe` must move that
> value under the owning tool block.

If you author a third-party **Tool** (a package with `opensipTools.kind: "tool"`),
two things changed. If you author a **check / scenario / adapter pack**, nothing
changed — packs were always parity-native (no Commander access to give up).

## 1. `register()` is removed — declare `commandSpecs`

The `Tool.register(cli)` hook and the raw Commander `program` handle are gone. A
tool now declares typed `commandSpecs` and the host mounts them — it owns flags,
help, completion, output, error mapping, and exit codes. This is the "one command
surface" invariant: a tool can no longer reach raw Commander.

**Before (2.x):**

```ts
export const tool = {
  metadata: { id: 'audit', version: '1.0.0', description: 'Audit tool' },
  commands: [{ name: 'audit', description: 'Run an audit' }],
  register(cli) {
    cli.program
      .command('audit')
      .option('--json', 'Output JSON', false)
      .action((opts) => {
        process.stdout.write(JSON.stringify(runAudit(opts)));
      });
  },
};
```

**After (3.0.0):**

```ts
import { defineCommand } from '@opensip-tools/core';

export const tool = {
  metadata: { id: 'audit', version: '1.0.0', description: 'Audit tool' },
  commands: [{ name: 'audit', description: 'Run an audit' }],
  commandSpecs: [
    defineCommand({
      name: 'audit',
      description: 'Run an audit',
      // `--json` (and the other cross-tool flags) come from the host registry —
      // you never declare them yourself.
      commonFlags: ['cwd', 'json', 'quiet', 'verbose'],
      scope: 'project',
      // The host renders + serializes your return; it owns `--json`.
      output: 'signal-envelope',
      handler: (opts, ctx) => runAudit(opts), // returns a SignalEnvelope
    }),
  ],
};
```

Key differences:

- **No `cli.program`.** You declare options as `OptionSpec`s; the host wires
  Commander. The handler receives the parsed options as its first argument.
- **No hand-rolled `--json` / `process.stdout.write`.** Pick an `output` mode
  (`signal-envelope` for a run, `command-result` for structured CLI output,
  `raw-stream` if you genuinely own stdout) and return your domain result — the
  host wraps it in a `CommandOutcome` and serializes it.
- **No live-view in `register()`.** If your tool has an interactive Ink view,
  register its renderer lazily (e.g. on the first live render) via
  `ctx.registerLiveView(key, renderer)` and declare `output: 'live-view'`.

See [Full tool plugins](/docs/opensip-tools/50-extend/06-full-tool-plugins/) for the complete
authoring shape.

## 2. `apiVersion` is now mandatory

The `apiVersion` grace window ended. A tool that declares no `apiVersion` in its
`package.json#opensipTools` manifest is no longer admitted — when you explicitly
run its command the CLI fails closed (exit 5); when it is merely discovered it is
skipped with a diagnostic.

**Add the epoch to your manifest:**

```json
{
  "name": "@you/opensip-audit",
  "opensipTools": {
    "kind": "tool",
    "id": "audit",
    "apiVersion": 1,
    "commands": [{ "name": "audit", "description": "Run an audit" }]
  }
}
```

`apiVersion` is the coarse plugin-API epoch the host gates on. Declare the epoch
your tool was built against (currently `1`); the CLI loads it when its epoch
matches and rejects it — with a message — when it does not.

## 3. `cli.recipe` is removed

The 2.8.0 deprecation window for cross-tool recipe defaults is over. A recipe
default belongs to the tool whose registry owns that recipe, and the `cli:`
namespace is strict in 3.0.0, so a remaining `cli.recipe` key is rejected during
config validation.

**Before (2.x grace path):**

```yaml
cli:
  recipe: opensip
```

**After (3.0.0):**

```yaml
fitness:
  recipe: opensip
```

Use `graph.recipe` or `simulation.recipe` for graph or sim defaults. If a project
needs different defaults for multiple tools, set each tool block independently.

## What did *not* change

- **Check / scenario / adapter packs** — no command surface to migrate; they were
  always declarative.
- **`--json` output shape** — still the 2.12.0 `CommandOutcome` wrapper.
- **Env vars, exit codes, dashboards, sessions** — unchanged.
- **The bundled tools** (`fit`/`graph`/`sim`) — same commands, same behaviour;
  internally they now load through the same plugin path your tool does.
