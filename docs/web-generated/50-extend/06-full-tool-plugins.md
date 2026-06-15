---
status: current
last_verified: 2026-06-12
release: v0.1.0
title: "Full Tool plugins"
audience: [plugin-authors]
purpose: "Build a Tool plugin — your own opensip-cli subcommand. Use when fit/sim/graph aren't the right shape and you want something fundamentally different."
source-files:
  - packages/core/src/tools/types.ts
  - packages/cli/src/index.ts
  - packages/fitness/engine/src/tool.ts
related-docs:
  - ./03-publishable-packs.md
  - ../10-concepts/02-tool-plugin-model.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
  - ../../decisions/ADR-0030-authored-tool-discovery.md
---
# Full Tool plugins

A Tool plugin contributes its own subcommand. Use this when you want something fundamentally different from `fit`, `sim`, or `graph` — an `audit-sec`, a `bench`, a custom `report`. Anything that has its own argv shape, its own logic, and its own result type.

This is the heaviest extension shape. Most teams never need it. If you just want to ship rules, [Publishable packs](/docs/opensip-cli/50-extend/03-publishable-packs/) is the right path.

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
    "apiVersion": 1,
    "commands": [
      { "name": "audit-sec", "description": "Run the security audit" }
    ]
  },
  "peerDependencies": {
    "@opensip-cli/contracts": "^0.1.0",
    "@opensip-cli/core": "^0.1.0"
  }
}
```

The `opensipTools` block is your tool's **static manifest** — read before your module is imported, so the host knows what it's admitting:

- **`kind: "tool"`** — the marker that makes the CLI discover your package.
- **`id`** — your tool's stable identity; must equal the runtime `tool.metadata.id`.
- **`apiVersion`** — the plugin-API epoch you target (currently `1`). A tool
  that declares no `apiVersion` is not admitted (it fail-closes when run
  explicitly, or is skipped with a diagnostic when discovered).
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

```ts
import { defineCommand, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { runAudit } from './audit.js';

export const tool: Tool = {
  metadata: {
    id: 'audit-sec', // must equal opensipTools.id in package.json
    version: '1.0.0',
    description: 'Lightweight security audit',
  },
  // Command metadata (name + description) — enumerated for --help/completion
  // without importing your module. Its name SET must match opensipTools.commands
  // in package.json AND your commandSpecs below (the host asserts all three agree).
  commands: [
    { name: 'audit-sec', description: 'Run the security audit' },
  ],
  // The typed specs the host mounts (mountCommandSpec): name/description/flags/
  // args + the handler. This is the one command surface — you never touch Commander.
  commandSpecs: [
    defineCommand<{ cwd: string }, ToolCliContext>({
      name: 'audit-sec',
      description: 'Run the security audit',
      // Cross-tool flags from the shared registry — `--cwd` and `--json` arrive
      // for free; you do NOT declare `--json` or render it yourself.
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      // The host renders the result and serializes `--json` as a CommandOutcome.
      output: 'command-result',
      handler: async (opts, cli) => {
        const result = await runAudit(opts.cwd);
        cli.setExitCode(result.passed ? 0 : 1);
        return result; // return your domain result — the host owns rendering / --json / exit
      },
    }),
  ],
  // Host-owned run timing (host-owned-run-timing): if your tool writes a
  // cross-tool history row (sessions list / report), do NOT persist it
  // yourself. RETURN a `ToolRunCompletion` from your handler (or live renderer)
  // — i.e. `{ result?, envelope?, session?, dashboard? }` — whose `session` is a
  // `ToolSessionContribution` `{ tool, cwd, recipe?, score, passed, payload? }`.
  // The host run plane stamps `startedAt`/`completedAt`/`durationMs` from the
  // single `RunTimer` and persists the row. The timer is read-only on the
  // context (`cli.runSession.timing`, also passed to live renderers as the
  // optional second `LiveViewContext` arg) for a display clock only — there is
  // no `record(...)` writer. Tools never capture their own Date for the generic
  // columns; internal per-scenario/per-check timers are fine and belong in your
  // `payload` (or the `dashboard` contribution for a per-run report tab).
});
    }),
  ],
};
```

The three command declarations — `package.json`'s `opensipTools.commands`, the Tool's `commands` metadata, and the `commandSpecs` — must agree on the command-name set. The host asserts this at load, so a half-renamed command fails fast with a clear error instead of a silent half-mounted surface.

That's the whole tool. Install it either way and `opensip audit-sec` works on the next invocation:

- **`opensip plugin add @my-co/audit-sec`** — the CLI detects the `opensipTools.kind: "tool"` marker (reading a local path's `package.json`, or `npm view` for a registry spec) and installs it **user-global** into `~/.opensip-cli/plugins/tool/`, so the subcommand is available in **every** project — the cross-project analogue of `npm i -g`. Add `--project` to install it project-local under `<project>/opensip-cli/.runtime/plugins/tool/` instead (that copy is **gitignored and not shared** with teammates, and keeps provenance `installed` — it is still an npm install, not authored content). Unlike fit/sim packs, a tool needs **no** `plugins.<domain>` config entry — it auto-discovers by its marker. (If detection can't reach the registry — offline / private — pass `--domain tool` to force the tool path.)
- **`npm install @my-co/audit-sec`** in your project — discovery walks the project tree's `node_modules`, so a plain install is picked up too. A global `npm i -g @my-co/audit-sec` next to a global `opensip-cli` is found via the CLI's own install tree.

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
  loading it would run untrusted code. It is admitted **only** when its `id` (or
  `*`) appears in `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`; otherwise the CLI
  **fail-closes (exit 5) before importing it**. Provenance is `project-local`.
- `~/.opensip-cli/tools/<name>/opensip-tool.manifest.json` — **trusted-by-default**:
  you placed it in your own home dir (the `npm i -g` analogue for authored code),
  so it loads without an allowlist. Provenance is `user-global`.

The sidecar **is** the manifest block (there is no `package.json` alongside it),
carrying the same identity fields inline — `kind`, `id`, `name`, `version`,
`apiVersion`, `commands` — plus the path to the tool's own resolved main entry:

```jsonc
// <project>/opensip-cli/tools/audit-sec/opensip-tool.manifest.json
{
  "kind": "tool",
  "id": "audit-sec",
  "name": "Security audit",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "dist/index.js",
  "commands": [
    { "name": "audit-sec", "description": "Run the security audit" }
  ]
}
```

The runtime contract is unchanged — the directory's resolved main must export
`tool: Tool`, and the host runs the same `assertManifestMatchesTool` drift guard.
Authored discovery, admission, dynamic import, and registration travel the exact
same path bundled and installed tools do ([ADR-0030](https://github.com/opensip-ai/opensip-cli/blob/v0.1.0/docs/decisions/ADR-0030-authored-tool-discovery.md)).

> **Sidecar vs `plugin add --project`.** `plugin add --project` *installs an npm
> package* into the gitignored `.runtime/plugins/tool/` and keeps provenance
> `installed`. An authored sidecar is *tracked source* with provenance
> `project-local` (project) or `user-global` (home). They are different
> mechanisms; the provenance label in `plugin list` tells them apart.

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

## Tools that use the kernel registries

A Tool that wants to reuse the fitness check registry (e.g. an `audit-fit` that runs a custom recipe) imports `@opensip-cli/fitness` and reuses `executeFit`, `defineRecipe`, etc. The fitness package re-exports these so a Tool author doesn't have to assemble a runner from scratch.

A Tool that's structurally different (a benchmark runner, a custom report generator) doesn't need to import `@opensip-cli/fitness` at all — it can be entirely self-contained, with its own logic and its own output shape, as long as it produces a renderable `CommandResult` for the CLI's render layer to consume.

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

## Tips that come up

- **Test every check with the same content filter the framework will use.** The strip behavior is per-language; a check that works on raw content might break on filtered content. Use the language adapter's `stripComments` directly in tests if needed.
- **Use `--debug` aggressively while authoring.** Your check's log lines (`ctx.log(...)`) appear in stderr; the day-level log file under `<project>/opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl` archives them. Filter by `runId` with `jq` if multiple runs landed in the same file.
- **Pin your peer-deps to majors, not minors.** Minor opensip-cli releases are non-breaking; pinning to a minor unnecessarily blocks consumers who are already on a newer minor.
- **Use the right discovery shape for the right export.** A package marked `opensipTools.kind: 'tool'` is treated as a Tool by the discovery walker — it must export `tool: Tool`. A check pack uses `kind: 'fit-pack'` and exports `checks` / `recipes`; simulation scenario packs use the `scenarios-*` package-name convention or an explicit `plugins.scenarioPackages:` list. Mismatching these shapes leads to a load failure that's logged but not fatal.
- **An authored sidecar tool is discovered by file presence, not a marker.** A tool under a `tools/` root (`<project>/opensip-cli/tools/` or `~/.opensip-cli/tools/`) is found by the presence of `opensip-tool.manifest.json`, not by a `node_modules` `opensipTools.kind` marker. Remember the project (`project-local`) location is deny-by-default — allowlist its `id` in `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` or it fail-closes before import.

## Where to go next

- [**The tool-plugin model**](/docs/opensip-cli/10-concepts/02-tool-plugin-model/) — the architectural seam your Tool plugs into.
- [**`tools` command**](/docs/opensip-cli/70-reference/12-tools-command/) — list, validate, install, uninstall, and purge data for whole Tool plugins.
- [**Report**](/docs/opensip-cli/70-reference/06-dashboard/) — the HTML report's lifecycle (the renderer your Tool's findings end up in).
- [**Package catalog**](/docs/opensip-cli/70-reference/02-package-catalog/) — the packages you can depend on.
- [**Coding standards**](/docs/opensip-cli/80-implementation/04-coding-standards/) — the style and structure conventions used throughout opensip-cli (handy if you're contributing back).
