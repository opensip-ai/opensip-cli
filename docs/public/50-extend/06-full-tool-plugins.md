---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Full Tool plugins"
audience: [plugin-authors]
purpose: "Build a Tool plugin — your own opensip-tools subcommand. Use when fit/sim/graph aren't the right shape and you want something fundamentally different."
source-files:
  - packages/core/src/tools/types.ts
  - packages/cli/src/index.ts
  - packages/fitness/engine/src/tool.ts
related-docs:
  - ./03-publishable-packs.md
  - ../10-concepts/02-tool-plugin-model.md
  - ../70-reference/01-cli-commands.md
---
# Full Tool plugins

A Tool plugin contributes its own subcommand. Use this when you want something fundamentally different from `fit`, `sim`, or `graph` — an `audit-sec`, a `bench`, a custom `report`. Anything that has its own argv shape, its own logic, and its own result type.

This is the heaviest extension shape. Most teams never need it. If you just want to ship rules, [Publishable packs](./03-publishable-packs.md) is the right path.

## Layout

```
@my-co/audit-sec/
├── package.json
├── src/
│   ├── index.ts                # exports: tool
│   ├── audit.ts                # the actual logic
│   └── …
├── dist/
└── README.md
```

## `package.json`

```json
{
  "name": "@my-co/audit-sec",
  "version": "0.1.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": { "kind": "tool" },
  "peerDependencies": {
    "@opensip-tools/contracts": "^2.0.0",
    "@opensip-tools/core": "^2.0.0"
  }
}
```

The `kind: "tool"` marker is what makes the CLI discover your package. Peer-dep on `@opensip-tools/contracts` and `@opensip-tools/core` — the consumer brings their own version.

## `src/index.ts`

```ts
import type { Tool, ToolCliContext } from '@opensip-tools/core';
import type { CliProgram } from '@opensip-tools/contracts';
import { runAudit } from './audit.js';

export const tool: Tool = {
  metadata: {
    id: 'audit-sec',
    version: '0.1.0',
    description: 'Lightweight security audit',
  },
  commands: [{ name: 'audit-sec', description: 'Run the security audit' }],
  register(cli: ToolCliContext) {
    const program = cli.program as CliProgram;
    program
      .command('audit-sec')
      .description('Run the security audit')
      .option('--cwd <path>', 'Target directory', process.cwd())
      .option('--json', 'Output structured JSON', false)
      .action(async (opts) => {
        const result = await runAudit(opts.cwd);
        if (opts.json) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          await cli.render(result);
        }
        cli.setExitCode(result.passed ? 0 : 1);
      });
  },
};
```

That's the whole tool. `npm install @my-co/audit-sec` (or `opensip-tools plugin add @my-co/audit-sec`) and `opensip-tools audit-sec` works on the next invocation.

## What you don't need

- An entry-points declaration.
- A hook or middleware registration.
- A code change in `@opensip-tools/cli`.
- A code change in `@opensip-tools/core`.
- A schema migration.

The Tool contract is the seam. The CLI walks `defaultToolRegistry`, discovers your package via the `opensipTools.kind: 'tool'` marker, and your Tool's `register()` mounts the command. For the architecture behind this decoupling, see [the tool-plugin model](../10-concepts/02-tool-plugin-model.md).

## Tools that use the kernel registries

A Tool that wants to reuse the fitness check registry (e.g. an `audit-fit` that runs a custom recipe) imports `@opensip-tools/fitness` and reuses `executeFit`, `defineRecipe`, etc. The fitness package re-exports these so a Tool author doesn't have to assemble a runner from scratch.

A Tool that's structurally different (a benchmark runner, a custom report generator) doesn't need to import `@opensip-tools/fitness` at all — it can be entirely self-contained, with its own logic and its own output shape, as long as it produces a renderable `CommandResult` for the CLI's render layer to consume.

## Don't extend `CliArgs`

`CliArgs` is the union shape that predates the per-command options interfaces. It still exists in `@opensip-tools/contracts` because the `*OptsToCliArgs` adapter functions in `@opensip-tools/fitness`, `@opensip-tools/simulation`, and the CLI's `init` command continue to bridge per-command options to the legacy executor signature (`executeFit(args: CliArgs, …)`, `executeSim(args: CliArgs)`, `executeInit(args: CliArgs & {…})`). It's marked `@deprecated`.

If you're authoring a new flag for a built-in command, add it to the per-command interface instead:

| Command | Options interface |
|---|---|
| `fit`     | `FitOptions` |
| `sim`     | `ToolOptions` |
| `init`    | `InitOptions` |
| your tool | a new interface in your tool package, named after the command |

The boundary types live in `@opensip-tools/contracts`. New flags should be additive on those interfaces, not on `CliArgs`. The adapters bridge the two shapes today; over time they fold away as the executors take per-command options directly.

Read this as: "the CLI subcommand has its own options shape, and that shape is the source of truth. `CliArgs` is the union that exists for historical reasons."

For your own Tool plugin, you don't need to touch `CliArgs` at all — your `register(cli)` defines its own Commander options and your action handler receives them as the first argument. Use a typed `CliProgram` (re-exported from `@opensip-tools/contracts`) if you want a lint-clean `cli.program as CliProgram` cast without taking a direct `commander` dependency in your package.

## Tips that come up

- **Test every check with the same content filter the framework will use.** The strip behavior is per-language; a check that works on raw content might break on filtered content. Use the language adapter's `stripComments` directly in tests if needed.
- **Use `--debug` aggressively while authoring.** Your check's log lines (`ctx.log(...)`) appear in stderr; the day-level log file under `<project>/opensip-tools/.runtime/logs/<YYYY-MM-DD>.jsonl` archives them. Filter by `runId` with `jq` if multiple runs landed in the same file.
- **Pin your peer-deps to majors, not minors.** Minor opensip-tools releases are non-breaking; pinning to a minor unnecessarily blocks consumers who are already on a newer minor.
- **Use the right discovery shape for the right export.** A package marked `opensipTools.kind: 'tool'` is treated as a Tool by the discovery walker — it must export `tool: Tool`. A check pack uses `kind: 'fit-pack'` (or `'sim-pack'`) and exports `checks` / `recipes`. Mismatching the two leads to a load failure that's logged but not fatal.

## Where to go next

- [**The tool-plugin model**](../10-concepts/02-tool-plugin-model.md) — the architectural seam your Tool plugs into.
- [**Dashboard**](../70-reference/06-dashboard.md) — the HTML report's lifecycle (the renderer your Tool's findings end up in).
- [**Package catalog**](../70-reference/02-package-catalog.md) — the packages you can depend on.
- [**Coding standards**](../80-implementation/04-coding-standards.md) — the style and structure conventions used throughout opensip-tools (handy if you're contributing back).
