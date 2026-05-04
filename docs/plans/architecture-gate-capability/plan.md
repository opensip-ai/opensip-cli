# Architecture Gate Capability Plan

Add a pre/post-fix architecture-gate primitive (`fit --gate-save` / `fit --gate-compare`) plus two new structural checks (file-level circular imports, file-level fan-out) so opensip-tools can be used as a regression detector inside pipelines that mutate code — including but not limited to OpenSIP's fix-pipeline.

## Why

OpenSIP's fix pipeline today verifies an agent's work with `pnpm test`. Tests catch behavioral regressions but not architectural drift — a circular import, a god-file getting worse, a duplicate function added rather than reused. A POC of an external Rust tool (sentrux) confirmed the gap is real; build-vs-buy review concluded that adding the capability to opensip-tools (which we own) is preferable to bolting on an external pre-1.0 binary. See `../../../opensip/docs/plans/backlog/18-architecture-gate-integration/poc-findings.md` for the POC evidence.

The capability is independently useful even outside the OpenSIP integration — pre-commit hooks, CI gates, manual diff audits.

## Target State

Two new CLI flags on the existing `fit` command:

```bash
opensip-tools fit --gate-save                      # Run all checks, save baseline to .opensip-tools/baseline.sarif
opensip-tools fit --gate-save --baseline <path>    # Save baseline to a specific path
opensip-tools fit --gate-compare                   # Run all checks, diff against baseline, exit 0/1
opensip-tools fit --gate-compare --baseline <path> # Compare against a specific baseline
```

Output of `--gate-compare`:

```
opensip-tools gate compare

Added (2):
  ✗ fit:circular-import      packages/foo/x.ts → y.ts
  ✗ fit:complex-function     packages/foo/z.ts:88 (cc=28, was 22)

Resolved (1):
  ✓ fit:dead-code            packages/foo/y.ts:10

Unchanged (1):
  · fit:no-any-types         packages/foo/x.ts:42

✗ DEGRADED — 2 new violations
exit 1
```

Exit code semantics:
- `0` — no new violations introduced (baseline state preserved or improved)
- `1` — at least one new violation introduced (regression)
- `2` — configuration error (missing baseline, invalid SARIF, etc.)

Plus two new checks under `packages/checks-builtin/src/checks/architecture/`:
- `circular-import-detection` — file-level cycle detection via Tarjan's SCC algorithm
- `module-coupling-fan-out` — flag files with outbound import fan-out above a configurable threshold (default 15)

## Design Decisions

**D1 — Baseline format is SARIF.** opensip-tools already emits SARIF 2.1.0 via `buildSarifLog()` in `packages/cli/src/sarif.ts`. The baseline is just the SARIF document written to disk. No new format design.

**D2 — Default baseline location is `<cwd>/.opensip-tools/baseline.sarif`.** Project-local rather than home-dir because baselines are repo-specific. The `.opensip-tools/` directory should be added to `.gitignore` (we'll document this in the README; we don't auto-modify users' gitignores).

**D3 — Diff matching is by `(filePath, ruleId, message-hash)` tuple.** Line numbers are intentionally NOT in the matching key — unrelated changes that shift line numbers should NOT register as added/resolved. The message hash captures cases like "complex-function on x.ts:foo (cc=22)" vs "complex-function on x.ts:foo (cc=28)" — different messages, treated as different violations (one resolved + one added rather than one unchanged).

**D4 — Gate is opt-in via CLI flags only.** No config file changes, no recipe changes, no new tags. The `fit` command runs unchanged when neither `--gate-save` nor `--gate-compare` is set.

**D5 — `--gate-save` and `--gate-compare` are mutually exclusive.** Specifying both is a config error (exit 2). They're separate operations called at different points in a pipeline.

**D6 — Missing baseline is an error, not a no-op.** `fit --gate-compare` against a non-existent baseline exits with config error (2), not "pass." Silent passing would mask integration bugs in callers (e.g., a caller forgetting to call `--gate-save` first).

**D7 — Two new checks are additive, not gate-required.** The gate primitive works against whatever checks are registered. The two new structural checks are valuable additions that make the gate detect more kinds of drift, but the gate itself ships independently.

## Phases

| Phase | Name | Description | Approx LOC |
|-------|------|-------------|------------|
| 1 | Gate primitive | New `gate.ts` module + `--gate-save` / `--gate-compare` CLI flags wired into `fit` command | ~250 |
| 2 | Import-graph builder | Shared infrastructure used by Phase 3 + Phase 4 (and future structural checks). Lives in `packages/core/src/framework/import-graph.ts` | ~200 |
| 3 | Circular-import check | New check using the import graph + Tarjan's SCC algorithm | ~150 |
| 4 | Fan-out check | New check using the import graph; threshold-driven | ~80 |
| 5 | Tests | Unit + integration tests for all of the above | ~400 |
| 6 | Release | Version bump, changelog, publish `@opensip-tools/cli` | small |

Phases 1 and 2 can run in parallel. Phases 3 and 4 both depend on Phase 2.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 1 | `packages/cli/src/gate.ts` | `packages/cli/src/types.ts` (add gate fields to `FitOptions` / `CliArgs`), `packages/cli/src/index.ts` (register CLI flags), `packages/cli/src/commands/fit.ts` (call into gate.ts when flags present), `packages/cli/src/exit-codes.ts` (add `GATE_DEGRADED` code), `README.md` (document new flags) |
| 2 | `packages/core/src/framework/import-graph.ts`, `packages/core/src/framework/__tests__/import-graph.test.ts` | `packages/core/src/index.ts` (export) |
| 3 | `packages/checks-builtin/src/checks/architecture/circular-import-detection.ts` | `packages/checks-builtin/src/checks/architecture/index.ts` (register) |
| 4 | `packages/checks-builtin/src/checks/architecture/module-coupling-fan-out.ts` | `packages/checks-builtin/src/checks/architecture/index.ts` (register) |
| 5 | `packages/cli/src/__tests__/gate.test.ts`, `packages/checks-builtin/src/checks/architecture/__tests__/circular-import-detection.test.ts`, `packages/checks-builtin/src/checks/architecture/__tests__/module-coupling-fan-out.test.ts` | — |
| 6 | — | `CHANGELOG.md`, `packages/cli/package.json` (version bump) |

## Critical Files Reference

| File | Role | Key structures |
|------|------|----------------|
| `packages/cli/src/sarif.ts` | Existing SARIF emitter | `buildSarifLog(output: CliOutput) → SARIF doc` (L24); `buildSarifRuns(output)` (L28) — the baseline is the same shape |
| `packages/cli/src/commands/fit.ts` | Existing fit command | `executeFit(args)` (L164) — produces `{result, output: CliOutput}` |
| `packages/cli/src/types.ts` | CLI types | `FitOptions` (L8), `CliArgs` (L44), `CliOutput` (L68), `CheckOutput` (L80), `FindingOutput` (L88) |
| `packages/cli/src/index.ts` | CLI commander setup | `.command('fit')` block (L289) — add new options |
| `packages/cli/src/persistence/store.ts` | Existing session persistence | Pattern reference for file I/O + mkdir handling |
| `packages/cli/src/exit-codes.ts` | Exit codes | `EXIT_CODES` (L1) — add `GATE_DEGRADED: 1` (reuse RUNTIME_ERROR value) and `GATE_CONFIG_ERROR: 2` (reuse CONFIGURATION_ERROR) — or, alternative, dedicated codes |
| `packages/core/src/framework/parse-cache.ts` | Existing TS AST cache | `getSharedSourceFile()` — Phase 2 uses this for the import-graph builder |
| `packages/core/src/framework/define-check.ts` | Check definition API | `defineCheck()` (L?) — pattern reference for new checks; `analyzeAll` mode is the right choice for both new checks since they need cross-file data |

## Phase 1 detail — Gate primitive

The gate has three operations:

**`saveBaseline(output: CliOutput, baselinePath: string): void`**
- Build SARIF via the existing `buildSarifLog(output)`
- Ensure the parent directory exists (`mkdirSync({recursive: true})`)
- Write the SARIF document to `baselinePath`
- Log `cli.gate.save.complete` with finding count

**`compareToBaseline(output: CliOutput, baselinePath: string): GateCompareResult`**
- Read baseline SARIF from `baselinePath`. If missing → throw `GateBaselineMissing` (caught at CLI layer → exit 2).
- Build current SARIF via `buildSarifLog(output)`
- Compute violation hashes for both: `sha256(filePath + '\n' + ruleId + '\n' + message)`
- Build sets: `baselineSet`, `currentSet`
- `added = currentSet - baselineSet`
- `resolved = baselineSet - currentSet`
- `unchanged = currentSet ∩ baselineSet`
- Return `{added, resolved, unchanged, baselinePath, degraded: added.length > 0}`

**`renderGateCompareOutput(result: GateCompareResult): string`**
- Pretty-print the added/resolved/unchanged sections per the example in "Target State"
- Returns string for stdout. Exit code is the caller's job.

CLI integration in `packages/cli/src/commands/fit.ts`:
- After `executeFit` produces `output`, check `args.gateSave` and `args.gateCompare` flags
- If `gateSave`: call `saveBaseline(output, args.baseline ?? '.opensip-tools/baseline.sarif')`
- If `gateCompare`: call `compareToBaseline(...)`, render output, set `process.exitCode = result.degraded ? 1 : 0`

## Phase 2 detail — Import-graph builder

`buildImportGraph(files: ReadonlyArray<{path: string; content: string}>): ImportGraph`

```typescript
interface ImportGraph {
  /** All node file paths */
  readonly nodes: ReadonlySet<string>
  /** Adjacency: file → files it imports */
  readonly outbound: ReadonlyMap<string, ReadonlySet<string>>
  /** Reverse adjacency: file → files that import it */
  readonly inbound: ReadonlyMap<string, ReadonlySet<string>>
}
```

Implementation:
- Use `getSharedSourceFile()` from `parse-cache.ts` to parse each file (TS AST)
- Walk top-level `ImportDeclaration` and `ExportDeclaration` nodes for module specifiers
- Resolve specifier to a project file path:
  - Relative imports: `path.resolve(dirname(importing), specifier)` plus `.ts`/`.tsx`/`/index.ts` resolution
  - Bare specifiers (npm packages): NOT in graph (we only care about intra-project edges)
  - Path aliases (tsconfig `paths`): defer — phase 2 leaves these unresolved (treated as unknown), but the graph still includes the file as a node. A follow-up plan can add tsconfig-aware resolution.
- Returns the ImportGraph

This module-resolution approach mirrors what the existing `phantom-dependency-detection.ts` check does (which works well in practice). We're not reinventing module resolution — we're following the same mostly-good-enough heuristic that's already shipped.

## Phase 3 detail — Circular-import check

```typescript
defineCheck({
  slug: 'circular-import-detection',
  description: 'Detects circular dependencies between files in the project',
  tags: ['architecture', 'modularity'],
  analyzeAll: async ({fileAccessor}) => {
    const files = await fileAccessor.readAll()
    const graph = buildImportGraph(files)
    const cycles = findStronglyConnectedComponents(graph)
      .filter(scc => scc.length > 1)  // ignore self-loops; only real cycles
    return cycles.map(cycle => ({
      severity: 'error',
      message: `Circular import: ${cycle.join(' → ')} → ${cycle[0]}`,
      filePath: cycle[0],
      // No line — this is a graph-level violation; first file in cycle is the anchor
    }))
  },
})
```

Algorithm: Tarjan's SCC. Standard implementation, ~80 LOC.

## Phase 4 detail — Fan-out check

```typescript
defineCheck({
  slug: 'module-coupling-fan-out',
  description: 'Flags files with high outbound import fan-out (potential god-files)',
  tags: ['architecture', 'modularity'],
  analyzeAll: async ({fileAccessor}) => {
    const files = await fileAccessor.readAll()
    const graph = buildImportGraph(files)
    const threshold = 15  // TODO: per-check config
    return [...graph.outbound.entries()]
      .filter(([, edges]) => edges.size > threshold)
      .map(([file, edges]) => ({
        severity: edges.size > threshold * 2 ? 'error' : 'warning',
        message: `High fan-out: ${file} imports ${edges.size} other files (threshold ${threshold})`,
        filePath: file,
      }))
  },
})
```

The threshold 15 matches sentrux's default. Composition-root files (DI, plugin registries) legitimately exceed this — Phase 4's deliverable includes a brief README note that authors can add `@fitness-ignore-file module-coupling-fan-out` for verified composition roots, and we'll document patterns operators commonly need to ignore.

## Risks

| ID | Risk | Mitigation |
|---|------|------------|
| R1 | TS module resolution edge cases (`paths` aliases, conditional exports) miss real edges | Phase 2 documents the heuristic and its limits; Phase 5 tests cover relative imports comprehensively. Path-alias support is a follow-up plan. |
| R2 | Tarjan's on a 5000-file repo is slow | Tarjan's is O(V+E); on 5658 files / 10425 edges (measured on OpenSIP repo) this completes in milliseconds. Not a real risk. |
| R3 | Hash-based diff misses semantically equivalent violations whose message differs by punctuation | Acceptable for v1. If false positives become annoying, normalize messages before hashing in a later pass. |
| R4 | Existing fitness checks change between baseline and compare runs (e.g., user upgrades opensip-tools mid-pipeline) | Out of scope. The gate trusts that the same opensip-tools version runs both calls. Document this. |

## Sequencing

Recommended build order:

1. **Phase 1 first** (gate primitive). It's the load-bearing capability — independent of new checks. Ship and use against existing checks.
2. **Phase 2 + 3 + 4 next**, since they all share the import graph. They can land as one PR or three.
3. **Phase 5 alongside each phase**, not at the end. Tests are cheaper to write while context is fresh.
4. **Phase 6** when 1–5 are stable.

## Out of scope (deferred)

- Path-alias resolution for the import graph (tsconfig `paths`)
- Cognitive complexity check (the existing `god-function-detection` covers CC adequately)
- DSM (Design Structure Matrix) — visualization, not a check
- Test-coverage gap detection — wants the import graph but adds heuristics for matching `.test.ts` siblings; defer to a follow-up
- Git churn / hotspot metrics — wants a new git data source; bigger scope
- Long-file thresholds — verify whether an existing check covers this; if not, trivial follow-up

## See also

- `../../../opensip/docs/plans/backlog/18-architecture-gate-integration/plan.md` — the consumer-side integration plan in the OpenSIP repo (currently backlogged)
- `../../../opensip/docs/plans/backlog/18-architecture-gate-integration/poc-findings.md` — POC evidence that informed this plan
