---
status: current
last_verified: 2026-06-09
release: v0.1.4
title: "The tool-plugin model"
audience: [contributors, plugin-authors]
purpose: "How the CLI doesn't know what `fit` does. The Tool contract, the manifest, the unified loader, and what it takes to add a third tool."
source-files:
  - packages/core/src/tools/types.ts
  - packages/core/src/tools/registry.ts
  - packages/core/src/tools/manifest-assert.ts
  - packages/core/src/tools/compatibility.ts
  - packages/cli/src/bootstrap/register-tools.ts
  - packages/cli/src/commands/mount-command-spec.ts
  - packages/fitness/engine/src/tool.ts
related-docs:
  - ./01-fitness-loop.md
  - ./03-modular-monolith.md
  - ./04-contract-surfaces.md
  - ../50-extend/01-plugin-authoring.md
  - ../50-extend/06-full-tool-plugins.md
---
# The tool-plugin model

The CLI is a generic dispatcher. It cannot tell `fit` from `sim` from `graph` from any future Tool. This isn't a stylistic choice — it's an architectural commitment that the layer policy enforces and that buys you the only thing that makes the platform shape-consistent over time: the freedom to add a tool without touching the kernel.

Bundled tools (`fit`/`sim`/`graph`) and installed or project-local tools load
through the same path ([ADR-0027](../../decisions/ADR-0027-ga-parity-cutover.md)).
The only thing distinguishing them is their **source of installation, never
their lifecycle**.

> **What you'll understand after this:**
> - What the `Tool` contract looks like and why it has the shape it does.
> - How a tool declares its commands as data (`commandSpecs`) that the host mounts.
> - How tools get discovered and admitted (manifest + `apiVersion`), bundled and third-party alike.
> - What you write to add a third tool.

---

## The contract

A Tool is a TypeScript object. The whole interface lives at [`packages/core/src/tools/types.ts`](../../../packages/core/src/tools/types.ts); the load-bearing members are:

```ts
interface Tool {
  metadata: { id: string; version: string; description: string };
  commands: ReadonlyArray<{ name: string; description: string; aliases?: readonly string[] }>;
  commandSpecs?: ReadonlyArray<CommandSpec<unknown, ToolCliContext>>;
  initialize?: () => Promise<void>;
  // Optional contribution slots (most tools use none):
  contributeScope?: () => ScopeContribution;          // per-run subscope (registries, etc.)
  collectReportData?: (scope: ToolScope) => Record<string, unknown>;
  config?: ToolConfigDeclaration;                      // a namespaced Zod schema block
  capabilityRegistrars?: Record<string, CapabilityRegistrar>;
  sessionReplay?: { tool: string; replaySession: (stored) => unknown };
}
```

A Tool is anything that satisfies that shape. `metadata`, `commands`, and `commandSpecs` are the parts every tool fills in; the rest are opt-in seams the host wires only if present.

### Why this exact shape

The contract has been deliberately kept narrow. Each core member exists for a specific reason:

- **`metadata.id`** is the registry key. `ToolRegistry.register(t)` writes `tools[t.metadata.id] = t` (first-writer-wins) — see [`packages/core/src/tools/registry.ts`](../../../packages/core/src/tools/registry.ts). The bootstrap's discovery loop deliberately skips packages whose `id` matches a bundled tool, so a non-customized third-party install can't accidentally clobber `fit`/`sim`/`graph`.
- **`commands[]`** carries metadata only — no handlers. The CLI uses this list for `--help` listings and conflict detection (two tools can't both claim the `fit` subcommand), and its name **set** must equal the manifest's `commands` (asserted at load — see below). Keeping it metadata-only means `--help` is cheap: the CLI doesn't import a tool's runtime to enumerate its commands.
- **`commandSpecs`** is the tool's **declarative command surface** — typed `CommandSpec`s (name, description, aliases, common-flag selection, per-command options/args, scope, output mode, and the handler). The host's `mountCommandSpec` ([`packages/cli/src/commands/mount-command-spec.ts`](../../../packages/cli/src/commands/mount-command-spec.ts)) reads them and owns the Commander wiring, the shared flags (`--cwd`/`--json`/…), parsing, help, completion, the `--json` `CommandOutcome` wrapping, and the exit-code pipeline. A handler returns its domain result; it never touches Commander and never writes to stdout. `commandSpecs` is the one command surface — §8 "one command surface" invariant.
- **`initialize()`** is optional async setup, called once per process — lazily, by the CLI's preAction hook, when a subcommand owned by this tool is about to run (not eagerly for every tool at startup, so an uninvoked tool and the `--help`/welcome paths pay nothing). Most tools don't need it (`fit` doesn't — its setup is lazy inside handlers). A throwing `initialize()` is fatal — the command does not run.

The optional contribution slots (`contributeScope`, `collectReportData`, `config`, `capabilityRegistrars`, `sessionReplay`) let a tool plug into the host's per-run scope, the cross-tool HTML report, the composed config document, a capability domain it owns, and `sessions show` replay — each only if the tool declares it. The `sessions show` surface (and the new `agent-catalog` discovery command) now include agent ergonomics such as `--filter` and `--raw` for focused historical inspection.

### Tool contract versions (ADR-0046 / ADR-0047)

The core `TOOL_CONTRACT_VERSION` (exported from `@opensip-cli/core`) is a marker for the generic `Tool` / `ToolExtensionPoints` / `ToolCliContext` "bus" surface. It is bumped **only** on actual changes to that surface and takes the major.minor of the CLI release that ships the change (it deliberately lags ordinary CLI releases).

Each tool also has (or will have) its own independent contract version for its rich domain surface:
- `FITNESS_CONTRACT_VERSION` (checks, recipes, defineCheck API, pack loading, etc.)
- `GRAPH_CONTRACT_VERSION`, `SIMULATION_CONTRACT_VERSION`, etc.

These per-tool versions are declared on the tool's `Tool` object (typically under `extensionPoints`) and follow the same ADR-driven bumping policy. They let a change to, say, the fitness check API evolve without forcing a bump to the core Tool contract or affecting graph/sim authors.

See ADR-0046 (core) and ADR-0047 (per-tool) for the full rules, and the JSDoc on the constants themselves. Tool authors extending a specific tool can pin against the relevant per-tool version for compatibility.

### The `ToolCliContext` shape

The context object is the inversion-of-control seam. A tool needs to render results, but it doesn't depend on Ink. It needs to set the exit code, but it doesn't mutate `process.exitCode`. The host provides those operations through the context:

```ts
interface ToolCliContext {
  scope: ToolScope;                              // per-run resources (logger, registries, datastore, project)
  render: (result: unknown) => Promise<void>;    // render a CommandResult through the shared seam
  registerLiveView: (key: string, renderer: LiveViewRenderer) => void;
  renderLive: (key: string, args: unknown) => Promise<void>;
  maybeOpenReport: (opts: { openRequested: boolean; jsonOutput: boolean }) => Promise<void>;
  emitJson: (value: unknown) => void;            // the sanctioned --json stdout seam
  setExitCode: (code: number) => void;           // the only writer of the final exit code
  logger: Logger;
  // …plus emitEnvelope / deliverSignals / writeSarif / emitError — the other governed output seams.
}
```

This context carries no Commander `program`. A handler has no raw-Commander
handle to reach, so "one command surface" is structural, not merely guarded —
the host owns the program internally and mounts each `commandSpec` itself.

`registerLiveView(key, renderer)` / `renderLive(key, args)` are the stateful UI seam. A tool that wants a streaming spinner-to-results experience registers its own renderer under a key (lazily, from a setup hook on first live render) and invokes it by key. The live-view registry is owned by the tool, not the CLI — `fit`, `sim`, and `graph` each ship one. Adding a new live view is a tool-side change, not a contract change.

---

## How tools get loaded

The flow lives in [`packages/cli/src/bootstrap/register-tools.ts`](../../../packages/cli/src/bootstrap/register-tools.ts) and runs once, at process startup, before argv is parsed. Every tool — bundled or installed — travels the **same** admission path:

```
1. Construct a fresh ToolRegistry for this invocation:
   const toolRegistry = new ToolRegistry();

2. Bundled tools load by PACKAGE NAME (not a static import):
   The list is data-driven from `packages/cli/src/bootstrap/bundled-tools.manifest.json`
   (Workstream A). For each: loadToolManifest → admitTool → dynamic import → register.
   The host holds NO `import { fitnessTool }` — the `no-bootstrap-tool-import`
   fitness check fails the build if a static tool-runtime import creeps back.

   To add a new first-party (bundled) tool: add its npm package name (and id for
   scaffolding expectation) to the manifest JSON; the uniform admission path is
   used automatically. Update contributor docs + the architecture ratchet if
   needed.

3. Discovery (third-party): walk, in precedence order, the project's
   .runtime/plugins/tool/ → the project node_modules → the user-global
   ~/.opensip-cli/plugins/tool/ → the CLI's own install tree, for any
   package whose package.json declares opensipTools.kind === 'tool'. Each
   travels the identical loadToolManifest → admitTool → import → register path.

4. admitTool gates every candidate:
   - apiVersion check (compatibility.ts): a tool that declares no `apiVersion`
     is INCOMPATIBLE and not admitted; a mismatched epoch is rejected with an
     upgrade hint.
   - assertManifestMatchesTool (manifest-assert.ts): the static manifest's
     `id` + command-name SET must equal the imported Tool's — a typed throw
     on drift, so a half-renamed command fails fast.

5. Mount: mountAllToolCommands walks the registry and mounts each tool's
   declared commandSpecs via mountCommandSpec. The host owns the Commander
   program; tools never see it.

6. Parse argv, then (lazy) initialize: when a subcommand is about to run, the
   CLI resolves the owning tool and calls its initialize() once per process,
   after the run scope is entered. Uninvoked tools pay nothing.
```

This is the parity cutover's core: **install-source independence is structural, not merely tested.** A bundled tool is loaded by the same `loadToolManifest → admitTool → dynamic import → register → mountCommandSpec` sequence an installed or project-local tool is.

### The discovery manifest

A third-party tool advertises itself with an `opensipTools` block in its `package.json` — read *before* its module is imported, so the host can admit it cheaply:

```json
{
  "name": "@yourorg/audit-sec",
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": {
    "kind": "tool",
    "id": "audit-sec",
    "apiVersion": 1,
    "commands": [
      { "name": "audit-sec", "description": "Run security audit" }
    ]
  }
}
```

The package's main entry must export a `tool` symbol that satisfies the `Tool` contract, whose `metadata.id` and command-name set match the manifest:

```ts
// dist/index.js
export const tool = {
  metadata: { id: 'audit-sec', version: '1.0.0', description: 'Security audit checks' },
  commands: [{ name: 'audit-sec', description: 'Run security audit' }],
  commandSpecs: [/* defineCommand({ name: 'audit-sec', … }) */],
};
```

Once installed, the CLI picks it up at next launch — no config edit, no code change in `cli` or `core`. A project-local pin shadows a user-global install of the same tool.

---

## Why this isn't entry-points or hooks

A few alternatives were considered. Worth knowing why they're not what's here.

- **No package.json `bin` shimming.** A Tool is *not* a separate binary. It's a subcommand inside the `opensip` binary. One config file, one logger, one runtime dir, one exit-code convention — shared across every tool a user has installed.
- **A thin manifest, not a full command-tree schema.** The `opensipTools` block is an *identity + admission* descriptor (`kind`, `id`, `apiVersion`, command names) — enough for the host to discover, version-check, and enumerate a tool's surface without importing it. The real command shape (options, args, handlers) lives in the typed `commandSpecs`; TypeScript and the load-time `assertManifestMatchesTool` keep the two in sync. There's no separate JSON option-schema to maintain.
- **No event hooks or middleware chain.** Tools don't subscribe to events; they own their commands end-to-end. This rules out "before-fit" plugins — but those would create an ordering problem (which middleware runs first?) and an observability problem (whose log line is this?). Tools are flat: install one, run one.
- **A declarative command surface, host-owned wiring.** A tool declares its
  commands as data (`commandSpecs`) and the host builds the Commander tree,
  applies the shared cross-tool flags, and owns parse → handler → render →
  `--json` → exit. Letting every tool touch Commander would make "the same flag
  means the same thing across tools" a convention rather than an invariant.
  Centralizing the wiring makes it structural — see
  [ADR-0027](../../decisions/ADR-0027-ga-parity-cutover.md) and
  [ADR-0021](../../decisions/ADR-0021-cross-tool-cli-flag-currency.md).

---

## What you write to add a third tool

The minimum viable tool, end-to-end:

```ts
// packages/audit-sec/src/index.ts
import { defineCommand, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { runAudit } from './audit.js';

export const auditSecTool: Tool = {
  metadata: {
    id: 'audit-sec',
    version: '1.0.0',
    description: 'Lightweight security audit',
  },
  commands: [
    { name: 'audit-sec', description: 'Run the audit' },
  ],
  commandSpecs: [
    defineCommand<{ cwd: string }, ToolCliContext>({
      name: 'audit-sec',
      description: 'Run the audit',
      commonFlags: ['cwd', 'json'],   // shared flags arrive for free; never declare --json yourself
      scope: 'project',
      output: 'command-result',       // host renders the result + wraps --json as a CommandOutcome
      handler: async (opts, cli) => {
        const result = await runAudit(opts.cwd);
        cli.setExitCode(result.passed ? 0 : 1);
        return result;                // return your domain result — the host owns rendering / --json / exit
      },
    }),
  ],
};

export const tool = auditSecTool; // discovery export
```

```json
// packages/audit-sec/package.json
{
  "name": "@yourorg/audit-sec",
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "module",
  "opensipTools": {
    "kind": "tool",
    "id": "audit-sec",
    "apiVersion": 1,
    "commands": [{ "name": "audit-sec", "description": "Run the audit" }]
  },
  "peerDependencies": {
    "opensip-cli": "^0.1.4",
    "@opensip-cli/core": "^0.1.4"
  }
}
```

That's the whole tool. Add `@yourorg/audit-sec` to the project (or run `opensip plugin add @yourorg/audit-sec`), and `opensip audit-sec` works. For the full walkthrough — installation modes, per-command options, kernel-registry reuse — see [Full Tool plugins](../50-extend/06-full-tool-plugins.md).

What you *don't* need:

- An entry-points declaration.
- A hook or middleware registration.
- A code change in `opensip-cli`.
- A code change in `@opensip-cli/core`.
- A schema migration for the project config (unless your tool has its own config — which goes in a tool-namespaced section under `opensip-cli.config.yml`, declared via the Tool's `config` slot).

If your tool also wants to ship checks (the way `@opensip-cli/checks-typescript` does for `fit`), that's a separate, lighter contract — a check pack declaring `opensipTools.kind: "fit-pack"`. See [`50-extend/01-plugin-authoring.md`](../50-extend/01-plugin-authoring.md).

---

## What this buys you

Three things, in order of importance:

1. **A stable kernel.** `@opensip-cli/core` does not import any tool. The layer policy ([dependency-cruiser config](../../../.config/dependency-cruiser.cjs)) enforces this — the build fails if `core` ever reached up. A kernel bump can't break a tool, because the kernel can't see the tool.
2. **Independent tool versioning.** Each Tool package has its own version. The CLI is pinned to compatible first-party tool releases, but third-party tools release on their own cadence. A user can pin a third-party `@yourorg/audit-sec` release while staying on `opensip-cli@0.1.4`.
3. **A future where `fit` is just one of many tools.** The platform was designed for `audit-*`, `lint-*`, `report-*`, `bench-*`, and similar Tools to slot in by shipping a manifest + `commandSpecs`, inheriting every host-owned plane (output, progress, config, sessions, dashboard). Today there are three (`fit`, `sim`, `graph`); the CLI grows by zero lines for the fourth.

---

## What's next

- **[`03-modular-monolith.md`](./03-modular-monolith.md)** — the layer cake the Tool contract sits at the top of. Why `fitness` is one package and not three; why `core` is the only thing every tool depends on.
- **[`04-contract-surfaces.md`](./04-contract-surfaces.md)** — every public edge: argv, Tool, plugin manifest, JSON output. The contract budget.
- **[`../50-extend/06-full-tool-plugins.md`](../50-extend/06-full-tool-plugins.md)** — the full how-to for writing a Tool plugin.
