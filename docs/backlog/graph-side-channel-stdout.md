# Backlog: route graph's gate / lookup / workspace output through the render seam

## What was deferred

The dual-renderer effort routed graph's **main report** through the central
render seam (`graph-done` → `resultToView` → Ink/plain text) and deleted the
hand-maintained `write*Plain` duplicates. But a few **other** graph
sub-commands still write human-readable text straight to stdout:

- `packages/graph/engine/src/cli/graph-modes.ts` — gate-save / gate-compare
  (`Graph baseline saved …`, `Graph gate PASS/FAIL …`) and report-to status.
- `packages/graph/engine/src/cli/lookup.ts` — the `graph-lookup` human
  listing (function occurrences).
- `packages/graph/engine/src/cli/workspace-report.ts` — the `--workspace`
  aggregate report.

These should become `CommandResult` variants (or reuse `graph-done` / a new
`lookup-done`) rendered through `cli.render()`, so the spec's criterion —
*no human-readable report text written via `process.stdout.write` in
graph/fitness* — holds across **all** of graph, not just the main report.

## Why deferred

- They are **not drift vectors**: unlike the deleted `write*Plain`
  functions, these are standalone formats with no cli-ui component twin to
  fall out of sync with. The actual drift bug (RunSummary / RunFooterHints
  duplication) is fixed.
- They were **out of the implementing plan's phase scope** — Phase 3 covered
  the main report, Phase 4 covered the fitness gate. Graph's gate / lookup /
  workspace paths were never in a phase, and expanding mid-build would have
  traded discipline for completeness.
- `graph --json` (the machine path for these commands) is unaffected and
  already correct.

## Source

- Spec: `docs/specs/dual-renderer-cli-output.md` (success criterion on
  zero direct human-report writes).
- Flagged during the Phase 4 audit (`rg process.stdout.write
  packages/graph/engine/src/cli/`), 2026-06-01.

## Promotion trigger

Pick this up when: someone wants graph gate/lookup/workspace output to be
consistent in pipes/CI the way the main report now is; or when a second
output surface needs that content renderer-agnostic. On pickup: add the
result variant(s) + `resultToView` case(s), route through `cli.render()`,
delete the direct writes, and delete this file.
