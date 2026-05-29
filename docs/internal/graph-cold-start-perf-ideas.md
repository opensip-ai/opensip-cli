# Graph: cold first-run performance ideas

**Status:** brainstorm / pre-decision. Nothing here is committed.
**Scope:** the *first* run of `opensip-tools graph` on a large repo, where
no cache exists. Warm and incremental runs are already fast — the cache
verdict path skips parse/walk/resolve wholesale and incremental rebuilds
re-walk only the closure of changed files.
**Goal:** identify experiments that could cut cold-run wall time on a
2k+ file monorepo, prioritised by effort vs likely payoff.

This is a "what could we try" doc. Each section names the bottleneck,
the proposed change, where the change would land in the codebase, and
the trade-off (correctness, complexity, memory).

---

## 1. Where the time actually goes (cold run)

From reading the pipeline end-to-end and the orchestrator wiring at
`packages/graph/engine/src/cli/orchestrate.ts:135–201`, a cold run is
**six serial stages on the main thread**:

| Stage      | Code                                            | Cold cost                  | Notes |
|------------|-------------------------------------------------|----------------------------|-------|
| discover   | `graph-typescript/src/discover.ts:36`           | ~ms                        | one tsconfig parse + glob |
| **parse**  | `graph-typescript/src/parse.ts:39–46`           | **seconds, dominant**      | one `ts.createProgram()` + eager `getTypeChecker()` |
| **walk**   | `graph-typescript/src/walk.ts:109`              | **seconds**                | one descent per SourceFile, single-threaded |
| **resolve**| `graph-typescript/src/edges.ts:95–142`          | seconds (proportional to call sites) | per-site `getSymbolAtLocation` |
| index      | `pipeline/indexes.ts:21`                        | ~ms                        | pure memory, O(functions·edges) |
| rules      | `orchestrate.ts:177–188`                        | ~ms                        | small ruleset, serial |

Two structural facts about that picture:

1. **Everything is sequential and on the main thread.** No worker
   threads, no piscina, no `Promise.all` fan-out inside a stage. The
   only parallelism in the entire graph tool is *across* workspace
   units in `--workspace` mode (`cli/workspace-runner.ts:107–161`),
   which spawns one child process per unit. A single-tsconfig project
   gets zero parallelism.
2. **Parse + eager type-check is the dominant cost.** `ts.createProgram`
   builds one unified `Program` covering every file in the project,
   then `program.getTypeChecker()` at `parse.ts:46` forces the binder
   (parent pointers + symbol tables) up front. The binder runs over
   the whole program before stage 2 even starts. For 2k+ files this is
   easily several seconds and grows with project size.

The synthetic-partition fallback at `cli/orchestrate/flat-monorepo-strategy.ts`
exists precisely because of (2) — for a flat monorepo of >2500 files,
the single-process Program won't even fit in 12 GB of heap. But for
*workspace* monorepos under that threshold, the single-process path is
still where most users live.

So the question is: how do we make the single-process cold path
materially faster, without sacrificing the edge-resolution fidelity the
type checker gives us?

---

## 2. Quick wins (low risk, days of work)

### 2.1 Fingerprint files in parallel, not in a single sync loop

`computeFilesFingerprint` at `cache/invalidate.ts:105–116` walks every
file with `statSync` in a tight loop. On 5k files this is ~10–50ms but
also blocks the event loop. It runs on **every** invocation, even
cache-hit ones (the orchestrator needs the current fingerprint to
compare).

**Change:** swap `statSync` for an `await Promise.all(files.map(fs.promises.stat))`
fan-out, or hand it off to a tiny worker. The OS still serialises real
disk work, but async stat batches better and stops blocking the event
loop while V8 is GC'ing the previous stage's AST.

**Caveat:** the [nodejs/node#38006](https://github.com/nodejs/node/issues/38006)
discussion notes the low-level async stat is itself ~2× slower per
call than sync; the win comes from concurrency, not per-call cost. Worth
measuring before assuming a win.

**Impact:** modest on its own (~10s of ms saved) but it's a precondition
for any other "do things while the parser runs" change.

### 2.2 Skip the eager `getTypeChecker()` when we know we won't resolve

`parse.ts:46` forces the binder unconditionally. The comment says it's
needed for parent pointers + symbol tables before either inventory
visitors or resolvers run. But:

- Inventory visitors (`walk.ts`) only need parent pointers, which the
  parser itself populates lazily on `getStart()` / `forEachChild()`.
  They don't need the symbol table.
- The symbol table is only needed by resolvers in
  `edge-resolvers/{direct-call,property-access,polymorphic,…}.ts`.

**Change:** push the `getTypeChecker()` call down into the resolve
stage, after the walk has finished. The walk gets to run as soon as
parsing completes; the binder runs concurrently with… well, with
nothing right now, but see §3.1.

**Risk:** subtle. Some inventory visitors might rely on `parent`
pointers that the binder populates. Needs a careful audit of the
visitors plus a regression test against the existing catalog snapshot.

**Impact:** this alone is probably zero, because the walk needs the
binder for symbol lookups in `resolveCallSites`. But it unblocks
overlapping walk + bind, which is §3.1.

### 2.3 Make the per-file walk multi-threaded via worker_threads

`walk.ts:119–135` iterates source files in a single `for` loop. For
each file `walkFile` does pure AST traversal — no shared mutable state
beyond a per-call `functions`/`callSites`/`dependencySites` buffer.

**Change:** shard `program.getSourceFiles()` across N worker threads,
each with its own buffer; merge buffers in the parent. Tree-sitter has
shown this pattern works well; the TS compiler's `SourceFile` objects
are *not* trivially transferable across worker boundaries, though,
because they carry references into the shared `Program`.

**Caveat — this is the gotcha:** `ts.SourceFile` shares state with
`Program` (the type checker, symbol map). You cannot just
`postMessage` a SourceFile to a worker. Two options:

- **a)** Workers re-parse their shard from raw text in a per-worker
  Program. That throws away cross-file type-checker benefits — the
  resolver pass would lose accuracy. Probably not worth it.
- **b)** Walk in workers using **tree-sitter** (already a transitive
  dep via the rust/python adapters) for the *inventory* pass only,
  then do the resolver pass single-threaded in the main thread's
  Program. Inventory ≈ "find function shapes + their bodyHash". That's
  not type-dependent — tree-sitter is fine for it.

**Impact:** for 2k files on an 8-core machine, the walk stage is
probably 3–5× faster if (b) works out. It's also a significant
re-architecture; track this in a plan, not a side task.

### 2.4 Lazy-load source text instead of forcing every file into the Program

`ts.createProgram` at `parse.ts:39` is handed `rootNames: [...input.files]`
— every discovered file becomes a Program root. The Program then reads
+ tokenises + parses each file before `getTypeChecker()` can run.

For a 2k-file project this is unavoidable if we want correct
cross-file resolution. But two optimisations apply:

- **Strip `.d.ts` rolling.** `discoverFiles` at `discover.ts:131–153`
  already filters `.d.ts` from its output, but `ts.createProgram` will
  re-discover declaration files via implicit transitive imports
  (`@types/*`, `node_modules` ambient types). Those count toward the
  parse budget. Setting `skipLibCheck: true` in `compilerOptions` for
  the graph Program (we're not type-checking, we're symbol-resolving)
  is cheap and broadly safe.
- **Disable JSDoc parsing.** `noErrorTruncation: true` and
  `disableSourceOfProjectReferenceRedirect: true` aren't options that
  speed parse, but `ts.createProgram`'s default JSDoc parsing can be
  side-stepped if we explicitly construct `SourceFile`s via
  `ts.createSourceFile(name, text, target, /*setParentNodes*/ true)`.
  Not a huge win in TS, but it's free.

**Impact:** maybe 5–15% off the parse stage. Cheap to try.

---

## 3. Bigger swings (weeks of work, higher payoff)

### 3.1 Overlap parse → walk → resolve with a pipelined Program

Today the pipeline is strict: parse must finish for all files, then
walk runs across all files, then resolve runs across all call sites.
But the TS Program *internally* can answer questions about a file as
soon as that file is parsed; the binder only needs all files before
*cross-file* symbol resolution.

**Change:** treat parse/walk as a producer-consumer pipeline. Stand up
two pools:

```
Parser pool ──► SourceFile queue ──► Walker pool ──► CallSite queue ──► Resolver pool
```

The parser pool tokenises + parses each file independently (TS exposes
`createSourceFile`). Walker workers consume parsed files as they
arrive and emit occurrences + flat call-site records. The resolver
pool waits for *all* walks to finish (cross-file symbol lookup needs
the full Program), but resolution can then happen in parallel because
resolvers only read from the shared TypeChecker.

**Where this changes the code:**
- `catalog-builder.ts:54–106` (the `buildAndResolveCatalog` function)
  becomes the orchestrator of the three pools.
- `parse.ts` exposes a lower-level "parse-file" API alongside the
  current whole-project one.
- `walk.ts:109` already accepts a `WalkInput` that includes the
  Program and a file list — it could be sharded as-is.

**Caveat:** the type checker is **not thread-safe**. Resolver workers
would each need their own Program (expensive) or we accept main-thread
serial resolution and gain only on parse+walk. The latter is probably
the right v1 — see §3.3 for why type-checker contention dominates.

**Impact (estimate):** parse stage drops by ~Ncores× (modulo binder
serial cost); walk drops by ~Ncores×; resolve unchanged. On an 8-core
CI runner with 2k files, total wall time could halve.

### 3.2 Persist the parse cache across runs

The Program is rebuilt from scratch on every `runGraph()` invocation.
There's *no* parse-result cache anywhere in `packages/graph/engine/src/cache/`
— the only cache is the final catalog (`persistence/catalog-repo.ts`).

For the first run, this is unavoidable. But:

- **Subsequent first-runs after `--no-cache`** redo all parsing.
- **Cache-invalidating changes** (tsconfig touched, TS upgraded —
  `cacheKey` mismatch at `invalidate.ts:59`) throw away the whole
  catalog and re-parse from scratch even when 99% of files are
  unchanged.

The TS compiler ships a `createIncrementalProgram` API
(`ts.createIncrementalProgram`) that persists per-file
`.tsbuildinfo`-style data. The community has built around it for years
(`fork-ts-checker-webpack-plugin`, `tsserver`'s on-disk index).

**Change:** when we *do* invalidate the catalog, fall back to
`createIncrementalProgram` if a `.tsbuildinfo` already exists in the
project. The Program reuses parsed files for any unchanged file. The
walk and resolve stages still need to run on changed files, but the
parse budget collapses.

**Where:** `parse.ts:39`, plus a new `parse-cache.ts` peer to
`invalidate.ts` to manage the buildinfo file lifecycle.

**Risk:** `tsbuildinfo` is tied to a specific `compilerOptions`. We'd
need to gate fallback on a hash match. Also adds a file the user has
to gitignore — not a deal-breaker but worth a thought.

**Impact:** for the "I bumped a workspace dep and now my cache is
invalid" scenario, this can take a re-parse from ~20s to ~2s.

### 3.3 Type-checker queries are the second-biggest cost — batch them

`resolveEdgesFromRecords` at `edges.ts:95–142` is a tight loop calling
`computeVerdict` per call site. Inside, resolvers call
`checker.getSymbolAtLocation`, `checker.getTypeAtLocation`, etc. Each
call walks the TS symbol graph; for 50k call sites this is a
substantial chunk of resolve time.

The TS compiler caches symbol lookups internally per `Program`, so
repeated lookups for the same `Node` are fast. But:

- Lookups for *different* nodes that share a parent chain still
  re-walk that chain.
- The resolver dispatcher at `edges.ts:103–127` doesn't *order* call
  sites by file or scope, so the type checker's internal caches can
  thrash across files.

**Change:** sort `callSites` by `sourceFile` (and within a file by
position) before resolving. Locality of reference improves; TS's
internal caches stay warm for each file.

**Where:** `catalog-builder.ts:90` (pass a sorted list to
`adapter.resolveCallSites`).

**Risk:** none beyond making sure the order doesn't matter for edge
output (it shouldn't — edges are keyed by `bodyHash`, not insertion
order). Easy to verify with a snapshot test.

**Impact:** likely 10–20% on the resolve stage. Cheap to try; no
architectural change.

### 3.4 Hash bodies once during parsing, not in the walk

`walk.ts` computes a `bodyHash` for every function-shape during the
descent (it's how `CallSiteRecord.ownerHash` is populated). The hash
is content-addressed over the function body's source text. For
unchanged files between two runs the body text is identical, but we
re-hash on every run.

**Change:** memoise body hashes by `(filePath, bodyStart, bodyEnd,
fileMtime)` across runs. On a cache-invalidating run, files whose
mtime hasn't changed reuse last run's hashes. This wouldn't help a
true *first* run, but it would compound with §3.2.

**Where:** new module in `cache/` adjacent to `invalidate.ts`.

**Impact:** modest on its own; meaningful when stacked with §3.2.

---

## 4. The frame change: do we even need `ts.createProgram`?

Worth saying out loud, because it's the elephant. The TS compiler
gives us *semantic* edge resolution — when one function calls another
via method dispatch, we follow the type. But the resolver fidelity is
already imperfect: the `polymorphic.ts` and `catalog-fallback.ts`
resolvers explicitly trade off accuracy for "this is good enough."

Alternative architectures, ordered by how disruptive they'd be:

### 4a. Tree-sitter for inventory, TS compiler only for resolve

Tree-sitter (already in the rust/python adapters) parses TS in a few
hundred ms for a 2k-file project — orders of magnitude faster than
`ts.createProgram`. It gives us a CST, not a fully type-aware AST, so:

- **Inventory** (find functions, classes, methods, arrows; hash
  bodies; pick out call expressions): trivially done with tree-sitter.
- **Resolution** (which symbol does this `foo()` actually refer to?):
  needs symbols. We could still run `ts.createProgram` *only* for the
  resolve stage and feed it the file list, but skip the walk that the
  TS Program currently drives.

This is essentially what
[`graphify.net`](https://graphify.net/tree-sitter-ast-extraction.html)
and the ACER paper describe: hybrid tree-sitter + LSP-style type
resolution. Several modern code-intel tools (Sourcegraph SCIP,
[Codebase-Memory](https://arxiv.org/html/2603.27277v1)) ship in this
shape.

The catch is the same as §2.3(b): managing two parsers — keeping
their notion of "function-shape" in sync across the inventory/resolver
boundary — is a real engineering cost. Probably worth a focused spike
before committing.

### 4b. Drop the TS compiler entirely; use oxc/swc for parsing

[Oxc](https://github.com/oxc-project/oxc) is a Rust JS/TS parser; its
parser benchmarks at ~2× swc and ~3× Biome (which is itself faster
than tsc). It even has a separate "semantic analyzer" layer for symbol
binding, exposed as a callable library.

But oxc's semantic layer doesn't (yet) give us TS *type-level* lookup
— it does scope binding, not type inference. For our resolver pass
that's the difference between "this identifier refers to symbol X" (we
get) and "this method call dispatches to function Y because the
receiver type is Z" (we don't). The `polymorphic.ts` and
`property-access.ts` resolvers depend on the latter.

Practically: oxc could replace the parse + walk stages and leave the
TS compiler only for the resolve stage; or we accept reduced fidelity
in exchange for ~10× cold-start speed. The first is two parsers; the
second is a product call.

### 4c. Wait for TypeScript 6.0's Go port

The TypeScript team's Go port lands at ~10× faster compile and bind
([architecture-weekly.com](https://www.architecture-weekly.com/p/typescript-migrates-to-go-whats-really)).
If our parse stage is dominated by the TS compiler's binder, and the
binder gets 10× faster "for free" when we upgrade, that's the easiest
possible win. Risk: timing — and we don't get the speedup until the
Go-native API is exposed through a Node binding suitable for use as
a library, not just a CLI. May land in the TS 6.x line; may be later.

This isn't an *action* so much as a thing to track. But it changes
the cost-benefit math on §3.1 and §4a/b: if a 10× win is coming in
six months for free, an architectural rewrite for 3–5× now is
arguably wasted effort.

---

## 5. What I'd actually try first

If we wanted to make progress this quarter without rewriting the
pipeline, in priority order:

1. **§3.3 (sort call sites for locality)** — a few hours of work, no
   risk, free 10–20% off resolve. No-brainer.
2. **§2.4 (`skipLibCheck`, lighter compiler options)** — a few hours,
   bounded risk, likely 5–15% off parse.
3. **§2.1 (parallel stat for fingerprint)** — a day, eliminates a
   blocking sync loop. Compounds with anything else we add.
4. **Profile.** Wrap each stage in `performance.mark/measure`, dump
   to JSON via the existing `runStage` hook in `orchestrate.ts:104–127`.
   We're guessing at proportions; a real flame graph on a 2k-file
   repo would tell us whether parse or walk dominates *for our
   visitor table specifically*, which would change which §3 swing to
   prioritise.
5. **§3.1 (parse/walk pipelining via worker_threads)** — a plan-level
   change, weeks of work. Only commit after profiling shows it's
   worth it.

§4 (tree-sitter, oxc, TS 6.0 Go) is a strategic conversation, not a
sprint. Worth tracking but not worth jumping at.

---

## 6. Open questions

- Do we have any real profiling data on cold-run wall time vs file
  count? The synthetic-partition threshold (2500) suggests we
  empirically hit a heap wall but doesn't tell us about CPU.
- The `--workspace` path already gives us per-unit parallelism via
  child processes. For users with workspace layouts, is cold-run
  speed even a felt pain? The complaint might be specifically about
  flat-large or single-tsconfig repos.
- Is the eager `getTypeChecker()` at `parse.ts:46` actually load-bearing
  for the walk, or is it a defensive precaution from an earlier
  iteration? Worth a code-archaeology dive before §2.2.

---

## Sources / external references

- [TypeScript Performance · microsoft/TypeScript Wiki](https://github.com/microsoft/TypeScript/wiki/Performance)
- [TypeScript 6.0 / Go port — 10× build perf](https://www.architecture-weekly.com/p/typescript-migrates-to-go-whats-really)
- [Oxc parser benchmarks](https://github.com/oxc-project/oxc)
- [Benchmark TypeScript Parsers](https://medium.com/@hchan_nvim/benchmark-typescript-parsers-demystify-rust-tooling-performance-025ebfd391a3)
- [tree-sitter-graph: building call graphs from CSTs](https://github.com/tree-sitter/tree-sitter-graph/)
- [Hybrid tree-sitter + LSP for call-graph accuracy (Graphify)](https://graphify.net/tree-sitter-ast-extraction.html)
- [Codebase-Memory: tree-sitter knowledge graphs for code](https://arxiv.org/html/2603.27277v1)
- [nodejs/node#38006 — fs.statSync vs fs.promises.stat perf](https://github.com/nodejs/node/issues/38006)
- [parallel-typescript spike](https://github.com/timocov/parallel-typescript)
