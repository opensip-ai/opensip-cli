---
status: current
last_verified: 2026-06-21
release: v0.1.14
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
  - packages/mcp/src/command.ts
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

## Extension taxonomy (author view)

| Extension | Discovery | Trust | Load boundary | Validation |
|-----------|-----------|-------|---------------|------------|
| Bundled whole tools | Shipped manifests | Trusted | In-process (host) | Startup admission |
| Installed whole tools | `node_modules` marker | Allowlist opt-in | Forked dispatch worker (ADR-0054) | `tools validate` / install |
| Project-local tools | `opensip-cli/tools/<id>/` sidecar | Deny-by-default | Forked dispatch worker (ADR-0054) | `tools validate` + allowlist |
| User-global tools | `~/.opensip-cli/tools/` | Trusted-by-default | Forked dispatch worker (ADR-0054) | `tools validate` |
| Fit / sim packs & recipes | `plugins.<domain>` | In-process; epoch metadata | In-process (host) | Domain registrars |
| Graph adapters & recipes | `plugins.graph` | In-process; epoch metadata | In-process (host) | Domain registrars |
| Loose project files | Plugin dirs | Executable when loaded | In-process (host) | Domain-specific |

Authoring on-ramps: `opensip tools create` (`minimal-js`, `ts-local`). See
[Create your first tool](../60-guides/07-create-your-first-tool.md),
[ADR-0061](../../decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md), and
[ADR-0076](../../decisions/ADR-0076-tool-authoring-template-and-helper-boundary.md).

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

Each Tool exposes exactly one **primary** command. Authors declare a single
`ToolIdentity`; `defineTool` derives `CommandSpec.name`, `metadata.name`, and the
config namespace from `identity.name`. Short forms are **CLI aliases** only.

| Tool package | `metadata.id` (UUID) | `identity.name` (canonical verb) | CLI aliases | Config namespace | `layoutKey` (paths / `session.tool`) |
|--------------|----------------------|----------------------------------|-------------|------------------|----------------------------------------|
| `@opensip-cli/fitness` | `afd68bd3-…` | `fitness` | `fit` | `fitness:` | `fit` |
| `@opensip-cli/simulation` | `715d32c2-…` | `simulation` | `sim` | `simulation:` | `sim` |
| `@opensip-cli/graph` | UUID | `graph` | — | `graph:` | `graph` |
| `@opensip-cli/yagni` | UUID | `yagni` | `yag` | `yagni:` | `yagni` |
| `@opensip-cli/mcp` | `f313c020-…` | `mcp` | — | — (no config block) | `mcp` |

`opensip fitness` and `opensip fit` invoke the same handler. Config blocks use the
canonical namespace (`fitness:`, not `fit:`). Plugin pins and on-disk layout remain
`plugins.fit:` and `opensip-cli/fit/` via `layoutKey`.

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
opensip yagni --json
```

`yagni` ships a primary command only in the MVP (no nested `list`/`export` children yet).

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

## Long-lived stream commands (`output: 'raw-stream'`)

Most tool primaries use `output: 'command-result'` (the host renders a
`CommandResult` / delivers a `SignalEnvelope`). A few commands instead own stdout
directly and declare `output: 'raw-stream'` with a **`rawStreamReason`** that
records *why* the host renders nothing. The reason is a closed enum (members
include `completion-script`, `file-export`, `worker-ipc`,
`runtime-render-dispatch`, `session-replay`, `diagnostic-gate`, and
`mcp-stdio`), each pinned to a real command by the `raw-stream-parity` inventory
test. The three most relevant to this taxonomy:

| `rawStreamReason` | Owner | Why it owns stdout |
|-------------------|-------|--------------------|
| `file-export` | `fit export`, `graph export` | The byte stream is a file artifact (SARIF / JSON), not a render. |
| `worker-ipc` | `fit-run-worker`, `graph-*-worker` (Tier 3) | An internal worker pipes structured IPC frames to its parent. |
| `mcp-stdio` | `mcp` (Tier 2) | A genuine JSON-RPC **transport** — see below. |

`opensip mcp` (the bundled [`@opensip-cli/mcp`](../70-reference/01-cli-commands.md#mcp--serve-the-call-graph--results-to-agents-over-stdio)
tool) is the taxonomy's one **long-lived stdio server**: a `scope: 'project'`
primary that blocks for its whole serve lifetime instead of running an analysis
and exiting. It uses `mcp-stdio` — *distinct from `worker-ipc`* — because stdout
is a real [Model Context Protocol](https://modelcontextprotocol.io) JSON-RPC
channel an external agent speaks over, not an internal worker pipe. **stdout
carries only JSON-RPC frames; all logging and diagnostics route to stderr** for
the serve lifetime. There is no run verdict to render, so the command emits no
`SignalEnvelope` and persists no session — it is a transport, not a run. This is
the documented escape hatch from the `SignalEnvelope`/`CommandResult` currency,
recorded in `raw-stream-parity` and justified in-file for
`command-handler-host-owned-output`. See
[ADR-0084](../../decisions/ADR-0084-mcp-server-surface.md).

## Tier 3 — Internal commands

Worker and CI-only commands declare `visibility: 'internal'` on both the
`CommandSpec` and the derived descriptor. They stay **invocable** but are hidden
from `opensip --help` and shell completion unless
`OPENSIP_CLI_SHOW_INTERNAL=1` (see [Environment variables](../70-reference/10-environment-variables.md)).

Bundled internal commands today:

- `fit-run-worker` — IPC worker for interactive fit runs
- `sim-run-worker` — IPC worker for interactive sim runs
- `graph-run-worker`, `graph-shard-worker` — graph pipeline workers
- `graph-equivalence-check` — CI catalog equivalence gate

`agent-catalog` is a separate curated machine surface; it is not controlled by
`OPENSIP_CLI_SHOW_INTERNAL`.

## Declaring nested commands in code

Use `definePrimaryCommand` for the primary command and `defineNestedCommand` for
discoverability children. `defineTool` fills in the primary name, aliases, and
nested `parent` from `identity`.

```ts
import {
  defineNestedCommand,
  definePrimaryCommand,
  defineTool,
  type ToolCliContext,
} from '@opensip-cli/core';

export const tool = defineTool({
  identity: { name: 'audit-sec', aliases: ['audit'] },
  metadata: {
    id: '0c9d1b75-1d6c-4d42-a2f7-76907c3f0181',
    version: '1.0.0',
    description: 'Lightweight security audit',
  },
  commandSpecs: [
    definePrimaryCommand<unknown, ToolCliContext>({
      description: 'Run the security audit',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async () => ({ type: 'text-lines', title: 'Audit', lines: [] }),
    }),
    defineNestedCommand<unknown, ToolCliContext>({
      name: 'list',
      description: 'List audit rules',
      commonFlags: ['cwd', 'json'],
      scope: 'project',
      output: 'command-result',
      handler: async () => ({ type: 'text-lines', title: 'Audit rules', lines: [] }),
    }),
    defineNestedCommand<unknown, ToolCliContext>({
      name: 'export',
      description: 'Export audit artifacts',
      commonFlags: ['cwd', 'json'],
      options: [
        { flag: '--format', value: '<fmt>', required: true, choices: ['sarif'] },
        { flag: '--out', value: '<path>', required: true },
      ],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'file-export',
      handler: async (_opts, cli) => {
        cli.emitRaw('wrote audit.sarif');
        return {};
      },
    }),
  ],
});
```

`defineTool` derives `metadata.name`, `commands[]`, the primary command name and
aliases, nested `parent`, the config namespace, and plugin/session layout keys
from `identity`.

## Manifest drift (`opensipTools.commands`)

The static manifest declares the same required `identity` block. It lists every
command by short name, not as nested paths; nested mounting is represented by the
serializable `parent` field:

```json
"id": "audit-sec",
"identity": { "name": "audit-sec", "aliases": ["audit"] },
"commands": [
  { "name": "audit-sec", "aliases": ["audit"], "description": "Run the security audit" },
  { "name": "list", "parent": "audit-sec", "description": "List audit rules" },
  { "name": "export", "parent": "audit-sec", "description": "Export audit artifacts (--format sarif)" }
]
```

At load, `assertManifestMatchesTool` compares manifest identity and command names
to the runtime descriptors derived from `commandSpecs`. Manifest `id`,
`identity.name`, runtime `metadata.name`, and the primary command name must agree.

## Resolved decisions

**Q6 — Config namespace (updated: aligns with `identity.name`).** Config keys are
the canonical tool name (`fitness:`, `simulation:`, `graph:`, `yagni:`). CLI aliases
(`fit`, `sim`, `yag`) do not introduce config aliases (`fit:` is not valid). Layout
paths and plugin pins still use `layoutKey` (`plugins.fit:`, `opensip-cli/fit/`).

**Q7 — `graph index` semantics (decided: single command + `--build`).** Default
behavior queries the persisted catalog and writes `symbolindex.json` (same as
`graph lookup` — never triggers an analysis run). Pass `--build` to run the
graph pipeline first, refresh the catalog, then emit the artifact. A nested
`graph index build` / `graph index query` split is not planned.

## Authoring checklist

- [ ] `defineTool` declares `identity`; `metadata.name` and the primary `CommandSpec.name` equal `identity.name`
- [ ] Discoverability verbs use `defineNestedCommand` (or `parent: identity.name`)
- [ ] Export uses `name: 'export'` + required `--format` (no `*-export` top-level names)
- [ ] Workers declare `visibility: 'internal'`
- [ ] `opensipTools.commands` lists every spec name (flat), matching derived descriptors
- [ ] Run `opensip tools validate <spec>` before enabling a third-party tool in CI

## Where to go next

- [**Full Tool plugins**](./06-full-tool-plugins.md) — end-to-end Tool package layout with nested examples
- [**Create your first Tool**](../60-guides/07-create-your-first-tool.md) — project-local sidecar walkthrough
- [**CLI commands reference**](../70-reference/01-cli-commands.md) — full command table
- [**Tool plugin model**](../10-concepts/02-tool-plugin-model.md) — why `commandSpecs` is the one command surface
