---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "Rules and gating (graph)"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "The ten graph rules, what each one detects, and how the save/compare gate flow integrates with CI."
source-files:
  - packages/graph/engine/src/rules/registry.ts
  - packages/graph/engine/src/rules/orphan-subtree.ts
  - packages/graph/engine/src/rules/duplicated-function-body.ts
  - packages/graph/engine/src/rules/no-side-effect-path.ts
  - packages/graph/engine/src/rules/test-only-reachable.ts
  - packages/graph/engine/src/rules/always-throws-branch.ts
  - packages/graph/engine/src/rules/large-function.ts
  - packages/graph/engine/src/rules/wide-function.ts
  - packages/graph/engine/src/rules/high-blast-untested.ts
  - packages/graph/engine/src/rules/cycle.ts
  - packages/graph/engine/src/rules/unexpected-coupling.ts
  - packages/graph/engine/src/rules/_severity-override.ts
  - packages/graph/engine/src/rules/_entry-points.ts
  - packages/graph/engine/src/baseline-strategy.ts
  - packages/graph/engine/src/lang-adapter/types.ts
related-docs:
  - ./01-stages-and-catalog.md
  - ./03-adding-a-language.md
  - ../20-fit/04-output-gate-sarif.md
  - ../70-reference/01-cli-commands.md
---
# Rules and gating (graph)

[`01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/) explained how `graph` builds its picture of the codebase. This doc covers what happens at stage 4 — the ten rules that turn that picture into actionable findings — and the gate workflow that lets you keep new regressions out of `main` without forcing a clean-up of everything that exists today.

> **What you'll understand after this:**
> - The ten rules graph ships with, what each detects, and the false-positive shape of each.
> - The gate save/compare model and how it differs from `fit`'s architecture gate.
> - How graph's SARIF output integrates with the same CI infrastructure `fit` uses.

---

## The rule contract

Every rule lives in [`packages/graph/engine/src/rules/<rule-name>.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/) and exports a single value implementing this shape:

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

The ten rules below are registered in [`rules/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/registry.ts) and run on every `graph` invocation (the default recipe is "run all rules") unless a `--recipe` narrows the set.

---

## The five core rules

### `graph:orphan-subtree`

[`rules/orphan-subtree.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/orphan-subtree.ts) — find functions not reachable from any inferred entry point.

The rule does a forward BFS from the entry-point seeds (computed by [`_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/_entry-points.ts), plus `config.entryPointHashes`) across `indexes.callees`. Any `FunctionOccurrence` not visited is flagged. This is *transitive* reachability, not a direct in-degree check — an entire chain of mutually-recursive helpers that nobody outside the chain calls is a single connected orphan subtree.

**Precision filter.** A finding is meant to be actionable — "delete it." To keep the signal that crisp, an unreachable occurrence is only flagged when all of the following hold (each is configurable):

- It is **not exported** (`visibility !== 'exported'`). Public surface is not dead merely because it lacks an *in-project* caller — it may be consumed across a package boundary the call graph cannot resolve. Override with `flagExportedOrphans: true`.
- It is **not in a test file** (`!inTestFile`). Test-file reachability is [`graph:test-only-reachable`](#graphtest-only-reachable)'s job; flagging here would double-report. Override with `flagTestOrphans: true`.
- It has **no decorators** (`decorators.length === 0`). Decorated functions (DI providers, route handlers, CLI commands) are framework-dispatched, not called by name, so a missing caller edge is expected.

(`module-init` occurrences are always entry points and are never flagged.)

**False-positive shape**: anything graph can't see is an unrecognized entry point. Today the inference recognizes `module-init`, `name-match` (`main`/`run`/`start`/`register`/`init`/`bootstrap`/`initialize`), and `no-callers-exported`. The `no-callers-exported` reason treats a **self-recursive** edge as *not* a caller — an exported recursive function whose only in-project caller is itself (e.g. a recursive renderer consumed only across a package boundary) is still an external entry point, so it and its file-local helper subtree stay reachable. The inference does not recognize `bin`-field entries from `package.json`, framework route handlers, or hand-registered scenario/check entry points unless they are declared via config (`entryPointHashes`).

### `graph:duplicated-function-body`

[`rules/duplicated-function-body.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/duplicated-function-body.ts) — group catalog entries by `bodyHash`. The rule has two complementary code paths under one slug:

1. **Per-instance (size-gated).** Report any group with more than one occurrence whose source span clears `minDuplicateBodyLines` (default 5) **and** whose normalized body clears `minDuplicateBodySize` (default 200 characters). This is the "two big functions someone should extract" case. It emits N-1 signals per group (one per non-primary copy).

2. **Aggregate (cross-package, light size floor).** A *small* body copied across *many* packages is the most expensive class of duplication, and the per-instance size floor is exactly what hides it (e.g. `stripStrings`/`stripComments` copied across five language adapters, each copy below the 200-character floor). For each body hash present in **≥ `minCrossPackageDuplicatePackages`** (default 3) *distinct* packages — identified via the same package-boundary the coupling grid uses — the rule emits **one** aggregate signal naming the sorted package list and the occurrence count. This path applies **no line floor** and a *lighter*, body-size-only floor (`minCrossPackageDuplicateBodySize`, default **80** characters) than the per-instance path's 200-character floor — tuned only to drop trivial bodies (empty DI-constructor shims, one-line getters, thin delegators) while keeping genuinely-small shared utilities visible. When a hash qualifies here, the per-instance signals for that same hash are **suppressed**, so a single duplicate group never double-reports. Bodies that don't reach N packages flow through path (1) unchanged.

Both paths apply the same exclusions: `arrow` / `function-expression` / `module-init` kinds and test-file occurrences are skipped. The aggregate signal carries `metadata: { packages, packageCount, occurrenceCount, bodyHash }` and is anchored at the lexicographically-lowest qualified name for a stable fingerprint.

**Config** ([`GraphConfig`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/types.ts)), read from the `graph:` block of `opensip-tools.config.yml`:

| Knob | Default | Effect |
| --- | --- | --- |
| `minDuplicateBodyLines` | 5 | Per-instance: minimum source-span lines. |
| `minDuplicateBodySize` | 200 | Per-instance: minimum normalized body characters. |
| `minCrossPackageDuplicatePackages` | 3 | Aggregate: minimum distinct packages a body hash must span to fire one aggregate signal (and suppress its per-instance copies). Lower to **2** for a repo where every two-package duplicate is a real hoist target; raise it to quiet a noisy repo. |
| `minCrossPackageDuplicateBodySize` | 80 | Aggregate: minimum normalized body characters (no line floor). Lighter than the per-instance floor — drops only trivial bodies while keeping small shared utilities visible. |

**False-positive shape**: the rule matches function bodies *textually* and does not currently resolve called identifiers through lexical scope. On the per-instance path, thin wrapper functions are suppressed by `minDuplicateBodySize`, but two larger functions with identical text and different lexical bindings can still look like duplicates. The aggregate cross-package path is the high-signal subset: ≥3 distinct packages is unambiguously shared infra that should be hoisted into a common package.

### `graph:no-side-effect-path`

[`rules/no-side-effect-path.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/no-side-effect-path.ts) — for each function, walk its transitive callee set. If no callee on any path touches a known side-effect primitive (`fs.*`, `process.*`, `console.*`, network I/O, `Math.random`, etc.), emit a signal.

The intent is to surface "dead" pure code — utilities that compute but never observe. Most findings are intentional (pure helpers like `findFunctions`, `findImports`), but a sideless function that's *supposed* to push violations into an array often points to a missing append: a check that returns an empty array regardless of input.

### `graph:test-only-reachable`

[`rules/test-only-reachable.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/test-only-reachable.ts) — compute reachability from the inferred entry points. Any occurrence reachable only via files where `inTestFile` is true is flagged.

This is the rule for catching "production helper that's only exercised by tests" — code shipped to users that nothing in the user-facing call graph ever invokes. It's the inverse of the more familiar "test coverage" question, which asks whether production code is reached *from* tests. This rule asks whether production code is reached *only* from tests.

### `graph:always-throws-branch`

[`rules/always-throws-branch.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/always-throws-branch.ts) — flag functions whose every recorded outbound call looks like a `throw new Error(...)` shape. The current implementation uses a textual heuristic: each `CallEdge.text` is matched against `/^\s*throw\s+(?:new\s+)?[A-Z]\w*/`; if every call edge from the function matches, the function is treated as an always-throws helper masquerading as a real function.

This catches the common case — a function whose body is a precondition wall — but it is not full control-flow analysis. Functions that throw under most, but not all, branches may be missed.

> **Blast radius as a *ranking* is a dashboard insight, not a rule.** A
> function's blast radius (`direct + 0.5 × transitive` callers, bounded
> reverse BFS) is a *ranking*, so a top-percentile cut can never reach zero
> and never gates. The ranking lives only in the dashboard's coupling /
> distribution views. Note the distinct gate rule below,
> [`graph:high-blast-untested`](#graphhigh-blast-untested), which uses blast as
> an **absolute** threshold combined with `!testReachable` — a bounded,
> actionable predicate (add a test) that *can* reach zero. There is no
> `graph:high-blast-function` rule.

## The five structural rules

Five additional rules gate **structural** properties — function size, parameter
count, untested high-reach functions, and call-graph / package cycles. Each is a
thin declarative predicate over the engine's derived **feature columns**
(`bodyLines`, `blast`, `testReachable`, `sccSize`, `crossesPackages`, package
coupling edges); none re-implements a traversal. All are **on** in the default
recipe. Thresholds are opinionated in-rule defaults, overridable via the
`graph:` config block.

### `graph:large-function`

[`rules/large-function.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/large-function.ts) — flag functions whose body is large enough to be worth splitting. Two bands over the `bodyLines` feature column (`endLine − line + 1`, so it counts comments + blank lines). The gate defaults are calibrated higher than the dashboard's "~80 worth questioning / ~150 too much" heuristic so the gate flags genuinely oversized functions rather than flooding the baseline:

- `> largeFunctionWarnLines` (default **300**) → `medium`.
- `> largeFunctionErrorLines` (default **500**) → `high`.

The synthetic `<module-init>` occurrence and test-file occurrences are skipped (this flags actual long functions in production code, not whole-file length). Actionable ("split it"), precise (a 500-line function is rarely intended), bounded (count reaches zero once every function is under the limit).

### `graph:wide-function`

[`rules/wide-function.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/wide-function.ts) — flag functions with too many parameters, read directly from `params.length` (raw catalog data, no feature column). Test-file occurrences are skipped:

- `> wideFunctionWarnParams` (default **5**) → `medium`.
- `> wideFunctionErrorParams` (default **7**) → `high`.

Suggestion: group related parameters into an options object, or split the function.

### `graph:high-blast-untested`

[`rules/high-blast-untested.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/high-blast-untested.ts) — the flagship combination gate: a high-reach function that **no test exercises**. The predicate is `blast.score >= threshold && !testReachable` — an **absolute** blast threshold (never a percentile), so the count reaches zero once every high-blast function is test-covered. This is exactly the bounded-gating shape [ADR-0001](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/docs/decisions/ADR-0001-graph-rules-actionable-precise-bounded.md) sanctions for a metric: it gates as an absolute-threshold input to an actionable, bounded predicate.

- `blast.score >= highBlastWarnThreshold` (default **75**) and untested → `medium`.
- `blast.score >= highBlastErrorThreshold` (default **150**) and untested → `high`.

A high-blast **tested** function and a **low-blast** untested function both emit nothing. Functions defined in a test file are skipped (asking whether test code "is reached by a test" is meaningless). The fix is one verb: add a test. Precision tracks edge-resolution fidelity (blast is computed over resolved call edges).

### `graph:cycle`

[`rules/cycle.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/cycle.ts) — flag call-graph cycles (strongly-connected components of size ≥ 2), read from the `scc` feature column (engine-side Tarjan; no in-rule cycle detection). One signal **per SCC**, anchored on the lowest-qualified-name member. The severity ladder:

- `sccSize === 1` → no signal (not a cycle).
- `crossesPackages` → `high` (wins regardless of size — cross-package cycles are the most expensive to unwind).
- `sccSize === 2` → `cycleSize2Severity` (default **`off`** — legitimate mutual recursion is common; set `low` to surface them as notes).
- `sccSize >= cycleMinSize` (default **3**) → `medium`.

A cycle whose members are **all** in test files is skipped (recursive test helpers / mutually-recursive fixtures are test code, not a production-architecture concern); a cycle that includes any production member is kept.

### `graph:unexpected-coupling`

[`rules/unexpected-coupling.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/unexpected-coupling.ts) — flag **package dependency cycles** (A→B→A), read from the package coupling edge column. One `high` signal per unordered package pair that forms a cycle. Bounded (reaches zero when the cycle is broken) and project-agnostic — it bakes in **no** layer names and reads no declared-layering input.

> **ADR-0001 boundary.** `unexpected-coupling` gates package **cycles** only. The statistical "coupling outlier" (a package-pair edge count far above the distribution) is a *ranking* → a **dashboard insight, not a gate rule** — it surfaces on the coupling view, never as a gate signal.

It de-dups with `graph:cycle`: that rule reports per-SCC at function granularity, this one reports per-package-pair at package granularity. Distinct `ruleId` + location → distinct fingerprints; the two are cross-linked via metadata (`relatedSccCount` ↔ `relatedPackageCycle`).

### Opinionated default, overridable severity (the clamp)

A rule's per-occurrence severity (including the multi-band ladders above) is the **base**. The `graph.severityOverrides` config block ([`_severity-override.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/_severity-override.ts)) is an **opt-in clamp**: setting `severityOverrides: { 'graph:<slug>': error }` forces every signal from that rule to `high` (`warning` → `medium`). It is **baseline-neutral when unset** — with no override configured, every rule emits exactly its base severity, so the gate baseline never churns from this wiring. `defaultSeverity` stays metadata, never the emitted value.

### Entry-point inference

[`rules/_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/rules/_entry-points.ts) is consumed by `orphan-subtree` and `test-only-reachable`. It's not itself a rule (note the leading underscore). The current implementation classifies each occurrence into one of three reasons:

```ts
type EntryPointReason = 'module-init' | 'name-match' | 'no-callers-exported';
```

The rules above don't know how the entry point list was built — the ones that use it (chiefly `orphan-subtree`) just consume the resulting `EntryPoint[]`. That decoupling means refining the inference (e.g. teaching it about `bin` fields or framework route registrations) doesn't touch any rule.

---

## Per-language fidelity

Rules don't know which adapter built the catalog — they consume `Catalog` + `Indexes` only — but each `CallEdge` carries a `confidence` field (`'high' | 'medium' | 'low'`) that reflects how the adapter resolved it. The TypeScript adapter uses the symbol table for direct calls and emits `'high'` confidence; the tree-sitter adapters (Python, Rust, Go, Java — all WASM-backed via `web-tree-sitter`) resolve by name and emit `'medium'` (or `'low'` when multiple catalog entries share a simple name). The same rule on a Python catalog therefore produces a noisier output than on a TypeScript catalog — same logic, different input quality.

The fidelity matrix:

| Rule | TypeScript adapter | Tree-sitter adapter (Python, Rust, Go, Java) |
|---|---|---|
| `orphan-subtree` | High — symbol resolution gives accurate transitive callee sets | Medium — name-based resolution; multiple `process` functions may pick the wrong target |
| `duplicated-function-body` | Medium — body hash is textual; lexical-scope FPs documented | Medium — same fidelity (body hashing is language-agnostic) |
| `no-side-effect-path` | High — accurate edges + side-effect primitive list | Low — edge inaccuracy compounds; the side-effect primitives list is per-adapter via `ruleHints.sideEffectPrimitives` |
| `test-only-reachable` | High — symbol resolution makes "callable from test only" precise | Low — same fidelity issue as no-side-effect-path |
| `always-throws-branch` | Medium — textual heuristic on `CallEdge.text`, language-agnostic | Medium — same heuristic, different syntax via `ruleHints.throwSyntaxRegex` |
| `large-function` | High — `bodyLines` is `endLine − line + 1`, emitted by every adapter | High — same (line spans are language-agnostic) |
| `wide-function` | High — `params` is raw catalog data in every adapter | High — same |
| `high-blast-untested` | High — blast + test reachability over accurate edges | Medium — precision tracks edge-resolution fidelity (blast over resolved edges) |
| `cycle` | High — SCCs over accurate call edges | Medium — name-based edges may merge/miss cycles |
| `unexpected-coupling` | High — package edges over accurate cross-package resolution | Medium — same edge-fidelity dependence |

The `ruleHints` surface ([`lang-adapter/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/lang-adapter/types.ts)) is how an adapter customises the per-rule inputs without changing rule logic: `isTestFile` for `test-only-reachable`, `sideEffectPrimitives` for `no-side-effect-path`, `throwSyntaxRegex` for `always-throws-branch`. An adapter that doesn't supply hints gets the engine's defaults and the corresponding rules silently degrade in precision rather than failing.

---

## The gate

The gate model: signal **fingerprints** are written to a baseline file with `--gate-save`; future runs compare current fingerprints against the baseline and exit non-zero on new ones.

```bash
# Establish the baseline once (commit the resulting file).
opensip-tools graph --gate-save

# In CI: fail the build if any new signal appeared.
opensip-tools graph --gate-compare
```

v2+: the baseline lives in the project's SQLite store (`<project>/opensip-tools/.runtime/datastore.sqlite`, gitignored), as rows in the host-owned `tool_baseline_entries` table scoped `tool = 'graph'` (ADR-0036 — one generic table pair serves every tool's gate). There is exactly one baseline per tool per project; the v1 `--baseline <path>` flag is gone (see [v2.0.0 CHANGELOG](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/CHANGELOG.md)).

### Signal fingerprints

A fingerprint is a string identity for a finding, used to diff against the baseline. The shape is `${ruleId}|${filePath}|${line}|${column}` — graph's declared [`fingerprintStrategy`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/baseline-strategy.ts) (ADR-0036: each tool stamps its own envelope; the host plane never re-fingerprints). The `message` is deliberately **excluded** — several rules embed run-varying counts in their message text (e.g. `duplicated-function-body`'s duplicate count), which would re-key an unchanged finding across runs. The line number **is** included, so fingerprints do change when a finding moves up or down the file.

Two properties matter:

1. **Stable across re-runs of the same source.** Re-running graph against an unchanged file produces the same fingerprint set; the gate is silent.
2. **Sensitive to position and message.** Renames, line shifts, and message tweaks all generate new fingerprints. Run `--gate-save` after any cleanup pass that moves findings around to avoid spurious "new finding" reports on the next compare.

Treat the graph baseline as a snapshot to be re-saved after refactors that move findings around.

### Compare semantics

`--gate-compare` reads the saved baseline rows and compares their fingerprint set against the current run's (the pure `diffBaseline` in `@opensip-tools/output`). The exit code is:

| Outcome | Exit code | Meaning |
|---|---|---|
| No new fingerprints | 0 | The diff is empty or only removes things. Safe to merge. |
| One or more new fingerprints | 1 | Something new appeared. The CI gate fails. |
| Baseline missing | 2 | Configuration error — run `--gate-save` first. |

This intentionally **allows fingerprint removal**. Cleaning up findings doesn't fail the gate; it just shrinks the baseline at the next save. Use the lifecycle: `--gate-compare` on every PR; periodically re-run `--gate-save` and commit the smaller baseline as the cleanup progresses.

### How this differs from `fit`'s gate

`fit`'s gate (see [`20-fit/04-output-gate-sarif.md`](/docs/opensip-tools/20-fit/04-output-gate-sarif/)) **is the same host machinery** (ADR-0036): both tools ride the same `saveBaseline`/`compareBaseline` seams over the same `tool_baseline_entries`/`tool_baseline_meta` table pair, atomic via SQLite transactions. What differs is each tool's declared `fingerprintStrategy`: fit hashes `(filePath, ruleId, message)` (no line number — line-shift tolerant); graph keys `ruleId|filePath|line|column` (no message — count-shift tolerant). Per [ADR-0011](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/docs/decisions/ADR-0011-signal-output-currency-formatter-sink.md), **both gates store signals, not SARIF**. The rows are scoped by the `tool` column, so the gates are independent — running one doesn't affect the other.

---

## SARIF and `--report-to`

`graph --json` produces the same `SignalEnvelope` `fit` and `sim` do, so any consumer of the JSON contract works unchanged (see [`70-reference/04-json-output-schema.md`](/docs/opensip-tools/70-reference/04-json-output-schema/)). For external integration, `--report-to <url>` posts SARIF 2.1.0 to a configured endpoint (OpenSIP Cloud or any SARIF-compatible receiver).

Per [ADR-0011](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/docs/decisions/ADR-0011-signal-output-currency-formatter-sink.md), graph no longer owns a SARIF emitter: it returns its `SignalEnvelope` and the composition root formats it via the **single shared** `formatSignalSarif` formatter ([`packages/output/src/format/signal-sarif.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/output/src/format/signal-sarif.ts)). Graph's only SARIF-specific responsibility is mapping each engine rule slug to its OpenSIP-convention rule id (`graph.<rule-family>.<rule-id>`) at envelope assembly ([`cli/build-envelope.ts`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/packages/graph/engine/src/cli/build-envelope.ts)) — tool vocabulary stays graph-owned. The shared formatter's mapping:

| Graph concept | SARIF field |
|---|---|
| Run | A single run per invocation: `runs[0].tool.driver.name = 'opensip-tools-graph'` |
| Rule | `runs[0].tool.driver.rules[].id` — the distinct OpenSIP-convention rule ids (`graph.<rule-family>.<rule-id>`), sorted |
| Signal | `runs[0].results[]`, each with `ruleId` set to its mapped OpenSIP rule id |
| Function occurrence | `result.locations[0].physicalLocation.{artifactLocation,region}` |
| Severity | `result.level` (`critical`/`high` → `error`; `medium` → `warning`; `low` → `note`) |

Today the SARIF carries `ruleId` + location only; fingerprinting remains part of the graph gate's SQLite baseline.

Exit code 4 is reserved for `--report-to` upload failure (network error or non-2xx response). This separates "the gate said no" (exit 1) from "we couldn't tell the gate anything" (exit 4) — both fail the build but mean different things.

---

## What's next

- **[`01-stages-and-catalog.md`](/docs/opensip-tools/40-graph/01-stages-and-catalog/)** — the pipeline and catalog that feeds these rules.
- **[`70-reference/01-cli-commands.md#graph`](/docs/opensip-tools/70-reference/01-cli-commands/)** — every flag, with exit-code semantics.
- **[`70-reference/06-dashboard.md`](/docs/opensip-tools/70-reference/06-dashboard/)** — the interactive Code Paths view, which renders graph results alongside fit's.
