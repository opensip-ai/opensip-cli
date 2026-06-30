---
status: current
last_verified: 2026-06-27
release: v0.1.17
title: "Full Tool plugins"
audience: [plugin-authors]
purpose: "Build a Tool plugin — your own opensip-cli subcommand. Use when fit/sim/graph/yagni aren't the right shape and you want something fundamentally different."
source-files:
  - packages/core/src/tools/types.ts
  - packages/cli/src/index.ts
  - packages/fitness/engine/src/tool.ts
related-docs:
  - ./03-publishable-packs.md
  - ./07-command-taxonomy.md
  - ../10-concepts/02-tool-plugin-model.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
  - ../../decisions/ADR-0030-authored-tool-discovery.md
---
# Full Tool plugins

A Tool plugin contributes its own subcommand. Use this when you want something fundamentally different from `fit`, `sim`, `graph`, or `yagni` — an `audit-sec`, a `bench`, a custom `report`. Anything that has its own argv shape, its own logic, and its own result type.

This is the heaviest extension shape. Most teams never need it. If you just want to ship rules, [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/) is the right path.

## Project-local authoring paths

| Path | Command | When to use |
|------|---------|-------------|
| `minimal-js` | `opensip tools create <id>` | Zero-dependency smoke tests inside a repo |
| `ts-local` | `opensip tools create <id> --template ts-local` | Typed authoring with `createTool()` before packaging |
| Publishable npm | `opensip tools install <spec>` | Distribution to other repos (deferred scaffold — see ADR-0076) |

`createTool()` is the ergonomic entry point for typed local tools; `defineTool()`
remains the explicit low-level contract. Neither helper synthesizes lifecycle
`extensionPoints` — absence is the safe default
([ADR-0076](https://github.com/opensip-ai/opensip-cli/blob/v0.1.17/docs/decisions/ADR-0076-tool-authoring-template-and-helper-boundary.md)).

Once a Tool exists as a package, the customer-facing management surface is the [`tools` command group](/docs/opensip-cli/70-reference/12-tools-command/): `tools list`, `tools validate`, `tools install`, `tools uninstall`, and `tools data-purge`.

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
  "version": "1.0.0",
  "main": "dist/index.js",
  "type": "module",
	  "opensipTools": {
	    "kind": "tool",
	    "id": "audit-sec",
	    "identity": { "name": "audit-sec" },
	    "apiVersion": 1,
	    "requires": [
	      { "resource": "filesystem", "access": "read", "scope": "project" }
	    ],
	    "commands": [
	      { "name": "audit-sec", "description": "Run the security audit" },
	      { "name": "list", "parent": "audit-sec", "description": "List audit rules" },
	      { "name": "recipes", "parent": "audit-sec", "description": "List audit recipes" },
	      { "name": "export", "parent": "audit-sec", "description": "Export audit artifacts (--format sarif)" }
	    ]
	  },
  "peerDependencies": {
    "@opensip-cli/contracts": "^0.1.17",
    "@opensip-cli/core": "^0.1.17"
  }
}
```

The `opensipTools` block is your tool's **static manifest** — read before your module is imported, so the host knows what it's admitting:

- **`kind: "tool"`** — the marker that makes the CLI discover your package.
- **`id`** — your canonical human key; must equal `identity.name` and runtime `tool.metadata.name`.
- **`identity`** — the single source for the primary command, aliases, config namespace, and layout key.
- **`apiVersion`** — the plugin-API epoch you declare. The host admits manifests
  when `MIN_SUPPORTED_PLUGIN_API_VERSION <= apiVersion <= PLUGIN_API_VERSION`
  (currently `1..1`). A tool that declares no `apiVersion` is not admitted (it
  fail-closes when run explicitly, or is skipped with a diagnostic when discovered).
- **`requires`** — optional, declaration-only resource requirements. The host
  normalizes and hashes them for manifest provenance/trust UX, but they are not
  a sandbox. An admitted external tool still runs with the current user's OS
  privileges.
- **`commands`** — the command **names** (with descriptions) your tool mounts. The host asserts this set equals your runtime `tool.commands` at load (`assertManifestMatchesTool`) and throws on drift — the manifest is the cheap, no-import way to enumerate your surface for `--help`/completion, so it must stay in sync with the tool.

Peer-dep on `@opensip-cli/contracts` and `@opensip-cli/core` at `^0.1.0`; the
consumer brings their own version. (While opensip-cli is pre-1.0, a `^0.x`
caret locks to the minor — `^0.1.0` is `>=0.1.0 <0.2.0` — so bump your peer
range when you adopt a new `0.y` line.)

## `src/index.ts`

A tool **declares** its commands as typed `CommandSpec`s and the host mounts them —
owning the common flags (`--cwd`, `--json`, …), parsing, help, completion, output
dispatch, and exit policy. You write a handler and a declaration; everything else
arrives for free, identically to a bundled tool. You never touch Commander, never
add `--json` yourself, and never write to stdout — the host renders your result and
wraps `--json` in a `CommandOutcome`.

| `CommandSpec.output` | Use for | External Tool support |
|---|---|---|
| `command-result` | Normal commands that return a renderable result | Supported |
| `raw-stream` | File export or worker/transport commands that own their stream | Supported, with `rawStreamReason` |
| `live-view` | Bundled in-process tools that register a renderer | Not supported for external manifests; validation fails fast |

```ts
import {
  defineNestedCommand,
  definePrimaryCommand,
  defineTool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { listAuditRecipes, listAuditRules, runAudit } from './audit.js';

export const tool = defineTool({
  identity: { name: 'audit-sec' },
  metadata: {
    id: '0c9d1b75-1d6c-4d42-a2f7-76907c3f0181',
    version: '1.0.0',
    description: 'Lightweight security audit',
  },
  // defineTool derives metadata.name, the primary command name, aliases,
  // nested parents, and commands[] from identity + these specs.
  commandSpecs: [
    definePrimaryCommand<{ cwd: string }, ToolCliContext>({
      description: 'Run the security audit',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async (opts, cli) => {
        const result = await runAudit(opts.cwd);
        cli.setExitCode(result.passed ? 0 : 1);
        return result;
      },
    }),
    defineNestedCommand<{ cwd: string }, ToolCliContext>({
      name: 'list',
      description: 'List audit rules',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async (opts) => listAuditRules(opts.cwd),
    }),
    defineNestedCommand<{ cwd: string }, ToolCliContext>({
      name: 'recipes',
      description: 'List audit recipes',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async (opts) => listAuditRecipes(opts.cwd),
    }),
    defineNestedCommand<{ cwd: string; out: string }, ToolCliContext>({
      name: 'export',
      description: 'Export audit artifacts',
      commonFlags: ['cwd', 'json'],
      options: [
        {
          flag: '--format',
          value: '<fmt>',
          required: true,
          choices: ['sarif'],
          description: 'Export artifact: sarif',
        },
        { flag: '--out', value: '<path>', required: true, description: 'Output file path' },
      ],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'file-export',
      handler: async (opts, cli) => {
        // file-writing export — same pattern as `fit export` / `graph export`
        await cli.writeSarif(/* … */, opts.out);
      },
    }),
  ],
});
```

## Output modes

A command declares one `output` mode on its `CommandSpec`; that mode determines
the single path your handler uses to produce output. You never write to stdout or
add `--json` yourself — the host renders your result and wraps `--json` in a
`CommandOutcome`.

| `output` mode | What your handler does | Host behavior |
|---|---|---|
| `command-result` (default) | `return` a `CommandResult` (e.g. `{ type: 'text-lines', … }`) | Renders for humans; wraps the result under `CommandOutcome` for `--json` |
| `signal-envelope` | `return` a `SignalEnvelope` (or `cli.emitEnvelope(env)`) | Wraps the envelope under `CommandOutcome.envelope`; routes baseline/SARIF/cloud seams |
| `raw-stream` | `cli.emitRaw(...)` (requires a `rawStreamReason`) | Writes your bytes verbatim — for human status lines / file-export confirmations, not machine JSON |
| `live-view` | `cli.renderLive(key, args)` | Renders an Ink/TTY live view. **Bundled/in-process tools only** — external manifest tools may not declare it (see [External tool trust boundary](#external-tool-trust-boundary-adr-0054-adr-0061)) |

**Error path (any mode).** To fail a command, either `throw` a typed `ToolError`
(the host maps it to an exit code) or call `cli.reportFailure({ error, … })` — the
host accepts any caught value, derives the message/exit code, logs, renders the
customer surface, and sets the exit code. Do not `process.exit` or format errors
yourself. See [Command failures vs findings](#command-failures-vs-findings).

## Logging and operational telemetry

During a normal command run, `cli.logger` resolves to the **per-run scope logger**
and writes structured JSONL under `<project>/opensip-cli/.runtime/logs/` when the
host configures a log directory. Prefer stamping a stable `module` on every entry:

```ts
import { createToolLogger } from '@opensip-cli/core';

const log = createToolLogger('audit-sec:cli');

handler: async (opts, cli) => {
  log.info({ evt: 'audit-sec.run.start', cwd: opts.cwd });
  // …
};
```

Or call `cli.logger` directly with both `evt` and `module` fields. Event names follow
the three-segment convention documented in [Coding standards](/docs/opensip-cli/80-implementation/04-coding-standards/).
`--debug` may mirror log lines to stderr; that channel is for operators, not
customer-facing command output.

## Command failures vs findings

| Situation | Seam |
|---|---|
| Scan/analysis results (signals, score, verdict) | Build a `SignalEnvelope` and return it (or call `cli.deliverSignals` after render) |
| Command cannot run (missing file, bad config, not found) | `await cli.reportFailure({ … })` |
| Uncaught `ToolError` in a handler | Host catches and calls `reportFailure` for you |
| Durable artifact export | `await cli.writeArtifact(path, bytes)` (or a narrower host seam such as `cli.writeSarif`) |

`reportFailure` fans out to structured log, human Ink / `--json` error `CommandOutcome`,
exit code, and diagnostics — the host owns routing. Example:

```ts
handler: async (opts, cli) => {
  try {
    cli.logger.info({ evt: 'audit-sec.run.start', module: 'audit-sec:cli' });
    return await runAudit(opts.cwd);
  } catch (error) {
    await cli.reportFailure({ error, jsonRequested: opts.json === true });
    return;
  }
};
```

See [ADR-0077](https://github.com/opensip-ai/opensip-cli/blob/v0.1.17/docs/decisions/ADR-0077-unified-tool-logging-and-error-reporting.md).

`defineTool` derives `commands[]` from `commandSpecs` (including `parent` for
nested children). The manifest lists every command by **short name** — `list`,
`recipes`, `export` — not as nested paths; external-host mounting uses the
serializable `parent` field in the manifest command shell.
See [Command surface taxonomy](/docs/opensip-cli/50-extend/07-command-taxonomy/) for the full Tier-1/2/3
grammar.

The manifest and derived `commands[]` must agree on the command-name set. The
host asserts this at load, so a half-renamed command fails fast with a clear
error instead of a silent half-mounted surface.

That's the whole tool. Install it either way and `opensip audit-sec` works on the next invocation:

- **`opensip tools install @my-co/audit-sec`** — validates the package against the Tool contract, then installs it **user-global** into `~/.opensip-cli/plugins/tool/` by default, so the subcommand is available in **every** project — the cross-project analogue of `npm i -g`. Add `--project` to install it project-local under `<project>/opensip-cli/.runtime/plugins/tool/` instead (that copy is **gitignored and not shared** with teammates, and keeps provenance `installed` — it is still an npm install, not authored content). Unlike fit/sim packs, a tool needs **no** `plugins.<domain>` config entry — it auto-discovers by its `opensipTools.kind: "tool"` marker. (Whole Tool plugins are managed ONLY by `opensip tools …`; the per-tool `plugin` group manages a pack-supporting tool's extension packs, not whole tools.)
- **`npm install @my-co/audit-sec`** in your project — discovery walks the project tree's `node_modules`, so a plain install is picked up too. A global `npm i -g @my-co/audit-sec` next to a global `opensip-cli` is found via the CLI's own install tree.

Installed npm tools found ambiently in `node_modules` are deny-by-default. The
managed path is `opensip tools install`: it validates the package, installs the
validated bytes, and records trust for the selected scope. The `tools install`
result includes `nextSteps` with the first command to try:

```bash
opensip audit-sec
```

`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` still accepts exact ids for manual
experiments or incident response. The `*` wildcard is accepted but warns because
it admits every discovered installed Tool.

## Authored Tool sidecars (tracked, no npm install)

The routes above all package your tool as **npm** (provenance `installed`). A
second mechanism lets you author a Tool as **tracked source** — the
whole-subcommand analogue of the `opensip-cli/fit/checks/` and
`opensip-cli/sim/scenarios/` convention — with no `npm install` and no
`package.json` marker. You declare identity via an `opensip-tool.manifest.json`
**sidecar** next to the tool's built entry, in one of two locations with
**different trust postures**:

- `<project>/opensip-cli/tools/<name>/opensip-tool.manifest.json` — **TRACKED**,
  committed alongside `opensip-cli/fit/` and `opensip-cli/sim/`. It is
  **deny-by-default**: it rides in with a `git clone` before you've read it, so
  loading it would run untrusted code. It is admitted **only** when its `id`
  appears in committed project config under `tools.trusted` or in the
  `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` override; otherwise the CLI **fail-closes
  (exit 5) before importing it**. Provenance is `project-local`.
- `~/.opensip-cli/tools/<name>/opensip-tool.manifest.json` — **trusted-by-default**:
  you placed it in your own home dir (the `npm i -g` analogue for authored code),
  so it loads without an allowlist. Provenance is `user-global`.

The sidecar **is** the manifest block (there is no `package.json` alongside it),
carrying the same identity fields inline — `kind`, `id`, `identity`, `name`,
`version`, `apiVersion`, `commands` — plus the path to the tool's own resolved
main entry:

```jsonc
// <project>/opensip-cli/tools/audit-sec/opensip-tool.manifest.json
{
	  "kind": "tool",
	  "id": "audit-sec",
	  "identity": { "name": "audit-sec" },
	  "name": "Security audit",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "dist/index.js",
	  "commands": [
	    { "name": "audit-sec", "description": "Run the security audit" },
	    { "name": "list", "parent": "audit-sec", "description": "List audit rules" },
	    { "name": "recipes", "parent": "audit-sec", "description": "List audit recipes" },
	    { "name": "export", "parent": "audit-sec", "description": "Export audit artifacts (--format sarif)" }
	  ]
}
```

The runtime contract is unchanged — the directory's resolved main must export
`tool: Tool`, and the host runs the same `assertManifestMatchesTool` drift guard.
Authored discovery, admission, dynamic import, and registration travel the exact
same path bundled and installed tools do ([ADR-0030](https://github.com/opensip-ai/opensip-cli/blob/v0.1.17/docs/decisions/ADR-0030-authored-tool-discovery.md)).

> **Sidecar vs `tools install --project`.** `tools install --project` *installs an
> npm package* into the gitignored `.runtime/plugins/tool/` and keeps provenance
> `installed`. An authored sidecar is *tracked source* with provenance
> `project-local` (project) or `user-global` (home). They are different
> mechanisms; the provenance label in `opensip tools list` tells them apart.

## What you don't need

- An entry-points declaration.
- A hook or middleware registration.
- A code change in `opensip-cli`.
- A code change in `@opensip-cli/core`.
- A schema migration.

The Tool contract is the seam. The CLI builds a per-invocation `ToolRegistry`,
discovers your package via the `opensipTools.kind: 'tool'` marker, admits it
(manifest + `apiVersion` check), dynamically imports it, and mounts your
declared `commandSpecs` via `mountCommandSpec`. `commandSpecs` is the one
command surface. For the architecture behind this decoupling, see
[the tool-plugin model](/docs/opensip-cli/10-concepts/02-tool-plugin-model/).

Contract versions (core `TOOL_CONTRACT_VERSION` + per-tool versions such as
`FITNESS_CONTRACT_VERSION`) are documented in the same model page and the
governing ADRs (0046/0047). Declare the relevant ones on your `Tool` object
(under `extensionPoints` is the preferred path) so hosts and `agent-catalog`
can see the exact surface you were written against.

## Recipe listing (shared display, tool-owned execution)

Fitness, graph, and simulation expose `recipes` list commands that return the
shared `ListRecipesResult` shape. Core provides display-only helpers
(`recipeDisplayInfo`, `allUnitsLabel`, …) for name/description/tags and a neutral
`selectionLabel`. Each tool still owns selector semantics and execution:

- **Fitness** — check selectors, retry/timeout/reporting during runs.
- **Graph** — rule selectors only; recipes do not execute scenarios.
- **Simulation** — scenario execution and sim-only selector arms.

There is no generic recipe execution framework in core.

## Tools that use the kernel registries

A Tool that wants to reuse the fitness check registry (e.g. an `audit-fit` that runs a custom recipe) imports `@opensip-cli/fitness` and reuses `executeFit`, `defineRecipe`, etc. The fitness package re-exports these so a Tool author doesn't have to assemble a runner from scratch.

A Tool that's structurally different (a benchmark runner, a custom report generator) doesn't need to import `@opensip-cli/fitness` at all — it can be entirely self-contained, with its own logic. For terminal output, return an existing renderable `CommandResult` shape such as `text-lines`; new host-specific result variants require a CLI/contracts change because the render mapping is intentionally closed and exhaustive.

## Participating in `init` scaffolding

`opensip init` is registry-driven: it scaffolds one directory tree per registered tool, and your tool owns its example bytes. To opt in, declare three optional `Tool` members — the host owns the directory layout, the document header, and `targets:`; you own everything inside your domain:

- **`pluginLayout`** — `{ domain, userSubdirs }`. `init` creates `opensip-cli/<domain>/<subdir>/` for each `userSubdirs` entry (fitness uses `{ domain: 'fit', userSubdirs: ['checks', 'recipes'] }`). A tool with no `pluginLayout` (e.g. `graph`) scaffolds nothing.
- **`scaffoldExamples(ctx)`** — returns the `ScaffoldFile[]` to write (each `{ kind, filename, content, stableId }`); `kind` matches one of your `userSubdirs`. `ctx.languages` is the project's detected/selected language list, so you can emit per-language examples.
- **`stableExampleIds()`** — your tool's COMPLETE pinned-id universe (across every language), used by `init --keep` to detect stale scaffolds left over from a config the project no longer uses.
- **`scaffoldConfigBlock()`** *(optional)* — returns your tool's YAML config block (e.g. fitness's `fitness:` block), appended to the host-rendered document. Omit it if your tool needs no config block.

No `packages/cli` change is needed to add a tool to `init` — the scaffolded set is exactly the registered set.

## Per-command options: one interface per command

Each built-in command has its own options interface in `@opensip-cli/contracts`, and that interface is the single source of truth for the command's flags — the executor takes it directly (`executeFit(args: FitOptions, …)`, `executeSim(args: ToolOptions)`, `executeInit(args: InitOptions & {…})`).

| Command | Options interface |
|---|---|
| `fit`     | `FitOptions` |
| `sim`     | `ToolOptions` |
| `init`    | `InitOptions` |
| your tool | a new interface in your tool package, named after the command |

New flags are additive on the relevant interface. There is no shared cross-command union — each command's shape stands on its own.

For your own Tool plugin you don't reuse any of these: you declare each
command's options as `OptionSpec`s on its `commandSpec`, and the host wires
Commander and passes the parsed options to your handler as the first argument.
You never touch Commander or take a `commander` dependency — the host owns the
program.

## External tool trust boundary (ADR-0054, ADR-0061)

Bundled first-party tools (`fitness`, `graph`, `simulation`) execute in the CLI host
process and are fail-closed on admission or mount failure (exit 5).

**External-provenance tools** (installed npm, project-local, user-global) use a
different posture — **fault isolation**, not capability isolation:

- **Host registration (M4-G)** — the host mounts command shells from the static
  manifest via `synthesizeExternalTool` and does **not** import the untrusted
  runtime module in the host process.
- **Worker dispatch (M4-E)** — command handlers for external provenance fork a
  `__tool-command-worker` child that loads and runs the real runtime in a
  **fault-isolation** boundary; results replay through the same `ToolCliContext` seams.
- **Lifecycle gating (M4-F)** — external lifecycle/capability hooks run in the
  worker, not the host.
- **Enforcement** — `host-tool-runtime-import-boundary` fitness check forbids
  host-side runtime imports outside the admission/dispatch modules.

> An admitted external tool runs at full user privilege: it can read the filesystem (including `~/.ssh` and `.env`), and make arbitrary network calls. It is fault-isolated (a crash/hang/OOM does not take down the host), not capability-isolated.

**In-process capability packs** (custom checks, graph adapters loaded via
`plugins.<domain>`) are the **least isolated** extension surface: they load in the
host process with import-error isolation only — no worker boundary. The external
worker fork does **not** cover them.

For the full extension trust-tier matrix, see
[ADR-0061](https://github.com/opensip-ai/opensip-cli/blob/v0.1.17/docs/decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md)
(canonical) and the contributor reference
[`docs/internal/plugin-isolation-surface.md`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.17/docs/internal/plugin-isolation-surface.md).

What is enforced at admission:

- Manifest compatibility, `apiVersion`, and manifest⇔runtime drift checks
  (`admit-tool-package.ts`).
- External manifest command shells may declare `output: "command-result"` or
  `output: "raw-stream"`; `output: "live-view"` is rejected by admission and by
  `tools validate`. A live-view renderer is executable UI code and cannot be
  mounted from a manifest-only external tool shell.
- Deny-by-default trust gates for project-local and installed tools. Project-local
  authored tools are admitted by `tools.trusted` (or the
  `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` override). Installed tools are admitted by a
  managed `tools install` trust record (or the `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`
  override). The `*` wildcard admits all and emits a per-invocation
  `cli.trust.wildcard_allowlist` deprecation warning (DEPRECATED — every matching
  tool runs at full user privilege).
- Deny-by-default capability packs for marker-discovered in-process extensions.
  Bundled first-party packs are trusted, and exact packages listed in
  `plugins.checkPackages`, `plugins.scenarioPackages`, or `plugins.graphAdapters`
  are explicit project trust decisions. Ambient marker-discovered packs require
  `OPENSIP_CLI_ALLOW_CAPABILITY_PACKS` by exact package name before import.
  Wildcard allowlisting is ignored for capability packs.
- **Mount isolation** — a broken external `commandSpecs` declaration warns and
  continues; bundled mount failures abort startup (exit 5).
- **`tools validate`** — probes a not-yet-trusted package in a child process
  (`staticOnly` on the admission pipeline).

What is **not** landed yet: **consumption-side** npm package verification at
install/load (publish-side `npm publish --provenance` already ships —
`.github/workflows/release.yml:236,248`). Public third-party ecosystem launch is
blocked until consumption-side verification + a capability/permission model ship
(ADR-0061). Until then, pin versions, review source, and use `opensip tools validate`
before enabling a new tool in CI.

## Tips that come up

- **Test every check with the same content filter the framework will use.** The strip behavior is per-language; a check that works on raw content might break on filtered content. Use the language adapter's `stripComments` directly in tests if needed.
- **Use `--debug` aggressively while authoring.** Your check's log lines (`ctx.log(...)`) appear in stderr; the day-level log file under `<project>/opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl` archives them. Filter by `runId` with `jq` if multiple runs landed in the same file.
- **For pre-1.0 peer dependencies, pin to the current minor line.** A caret range such as `^0.1.0` allows patch updates but not `0.2.0`; revisit the range when you adopt a new `0.y` line.
- **Use the right discovery shape for the right export.** A package marked `opensipTools.kind: 'tool'` is treated as a Tool by the discovery walker — it must export `tool: Tool`. A check pack uses `kind: 'fit-pack'` and exports `checks` / `recipes`; simulation scenario packs use the `scenarios-*` package-name convention or an explicit `plugins.scenarioPackages:` list. Mismatching these shapes leads to a load failure that's logged but not fatal.
- **An authored sidecar tool is discovered by file presence, not a marker.** A tool under a `tools/` root (`<project>/opensip-cli/tools/` or `~/.opensip-cli/tools/`) is found by the presence of `opensip-tool.manifest.json`, not by a `node_modules` `opensipTools.kind` marker. Remember the project (`project-local`) location is deny-by-default — list its `id` in `tools.trusted` or use the `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` override, otherwise it fail-closes before import.

## Where to go next

- [**Command surface taxonomy**](/docs/opensip-cli/50-extend/07-command-taxonomy/) — Tier-1/2/3 grammar, nested `parent`, export `--format`, internal visibility.
- [**The tool-plugin model**](/docs/opensip-cli/10-concepts/02-tool-plugin-model/) — the architectural seam your Tool plugs into.
- [**`tools` command**](/docs/opensip-cli/70-reference/12-tools-command/) — list, validate, install, uninstall, and purge data for whole Tool plugins.
- [**Report**](/docs/opensip-cli/70-reference/06-dashboard/) — the HTML report's lifecycle (the renderer your Tool's findings end up in).
- [**Package catalog**](/docs/opensip-cli/70-reference/02-package-catalog/) — the packages you can depend on.
- [**Coding standards**](/docs/opensip-cli/80-implementation/04-coding-standards/) — the style and structure conventions used throughout opensip-cli (handy if you're contributing back).
