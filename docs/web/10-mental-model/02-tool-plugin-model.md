---
status: current
last_verified: 2026-05-15
title: "The tool-plugin model"
audience: [contributors, plugin-authors]
purpose: "How the CLI doesn't know what `fit` does. The Tool contract, the registry, the dispatcher, and what it takes to add a third tool."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/tools/registry.ts
  - packages/core/src/plugins/tool-package-discovery.ts
  - packages/cli/src/index.ts
  - packages/fitness/engine/src/tool.ts
  - packages/simulation/engine/src/tool.ts
related-docs:
  - ./01-fitness-loop.md
  - ./03-modular-monolith.md
  - ./04-contract-surfaces.md
  - ../60-surfaces/02-plugin-authoring.md
---
# The tool-plugin model

The CLI is a generic dispatcher. It cannot tell `fit` from `sim` from any future Tool. This isn't a stylistic choice — it's an architectural commitment that the layer policy enforces and that buys you the only thing that makes the platform shape-consistent over time: the freedom to add a tool without touching the kernel.

> **What you'll understand after this:**
> - What the `Tool` contract looks like and why it has the shape it does.
> - How tools get discovered (first-party static, third-party via `node_modules` walk).
> - The two-step "register then run" lifecycle.
> - What you write to add a third tool.

---

## The contract

A Tool is a TypeScript object. Five fields, two methods. The whole interface lives at [`packages/core/src/tools/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/core/src/tools/types.ts):

```ts
interface Tool {
  metadata: { id: string; version: string; description: string };
  commands: ReadonlyArray<{ name: string; description: string; aliases?: readonly string[] }>;
  register(cli: ToolCliContext): void;
  initialize?: () => Promise<void>;
}
```

That's the entire surface. A Tool is anything that satisfies that shape.

### Why this exact shape

The contract has been deliberately kept narrow. Each field exists for a specific reason:

- **`metadata.id`** is the registry key. `defaultToolRegistry.register(t)` writes `tools[t.metadata.id] = t`. Re-registering the same id is a no-op (last writer wins) — see [`packages/core/src/tools/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/core/src/tools/registry.ts). This is how a third-party Tool can override a first-party one.
- **`commands[]`** carries metadata only — no handlers. The CLI uses this list for `--help` listings and conflict detection (two tools can't both claim the `fit` subcommand). Keeping the list metadata-only means `--help` is cheap: the CLI doesn't have to invoke each tool's `register()` to enumerate available commands.
- **`register(cli)`** does the actual Commander wiring. It receives a `ToolCliContext` (the program object, the render function, the dashboard launcher, the logger, the exit-code setter) and uses it to mount its commands. Tools never import the CLI package directly — they call back into shared infrastructure through this context object.
- **`initialize()`** is optional async setup, called once before any command runs. Most tools don't need it (`fit` doesn't — its setup is lazy inside command handlers). It's there for tools that need eager work: warming a cache, loading a marketplace catalog, validating a license.

### The `ToolCliContext` shape

The context object is the inversion-of-control seam. A tool needs to render results, but it doesn't depend on Ink. It needs to launch a dashboard, but it doesn't depend on the open-browser logic. The CLI provides those operations through the context:

```ts
interface ToolCliContext {
  program: unknown;                              // Commander program (cast inside the tool)
  render: (result: unknown) => Promise<void>;
  renderLive: (viewKey: string, args: unknown) => Promise<void>;
  maybeOpenDashboard: (opts: { openRequested: boolean; jsonOutput: boolean; cwd: string }) => Promise<void>;
  logger: typeof coreLogger;
  setExitCode: (code: number) => void;
}
```

`program` is typed as `unknown` so the contract doesn't pin tools to a specific Commander major version. Each tool casts it on the way in: `const program = cli.program as Command`. If a Commander upgrade changes the type, only the tools that touch that exact API need to update — the contract itself stays stable.

`renderLive(viewKey, args)` is the only stateful UI seam. The CLI maintains a small registry of "live views" (currently `'fit'`); a tool that wants a streaming spinner-to-results experience asks for one by name. Adding a new live view is a CLI-side change, not a contract change.

---

## How tools get registered

The flow lives in [`packages/cli/src/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/cli/src/index.ts) and runs once, at process startup, before argv is parsed.

```
1. Static imports (compile-time):
   import { fitnessTool } from '@opensip-tools/fitness';
   import { simulationTool } from '@opensip-tools/simulation';
   defaultToolRegistry.register(fitnessTool);
   defaultToolRegistry.register(simulationTool);

2. Discovery (runtime):
   for each package in node_modules where package.json
     declares opensipTools.kind === 'tool':
       import its main entry, expect a `tool` export,
       defaultToolRegistry.register(import.tool);

3. Optional initialize:
   for each tool in defaultToolRegistry.list():
     await tool.initialize?.();

4. Build Commander tree:
   const cli = createCliContext(program);
   for each tool:
     tool.register(cli);

5. Parse argv:
   program.parseAsync(process.argv);
```

First-party tools (`fit`, `sim`) are imported statically. They're a direct dep of `@opensip-tools/cli` and ship in the same npm install. Third-party tools are discovered by walking `node_modules` for any package whose `package.json` declares the `opensipTools` metadata block — see [`packages/core/src/plugins/tool-package-discovery.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/core/src/plugins/tool-package-discovery.ts).

The discovery shape is:

```json
{
  "name": "@yourorg/audit-sec",
  "version": "0.3.0",
  "main": "dist/index.js",
  "opensipTools": {
    "kind": "tool"
  }
}
```

The package's main entry must export a `tool` symbol that satisfies the `Tool` contract:

```ts
// dist/index.js
export const tool = {
  metadata: { id: 'audit-sec', version: '0.3.0', description: 'Security audit checks' },
  commands: [{ name: 'audit-sec', description: 'Run security audit' }],
  register(cli) { /* ... */ },
};
```

Once the package is installed under `node_modules` (project-pinned via `plugin add` or transitively via a regular dependency), the CLI picks it up at next launch. No config edit, no code change in `cli` or `core`.

---

## Why this isn't entry-points or hooks

A few alternatives were considered. Worth knowing why they're not what's here.

- **No package.json `bin` shimming.** A Tool is *not* a separate binary. It's a subcommand inside the `opensip-tools` binary. This means one config file, one logger, one runtime dir, one exit-code convention — shared across every tool a user has installed.
- **No JSON manifest schema.** The `opensipTools` field in package.json is just a discovery flag (`kind: 'tool'`). The actual contract is enforced at TypeScript compile time and at runtime by `defaultToolRegistry.register()`. No validator, no schema migration story — if your `tool` export doesn't satisfy the interface, the build fails or the CLI throws on startup.
- **No event hooks or middleware chain.** Tools don't subscribe to events; they own their commands end-to-end. This rules out "before-fit" plugins — but those would create an ordering problem (which middleware runs first?) and an observability problem (whose log line is this?). Tools are flat: install one, run one.
- **No declarative command tree.** A tool wires its own Commander commands inside `register()`. The alternative — declare commands as data, let the CLI build the tree — was rejected because Commander's option-parsing surface is large and varies between major versions. Letting each tool own its own wiring keeps the CLI small.

---

## What you write to add a third tool

The minimum viable tool, end-to-end:

```ts
// packages/audit-sec/src/index.ts
import type { Tool } from '@opensip-tools/core';
import type { Command } from 'commander';

export const auditSecTool: Tool = {
  metadata: {
    id: 'audit-sec',
    version: '0.1.0',
    description: 'Lightweight security audit',
  },
  commands: [
    { name: 'audit-sec', description: 'Run the audit' },
  ],
  register(cli) {
    const program = cli.program as Command;
    program
      .command('audit-sec')
      .description('Run the audit')
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

export const tool = auditSecTool; // discovery export
```

```json
// packages/audit-sec/package.json
{
  "name": "@yourorg/audit-sec",
  "version": "0.1.0",
  "main": "dist/index.js",
  "opensipTools": { "kind": "tool" },
  "peerDependencies": {
    "@opensip-tools/cli": "^1.0.0",
    "@opensip-tools/core": "^1.0.0"
  }
}
```

That's the whole tool. `npm install @yourorg/audit-sec` (or `opensip-tools plugin add @yourorg/audit-sec`), and `opensip-tools audit-sec` works.

What you *don't* need:

- An entry-points declaration.
- A hook or middleware registration.
- A code change in `@opensip-tools/cli`.
- A code change in `@opensip-tools/core`.
- A schema migration for the project config (unless your tool has its own config — which goes in a tool-namespaced section under `opensip-tools.config.yml`).

If your tool also wants to ship checks (the way `@opensip-tools/checks-typescript` does for `fit`), you have a separate option: a check pack — any npm package whose name matches `@opensip-tools/checks-*` (or is listed in `plugins.checkPackages:`). That's a different contract — see [`60-surfaces/02-plugin-authoring.md`](/docs/opensip-tools/60-surfaces/02-plugin-authoring/).

---

## What this buys you

Three things, in order of importance:

1. **A stable kernel.** `@opensip-tools/core` does not import any tool. The layer policy ([dependency-cruiser config](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/.dependency-cruiser.cjs)) enforces this — `core-imports-nothing-workspace` would fail the build if `core` ever reached up. This means kernel changes are safe: a kernel bump can't break a tool, because the kernel can't see the tool.
2. **Independent tool versioning.** Each Tool package has its own version. The CLI is pinned to a major-version range of each first-party tool, but third-party tools can release on their own cadence. A user can pin `@opensip-tools/checks-python@2.x` while staying on `@opensip-tools/cli@1.x`.
3. **A future where `fit` is just one of many tools.** The platform was designed for `audit-*`, `lint-*`, `report-*`, `bench-*`, and similar Tools to slot in. Today there are two; tomorrow there might be ten. The CLI grows by zero lines.

---

## What's next

- **[`03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/)** — the layer cake the Tool contract sits at the top of. Why `fitness` is one package and not three; why `core` is the only thing every tool depends on.
- **[`04-contract-surfaces.md`](/docs/opensip-tools/10-mental-model/04-contract-surfaces/)** — every public edge: argv, Tool, plugin manifest, JSON output. The contract budget.
- **[`../60-surfaces/02-plugin-authoring.md`](/docs/opensip-tools/60-surfaces/02-plugin-authoring/)** — full walkthrough of writing a Tool, a check pack, and a project-local check.
