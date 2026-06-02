---
status: current
last_verified: 2026-05-26
release: v2.0.x
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
  - ../20-fit/04-output-gate-sarif.md
  - ../70-reference/01-cli-commands.md
---
# Rules and gating (graph)

[`01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/) explained how `graph` builds its picture of the codebase. This doc covers what happens at stage 4 — the five rules that turn that picture into actionable findings — and the gate workflow that lets you keep new regressions out of `main` without forcing a clean-up of everything that exists today.

> **What you'll understand after this:**
> - The five rules graph ships with, what each detects, and the false-positive shape of each.
> - The gate save/compare model and how it differs from `fit`'s architecture gate.
> - How graph's SARIF output integrates with the same CI infrastructure `fit` uses.

---

## The rule contract

Every rule lives in [`packages/graph/engine/src/rules/<rule-name>.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/) and exports a single value implementing this shape:

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

The five rules below are registered in [`rules/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/registry.ts) and run on every `graph` invocation unless the caller filters with `--check <slug>` (planned, not yet shipped) or `--no-check <slug>` (also planned).

---

## The five rules

### `graph:orphan-subtree`

[`rules/orphan-subtree.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/orphan-subtree.ts) — find functions not reachable from any inferred entry point.

The rule does a forward BFS from the entry-point seeds (computed by [`_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/_entry-points.ts), plus `config.entryPointHashes`) across `indexes.callees`. Any `FunctionOccurrence` not visited is flagged. This is *transitive* reachability, not a direct in-degree check — an entire chain of mutually-recursive helpers that nobody outside the chain calls is a single connected orphan subtree.

**Precision filter.** A finding is meant to be actionable — "delete it." To keep the signal that crisp, an unreachable occurrence is only flagged when all of the following hold (each is configurable):

- It is **not exported** (`visibility !== 'exported'`). Public surface is not dead merely because it lacks an *in-project* caller — it may be consumed across a package boundary the call graph cannot resolve. Override with `flagExportedOrphans: true`.
- It is **not in a test file** (`!inTestFile`). Test-file reachability is [`graph:test-only-reachable`](#graphtest-only-reachable)'s job; flagging here would double-report. Override with `flagTestOrphans: true`.
- It has **no decorators** (`decorators.length === 0`). Decorated functions (DI providers, route handlers, CLI commands) are framework-dispatched, not called by name, so a missing caller edge is expected.

(`module-init` occurrences are always entry points and are never flagged.)

**False-positive shape**: anything graph can't see is an unrecognized entry point. Today the inference recognizes `module-init`, `name-match` (`main`/`run`/`start`/`register`/`init`/`bootstrap`/`initialize`), and `no-callers-exported`. The `no-callers-exported` reason treats a **self-recursive** edge as *not* a caller — an exported recursive function whose only in-project caller is itself (e.g. a recursive renderer consumed only across a package boundary) is still an external entry point, so it and its file-local helper subtree stay reachable. The inference does not recognize `bin`-field entries from `package.json`, framework route handlers, or hand-registered scenario/check entry points unless they are declared via config (`entryPointHashes`).

### `graph:duplicated-function-body`

[`rules/duplicated-function-body.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/duplicated-function-body.ts) — group catalog entries by `bodyHash`. The rule has two complementary code paths under one slug:

1. **Per-instance (size-gated).** Report any group with more than one occurrence whose source span clears `minDuplicateBodyLines` (default 5) **and** whose normalized body clears `minDuplicateBodySize` (default 200 characters). This is the "two big functions someone should extract" case. It emits N-1 signals per group (one per non-primary copy).

2. **Aggregate (cross-package, no size floor).** A *small* body copied across *many* packages is the most expensive class of duplication, and the per-instance size floor is exactly what hides it (e.g. `stripStrings`/`stripComments` copied across five language adapters, each copy below the 200-character floor). For each body hash present in **≥ `minCrossPackageDuplicatePackages`** (default 3) *distinct* packages — identified via the same package-boundary the coupling grid uses — the rule emits **one** aggregate signal naming the sorted package list and the occurrence count, with **no** per-copy size or line floor. When a hash qualifies here, the per-instance signals for that same hash are **suppressed**, so a single duplicate group never double-reports. Bodies that don't reach N packages flow through path (1) unchanged.

Both paths apply the same exclusions: `arrow` / `function-expression` / `module-init` kinds and test-file occurrences are skipped. The aggregate signal carries `metadata: { packages, packageCount, occurrenceCount, bodyHash }` and is anchored at the lexicographically-lowest qualified name for a stable fingerprint.

**Config** ([`GraphConfig`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/types.ts)), read from the `graph:` block of `opensip-tools.config.yml`:

| Knob | Default | Effect |
| --- | --- | --- |
| `minDuplicateBodyLines` | 5 | Per-instance: minimum source-span lines. |
| `minDuplicateBodySize` | 200 | Per-instance: minimum normalized body characters. |
| `minCrossPackageDuplicatePackages` | 3 | Aggregate: minimum distinct packages a body hash must span to fire one aggregate signal (and suppress its per-instance copies). Lower to **2** for a repo where every two-package duplicate is a real hoist target; raise it to quiet a noisy repo. |

**False-positive shape**: the rule matches function bodies *textually* and does not currently resolve called identifiers through lexical scope. On the per-instance path, thin wrapper functions are suppressed by `minDuplicateBodySize`, but two larger functions with identical text and different lexical bindings can still look like duplicates. The aggregate cross-package path is the high-signal subset: ≥3 distinct packages is unambiguously shared infra that should be hoisted into a common package.

### `graph:no-side-effect-path`

[`rules/no-side-effect-path.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/no-side-effect-path.ts) — for each function, walk its transitive callee set. If no callee on any path touches a known side-effect primitive (`fs.*`, `process.*`, `console.*`, network I/O, `Math.random`, etc.), emit a signal.

The intent is to surface "dead" pure code — utilities that compute but never observe. Most findings are intentional (pure helpers like `findFunctions`, `findImports`), but a sideless function that's *supposed* to push violations into an array often points to a missing append: a check that returns an empty array regardless of input.

### `graph:test-only-reachable`

[`rules/test-only-reachable.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/test-only-reachable.ts) — compute reachability from the inferred entry points. Any occurrence reachable only via files where `inTestFile` is true is flagged.

This is the rule for catching "production helper that's only exercised by tests" — code shipped to users that nothing in the user-facing call graph ever invokes. It's the inverse of the more familiar "test coverage" question, which asks whether production code is reached *from* tests. This rule asks whether production code is reached *only* from tests.

### `graph:always-throws-branch`

[`rules/always-throws-branch.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/always-throws-branch.ts) — flag functions whose every recorded outbound call looks like a `throw new Error(...)` shape. The current implementation uses a textual heuristic: each `CallEdge.text` is matched against `/^\s*throw\s+(?:new\s+)?[A-Z]\w*/`; if every call edge from the function matches, the function is treated as an always-throws helper masquerading as a real function.

This catches the common case — a function whose body is a precondition wall — but it is not full control-flow analysis. Functions that throw under most, but not all, branches may be missed.

> **Blast radius is a dashboard insight, not a rule.** A function's
> blast radius (`direct + 0.5 × transitive` callers, bounded reverse BFS)
> is a *ranking*, not a defect predicate — a top-percentile cut can never
> reach zero, so it was never a gate. It now lives only in the dashboard's
> **Hot Functions** view, which ranks functions by their composite blast
> score. There is no `graph:high-blast-function` rule and it emits no gate
> signals.

### Entry-point inference

[`rules/_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/rules/_entry-points.ts) is consumed by `orphan-subtree` and `test-only-reachable`. It's not itself a rule (note the leading underscore). The current implementation classifies each occurrence into one of three reasons:

```ts
type EntryPointReason = 'module-init' | 'name-match' | 'no-callers-exported';
```

The rules above don't know how the entry point list was built — the ones that use it (chiefly `orphan-subtree`) just consume the resulting `EntryPoint[]`. That decoupling means refining the inference (e.g. teaching it about `bin` fields or framework route registrations) doesn't touch any rule.

---

## Per-language fidelity

Rules don't know which adapter built the catalog — they consume `Catalog` + `Indexes` only — but each `CallEdge` carries a `confidence` field (`'high' | 'medium' | 'low'`) that reflects how the adapter resolved it. The TypeScript adapter uses the symbol table for direct calls and emits `'high'` confidence; the tree-sitter Python and Rust adapters resolve by name and emit `'medium'` (or `'low'` when multiple catalog entries share a simple name). The same rule on a Python catalog therefore produces a noisier output than on a TypeScript catalog — same logic, different input quality.

The fidelity matrix:

| Rule | TypeScript adapter | Tree-sitter adapter (Python, Rust) |
|---|---|---|
| `orphan-subtree` | High — symbol resolution gives accurate transitive callee sets | Medium — name-based resolution; multiple `process` functions may pick the wrong target |
| `duplicated-function-body` | Medium — body hash is textual; lexical-scope FPs documented | Medium — same fidelity (body hashing is language-agnostic) |
| `no-side-effect-path` | High — accurate edges + side-effect primitive list | Low — edge inaccuracy compounds; the side-effect primitives list is per-adapter via `ruleHints.sideEffectPrimitives` |
| `test-only-reachable` | High — symbol resolution makes "callable from test only" precise | Low — same fidelity issue as no-side-effect-path |
| `always-throws-branch` | Medium — textual heuristic on `CallEdge.text`, language-agnostic | Medium — same heuristic, different syntax via `ruleHints.throwSyntaxRegex` |

The `ruleHints` surface ([`lang-adapter/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/lang-adapter/types.ts)) is how an adapter customises the per-rule inputs without changing rule logic: `isTestFile` for `test-only-reachable`, `sideEffectPrimitives` for `no-side-effect-path`, `throwSyntaxRegex` for `always-throws-branch`. An adapter that doesn't supply hints gets the engine's defaults and the corresponding rules silently degrade in precision rather than failing.

---

## The gate

The gate model: signal **fingerprints** are written to a baseline file with `--gate-save`; future runs compare current fingerprints against the baseline and exit non-zero on new ones.

```bash
# Establish the baseline once (commit the resulting file).
opensip-tools graph --gate-save

# In CI: fail the build if any new signal appeared.
opensip-tools graph --gate-compare
```

v2: the baseline lives in the project's SQLite store (`<project>/opensip-tools/.runtime/datastore.sqlite`, gitignored), in the `graph_baseline_signals` table. There is exactly one baseline per project; the v1 `--baseline <path>` flag is gone (see [v2.0.0 CHANGELOG](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/CHANGELOG.md)).

### Signal fingerprints

A fingerprint is a string identity for a finding, used to diff against the baseline. The shape is `${ruleId}|${filePath}|${line}|${message}` — see [`fingerprintSignal` in `gate.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/gate.ts). The line number is included, so fingerprints **do** change when a finding moves up or down the file.

Two properties matter:

1. **Stable across re-runs of the same source.** Re-running graph against an unchanged file produces the same fingerprint set; the gate is silent.
2. **Sensitive to position and message.** Renames, line shifts, and message tweaks all generate new fingerprints. Run `--gate-save` after any cleanup pass that moves findings around to avoid spurious "new finding" reports on the next compare.

Treat the graph baseline as a snapshot to be re-saved after refactors that move findings around.

### Compare semantics

`--gate-compare` reads the baseline file and compares its fingerprint set against the current run's. The exit code is:

| Outcome | Exit code | Meaning |
|---|---|---|
| No new fingerprints | 0 | The diff is empty or only removes things. Safe to merge. |
| One or more new fingerprints | 1 | Something new appeared. The CI gate fails. |
| Baseline missing | 2 | Configuration error — run `--gate-save` first. |

This intentionally **allows fingerprint removal**. Cleaning up findings doesn't fail the gate; it just shrinks the baseline at the next save. Use the lifecycle: `--gate-compare` on every PR; periodically re-run `--gate-save` and commit the smaller baseline as the cleanup progresses.

### How this differs from `fit`'s gate

`fit`'s gate (see [`20-fit/04-output-gate-sarif.md`](/docs/opensip-tools/20-fit/04-output-gate-sarif/)) is fundamentally the same shape — save fingerprints, compare later, fail on new — but it uses a SARIF baseline and hashes findings on `(filePath, ruleId, message)` (no line number). Graph's gate uses a fingerprint-set baseline that includes line numbers. v2: both baselines live in the project's SQLite store (`fit_baseline` row and `graph_baseline_signals` rows respectively), atomic via SQLite transactions. They're independent — running one doesn't affect the other.

---

## SARIF and `--report-to`

`graph --json` produces the same `CliOutput` envelope `fit` does, so any consumer of the JSON contract works unchanged. For external integration, `--report-to <url>` posts SARIF 2.1.0 to a configured endpoint (OpenSIP Cloud or any SARIF-compatible receiver).

The SARIF mapping is a graph-native emitter, [`renderSarifOpenSip` in `render/sarif-opensip.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/render/sarif-opensip.ts) (re-exported as `renderSarif` from [`render/sarif.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.5.0/packages/graph/engine/src/render/sarif.ts); since DEC-498 it no longer wraps fitness's `buildSarifLog`):

| Graph concept | SARIF field |
|---|---|
| Run | A single run per invocation: `runs[0].tool.driver.name = 'opensip-tools-graph'` |
| Rule | `runs[0].tool.driver.rules[].id` — the distinct OpenSIP-convention rule ids (`graph.<rule-family>.<rule-id>`), sorted |
| Signal | `runs[0].results[]`, each with `ruleId` set to its mapped OpenSIP rule id |
| Function occurrence | `result.locations[0].physicalLocation.{artifactLocation,region}` |
| Severity | `result.level` (`error` \| `warning`) |

The graph SARIF reuses fitness's `buildSarifLog` (DEC-3) and emits the standard SARIF 2.1.0 fields. Today the SARIF carries `ruleId` + location only; fingerprinting remains part of the graph gate's SQLite baseline.

Exit code 4 is reserved for `--report-to` upload failure (network error or non-2xx response). This separates "the gate said no" (exit 1) from "we couldn't tell the gate anything" (exit 4) — both fail the build but mean different things.

---

## What's next

- **[`01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/)** — the pipeline and catalog that feeds these rules.
- **[`70-reference/01-cli-commands.md#graph`](/docs/opensip-tools/70-reference/01-cli-commands/)** — every flag, with exit-code semantics.
- **[`70-reference/06-dashboard.md`](/docs/opensip-tools/70-reference/06-dashboard/)** — the interactive Code Paths view, which renders graph results alongside fit's.
