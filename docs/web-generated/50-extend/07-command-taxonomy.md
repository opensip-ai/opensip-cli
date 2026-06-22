---
status: current
last_verified: 2026-06-21
release: v0.1.9
title: "Command surface taxonomy"
audience: [plugin-authors, contributors, ci-integrators]
purpose: "The Tier-1/2/3 command grammar — nested `<tool> <verb>` mounting, export `--format`, internal visibility, and manifest drift rules."
source-files:
  - packages/core/src/tools/command-spec.ts
  - packages/core/src/tools/derive-commands-from-specs.ts
  - packages/cli/src/commands/mount-command-spec.ts
  - packages/cli/src/commands/internal-command-visibility.ts
  - packages/fitness/engine/src/cli/fit/fit-aux-command-specs.ts
  - packages/graph/engine/src/cli/graph/graph-aux-command-specs.ts
related-docs:
  - ../10-concepts/02-tool-plugin-model.md
  - ./06-full-tool-plugins.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/10-environment-variables.md
---
# Command surface taxonomy

Every `opensip` subcommand belongs to one of three tiers. The grammar is
enforced for bundled first-party tools (dogfood check
`tool-command-taxonomy.mjs`) and is the recommended shape for third-party Tool
plugins.

## The three tiers

| Tier | Who owns it | Grammar | Examples |
|------|-------------|---------|----------|
| **Tier 1 — Host** | CLI composition root | Flat top-level names | `init`, `report`, `sessions`, `configure`, `agent-catalog`, `completion`, `uninstall` |
| **Tier 2 — Tool public** | Each Tool's `commandSpecs` | `<tool>` primary + nested `<tool> <verb>` children | `fit`, `fit list`, `graph export`, `sim recipes` |
| **Tier 3 — Tool internal** | Same Tool, `visibility: 'internal'` | Flat names, hidden from public surfaces | `fit-run-worker`, `graph-shard-worker`, `graph-equivalence-check` |

Host-owned commands mount after tool primaries so a tool cannot squat a host name.
Per-tool `plugin` groups (`opensip fit plugin …`) are host-mounted under each
pack-supporting tool primary — there is no top-level `opensip plugin`.

## Tier 2 grammar

### Primary command

Each Tool exposes exactly one **primary** command. Its `CommandSpec.name` equals
`metadata.name` (the short verb users type):

| Tool package | `metadata.id` (registry key) | `metadata.name` (command verb) | Config namespace |
|--------------|------------------------------|--------------------------------|------------------|
| `@opensip-cli/fitness` | UUID (`afd68bd3-…`) | `fit` | `fitness:` |
| `@opensip-cli/simulation` | UUID | `sim` | `simulation:` |
| `@opensip-cli/graph` | UUID | `graph` | `graph:` |

The command verb and config namespace are **decoupled**. Existing
`opensip-cli.config.yml` blocks keep using `fitness:` / `simulation:` / `graph:`.
Config namespaces stay `fitness:` / `simulation:` / `graph:` permanently — command
verbs (`fit`, `sim`, `graph`) do not drive config keys (see [Resolved decisions](#resolved-decisions)).

### Nested discoverability children

Auxiliary commands mount as **children** of the primary via `parent: '<tool>'`
on the `CommandSpec` (and on the derived `ToolCommandDescriptor`). Users invoke
them as `<tool> <verb>`:

```
opensip fit list
opensip fit recipes
opensip fit export --format baseline --out fit.sarif
opensip graph list
opensip graph recipes
opensip graph lookup <symbol>
opensip graph index
opensip graph export --format sarif --out graph.sarif
opensip sim recipes
```

**Do not** introduce flat hyphenated top-level names (`fit-list`, `sarif-export`,
`graph-baseline-export`, …). Those legacy forms were removed; parity tests assert
they no longer resolve.

### When to add nested children

| Verb | Typical purpose | First-party example |
|------|-----------------|---------------------|
| `list` | Enumerate rules, checks, or catalog entries | `fit list`, `graph list` |
| `recipes` | Enumerate named run lineups | `fit recipes`, `graph recipes`, `sim recipes` |
| `export` | Write a file artifact (`--format` selects the shape) | `fit export`, `graph export` |
| `lookup` | Point query against a built index | `graph lookup` |
| `index` | Query persisted catalog; `--build` refreshes first | `graph index`, `graph index --build` |

A tool with only one user-facing action needs only the primary — nested children
are optional discoverability and export surfaces.

## Export commands (`<tool> export --format <fmt>`)

Export is always a **nested** child named `export` with a required `--format`
choice. Different tools can share the verb `export` because mounting is scoped
by `parent`.

| Tool | `--format` values | Output |
|------|-------------------|--------|
| `fit` | `baseline` | SARIF-shaped gate baseline (via host baseline seam) |
| `graph` | `baseline`, `catalog`, `sarif` | JSON fingerprints, catalog JSON, or SARIF findings |

The `--format` value names the **artifact role**, not always the on-disk syntax.
For example, `fit export --format baseline` writes SARIF because fitness's gate
baseline is SARIF-shaped; `graph export --format baseline` writes JSON
fingerprints.

Add new formats by extending the `choices` array on the export spec — no new
top-level command name.

## Tier 3 — Internal commands

Worker and CI-only commands declare `visibility: 'internal'` on both the
`CommandSpec` and the derived descriptor. They stay **invocable** but are hidden
from `opensip --help` and shell completion unless
`OPENSIP_CLI_SHOW_INTERNAL=1` (see [Environment variables](/docs/opensip-cli/70-reference/10-environment-variables/)).

Bundled internal commands today:

- `fit-run-worker` — IPC worker for interactive fit runs
- `sim-run-worker` — IPC worker for interactive sim runs
- `graph-run-worker`, `graph-shard-worker` — graph pipeline workers
- `graph-equivalence-check` — CI catalog equivalence gate

`agent-catalog` is a separate curated machine surface; it is not controlled by
`OPENSIP_CLI_SHOW_INTERNAL`.

## Declaring nested commands in code

Use `defineCommand` (or a plain `CommandSpec` object) with `parent` set to your
primary verb:

```ts
import { defineCommand, defineTool, type ToolCliContext } from '@opensip-cli/core';

export const tool = defineTool({
  metadata: {
    id: 'audit-sec',
    name: 'audit-sec', // primary verb == metadata.name
    version: '1.0.0',
    description: 'Lightweight security audit',
  },
  commandSpecs: [
    defineCommand({
      name: 'audit-sec',
      description: 'Run the security audit',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async (opts, cli) => { /* … */ },
    }),
    defineCommand({
      name: 'list',
      parent: 'audit-sec',
      description: 'List audit rules',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async (opts) => { /* … */ },
    }),
    defineCommand({
      name: 'export',
      parent: 'audit-sec',
      description: 'Export audit artifacts',
      commonFlags: ['cwd', 'json'],
      options: [
        { flag: '--format', value: '<fmt>', required: true, choices: ['sarif'] },
        { flag: '--out', value: '<path>', required: true },
      ],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'file-export',
      handler: async () => { /* … */ },
    }),
  ],
});
```

`defineTool` derives `commands[]` from `commandSpecs` (including `parent` and
`visibility`). Prefer `defineTool` over hand-maintaining a parallel `commands`
array.

## Manifest drift (`opensipTools.commands`)

The static manifest lists every command **by short name** (not as nested paths).
Nested mounting is expressed only in `commandSpecs` via `parent`:

```json
"commands": [
  { "name": "audit-sec", "description": "Run the security audit" },
  { "name": "list", "description": "List audit rules" },
  { "name": "export", "description": "Export audit artifacts (--format sarif)" }
]
```

At load, `assertManifestMatchesTool` compares the manifest name set to the
runtime descriptors derived from `commandSpecs`. All three surfaces — manifest,
derived `commands`, and `commandSpecs` — must agree.

## Resolved decisions

**Q6 — Config namespace (decided: keep as-is).** Config keys remain `fitness:`,
`simulation:`, and `graph:`. Command verbs (`fit`, `sim`, `graph`) are decoupled
from config namespaces and will not be aliased (`fit:`, `sim:`) or migrated.

**Q7 — `graph index` semantics (decided: single command + `--build`).** Default
behavior queries the persisted catalog and writes `symbolindex.json` (same as
`graph lookup` — never triggers an analysis run). Pass `--build` to run the
graph pipeline first, refresh the catalog, then emit the artifact. A nested
`graph index build` / `graph index query` split is not planned.

## Authoring checklist

- [ ] `metadata.name` equals the primary `CommandSpec.name`
- [ ] Discoverability verbs (`list`, `recipes`, `export`, …) use `parent: '<tool>'`
- [ ] Export uses `name: 'export'` + required `--format` (no `*-export` top-level names)
- [ ] Workers declare `visibility: 'internal'`
- [ ] `opensipTools.commands` lists every spec name (flat), matching derived descriptors
- [ ] Run `opensip tools validate <spec>` before enabling a third-party tool in CI

## Where to go next

- [**Full Tool plugins**](/docs/opensip-cli/50-extend/06-full-tool-plugins/) — end-to-end Tool package layout with nested examples
- [**Create your first Tool**](/docs/opensip-cli/60-guides/07-create-your-first-tool/) — project-local sidecar walkthrough
- [**CLI commands reference**](/docs/opensip-cli/70-reference/01-cli-commands/) — full command table
- [**Tool plugin model**](/docs/opensip-cli/10-concepts/02-tool-plugin-model/) — why `commandSpecs` is the one command surface