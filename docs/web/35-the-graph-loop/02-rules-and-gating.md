---
status: current
last_verified: 2026-05-16
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
related-docs:
  - ./01-stages-and-catalog.md
  - ../20-the-fit-loop/04-output-gate-sarif.md
  - ../60-surfaces/01-cli-command-tree.md
---
# Rules and gating (graph)

[`01-stages-and-catalog.md`](/docs/opensip-tools/35-the-graph-loop/01-stages-and-catalog/) explained how `graph` builds its picture of the codebase. This doc covers what happens at stage 4 — the five rules that turn that picture into actionable findings — and the gate workflow that lets you keep new regressions out of `main` without forcing a clean-up of everything that exists today.

> **What you'll understand after this:**
> - The five rules graph ships with, what each detects, and the false-positive shape of each.
> - The gate save/compare model and how it differs from `fit`'s architecture gate.
> - How graph's SARIF output integrates with the same CI infrastructure `fit` uses.

---

## The rule contract

Every rule lives in [`packages/graph/engine/src/rules/<rule-name>.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/) and exports a single value implementing this shape:

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

The five rules below are registered in [`rules/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/registry.ts) and run on every `graph` invocation unless the caller filters with `--check <slug>` (planned, not yet shipped) or `--no-check <slug>` (also planned).

---

## The five rules

### `graph:orphan-subtree`

[`rules/orphan-subtree.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/orphan-subtree.ts) — find functions with zero callers that aren't legitimate entry points.

For each occurrence in the catalog, look up `indexes.inboundEdges` for callers. If the list is empty AND the occurrence isn't tagged as an entry point by [`_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/_entry-points.ts), emit a signal.

**False-positive shape**: anything graph can't see is an unrecognized "entry point" until the inference learns about it. Today the inference recognizes `module-init`, `name-match` (`main`/`run`/`start`/`register`/`init`/`bootstrap`/`initialize`), and `no-callers-exported`. Pre-`v0.3` it does *not* recognize `bin`-field entries from `package.json`, framework route handlers, or hand-registered scenario/check entry points — those need to be added to the heuristic chain or declared via config.

### `graph:duplicated-function-body`

[`rules/duplicated-function-body.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/duplicated-function-body.ts) — group catalog entries by `bodyHash`; report any group with more than one occurrence (above a minimum-line threshold to skip trivial bodies like `return null`).

**False-positive shape**: the rule matches function bodies *textually* and does not currently resolve called identifiers through lexical scope. A codebase using a wrapper-and-delegate convention (every check has an `analyze(content, filePath)` that delegates to a local `analyzeFile()`) produces a wave of false matches because every wrapper looks identical. Tracked in [`docs/plans/graph-rule-enhancements.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/docs/plans/graph-rule-enhancements.md) for v0.3. Until then, cross-package duplications (where lexical scope can't fool the rule) are the high-signal subset.

### `graph:no-side-effect-path`

[`rules/no-side-effect-path.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/no-side-effect-path.ts) — for each function, walk its transitive callee set. If no callee on any path touches a known side-effect primitive (`fs.*`, `process.*`, `console.*`, network I/O, `Math.random`, etc.), emit a signal.

The intent is to surface "dead" pure code — utilities that compute but never observe. Most findings are intentional (pure helpers like `findFunctions`, `findImports`), but a sideless function that's *supposed* to push violations into an array often points to a missing append: a check that returns an empty array regardless of input.

### `graph:test-only-reachable`

[`rules/test-only-reachable.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/test-only-reachable.ts) — compute reachability from the inferred entry points. Any occurrence reachable only via files where `inTestFile` is true is flagged.

This is the rule for catching "production helper that's only exercised by tests" — code shipped to users that nothing in the user-facing call graph ever invokes. It's the inverse of the more familiar "test coverage" question, which asks whether production code is reached *from* tests. This rule asks whether production code is reached *only* from tests.

### `graph:always-throws-branch`

[`rules/always-throws-branch.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/always-throws-branch.ts) — per-function control-flow analysis: for each branch in the function body (if/else, switch case, try/catch arm), check whether every code path through that branch ends in a `throw`. If yes, emit a signal.

The intent is to catch "this branch is unreachable in practice." A common pattern: a code path that should have been `early return` was written as `throw` for prototype safety and never converted back, so the branch silently masks a real bug case.

### Entry-point inference

[`rules/_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/_entry-points.ts) is consumed by `orphan-subtree` and `test-only-reachable`. It's not itself a rule (note the leading underscore). The current implementation classifies each occurrence into one of three reasons:

```ts
type EntryPointReason = 'module-init' | 'name-match' | 'no-callers-exported';
```

The five rules above don't know how the entry point list was built — they consume the resulting `EntryPoint[]`. That decoupling means refining the inference (e.g. teaching it about `bin` fields or framework route registrations) doesn't touch any rule.

---

## The gate

The gate model: signal **fingerprints** are written to a baseline file with `--gate-save`; future runs compare current fingerprints against the baseline and exit non-zero on new ones.

```bash
# Establish the baseline once (commit the resulting file).
opensip-tools graph --gate-save

# In CI: fail the build if any new signal appeared.
opensip-tools graph --gate-compare
```

By default the baseline lives at `<project>/opensip-tools/.runtime/cache/graph/baseline.json` (gitignored). Override with `--baseline <path>` if you want to commit it.

### Signal fingerprints

A fingerprint is a stable, location-independent identity for a finding. It's built from the rule slug plus a rule-specific "what this finding is *about*" key — typically the body-hash of the function in question, the deduplicated set of bodies for duplication findings, or the qualified name for orphans. See [`gate.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/gate.ts) for the per-rule fingerprint shape.

Three properties matter:

1. **Stable across renames and line moves.** Renaming `foo` to `bar` does not generate a new fingerprint if the body hash didn't change. The intent of the gate is "did the *shape* of the problem change?", not "did anything in the file move?"
2. **Stable across formatter passes.** Body hashes are computed from a normalized form of the function body, not the source text.
3. **Unstable across genuine logic changes.** Once a finding's *substance* changes (the function body actually changes), it's treated as a new finding. That's the right behavior — if you re-fix the same thing differently, the gate should notice.

### Compare semantics

`--gate-compare` reads the baseline file and compares its fingerprint set against the current run's. The exit code is:

| Outcome | Exit code | Meaning |
|---|---|---|
| No new fingerprints | 0 | The diff is empty or only removes things. Safe to merge. |
| One or more new fingerprints | 1 | Something new appeared. The CI gate fails. |
| Baseline file missing | 2 | Configuration error — run `--gate-save` first. |
| Baseline file malformed | 2 | Configuration error — corrupt baseline. |

This intentionally **allows fingerprint removal**. Cleaning up findings doesn't fail the gate; it just shrinks the baseline at the next save. Use the lifecycle: `--gate-compare` on every PR; periodically re-run `--gate-save` and commit the smaller baseline as the cleanup progresses.

### How this differs from `fit`'s gate

`fit`'s gate (see [`20-the-fit-loop/04-output-gate-sarif.md`](/docs/opensip-tools/20-the-fit-loop/04-output-gate-sarif/)) is fundamentally the same shape — save fingerprints, compare later, fail on new — but it operates on per-check findings keyed by `{checkSlug, filePath, identityHash}`. Graph's gate operates on per-rule findings keyed by the body hash of the underlying function. The mechanism is parallel; the units differ.

Both gates live in the same `<project>/opensip-tools/.runtime/cache/` directory tree (`baseline.sarif` for fit, `graph/baseline.json` for graph) and both atomic-write through a tmp + rename. They're independent — running one doesn't affect the other.

---

## SARIF and `--report-to`

`graph --json` produces the same `CliOutput` envelope `fit` does, so any consumer of the JSON contract works unchanged. For external integration, `--report-to <url>` posts SARIF 2.1.0 to a configured endpoint (OpenSIP Cloud or any SARIF-compatible receiver).

The SARIF mapping in [`render/sarif.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/render/sarif.ts):

| Graph concept | SARIF field |
|---|---|
| Tool | `runs[0].tool.driver.name = "opensip-tools-graph"` |
| Rule | `runs[0].tool.driver.rules[].id = <rule slug>` |
| Signal | `runs[0].results[]` |
| Function occurrence | `result.locations[0].physicalLocation.{artifactLocation,region}` |
| Body hash | `result.partialFingerprints.bodyHash` |
| Severity | `result.level` (`error` | `warning`) |

The `partialFingerprints` shape matches what GitHub's code-scanning UI uses to deduplicate findings across runs — pushing graph SARIF into GitHub gives you the same "new alerts / closed alerts" view you get from any other scanner.

Exit code 4 is reserved for `--report-to` upload failure (network error or non-2xx response). This separates "the gate said no" (exit 1) from "we couldn't tell the gate anything" (exit 4) — both fail the build but mean different things.

---

## What's next

- **[`01-stages-and-catalog.md`](/docs/opensip-tools/35-the-graph-loop/01-stages-and-catalog/)** — the pipeline and catalog that feeds these rules.
- **[`60-surfaces/01-cli-command-tree.md#graph`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/)** — every flag, with exit-code semantics.
- **[`60-surfaces/03-dashboard.md`](/docs/opensip-tools/60-surfaces/03-dashboard/)** — the interactive Code Paths view, which renders graph results alongside fit's.
- **[`../plans/graph-rule-enhancements.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/docs/plans/graph-rule-enhancements.md)** — open work on the rules themselves, including the lexical-scope fix for `duplicated-function-body`.
