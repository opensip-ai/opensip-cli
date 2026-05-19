---
status: current
last_verified: 2026-05-18
release: v1.3.0
title: "Adding a language to graph"
audience: [contributors, plugin-authors]
purpose: "Step-by-step guide for writing a new GraphLanguageAdapter — Go, Java, C/C++, or anything else — without touching the engine."
source-files:
  - packages/graph/engine/src/lang-adapter/types.ts
  - packages/graph/engine/src/lang-adapter/registry.ts
  - packages/graph/engine/src/lang-adapter/edge-helpers.ts
  - packages/graph/engine/src/lang-typescript/index.ts
  - packages/graph/engine/src/lang-python/index.ts
  - packages/graph/engine/src/lang-rust/index.ts
  - packages/graph/engine/src/bootstrap.ts
  - packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts
related-docs:
  - ./01-stages-and-catalog.md
  - ./02-rules-and-gating.md
  - ../../plans/10-graph-language-pluggability.md
  - ../../plans/11-graph-language-adapter-contract.md
---

# Adding a language to graph

The `graph` tool started as a TypeScript-only call-graph engine. PR 3 of [plan 10](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/10-graph-language-pluggability.md) introduced a six-method `GraphLanguageAdapter` contract so the engine itself doesn't know any specific language. v1.3.0 ships three first-party adapters — TypeScript (symbol-resolved), Python (tree-sitter), Rust (tree-sitter) — and any first-party or third-party adapter slots in by implementing the contract and registering itself.

This doc walks a contributor through that workflow.

> **What you'll have done after this:**
> - Decided where your adapter lives (first-party in this repo vs. third-party npm package).
> - Implemented the six adapter methods against your language's parser.
> - Run the contract test suite against your fixture project.
> - Registered the adapter so `opensip-tools graph` works on a project in your language.

---

## 1. Read first

Two short docs are the contract you implement against:

- [`docs/plans/11-graph-language-adapter-contract.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/11-graph-language-adapter-contract.md) — the interface signatures, behavioral invariants I-1 through I-9, and per-language feasibility sketches (Python, Rust, Go, Java, C/C++).
- [`packages/graph/engine/src/lang-adapter/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-adapter/types.ts) — the canonical TypeScript source for the interface and all I/O shapes.

Then look at the reference implementations. Three ship in v1.3.0:

- [`packages/graph/engine/src/lang-typescript/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/index.ts) — `typescriptGraphAdapter` is a thin façade over the existing TypeScript-specific machinery. Each contract method delegates to a sibling file (`discover.ts`, `parse.ts`, `walk.ts`, `edges.ts`, `cache-key.ts`) and translates I/O shapes. Symbol-resolved (`'high'` confidence on direct calls).
- [`packages/graph/engine/src/lang-python/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-python/index.ts) — `pythonGraphAdapter` is the canonical tree-sitter reference. ~8 source files plus a fixture project. Discovery via `pyproject.toml` / `setup.py` with `**/*.py` glob fallback; resolution by simple name. **If you're writing a tree-sitter adapter, read this one first** — its layout is the recommended template.
- [`packages/graph/engine/src/lang-rust/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-rust/index.ts) — `rustGraphAdapter` adds receiver-type narrowing on top of the Python pattern (`Foo::method(...)` lifts confidence when the receiver type is statically present in the call expression). Discovery via `Cargo.toml` with `**/*.rs` glob fallback.

---

## 2. The six methods

A `GraphLanguageAdapter` exposes six methods plus three identity fields (`id`, `fileExtensions`, `displayName`). The same data flows through them in order:

| Method | Responsibility | TypeScript reference |
|---|---|---|
| `discoverFiles` | Resolve which files belong to the project for a given cwd. Reads language-specific config (tsconfig.json, pyproject.toml, Cargo.toml, etc.). Returns absolute, realpath-normalized, sorted file paths. | [`lang-typescript/discover.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/discover.ts) |
| `parseProject` | Build adapter-internal parse state. The shape is opaque (`P = unknown`); the engine passes it back into `walkProject` and `resolveCallSites` unchanged. TypeScript holds a `ts.Program`; a tree-sitter adapter would hold a `Map<filePath, Tree>` plus a project-wide call-graph hint. | [`lang-typescript/parse.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/parse.ts) |
| `walkProject` | One pass over the parsed project. Emit `FunctionOccurrence`s (one per callable thing — function, method, arrow, constructor, getter/setter, plus a synthetic module-init per file) AND `CallSiteRecord`s (pre-located call expressions, owner-keyed by `bodyHash`). | [`lang-typescript/walk.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/walk.ts) |
| `resolveCallSites` | Resolve the call-site list against the frozen catalog. Return a `bodyHash → CallEdge[]` map plus resolution stats. Call edges carry a `confidence` (`'high'` for symbol-resolved, `'medium'`/`'low'` for name-only resolution). | [`lang-typescript/edges.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/edges.ts) (`resolveEdgesFromRecords`) |
| `cacheKey` | Compute an opaque per-adapter cache invalidation key. Different adapters MUST emit different prefixes (e.g. `ts-…`, `py-…`, `rs-…`) so cross-adapter accidents hash-mismatch immediately. | [`lang-typescript/cache-key.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/cache-key.ts) |
| `ruleHints` | Optional. Declare what counts as a test file in your language and which side-effect primitives the `no-side-effect-path` rule should look for. Without this, defaults apply and rules silently degrade. | [`lang-typescript/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/index.ts) (`ruleHints`) |

The exact TypeScript signatures live in [`lang-adapter/types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-adapter/types.ts). Read that file once — it's the technical reference.

---

## 3. Recommended file layout

For a new first-party adapter under `packages/graph/engine/src/lang-<id>/`:

```
src/lang-<id>/
  discover.ts        — discoverFiles implementation (reads pyproject.toml / Cargo.toml / etc.)
  parse.ts           — parseProject implementation (tree-sitter parser, LSP-server bridge, …)
  walk.ts            — walkProject implementation (one pass, emit occurrences + call-site records)
  resolve.ts         — resolveCallSites implementation (name-based or symbol-based)
  cache-key.ts       — cacheKey implementation (hash language config + toolchain version)
  rule-hints.ts      — ruleHints constant (isTestFile, sideEffectPrimitives, throwSyntaxRegex)
  index.ts           — exports the adapter:
                          export const <id>GraphAdapter: GraphLanguageAdapter<P> = {
                            id: '<id>',
                            fileExtensions: ['.<ext>'],
                            displayName: '<DisplayName>',
                            discoverFiles, parseProject, walkProject,
                            resolveCallSites, cacheKey,
                            ruleHints,
                          };
  __fixtures__/<id>/ — small project that exercises file discovery,
                       parsing, occurrence emission, call resolution
```

This mirrors `lang-python/` and `lang-rust/` — the recommended template for tree-sitter adapters. The TypeScript adapter has a deeper subdir layout (`inventory-visitors/`, `edge-resolvers/`, `inventory-helpers/`) because its symbol-resolved walk is genuinely more complex; for a tree-sitter adapter the flat layout is plenty. Adapters that prefer one big file or a different breakdown are fine — the contract doesn't care, only the public `index.ts` export matters.

For a third-party adapter, ship it as a separate npm package (e.g. `@your-org/graph-lang-elixir`) that exports the adapter. Users add it to their `plugins.tools` list and the graph tool's bootstrap calls `registerAdapter` on it.

---

## 4. The contract test suite

Every adapter MUST pass the contract test suite at [`packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts). It validates the nine behavioral invariants from [`docs/plans/11-graph-language-adapter-contract.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/11-graph-language-adapter-contract.md) §3:

| Invariant | What the test checks |
|---|---|
| **I-1** | `walkProject` is deterministic — two calls return the same occurrences and call-site summary. |
| **I-2** | Different bodies produce different `bodyHash`es (the duplicated-function-body rule depends on this). |
| **I-3** | Every `CallSiteRecord.ownerHash` exists in the same walk's `occurrences`. |
| **I-4** | `resolveCallSites` does not mutate its input catalog. |
| **I-5** | Every `CallEdge.to` references a catalog `bodyHash` or is empty (no dangling targets). |
| **I-6** | `cacheKey` is stable for stable input AND changes when the language config file changes. |
| **I-7** | `parseProject` is total over its `files` input — every file is either parsed or named in `parseErrors`. |
| **I-8** | `adapter.id` matches the language family the adapter handles, and `cacheKey` carries an adapter-distinct prefix. |
| **I-9** | `discoverFiles` is referentially transparent — repeated calls return the same files list. |

Add a `describe` block to that test file for your adapter. Each adapter ships with a small fixture project under `__tests__/fixtures/<id>/` that exercises file discovery, parsing, occurrence emission, and call resolution. The fixture should produce non-trivial occurrences (at least one function, one method, one arrow / lambda equivalent, one anonymous callable).

---

## 5. Per-language fidelity expectations

Different adapters produce different-fidelity edges. This is intrinsic — TypeScript's `getSymbolAtLocation` is rich; tree-sitter-based adapters resolve calls by name and have no symbol table. The contract surfaces this via `CallEdge.confidence`:

| Adapter | `confidence` for direct calls | Notes |
|---|---|---|
| `typescript` (shipped, v1.0) | `'high'` (symbol-resolved) | Reference. Has the TS type-checker. |
| `python` (shipped, v1.3.0) | Mostly `'medium'`; `'low'` on simple-name collisions | Tree-sitter; multiple functions named `process` may resolve to the wrong target. |
| `rust` (shipped, v1.3.0) | `'medium'` (with `impl` block context for receivers) | Tree-sitter; trait dispatch and method-on-generic resolution stay name-only. |
| `go` (planned) | `'medium'` | Receiver type carries info that helps disambiguation but not via a symbol table. |
| `java` (planned) | `'medium'` | Class context is rich (everything is in a class). |
| `c/c++` (planned) | `'medium'` | Header/source duplication and namespace resolution are the wrinkles. |

Per-rule fidelity expectations (from [plan 10 §6](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/10-graph-language-pluggability.md)):

| Rule | TS adapter (today) | Tree-sitter adapter (Python/Rust/Go/Java/C++) |
|---|---|---|
| `orphan-subtree` | High — symbol resolution gives accurate transitive callee sets | Medium — name-based resolution; multiple `process` functions may pick wrong target |
| `duplicated-function-body` | Medium — body hash is textual; lexical-scope FPs documented | Medium — same fidelity (body hashing is language-agnostic) |
| `no-side-effect-path` | High — accurate edges + side-effect primitive list | Low — edge inaccuracy compounds; side-effect list is also language-specific |
| `test-only-reachable` | High — symbol resolution makes "callable from test only" precise | Low — same fidelity issue as no-side-effect-path |
| `always-throws-branch` | Medium — textual heuristic on `CallEdge.text`, language-agnostic | Medium — same heuristic, different syntax via the adapter's `throwSyntaxRegex` hint |

When you ship a new adapter, add a row to this table in your PR.

---

## 6. Registration

For first-party adapters in this repo, add one line to [`packages/graph/engine/src/bootstrap.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/bootstrap.ts) (which today registers the three first-party adapters):

```ts
import { registerAdapter } from './lang-adapter/registry.js';
import { pythonGraphAdapter } from './lang-python/index.js';
import { rustGraphAdapter } from './lang-rust/index.js';
import { typescriptGraphAdapter } from './lang-typescript/index.js';
import { goGraphAdapter } from './lang-go/index.js'; // ← new

registerAdapter(typescriptGraphAdapter);
registerAdapter(pythonGraphAdapter);
registerAdapter(rustGraphAdapter);
registerAdapter(goGraphAdapter); // ← new
```

`bootstrap.ts` is imported as a side-effect module from both `tool.ts` (the Tool plugin entry) and `cli/orchestrate.ts` (so direct `runGraph()` callers in tests don't need to register manually). A new adapter is live the moment it's registered there.

Once two or more adapters are registered, [`pickAdapter(cwd)`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-adapter/registry.ts) chooses by file-extension dominance with a deterministic preference list (TS > Python > Rust on ties). Add your language to the preference list in `resolveTie` if you ship a new first-party adapter.

For third-party adapters: ship an npm package whose `tool.ts` (or any module imported when the package loads) calls `registerAdapter(yourAdapter)`. Users add the package to their `plugins.tools` list per the standard plugin docs.

---

## 7. First PR checklist

When you open the PR for a new adapter, verify each of these:

- [ ] Contract test suite passes against the new adapter (a `describe` block in `__tests__/lang-adapter-contract.test.ts` referencing your fixture project).
- [ ] Per-rule fidelity entry added to the table in §5 of this doc.
- [ ] Adapter ships with at least one fixture project under `__tests__/fixtures/<id>/` that exercises file discovery, parsing, occurrence emission, and call resolution.
- [ ] README and CLI `--help` mention the new language.
- [ ] dep-cruiser layer rules pass — `pipeline/`, `cache/`, `rules/`, `render/` and `cli/*` (except `bootstrap.ts` and `tool.ts`) MUST NOT import your `lang-<id>/` directory.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all clean.
- [ ] If your `cacheKey` prefix is novel (it must be), document it in your `cache-key.ts`'s docstring so the next adapter author doesn't accidentally collide.

---

## 8. Common gotchas

These are drawn from real bugs caught while shipping the Python (PR 5) and Rust (PR 6) adapters in v1.3.0.

- **Don't reach back into the catalog inside `walkProject`.** The catalog is built _after_ the walk from the walker's occurrence output. If your walker tries to look up a callee in the catalog mid-walk, you'll get `undefined` for half of them. That's what `resolveCallSites` is for — it runs after the catalog is frozen.
- **Don't mutate `catalog` from `resolveCallSites`.** Per I-4, the catalog is frozen by the time it reaches the resolver. Build name-lookup helpers locally in the resolver function and discard them on return.
- **Module-init synthetic occurrences are mandatory.** Top-level statements in a file own call sites that need a stable `ownerHash`. Synthesize one `<module-init:<filePath>>` occurrence per file with a body hash derived from the file path (not the file contents), so it's stable.
- **Adapter cacheKey prefixes must not collide.** A Python catalog with `cacheKey: ts-...` would falsely match a TypeScript run. Always include the language id at the start of your prefix (e.g. `py-`, `rs-`, `go-`). Invariant I-8 enforces this in the contract test suite.
- **Keep `walkProject` deterministic.** Don't rely on `Map` iteration order across runs (it's stable in V8 but worth being explicit); always sort outputs by a stable key (file path, then position) before emission. The byte-identical-catalog gate will catch most violations on the second test run.
- **Watch for `*/` inside JSDoc-style block comments in source you generate.** When emitting comments into your adapter's TypeScript files, a literal `*/` inside a `/** … */` block silently terminates the comment and the next character flips into code. Escape as `*​/` or split across lines.
- **Tree-sitter's `Language` type unifies awkwardly across grammar packages.** `tree-sitter-python` and `tree-sitter-rust` re-declare `Language` from their own `tree-sitter` peer dep. Cast to `any` at the parser-construction boundary or pin a single tree-sitter version across both grammar packages; the type-only mismatch is otherwise unfixable without a contract change.
- **Tree-sitter peer-dep warnings during install are non-fatal.** pnpm flags `tree-sitter-python@x` wants `tree-sitter@y` mismatches as warnings; the adapters work fine at the version we ship. If you see them, pin the grammar version to one your tree-sitter is known to support, or accept the warning.
- **Reuse the shared `appendEdge` helper.** [`lang-adapter/edge-helpers.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-adapter/edge-helpers.ts) was extracted in PR 6 because the duplicated-function-body rule legitimately fired across the three adapters' near-identical helpers. Use it instead of writing your own; if you need a variant, add a parameter rather than forking.

---

## 9. Where to ask

- The contract docs ([`10`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/10-graph-language-pluggability.md) and [`11`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/11-graph-language-adapter-contract.md)) discuss every design decision and call out deferred questions.
- The TypeScript adapter ([`lang-typescript/index.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/packages/graph/engine/src/lang-typescript/index.ts)) is the concrete reference; reading it end-to-end takes ~30 minutes.
- The contract test suite is the spec — if the test passes for your adapter, you're conforming.

---

## What's next

- **[`01-stages-and-catalog.md`](/docs/opensip-tools/40-the-graph-loop/01-stages-and-catalog/)** — the engine pipeline your adapter feeds into.
- **[`02-rules-and-gating.md`](/docs/opensip-tools/40-the-graph-loop/02-rules-and-gating/)** — the five rules that consume the catalog and the gate workflow.
- **[`docs/plans/10-graph-language-pluggability.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.3.1/docs/plans/10-graph-language-pluggability.md)** — the master plan covering motivation, sequencing, and acceptance gates for the language-pluggability initiative.
