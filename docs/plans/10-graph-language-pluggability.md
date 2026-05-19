---
status: proposed
last_verified: 2026-05-18
title: "graph Tool — language pluggability"
audience: [contributors, maintainers]
purpose: "Refactor graph from a TypeScript-only engine into a tool with a clean GraphLanguageAdapter contract, so contributors can add Python, Rust, Go, Java, C/C++ adapters without touching the engine. Designed for an open-source workflow where reviewers expect a written contract, an acceptance gate, and a single-PR-per-step diff."
related-docs:
  - ./11-graph-language-adapter-contract.md
  - ./12-graph-language-pluggability-prs.md
  - ./00-graph-performance-improvements.md
  - ../architecture/40-the-graph-loop/01-stages-and-catalog.md
---

# graph Tool — language pluggability

## 0. Why this exists

Today `@opensip-tools/graph` is **structurally TypeScript-only**. 31 source files import `'typescript'`, the catalog stores `tsConfigPath` and `tsCompilerVersion`, the cache invalidates on TS version changes, and every inventory visitor and edge resolver branches on `ts.is*(node)` predicates. There is no language abstraction; "TypeScript" is hardcoded into stage 0 (file discovery), stages 1+2 (parse, walk, resolve), and the on-disk catalog format.

This is fine while we ship one language. It is not fine for an open-source codebase that wants outside contributors to add Python, Rust, Go, Java, or C/C++ adapters. A contributor today would have to read 31 files, absorb the unwritten contract between them, and either:

1. Copy the TypeScript pipeline into a sibling and prune what doesn't apply (hours of code archaeology, and the result drifts from the original on the next graph change), or
2. Carve out an abstraction in their own PR while also writing the new adapter (two unrelated changes in one review, neither cleanly judgable).

Both paths produce reviews where "is the abstraction right?" and "is the language adapter right?" are entangled. We want them separable: ship the contract first, then add adapters one PR at a time.

## 1. Goals

- **A `GraphLanguageAdapter` contract** that any language can implement to participate in graph. Six methods total (file discovery, parse, walk for occurrences, walk for call sites, body hashing, call resolution).
- **Engine code that depends on the contract, not on TypeScript.** `pipeline/`, `cache/`, `rules/`, `cli/` cannot import `'typescript'` or any lang-specific package. Enforced by dep-cruiser.
- **Catalog format generic over language.** Replace `tsConfigPath` + `tsCompilerVersion` with `language` + adapter-supplied `cacheKey`. Bump catalog version once (v3). After this lands, adding a language never bumps the catalog version again.
- **Byte-identical TypeScript catalog before-vs-after.** The refactor changes architecture, not behavior. Verified by an MD5 acceptance gate on opensip-tools self-graph.
- **A contributor-ready adapter authoring guide** under `docs/architecture/`. PR with new adapter = "I followed `40-the-graph-loop/03-adding-a-language.md` against my language; the contract tests pass."

## 2. Non-goals

- **Cross-language graphs.** A TS file calling a Rust function compiled to WASM is still two separate graphs. Single-language per project.
- **Type-aware symbol resolution for non-TS languages.** TypeScript's `getSymbolAtLocation` is rich; tree-sitter-based adapters resolve calls by name. The contract supports both fidelity tiers via `CallEdge.confidence`. Specific languages may someday integrate LSP servers, but that's a per-adapter decision, not a contract issue.
- **Migration of existing on-disk caches.** Catalog v2 → v3 invalidates the cache exactly once. Users see one cold rebuild. Not worth shipping a migrator for a gitignored file.
- **Changes to rule semantics.** The five rules (`orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`) keep their input contract: `(Catalog, Indexes, GraphConfig) → Signal[]`. They do not learn about languages.

## 3. The current pain in concrete terms

`packages/graph/engine/src/`:

```
pipeline/
  discover.ts          ← reads tsconfig.json directly
  walk.ts              ← imports 'typescript', uses ts.SourceFile, ts.Node throughout
  inventory.ts         ← legacy single-stage walker, also TS-coupled
  edges.ts             ← imports 'typescript', uses program.getTypeChecker()
  inventory-visitors/  ← 7 files, each switches on ts.is*(node)
  edge-resolvers/      ← 5 files, each calls typeChecker.getSymbolAtLocation
  inventory-helpers/   ← TS-specific name synthesis, decorator extraction, visibility
cache/
  invalidate.ts        ← keys cache on tsCompilerVersion + tsConfigPath
types.ts               ← Catalog has `tsConfigPath: string`, `tsCompilerVersion: string`
cli/
  scope.ts             ← --package resolution assumes TS workspace layout
```

**There is no contract.** `walk.ts`'s `walkProgram` happens to take a `ts.Program` because that's all it knows. A Python adapter has nothing to implement against — it would have to define the contract while implementing it.

**There is no enforcement.** Nothing prevents a future PR from adding `import ts from 'typescript'` in `rules/no-side-effect-path.ts`. Layering exists in the architecture docs, not in the build system.

**There is no acceptance gate.** Refactoring the engine today carries an unbounded behavioral risk because the only way to verify the catalog didn't change is to read every diff line carefully.

This plan fixes all three.

## 4. Approach: contract-first, in five PRs

The plan ships in five reviewable PRs. Each PR is independently shippable; the codebase is in a working state at every step. PRs 5+ are deferred until language demand is concrete.

### PR 1 — Plan doc (this document) + contract sketch

**Lands:** This file and [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md). No code.

**Reviewable in:** ~30 minutes.

**Acceptance:** The contract sketch identifies every TypeScript-specific behavior the engine relies on today, and proposes a generic equivalent for each. Reviewers can disagree about contract shape *before* any code lands.

### PR 2 — Extract `lang-typescript` subdirectory

**Lands:** Pure code-move. Every TS-specific source file under `packages/graph/engine/src/` moves into a new `packages/graph/engine/src/lang-typescript/` subdirectory:

```
src/
  lang-typescript/
    walk.ts                    (was src/pipeline/walk.ts)
    inventory.ts               (was src/pipeline/inventory.ts)
    edges.ts                   (was src/pipeline/edges.ts)
    discover.ts                (was src/pipeline/discover.ts)
    inventory-visitors/        (was src/pipeline/inventory-visitors/)
    edge-resolvers/            (was src/pipeline/edge-resolvers/)
    inventory-helpers/         (was src/pipeline/inventory-helpers/)
    edge-helpers/              (was src/pipeline/edge-helpers/)
    index.ts                   ← public surface: typescriptGraphAdapter
  pipeline/                    ← becomes language-agnostic orchestration only
  cache/                       ← unchanged
  rules/                       ← unchanged
  cli/                         ← unchanged
```

**No new abstraction.** `cli/orchestrate.ts` still calls into the same functions; their import paths just changed. Rules, cache, render unchanged.

**dep-cruiser rule added:** files outside `lang-typescript/` cannot `import 'typescript'`. The orchestrator gets one waiver line for now (it imports from `lang-typescript/index.ts`); PR 3 removes that waiver.

**Acceptance:**
- All 36 packages' tests pass.
- Catalog produced by `node packages/cli/dist/index.js graph --no-cache` against opensip-tools is **MD5-identical** to a pre-refactor baseline.
- `pnpm lint` is clean (the new dep-cruiser rule passes).

**Reviewable in:** ~1 hour. Diff is 95% renames; no logic changes. The byte-identical-catalog gate is the safety net.

### PR 3 — Define the contract, route TypeScript through it

**Lands:**
- `packages/graph/engine/src/lang-adapter/types.ts` — the `GraphLanguageAdapter` interface (six methods, see [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md)).
- `packages/graph/engine/src/lang-adapter/registry.ts` — a registry that maps adapter `id` → `GraphLanguageAdapter`. Like the existing `defaultLanguageRegistry` in `@opensip-tools/core/languages/registry.ts`, but specific to graph because the contract surfaces are different.
- `packages/graph/engine/src/lang-typescript/index.ts` — a new file that wraps the existing `lang-typescript/` code as `typescriptGraphAdapter: GraphLanguageAdapter`. No behavior change; it's a façade.
- `packages/graph/engine/src/cli/orchestrate.ts` — refactored to consume the registry instead of importing `lang-typescript/walk.ts` directly. Looks up the adapter for the project, calls its methods.
- Catalog v3: `tsConfigPath` and `tsCompilerVersion` fields are removed; `language: string` and `cacheKey: string` are added. The `version` field flips from `'2.0'` to `'3.0'`. Old caches invalidate gracefully (the existing `classifyCatalog` fall-through path handles unknown versions).

**dep-cruiser rules added:**
- Nothing in `pipeline/`, `cache/`, `rules/`, `render/`, or `cli/` may import from `lang-typescript/` or `'typescript'`.
- Only `lang-adapter/`, `cli/orchestrate.ts`, and `tool.ts` may import from `lang-typescript/index.ts`.

**Acceptance:**
- Byte-identical catalog gate: same MD5 as the PR 2 baseline. The catalog *shape* differs (v3 fields), but a `--no-cache` rebuild produces the same output deterministically; baseline is regenerated against the new shape.
- All 36 packages' tests pass.
- `pnpm lint` is clean. The dep-cruiser rules now enforce the layering.
- A new `__tests__/lang-adapter-contract.test.ts` file validates that `typescriptGraphAdapter` implements every contract method correctly. This becomes the contract test suite future adapters run against.

**Reviewable in:** ~3 hours. This is the intellectual content of the refactor. The byte-identical catalog gate is the safety net.

### PR 4 — Contributor authoring guide

**Lands:** `docs/architecture/40-the-graph-loop/03-adding-a-language.md`. Walks a contributor through:

- The six adapter methods, with TypeScript reference signatures cross-linked into `lang-typescript/`.
- File-by-file template for a new adapter (recommended layout: `lang-<id>/{discover,walk,resolve,index}.ts`).
- The contract test suite they run against (`__tests__/lang-adapter-contract.test.ts`).
- Per-language fidelity expectations: TypeScript produces high-confidence edges via symbol resolution; tree-sitter adapters typically produce medium/low. The `CallEdge.confidence` field is observable to rules and end users.
- How to register an adapter (one line in the registry, one line in `tool.ts` for first-party adapters; npm package for third-party).

**Acceptance:** Written prose only. Reviewable as a "does this make sense to someone who hasn't touched this code?" pass.

**Reviewable in:** ~1 hour.

### PR 5 — Python adapter (deferred)

**Lands:** New first-party package `@opensip-tools/graph-lang-python` (or inlined under `packages/graph/lang-python/` — TBD by whoever picks this up).

- Tree-sitter Python parser.
- `pythonGraphAdapter: GraphLanguageAdapter` implementing the six methods.
- Name-based call resolution (no symbol table; `CallEdge.confidence` is mostly `medium`).
- File discovery via `pyproject.toml` / `setup.py` / fallback to `**/*.py`.
- Tests: contract suite + a small fixture project.

This PR is the first proof the contract holds. It will surface contract bugs that PRs 1-4 missed. Expect 1-2 follow-up PRs to refine the interface — this is the cost of designing without a second implementation, and it is exactly why we want the second implementation now rather than three years from now.

**Status:** deferred until concrete demand. The first three PRs make this possible at any time without further engine changes.

### PR 6 — Rust adapter (deferred)

Second adapter. Validates that PR 5's contract refinements generalized. Likely uses tree-sitter Rust + name-based resolution; could integrate `rust-analyzer` as a fidelity upgrade later. File discovery via `Cargo.toml`.

By the time PR 6 lands, the contract should be stable. Future adapters (Go, Java, C/C++) follow the same shape with no further contract iteration expected.

## 5. Catalog v3 migration

The catalog file shape changes once. After this, the format is generic over language and we don't expect another version bump for the foreseeable future.

**Removed fields:**
- `tsConfigPath: string` — TypeScript-specific.
- `tsCompilerVersion: string` — TypeScript-specific.

**Added fields:**
- `language: string` — the adapter ID that built this catalog. Catalogs are not portable between languages; loading a Python catalog as TypeScript is a cache miss.
- `cacheKey: string` — opaque per-adapter version key. The TypeScript adapter sets it to `ts-${ts.version}-${tsconfigContentHash}`. The Python adapter sets it to whatever fingerprints its toolchain (e.g. `py-${pythonVersion}-${pyprojectHash}`).

**Existing fields unchanged:**
- `version: '3.0'` (was `'2.0'`)
- `tool: 'graph'`
- `builtAt: string`
- `filesFingerprint?: string`
- `functions: Record<string, FunctionOccurrence[]>`

**Migration path for users:** the `classifyCatalog` function in `cache/invalidate.ts` returns `'invalid'` when it sees a `version` it doesn't know about. v2 catalogs become invalid; users get one cold rebuild. This is the same path that's already exercised whenever the TS compiler version changes today.

**Migration path for code:** all reads/writes go through `cache/normalize.ts`, `cache/read.ts`, `cache/write.ts`. The shape change is mechanical; the streamed-write logic from Phase 2 of the perf plan stays unchanged because it serializes whatever the catalog object holds.

## 6. Per-rule fidelity matrix

Different adapters produce different-fidelity edges. This is intrinsic to the problem; a refactor cannot fix it. What the refactor *can* do is make the fidelity *observable* to rules so they degrade gracefully.

| Rule | TS adapter (today) | Tree-sitter adapter (Python/Rust/Go) | Notes |
|---|---|---|---|
| `orphan-subtree` | High — symbol resolution gives accurate transitive callee sets | Medium — name-based resolution; multiple functions named `process` may pick wrong target | Entry-point heuristics already work cross-language |
| `duplicated-function-body` | Medium — body hash is textual; lexical-scope FPs documented | Medium — same fidelity (body hashing is language-agnostic) | Adapter supplies normalized body text |
| `no-side-effect-path` | High — accurate edges + side-effect primitive list | Low — edge inaccuracy compounds; side-effect list is also language-specific | Each adapter declares its side-effect primitives |
| `test-only-reachable` | High — symbol resolution makes "callable from test only" precise | Low — same fidelity issue as no-side-effect-path | Adapter declares which files count as tests |
| `always-throws-branch` | Medium — textual heuristic on `CallEdge.text`, language-agnostic | Medium — same heuristic, different syntax. Adapter declares the throw shape per language | |

**Rules learn an opt-in `minConfidence` config field.** Default `'low'` (today's behavior; everything is included). Setting `'medium'` or `'high'` lets users tighten precision when running rules against name-only adapters.

This matrix is a pre-launch contract: each adapter PR includes a "this language's fidelity per rule" entry that updates this table.

## 7. Acceptance gates

Two non-negotiable gates apply to PRs 2 and 3:

1. **Byte-identical TypeScript catalog.** Before each PR is merged, run `node packages/cli/dist/index.js graph --no-cache` on opensip-tools self-graph, MD5 the resulting `catalog.json`, and verify it matches the baseline. If it doesn't, the refactor changed observable behavior; reject. (PR 3 regenerates the baseline once for the v3 shape change; PR 2 must match the v2 baseline exactly.)
2. **dep-cruiser is the contract enforcer.** After PR 3, attempting to add `import ts from 'typescript'` anywhere outside `lang-typescript/` must fail `pnpm lint`. CI runs `pnpm lint` on every PR. The architectural rule lives in `.dependency-cruiser.cjs`, not in human review.

PRs 5+ each include:
- Contract test suite passes against the new adapter.
- Per-rule fidelity entry added to the matrix in §6.
- Adapter ships with at least one fixture project that exercises file discovery, parsing, occurrence emission, and call resolution.
- README and CLI `--help` mention the new language.

## 8. Open questions

1. **Adapter packaging — first-party (`packages/graph/lang-python/`) or third-party (`@opensip-tools/graph-lang-python` published separately)?** PR 5 will decide. Argument for first-party: lower friction for users (`opensip-tools graph` works on Python out of the box). Argument for third-party: it's the same plugin model fitness already uses, lets users opt in. Defaulting to first-party for the first 1-2 languages, third-party once the contract has been proven by them.

2. **Should rules know about adapter capabilities?** A Python adapter might not produce JSX-element edges; the JSX-specific code in `polymorphic.ts` etc. is moot for it. The clean solution: each rule introspects edge resolution kinds it sees, doesn't assume any are present. Open question — current code has assumptions; PR 3 may need to weaken them.

3. **Tree-sitter dependency.** If most adapters use tree-sitter, should there be a shared `lang-tree-sitter-base` helper inside `@opensip-tools/graph` so each adapter doesn't reimplement query glue? Probably yes after PR 6. Premature before.

4. **Per-adapter cache files vs. one cache file.** Today there's one `catalog.json` per project. If a project ever contains both TypeScript and Python source, are they two separate catalogs or one merged? Current §2 non-goal says single-language per project — but worth re-checking after PR 5 ships.

5. **CLI command-tree exposure.** Does the user say `opensip-tools graph --language python` to disambiguate, or does the orchestrator auto-detect by file extensions found? Auto-detect is simpler when one language dominates a project; explicit flag is needed for mixed-language repos. Defer until after PR 5; the orchestrator initially picks the only registered adapter.

## 9. References

- [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md) — the contract surface (interface signatures, behavioral invariants).
- [`12-graph-language-pluggability-prs.md`](./12-graph-language-pluggability-prs.md) — file-by-file PR-2 and PR-3 sequencing.
- [`00-graph-performance-improvements.md`](./00-graph-performance-improvements.md) — the perf-plan history. Wave 4's `cache/invalidate.ts` and `walk.ts` are central to this refactor.
- [`docs/architecture/40-the-graph-loop/01-stages-and-catalog.md`](../architecture/40-the-graph-loop/01-stages-and-catalog.md) — current pipeline architecture; will need a follow-up edit after PR 3 to describe the adapter layer.
- [`docs/architecture/40-the-graph-loop/02-rules-and-gating.md`](../architecture/40-the-graph-loop/02-rules-and-gating.md) — rule contract; mostly unchanged but gains a `minConfidence` config knob.
