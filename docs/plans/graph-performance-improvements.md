---
status: proposed
last_verified: 2026-05-17
title: "graph Tool — performance improvements"
audience: [contributors]
purpose: "Sequenced plan for reducing graph's peak memory and wall-clock on monorepo-scale codebases (5000+ files). Driven by an OpenSIP run that OOM'd at Node's default 4 GB heap after ~17 min and completed under a 12 GB heap in ~25 min."
related-docs:
  - ./graph-tool-v2-design.md
  - ./graph-rule-enhancements.md
---

# graph Tool — performance improvements

A first-pass performance plan, grounded in one real-world run: graph against the OpenSIP monorepo (5476 source files, 61131 catalog functions, 6192 inferred entry points).

> **Why now.** With Node's default 4 GB heap, the run crashed with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` after ~17 minutes — the V8 stack showed the OOM happening inside `CreateObjectLiteral`/`InterpreterEntryTrampoline`, i.e. allocating descriptors for AST node literals during TypeScript program construction. A retry with `NODE_OPTIONS=--max-old-space-size=12288` completed in ~25 minutes with a peak resident of ~4.2 GB. The tool works on this codebase, but the run-time and the silent-OOM-then-investigate experience are both costs we can cut.

## 0. Goals & non-goals

**Goals**

- Peak memory ≤ 2 GB on the OpenSIP-scale (≈5500 files) workload, so the default Node heap is sufficient.
- Wall-clock ≤ 5 minutes for a cold run on the same workload.
- The first 1000-file run still emits useful progress logging within 30 s of start (today, stages run silently until completion).
- Zero loss of fidelity in the orphan-subtree and duplicated-function-body findings (they're the highest-signal rules on real codebases).

**Non-goals**

- Cross-language support beyond TypeScript (separate roadmap).
- Incremental-rebuild support beyond what stage-1 caching already does (separate plan).
- Distributed execution. Single-machine multi-core only.

## 1. Measured bottlenecks

### 1.1 Memory hotspots, in priority order

1. **TypeScript Program over the whole monorepo.** `ts.createProgram({ rootNames: files, options })` in `pipeline/inventory.ts:46` loads and parses every `.ts/.tsx` (3000+ files for OpenSIP). The subsequent `program.getTypeChecker()` forces full symbol binding. This is the dominant ~3 GB peak. The OOM stack confirms — V8 ran out of memory allocating AST node descriptors during program construction.

2. **`node.getText(sourceFile)` per function for hashing.** `inventory-helpers/hash-body.ts:40-42` does `node.getText()` → `stripComments(text)` → `normalizeWhitespace(s)` → `sha256(s)`. Four string allocations per function. Across ~61k functions, that's ~250 k transient string allocations.

3. **Two full AST walks.** Stage 1 (`buildInventory`) walks every file, then Stage 2 (`resolveEdges`) walks every file again from `edges.ts:62`. The catalog from Stage 1 stays live during Stage 2.

4. **`rebuildCatalog` doubles memory transiently.** `edges.ts:488` builds a fresh `functions` map by mapping every occurrence with new `calls` arrays. Old + new catalog both live until GC.

5. **`writeCatalog` materialises the catalog as one JSON string.** `cache/write.ts:22` calls `JSON.stringify(normalized, null, 2)` — for the OpenSIP catalog (~5500 files × multiple occurrences each), this is a ~50 MB single string allocation right before write.

6. **`normalizeCatalogForSerialization` copies every per-name occurrence array** for sorting (`cache/normalize.ts:24-27`). Multiplied across thousands of names.

### 1.2 CPU hotspots

1. **Sequential file processing.** Both stages process files one at a time on a single thread. During the 25-minute run, one core was pegged at 100 % while the other 7 were idle.

2. **Typechecker queried per call site.** Every property-access, new, JSX, and identifier reference invokes `typeChecker.getSymbolAtLocation(...)`. Tens of thousands of call sites × the checker's per-query work dominates Stage 2 wall-clock.

3. **SHA-256 + stripComments + whitespace-normalize per function.** Small cost individually; 61k × the chain adds up to seconds.

### 1.3 UX gap

When the run crashes with the heap-OOM signature, the user sees a 50-line V8 stack trace and no graph-side context. There's no early "your input has 5500 files; consider `--max-old-space-size=8192`" hint. No progress emission during the silent middle of Stage 1.

## 2. Phased plan

Phases are ordered by **payoff per unit of engineering effort**, not by what's most architecturally satisfying. Phase 0 is the smallest change that unblocks running on a default Node heap; phase 5 is structural and large.

### Phase 0 — UX hint + heap-size guidance (≤ 1 hour)

**Scope.** Emit a startup warning when `discoverFiles` returns > 1000 files, recommending `NODE_OPTIONS=--max-old-space-size=8192` (or higher). Document the threshold and rationale in the graph README.

**Files**
- `packages/graph/engine/src/cli/graph.ts` — startup check after `discoverFiles`.
- `packages/graph/engine/README.md` — heap-sizing section.

**Acceptance**
- A run on a 1500-file project emits a single `cli.warn(...)` line within 1 second of start, naming the file count and the suggested flag.
- Below the threshold, no warning.

**Why first.** Lands in an hour, immediately changes the failure mode of large-repo runs from "silent OOM at minute 17" to "actionable hint at minute 0".

---

### Phase 1 — Free the Program after Stage 2 (≤ 1 day)

**Scope.** The `RunGraphResult` returned by `runGraph` should not retain the `ts.Program`. Currently the program is held until function return via the inventory + edges variables. Once Stage 2 finishes, Stage 3+ (`buildIndexes`, rules) only need the `Catalog`. Drop the program reference so V8 can collect ~1–2 GB of bound AST before serialization runs.

**Files**
- `packages/graph/engine/src/cli/orchestrate.ts` — narrow `RunGraphResult` to `{ catalog, indexes, signals, resolutionStats, cacheHit }`; explicit `program = null` after edge resolution.
- `packages/graph/engine/src/pipeline/inventory.ts` — return the program separately so the orchestrator can drop it without changing the function's shape.

**Acceptance**
- Peak resident drops by ≥ 25 % on the OpenSIP workload (target: 4.2 GB → ≤ 3.2 GB).
- All existing graph engine tests pass unchanged.

**Risk.** Low — purely a memory-management change. The program reference isn't part of the public output.

---

### Phase 2 — Stream the catalog write (≤ 1 day)

**Scope.** Replace `cache/write.ts:22`'s `JSON.stringify(normalized, null, 2)` + `writeFileSync` with a streamed Writer that emits:
- Top-level metadata (version, builtAt, etc.) as one JSON object.
- The `functions` field as a streamed object: write `"functions": {`, then for each sorted name write `"<name>": [...]` line-by-line, then `}`.

**Files**
- `packages/graph/engine/src/cache/write.ts` — replace single-string serialisation with `fs.createWriteStream` + chunked emit.
- `packages/graph/engine/src/cache/normalize.ts` — convert to an iterator that yields `[name, occurrences]` pairs in sorted order, so the writer doesn't need the whole normalised catalog in memory at once.

**Acceptance**
- Cache write peak (RSS delta during write) drops to a constant (≤ 50 MB regardless of catalog size).
- Cache read still works against the new file shape — same byte-stable JSON, same `JSON.parse` round-trip.
- Catalog file is byte-identical (or only-whitespace-different) to today's output, so existing on-disk caches aren't invalidated.

**Risk.** Low. The on-disk format is unchanged; this is purely a serialisation refactor.

---

### Phase 3 — Drop `node.getText()` for hashing (≤ 0.5 day)

**Scope.** In `inventory-helpers/hash-body.ts:40`, replace `node.getText(sourceFile)` with `sourceFile.text.slice(node.getStart(sf), node.getEnd())`. `sourceFile.text` is a single string the program already holds; `slice` returns a substring of it (V8 implements substring sharing) instead of walking the AST to materialise text.

**Files**
- `packages/graph/engine/src/pipeline/inventory-helpers/hash-body.ts` — `digestFunctionBody` body change.
- Same package's tests confirm hashes are unchanged (the input to `stripComments` is the same string content).

**Acceptance**
- `pnpm --filter @opensip-tools/graph test` passes (hash regressions caught by `__tests__/hash-body.test.ts`).
- Stage 1 wall-clock drops measurably on a 1000+ file workload (target: ≥ 10 % reduction).

**Risk.** Low. The string content is identical; only the allocation path changes.

---

### Phase 4 — Combine Stage 1 + Stage 2 into one AST walk per file (3–5 days)

**Scope.** Today, every source file is walked twice — once for inventory, once for edges. Unify into a single walk per file that collects:
- Function occurrences (today's Stage 1 output).
- Per-occurrence call-site `(node, ownerHash)` pairs (today's Stage 2 traversal). Resolution still happens after — the walk only records *what to resolve*.

After all files are walked once, do a single pass over the collected call-site records and dispatch resolvers. This pass doesn't walk the AST — it iterates a flat list of pre-located nodes.

**Files**
- New `packages/graph/engine/src/pipeline/walk.ts` — the unified single-walk-per-file pass.
- `packages/graph/engine/src/pipeline/inventory.ts` — narrowed to "build catalog from collected occurrences" (no walk).
- `packages/graph/engine/src/pipeline/edges.ts` — narrowed to "resolve pre-collected call sites" (no walk).
- `packages/graph/engine/src/cli/orchestrate.ts` — wire the new shape.

**Acceptance**
- Wall-clock drops by ≥ 30 % on the OpenSIP workload (target: 25 min → ≤ 17 min, before any parallelism).
- Catalog output is byte-identical to the pre-refactor output (golden-file test against an existing cache).
- All existing engine tests pass.

**Risk.** Medium. Touches the boundary between the two heaviest stages. The acceptance gate (byte-identical catalog) is the safety net.

---

### Phase 5 — Lazy typechecker init (≤ 1 day)

**Scope.** Stage 1 doesn't need `getTypeChecker()`. Today, `inventory.ts:53` forces it eagerly to populate parent pointers — but parent pointers are populated by AST construction in the program, not by the checker; the eager call is paranoia. Defer the call to the first resolver in Stage 2 that actually needs it.

**Files**
- `packages/graph/engine/src/pipeline/inventory.ts` — drop the eager `program.getTypeChecker()` call. Add a unit test that confirms parent pointers are present without the call.
- `packages/graph/engine/src/pipeline/edges.ts` — call `program.getTypeChecker()` once at the top of `resolveEdges` (already does this via `const checker = input.program.getTypeChecker()`).

**Acceptance**
- Stage 1 wall-clock drops by 20–40 % (checker init is most of Stage 1's tail cost today).
- A `pipeline/__tests__/inventory.test.ts` assertion confirms `sf.statements[0].parent === sf` after `buildInventory`.

**Risk.** Low–medium. If parent pointers turn out to need the checker for some constructs (decorators in some compiler-options combos?), revert and document. The assertion in the test pins the contract.

---

### Phase 6 — Per-workspace-package mode (3–5 days)

**Scope.** Add a `--package <name>` (or `--scope <glob>`) flag that runs graph against a single workspace package's tsconfig. Cross-package call sites resolve as `unknown` (lower fidelity, much faster). For monorepos with many small packages, this turns "1 × 25-minute run" into "1 × 30-second run per package," parallelizable trivially via xargs / GNU parallel.

**Files**
- New `packages/graph/engine/src/cli/scope.ts` — resolves `--package`/`--scope` against `pnpm-workspace.yaml` / `package.json` workspaces / npm workspaces.
- `packages/graph/engine/src/cli/graph.ts` — wire the flag into `discoverFiles`.
- `packages/graph/engine/README.md` — document the trade-off.

**Acceptance**
- A run with `--package @opensip/pipeline` completes in ≤ 60 s on the OpenSIP repo.
- Unresolved call sites that cross package boundaries are tagged `resolution: 'cross-package-unresolved'` (new variant) so consumers can see them.

**Risk.** Low. Strictly additive — existing global runs unchanged.

---

### Phase 7 — Parallelize Stage 1 via `worker_threads` (1–2 weeks)

**Scope.** Partition source files across N workers (N = `os.cpus().length - 1`). Each worker creates an isolated Program over its slice and emits a partial catalog. The main thread merges. Cross-file edges within a partition resolve normally; cross-partition edges are resolved in a second main-thread pass that consults the merged catalog (no full Program needed for that lookup).

**Files**
- New `packages/graph/engine/src/pipeline/parallel.ts` — the orchestrator.
- New `packages/graph/engine/src/pipeline/worker-entry.ts` — the worker body.
- `packages/graph/engine/src/cli/orchestrate.ts` — gate behind `--parallel` (or auto-enable when `files.length > 1000`).

**Acceptance**
- Wall-clock on the OpenSIP workload drops by ≥ 4× on an 8-core machine (target: post-Phase 4 17 min → ≤ 5 min on 8 cores).
- Catalog output is byte-identical to the single-threaded run (modulo non-deterministic Map iteration, which `normalizeCatalogForSerialization` already sorts away).
- Per-worker peak heap stays under 1.5 GB so the global Node heap (worker pool + main thread) fits in 8 GB.

**Risk.** Medium-high. Worker-thread boundaries are an error-prone surface (serialisation overhead, error propagation, GC tuning per worker). The byte-identical-catalog acceptance gate is the safety net.

---

## 3. Sequencing & deliverables

**Wave 1 — eliminate the silent OOM (≤ 2 days total)**
- Phase 0 (UX hint).
- Phase 1 (free the program).
- Phase 2 (stream the write).
- Phase 3 (slice-not-getText).

Expected after Wave 1: OpenSIP-scale runs fit in 2 GB heap; no silent OOM.

**Wave 2 — cut wall-clock (≤ 1 week total)**
- Phase 4 (single AST walk).
- Phase 5 (lazy checker init).

Expected after Wave 2: OpenSIP wall-clock from 25 min → ≤ 15 min single-threaded.

**Wave 3 — give users an "I just want my package" escape hatch (≤ 1 week)**
- Phase 6 (per-workspace mode).

Expected: per-package runs in seconds, suitable for pre-commit hooks and per-package CI.

**Wave 4 — multi-core for the global run (1–2 weeks)**
- Phase 7 (parallel workers).

Expected: OpenSIP-scale global run in ≤ 5 min on an 8-core dev box.

## 4. Open questions

1. **Does `getTypeChecker()` in Stage 1 actually do something Stage 1 needs?** Phase 5's risk hinges on this. Worth a 1-hour investigation before committing to that phase — write a unit test that asserts parent pointers and a few sample symbol lookups still work when the eager call is removed.

2. **Should the cache file format change in Phase 2, or stay byte-identical?** The streamed write can produce identical JSON output (just chunked); preserving that lets existing on-disk caches stay valid. Worth keeping unless there's a separate reason to bump the version.

3. **Is per-worker isolation enough in Phase 7?** Workers will each load TypeScript fresh — that's ~50 MB of TypeScript itself × N workers. May want to share the TypeScript module via `worker_threads` SharedArrayBuffer transfer, or accept the duplication.

4. **What's the target for incremental runs?** Today Stage 1's cache invalidation is at file-list granularity (any file changes → full rebuild). A finer-grained invalidation (per-file occurrences cached, only changed files re-walked) is a separate plan worth scoping after Wave 2 ships.

## 5. References

- Pipeline architecture: [`graph-tool-v2-design.md`](./graph-tool-v2-design.md).
- Rule semantics: [`graph-rule-enhancements.md`](./graph-rule-enhancements.md).
- OpenSIP measurement run: 5476 files, 61131 functions, 6192 entry points, 121 findings; OOM at 4 GB heap after ~17 min; ~25 min with 12 GB heap, peak resident ~4.2 GB.
