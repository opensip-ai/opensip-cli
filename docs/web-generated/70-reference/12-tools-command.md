---
status: current
last_verified: 2026-06-12
release: v0.1.11
title: "`tools` command"
audience: [plugin-authors, contributors]
purpose: "Customer-facing command group for managing whole Tool plugins: list, validate, install, uninstall, and data-purge."
source-files:
  - packages/cli/src/commands/tools/index.ts
  - packages/cli/src/commands/tools/list.ts
  - packages/cli/src/bootstrap/register-tools.ts
  - packages/core/src/plugins/manifest-loader.ts
related-docs:
  - ./01-cli-commands.md
  - ./10-environment-variables.md
  - ../50-extend/06-full-tool-plugins.md
---
# `tools` — manage whole Tool plugins

The customer-facing command group for whole Tool plugins (ADR-0041): packages
declaring `package.json#opensipTools.kind: "tool"` that contribute entire
subcommands to the CLI. Six subcommands — no flag aliases, no `tool`
singular:

```
opensip tools list
opensip tools validate <spec>
opensip tools create <tool-id>
opensip tools install <spec> [--global|--project]
opensip tools uninstall <name-or-id> [--global|--project] [--purge-data]
opensip tools data-purge <tool-id>
```

`tools` is the **only** way to install/uninstall a whole Tool plugin — the
former `plugin add/remove --domain tool` path was retired (the per-tool `plugin`
group is now scoped to a pack-supporting tool's own extension packs, not whole
Tool plugins). `tools` is implemented over the same host directories and npm
helpers the pack path uses.

## A note you should read first: code execution

**`tools validate` and `tools install` execute the candidate package's
module.** Validating a package is trusting it to execute. Two mitigations —
which are mitigations, not promises:

- staging installs run `npm install --ignore-scripts`, so install-time
  hooks (the classic supply-chain vector) never fire;
- the module import runs in a child process with a 30-second hard timeout —
  a **crash boundary** (a hanging or env-mutating candidate cannot corrupt
  the CLI), **not a security boundary** (same user privileges).

`tools list` is the read-only exception: it never imports a tool runtime —
every row comes from manifest file reads and the current run's recorded
provenance.

## `tools list`

The effective tool inventory: bundled tools, user-global installs
(`~/.opensip-cli/plugins/tool/`), and project-local installs
(`<project>/opensip-cli/.runtime/plugins/tool/`).

| Column | Meaning |
|---|---|
| `tool` | The tool's stable id (from its manifest). |
| `version` | Manifest version. |
| `source` | `bundled`, `global`, or `project`. |
| `commands` | Command names the manifest declares. |
| `[manifest-only]` | Present on disk but not loaded by this run (e.g. a broken runtime — listing never imports, so it still lists). |
| `[shadowed]` | A global row whose tool id is overridden by a project-local install (project wins, matching discovery order). |

`--global` / `--project` filter to one install scope. `--json` puts the rows
under `.data.tools`.

## `tools validate <spec>`

Runs the SAME admission pipeline the CLI's bootstrap admits every tool
through (one validator — a package that validates clean is a package the CLI
will load), plus the storage and config contracts. Sections:

| Section | What it checks |
|---|---|
| `manifest` | A conformant `package.json#opensipTools` manifest loads. |
| `compatibility` | `apiVersion` is declared and in range (the same gate bundled tools pass). |
| `runtime-load` | The module imports (child-process probe). |
| `tool-shape` | The module exports a valid `tool`. |
| `manifest-runtime-coherence` | Manifest id + command surface match the runtime. |
| `config-contract` | A manifest that declares config has a runtime `Tool.config`; its namespace equals the tool id. |
| `storage-contract` | No DDL strings, no schema-mutation pragmas, no direct datastore-file paths (ADR-0042 Tier A). |
| `import-boundaries` | No datastore-private schema/migration imports, no migration runners. |

`<spec>` is an npm spec, a tarball, or a local directory. npm/tarball specs
stage into a throwaway temp host. A local directory validates **in place** by
default; pass `--install-deps` to stage it with its dependencies resolved so
the runtime sections can actually load it. Without `--install-deps`, runtime
sections that fail on unresolved imports report as **skipped** and the
verdict is `incomplete` — an unverified runtime is never a pass.

Exit codes: `0` = `passed`; `2` = `failed` or `incomplete`.

## `tools create <tool-id>`

Scaffolds a minimal **project-local** Tool under `opensip-cli/tools/<id>/` so you
can start authoring a whole Tool plugin without hand-writing the manifest +
contract boilerplate. `<tool-id>` is kebab-case and also becomes the subcommand
name. Pass `--force` to overwrite the scaffold when the tool directory already
exists. This is the authoring on-ramp; for the full walkthrough see
[Create your first tool](/docs/opensip-cli/60-guides/07-create-your-first-tool/).

```bash
opensip tools create my-audit          # writes opensip-cli/tools/my-audit/
opensip tools create my-audit --force  # overwrite an existing scaffold
```

## `tools install <spec>`

Atomic stage → validate → activate:

1. Stage into a temp host (`--ignore-scripts`).
2. Run the full `tools validate` sections against the staged bytes.
3. Only a `passed` verdict activates — and activation installs a tarball
   packed **from the staged dir**, so the bytes that run are exactly the
   bytes that validated (never a re-resolve of the original spec).

A failed install leaves no discoverable tool behind. Default scope is
**global** (available in every project for this user); `--project` installs
into this project's runtime tool host instead.

## `tools uninstall <name-or-id>`

Accepts a tool id **or** an npm package name; resolves the identity from
manifest scans and shows what it resolved before removing. Rules:

- installed in one scope → plain `tools uninstall <id>` works;
- installed in **both** scopes → requires `--global` or `--project`;
- bundled tools are rejected (they ship with the CLI);
- project SQLite data is **never** deleted by uninstall alone.

`--purge-data` (project scope only — runtime data lives per project) also
runs the data purge below after a successful uninstall.

## `tools data-purge <tool-id>`

Deletes one tool's rows from the project datastore — **rows, never tables**
(the SQLite schema is host-owned and shared):

- `sessions` rows (per-tool payloads cascade),
- baseline entries + the baseline existence marker,
- `tool_state` rows (the keyed tool-state plane, ADR-0042).

Reports counts per store. Works for any tool id, including bundled tools
(purging your fit history is legitimate). First-party ids are accepted in
either form (`fit`/`fitness`, `sim`/`simulation`).

Surface note: this is a flat `data-purge` subcommand (the spec drafted a
nested `tools data purge`; the host's command machinery is deliberately one
group level deep).

## See also

- [`01-cli-commands.md`](/docs/opensip-cli/70-reference/01-cli-commands/) — the full command inventory.
- [`../50-extend/06-full-tool-plugins.md`](/docs/opensip-cli/50-extend/06-full-tool-plugins/)
  — how to build a package that contributes a full command surface.
- ADR-0041 / ADR-0042 / ADR-0043 in `docs/decisions/` — the decisions behind
  the surface, the storage contract, and the config-namespace warning.
