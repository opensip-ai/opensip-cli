---
status: current
last_verified: 2026-05-18
release: v1.3.0
title: "Rules and gating (graph)"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The five graph rules, what each one detects, and how the save/compare gate flow integrates with CI."
source-files:
  - packages/graph/engine/src/rules/registry.ts
  - packages/graph/engine/src/rules/orphan-subtree.ts
  - packages/graph/engine/src/rules/duplicated-function-body.ts
  - packages/graph/engine/src/rules/no-side-effect-path.ts
  - packages/graph/engine/src/rules/test-only-reachable.ts
  - packages/graph/engine/src/rules/always-throws-branch.ts
  - packages/graph/engine/src/rules/_entry-points.ts
  - packages/graph/engine/src/gate.ts
  - packages/graph/engine/src/render/sarif.ts
  - packages/graph/engine/src/lang-adapter/types.ts
related-docs:
  - ./01-stages-and-catalog.md
  - ./03-adding-a-language.md
  - ../20-the-fit-loop/04-output-gate-sarif.md
  - ../70-surfaces/01-cli-command-tree.md
  - ../../plans/10-graph-language-pluggability.md
---
# Rules and gating (graph)

[`01-stages-and-catalog.md`](./01-stages-and-catalog.md) explained how `graph` builds its picture of the codebase. This doc covers what happens at stage 4 — the five rules that turn that picture into actionable findings — and the gate workflow that lets you keep new regressions out of `main` without forcing a clean-up of everything that exists today.

> **What you'll understand after this:**
> - The five rules graph ships with, what each detects, and the false-positive shape of each.
> - The gate save/compare model and how it differs from `fit`'s architecture gate.
> - How graph's SARIF output integrates with the same CI infrastructure `fit` uses.

---

## The rule contract

Every rule lives in [`packages/graph/engine/src/rules/<rule-name>.ts`](../../../packages/graph/engine/src/rules/) and exports a single value implementing this shape:

```ts
interface Rule {
  readonly slug: string;                                // 'graph:orphan-subtree'
  readonly defaultSeverity: 'error' | 'warning';
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
  ) => readonly Signal[];
}
```

A rule receives frozen inputs (the catalog from stages 1+2, the indexes from stage 3) and returns a list of typed `Signal`s. It cannot import the parser, cannot import another rule, cannot read files. That isolation makes rules unit-testable in ten lines and lets us replace any one of them without touching the rest.

The five rules below are registered in [`rules/registry.ts`](../../../packages/graph/engine/src/rules/registry.ts) and run on every `graph` invocation unless the caller filters with `--check <slug>` (planned, not yet shipped) or `--no-check <slug>` (also planned).

---

## The five rules

### `graph:orphan-subtree`

[`rules/orphan-subtree.ts`](../../../packages/graph/engine/src/rules/orphan-subtree.ts) — find functions not reachable from any inferred entry point.

The rule does a forward BFS from the entry-point seeds (computed by [`_entry-points.ts`](../../../packages/graph/engine/src/rules/_entry-points.ts), plus `config.entryPointHashes`) across `indexes.callees`. Any `FunctionOccurrence` not visited is flagged. This is *transitive* reachability, not a direct in-degree check — an entire chain of mutually-recursive helpers that nobody outside the chain calls is a single connected orphan subtree.

**False-positive shape**: anything graph can't see is an unrecognized "entry point" until the inference learns about it. Today the inference recognizes `module-init`, `name-match` (`main`/`run`/`start`/`register`/`init`/`bootstrap`/`initialize`), and `no-callers-exported`. Pre-`v0.3` it does *not* recognize `bin`-field entries from `package.json`, framework route handlers, or hand-registered scenario/check entry points — those need to be added to the heuristic chain or declared via config.

### `graph:duplicated-function-body`

[`rules/duplicated-function-body.ts`](../../../packages/graph/engine/src/rules/duplicated-function-body.ts) — group catalog entries by `bodyHash`; report any group with more than one occurrence (above a minimum-line threshold to skip trivial bodies like `return null`).

**False-positive shape**: the rule matches function bodies *textually* and does not currently resolve called identifiers through lexical scope. A codebase using a wrapper-and-delegate convention (every check has an `analyze(content, filePath)` that delegates to a local `analyzeFile()`) produces a wave of false matches because every wrapper looks identical. The 2026-05-17 mitigation was a `minDuplicateBodySize` threshold (default 200 normalised chars) that suppresses thin-wrapper bodies; the deeper "two functions whose bodies textually match but whose called identifiers resolve to different declarations are not duplicates" invariant remains unenforced. Cross-package duplications (where lexical scope can't fool the rule) are the high-signal subset.

### `graph:no-side-effect-path`

[`rules/no-side-effect-path.ts`](../../../packages/graph/engine/src/rules/no-side-effect-path.ts) — for each function, walk its transitive callee set. If no callee on any path touches a known side-effect primitive (`fs.*`, `process.*`, `console.*`, network I/O, `Math.random`, etc.), emit a signal.

The intent is to surface "dead" pure code — utilities that compute but never observe. Most findings are intentional (pure helpers like `findFunctions`, `findImports`), but a sideless function that's *supposed* to push violations into an array often points to a missing append: a check that returns an empty array regardless of input.

### `graph:test-only-reachable`

[`rules/test-only-reachable.ts`](../../../packages/graph/engine/src/rules/test-only-reachable.ts) — compute reachability from the inferred entry points. Any occurrence reachable only via files where `inTestFile` is true is flagged.

This is the rule for catching "production helper that's only exercised by tests" — code shipped to users that nothing in the user-facing call graph ever invokes. It's the inverse of the more familiar "test coverage" question, which asks whether production code is reached *from* tests. This rule asks whether production code is reached *only* from tests.

### `graph:always-throws-branch`

[`rules/always-throws-branch.ts`](../../../packages/graph/engine/src/rules/always-throws-branch.ts) — flag functions whose every recorded outbound call looks like a `throw new Error(...)` shape. v0.2 ships a textual heuristic: each `CallEdge.text` is matched against `/^\s*throw\s+(?:new\s+)?[A-Z]\w*/`; if every call edge from the function matches, the function is treated as an always-throws helper masquerading as a real function.

True per-branch CFG analysis (every path through every if/else / switch case / try-catch arm ends in a throw) is deferred to v0.3 — the source comment in `always-throws-branch.ts` records the deferral. Until then, the heuristic catches the common shape (a function whose body is a precondition wall) at the cost of missing functions that throw under most but not all branches.

### Entry-point inference

[`rules/_entry-points.ts`](../../../packages/graph/engine/src/rules/_entry-points.ts) is consumed by `orphan-subtree` and `test-only-reachable`. It's not itself a rule (note the leading underscore). The current implementation classifies each occurrence into one of three reasons:

```ts
type EntryPointReason = 'module-init' | 'name-match' | 'no-callers-exported';
```

The five rules above don't know how the entry point list was built — they consume the resulting `EntryPoint[]`. That decoupling means refining the inference (e.g. teaching it about `bin` fields or framework route registrations) doesn't touch any rule.

---

## Per-language fidelity

Rules don't know which adapter built the catalog — they consume `Catalog` + `Indexes` only — but each `CallEdge` carries a `confidence` field (`'high' | 'medium' | 'low'`) that reflects how the adapter resolved it. The TypeScript adapter uses the symbol table for direct calls and emits `'high'` confidence; the tree-sitter Python and Rust adapters resolve by name and emit `'medium'` (or `'low'` when multiple catalog entries share a simple name). The same rule on a Python catalog therefore produces a noisier output than on a TypeScript catalog — same logic, different input quality.

The fidelity matrix from [plan 10 §6](../../plans/10-graph-language-pluggability.md):

| Rule | TypeScript adapter | Tree-sitter adapter (Python, Rust) |
|---|---|---|
| `orphan-subtree` | High — symbol resolution gives accurate transitive callee sets | Medium — name-based resolution; multiple `process` functions may pick the wrong target |
| `duplicated-function-body` | Medium — body hash is textual; lexical-scope FPs documented | Medium — same fidelity (body hashing is language-agnostic) |
| `no-side-effect-path` | High — accurate edges + side-effect primitive list | Low — edge inaccuracy compounds; the side-effect primitives list is per-adapter via `ruleHints.sideEffectPrimitives` |
| `test-only-reachable` | High — symbol resolution makes "callable from test only" precise | Low — same fidelity issue as no-side-effect-path |
| `always-throws-branch` | Medium — textual heuristic on `CallEdge.text`, language-agnostic | Medium — same heuristic, different syntax via `ruleHints.throwSyntaxRegex` |

The `ruleHints` surface ([`lang-adapter/types.ts`](../../../packages/graph/engine/src/lang-adapter/types.ts)) is how an adapter customises the per-rule inputs without changing rule logic: `isTestFile` for `test-only-reachable`, `sideEffectPrimitives` for `no-side-effect-path`, `throwSyntaxRegex` for `always-throws-branch`. An adapter that doesn't supply hints gets the engine's defaults and the corresponding rules silently degrade in precision rather than failing.

---

## The gate

The gate model: signal **fingerprints** are written to a baseline file with `--gate-save`; future runs compare current fingerprints against the baseline and exit non-zero on new ones.

```bash
# Establish the baseline once (commit the resulting file).
opensip-tools graph --gate-save

# In CI: fail the build if any new signal appeared.
opensip-tools graph --gate-compare
```

v2: the baseline lives in the project's SQLite store (`<project>/opensip-tools/.runtime/datastore.sqlite`, gitignored), in the `graph_baseline_signals` table. There is exactly one baseline per project; the v1 `--baseline <path>` flag is gone (see [v2.0.0 CHANGELOG](../../../CHANGELOG.md)).

### Signal fingerprints

A fingerprint is a string identity for a finding, used to diff against the baseline. The shape is `${ruleId}|${filePath}|${line}|${message}` — see [`fingerprintSignal` in `gate.ts`](../../../packages/graph/engine/src/gate.ts). The line number is included, so fingerprints **do** change when a finding moves up or down the file. This is intentional for v0.2 (a smaller, simpler baseline); the trade-off is documented below.

Two properties matter:

1. **Stable across re-runs of the same source.** Re-running graph against an unchanged file produces the same fingerprint set; the gate is silent.
2. **Sensitive to position and message.** Renames, line shifts, and message tweaks all generate new fingerprints. Run `--gate-save` after any cleanup pass that moves findings around to avoid spurious "new finding" reports on the next compare.

A line-shift-invariant fingerprint (the way fit's gate works) is on the v0.3 roadmap — for now, treat the graph baseline as a snapshot to be re-saved after refactors.

### Compare semantics

`--gate-compare` reads the baseline file and compares its fingerprint set against the current run's. The exit code is:

| Outcome | Exit code | Meaning |
|---|---|---|
| No new fingerprints | 0 | The diff is empty or only removes things. Safe to merge. |
| One or more new fingerprints | 1 | Something new appeared. The CI gate fails. |
| Baseline missing | 2 | Configuration error — run `--gate-save` first. |

This intentionally **allows fingerprint removal**. Cleaning up findings doesn't fail the gate; it just shrinks the baseline at the next save. Use the lifecycle: `--gate-compare` on every PR; periodically re-run `--gate-save` and commit the smaller baseline as the cleanup progresses.

### How this differs from `fit`'s gate

`fit`'s gate (see [`20-the-fit-loop/04-output-gate-sarif.md`](../20-the-fit-loop/04-output-gate-sarif.md)) is fundamentally the same shape — save fingerprints, compare later, fail on new — but it uses a SARIF baseline and hashes findings on `(filePath, ruleId, message)` (no line number). Graph's gate uses a fingerprint-set baseline that includes line numbers. v2: both baselines live in the project's SQLite store (`fit_baseline` row and `graph_baseline_signals` rows respectively), atomic via SQLite transactions. They're independent — running one doesn't affect the other.

---

## SARIF and `--report-to`

`graph --json` produces the same `CliOutput` envelope `fit` does, so any consumer of the JSON contract works unchanged. For external integration, `--report-to <url>` posts SARIF 2.1.0 to a configured endpoint (OpenSIP Cloud or any SARIF-compatible receiver).

The SARIF mapping in [`render/sarif.ts`](../../../packages/graph/engine/src/render/sarif.ts):

| Graph concept | SARIF field |
|---|---|
| Run (per-rule) | `runs[i].tool.driver.name = <rule slug>` (one SARIF run per check/rule; see `buildSarifLog` in [`packages/fitness/engine/src/sarif.ts`](../../../packages/fitness/engine/src/sarif.ts), which assigns `driver.name = ch.checkSlug`) |
| Rule | `runs[i].tool.driver.rules[].id = <rule slug>` |
| Signal | `runs[i].results[]` |
| Function occurrence | `result.locations[0].physicalLocation.{artifactLocation,region}` |
| Severity | `result.level` (`error` \| `warning`) |

The graph SARIF reuses fitness's `buildSarifLog` (DEC-3) and emits the standard SARIF 2.1.0 fields. A `partialFingerprints` augmentation that would let GitHub's code-scanning UI dedupe across runs is on the roadmap; today the SARIF carries `ruleId` + location only.

Exit code 4 is reserved for `--report-to` upload failure (network error or non-2xx response). This separates "the gate said no" (exit 1) from "we couldn't tell the gate anything" (exit 4) — both fail the build but mean different things.

---

## What's next

- **[`01-stages-and-catalog.md`](./01-stages-and-catalog.md)** — the pipeline and catalog that feeds these rules.
- **[`70-surfaces/01-cli-command-tree.md#graph`](../70-surfaces/01-cli-command-tree.md)** — every flag, with exit-code semantics.
- **[`70-surfaces/03-dashboard.md`](../70-surfaces/03-dashboard.md)** — the interactive Code Paths view, which renders graph results alongside fit's.
- **[`../plans/00-graph-performance-improvements.md`](../../plans/00-graph-performance-improvements.md)** — perf-plan history covering the rule and pipeline evolution since v1.1.
