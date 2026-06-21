---
status: current
last_verified: 2026-06-12
release: v0.1.8
title: "Use graph"
audience: [getting-started, ci-integrators, contributors]
purpose: "Task-led guide for running static call-graph analysis, inspecting discovered files, scoping runs, opening the dashboard, and adopting graph gates."
source-files:
  - packages/graph/engine/src/tool.ts
  - packages/graph/engine/src/cli/graph/graph-command-spec.ts
  - packages/graph/engine/src/cli/graph/graph-aux-command-specs.ts
related-docs:
  - ../40-graph/01-stages-and-catalog.md
  - ../40-graph/02-rules-and-gating.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/06-dashboard.md
---
# Use graph

`opensip graph` builds a static call graph and runs graph rules over it. Use it when the question is about reachability, dead code, duplicated bodies, cycles, blast radius, or surprising coupling.

## 1. Confirm graph sees the right files

Start with discovery only:

```bash
opensip graph --list-files
```

This is cheap: it asks the language adapter what it would analyze and exits before building a catalog.

For machine-readable output:

```bash
opensip graph --list-files --json
```

If the list is empty, check language markers and scope. You can force an adapter:

```bash
opensip graph --language typescript --list-files
opensip graph --language python --list-files
```

## 2. Run graph

```bash
opensip graph
```

The default output is compact. Use verbose mode when you want details in the terminal:

```bash
opensip graph --verbose
```

The run creates a session and writes report data to the project runtime store. Open the report with:

```bash
opensip report
```

## 3. Scope the run

For a subtree:

```bash
opensip graph packages/api
```

For multiple subtrees:

```bash
opensip graph packages/api packages/web
```

For workspace fan-out:

```bash
opensip graph --workspace
opensip graph --workspace --concurrency 4
```

Use `--workspace` for large monorepos when each workspace unit can be analyzed independently. It runs memory-isolated child processes and aggregates the result into one session.

## 4. Inspect the catalog

After a graph run, look up function occurrences by name:

```bash
opensip graph lookup saveBaseline
opensip graph lookup saveBaseline --json
```

Emit an editor-friendly symbol index:

```bash
opensip graph index --out symbolindex.json
opensip graph index --build --out symbolindex.json
```

Both commands read the persisted catalog by default. Use `--build` on `graph index`
to refresh the catalog first, or run `opensip graph` before querying.

## 5. Gate on new graph findings

Save the current graph findings as the baseline:

```bash
opensip graph --gate-save
```

Then fail only when a future run introduces new findings:

```bash
opensip graph --gate-compare
```

For GitHub Code Scanning or any SARIF consumer:

```bash
opensip graph --gate-compare --sarif graph.sarif
```

## 6. Use recipes when you need a subset

List graph recipes:

```bash
opensip graph recipes
```

Run one:

```bash
opensip graph --recipe <name>
```

No `--recipe` means the default graph rule set.

## What to remember

- `graph --list-files` answers "what will graph analyze?" without building.
- `graph --workspace` is the large-monorepo path.
- `graph --gate-save` and `graph --gate-compare` use the same baseline model as `fit`.
- `graph` does not have an `--open` flag; run `opensip report` after the graph run to open the HTML report.

## Where to go next

| You want to ... | Go to |
|---|---|
| Understand the pipeline | [Stages and catalog](/docs/opensip-cli/40-graph/01-stages-and-catalog/) |
| Understand rules and baselines | [Rules and gating](/docs/opensip-cli/40-graph/02-rules-and-gating/) |
| Add a graph language adapter | [Adding a language](/docs/opensip-cli/40-graph/03-adding-a-language/) |
| Look up every graph flag | [CLI commands](/docs/opensip-cli/70-reference/01-cli-commands/#graph--static-call-graph--dead-end-analysis) |
