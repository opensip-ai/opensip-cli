---
status: current
last_verified: 2026-05-17
title: "Stages and catalog (graph)"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "How `graph` builds its picture of the codebase — the six-stage pipeline, the catalog format, and the content-keyed cache."
source-files:
  - packages/graph/engine/src/tool.ts
  - packages/graph/engine/src/pipeline/discover.ts
  - packages/graph/engine/src/pipeline/walk.ts
  - packages/graph/engine/src/pipeline/inventory.ts
  - packages/graph/engine/src/pipeline/edges.ts
  - packages/graph/engine/src/pipeline/indexes.ts
  - packages/graph/engine/src/cache/read.ts
  - packages/graph/engine/src/cache/write.ts
  - packages/graph/engine/src/cache/invalidate.ts
  - packages/graph/engine/src/cli/orchestrate.ts
  - packages/graph/engine/src/cli/scope.ts
  - packages/graph/engine/src/cli/packages-runner.ts
  - packages/graph/engine/src/types.ts
related-docs:
  - ./02-rules-and-gating.md
  - ../10-mental-model/02-tool-plugin-model.md
  - ../60-subsystems/01-language-adapters.md
  - ../../plans/graph-performance-improvements.md
---
# Stages and catalog (graph)

The `graph` command is the static call-graph tool. Where `fit` answers "is the codebase clean?" with a regex-and-AST pass over each file in isolation, and `sim` answers "does it behave correctly under stress?" with a runtime simulation, `graph` answers a different shape of question: **"what is reachable from where?"** Orphans, side-effect chains, duplicated bodies, test-only reachable code — all are questions about the *shape* of the call graph, not the contents of any single file.

> **Naming.** The CLI command, package (`@opensip-tools/graph`), source directory (`packages/graph/`), and catalog cache (`opensip-tools/.runtime/cache/graph/`) are all named `graph` because the engine builds the project's call graph. The dashboard surfaces this data under a tab called **Code Paths** — the user-facing word for the questions you can ask of that graph. Marketing copy, the website, and end-user docs say "Code Paths"; CLI-facing developer docs and code identifiers say "graph". Each layer uses the word that fits its audience: `graph` is precise and short for typing, "Code Paths" describes what the user is doing when they look at it.

> **What you'll understand after this:**
> - The six-stage pipeline graph uses to build its picture of the codebase.
> - Why inventory finishes before edges start, and why edges reference catalog entries by hash.
> - The catalog file format on disk and how cache invalidation works.
> - How entry points are inferred and why they're a separate concern from the rules that consume them.

---

## The six-stage pipeline

```
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 0  —  DISCOVER FILES                                          │
│  Walk tsconfig include/exclude. Output: AbsolutePath[]               │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 1+2 — UNIFIED WALK                                            │
│  Per file: one AST descent that emits FunctionOccurrence records     │
│  AND pre-located call-site records. Resolvers dispatch over the      │
│  flat call-site list (no second walk). See pipeline/walk.ts.         │
│  Output: Catalog (functions + resolved CallEdges)                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 3  —  INDEX BUILD                                             │
│  Linear scan over Catalog. Build inverted indexes.                   │
│  Output: Indexes (in-memory, not persisted)                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 4  —  RULES                                                   │
│  Each rule: (Catalog, Indexes, Config) → Signal[]                    │
│  Output: Signal[]                                                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 5  —  RENDER                                                  │
│  Signal[] → terminal report | JSON | SARIF | dashboard               │
│  Output: stdout, files, exit code                                    │
└──────────────────────────────────────────────────────────────────────┘
```

Each stage is one module in [`packages/graph/engine/src/pipeline/`](../../../packages/graph/engine/src/pipeline/) (stages 0–3) or [`packages/graph/engine/src/rules/`](../../../packages/graph/engine/src/rules/) and [`packages/graph/engine/src/render/`](../../../packages/graph/engine/src/render/) (stages 4–5). Stages communicate only through their typed outputs; a stage cannot import a sibling stage, cannot reach back to read its predecessor's intermediate state, cannot peek into the next stage's expectations. This isolation is the single most important property of the design — every other guarantee derives from it.

> **History — Stage 1 + Stage 2 fused (Phase 4, 2026-05-17).** Originally these were two separate AST walks per file: Stage 1 emitted function occurrences; Stage 2 walked the same AST a second time to find and resolve call sites. The two walks descended in identical order and the only data flowing between them was each function-shape's bodyHash — which Stage 1 already computed. Phase 4 of [`docs/plans/graph-performance-improvements.md`](../../plans/graph-performance-improvements.md) fused the two passes into [`pipeline/walk.ts`](../../../packages/graph/engine/src/pipeline/walk.ts). Legacy `buildInventory` and `resolveEdges` entry points are retained for tests and external callers; they share the dispatch helpers from `walk.ts`. The orchestrator calls `walkProgram` once and feeds the resulting call-site records to `resolveEdgesFromRecords`.

### Stage 0 — Discover

[`pipeline/discover.ts`](../../../packages/graph/engine/src/pipeline/discover.ts) resolves the project's `tsconfig.json`, applies its `include` / `exclude` patterns, and produces a sorted, deduplicated list of absolute file paths. No TypeScript `Program` is created here — that's stage 1's job. Stage 0 is purely about *what files exist*.

Output: `{ projectDirAbs, tsConfigPathAbs, files, compilerOptions }`. Typical runtime on this repo: ~50ms.

### Stage 1+2 — Unified walk

[`pipeline/walk.ts`](../../../packages/graph/engine/src/pipeline/walk.ts) parses every file from stage 0, walks each AST exactly once, and emits both:
- A **Catalog** — a flat, indexed list of every callable thing in the project. "Callable thing" is broader than function: function declarations, arrow functions, methods, constructors, getter/setter pairs, function expressions, and one synthetic `<module-init>` entry per file that owns its top-level statements.
- A list of **CallSiteRecord**s — pre-located nodes that Stage 2's resolvers will dispatch over (call/new/jsx/identifier-in-value-position/shorthand assignment). Each record carries the `bodyHash` of the enclosing function-shape, computed by the same visitor pass, so the resolver dispatcher doesn't need to re-walk the AST or re-hash to find ownership.

The orchestrator then runs `resolveEdgesFromRecords` from [`pipeline/edges.ts`](../../../packages/graph/engine/src/pipeline/edges.ts) over the flat record list. Resolvers dispatch by node shape — direct call, property access, JSX, new expression, polymorphic dispatch, value reference, shorthand — and write a `CallEdge` to the matching `FunctionOccurrence`'s `calls` array.

Each entry is a `FunctionOccurrence`:

```ts
interface FunctionOccurrence {
  readonly bodyHash: string;          // sha256 of normalized body (whitespace/comments stripped)
  readonly bodySize?: number;         // length of the normalized body in chars; used by dup-body threshold
  readonly simpleName: string;        // 'analyze', or '<arrow:src/foo.ts:42:8>' for anonymous
  readonly qualifiedName: string;     // 'fitness/engine/src/gate.saveBaseline'
  readonly filePath: string;          // relative to projectDirAbs
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly kind: FunctionKind;        // 'function-declaration' | 'arrow' | 'method' | 'constructor' | …
  readonly params: readonly Param[];
  readonly returnType: string | null; // best-effort TS type text; null if not resolvable
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: 'exported' | 'module-local' | 'private';
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly calls: readonly CallEdge[]; // populated by Stage 2 resolvers
}
```

The visitor logic lives in [`pipeline/inventory-visitors/`](../../../packages/graph/engine/src/pipeline/inventory-visitors/) — one file per node kind. The helpers that compute body hashes, synthesize names for anonymous functions, classify visibility, and extract decorators live alongside in [`pipeline/inventory-helpers/`](../../../packages/graph/engine/src/pipeline/inventory-helpers/). The shared dispatch table (`dispatchVisitor`, `isInlineCallable`) lives in [`pipeline/walk.ts`](../../../packages/graph/engine/src/pipeline/walk.ts) so Stage 1's legacy `buildInventory` and the unified walk share the same node-shape detection.

**Why inventory finishes building before resolvers run.** Resolvers look up callees by name and bodyHash in the catalog. The unified walk emits all occurrences first, then the orchestrator builds the initial catalog, then `resolveEdgesFromRecords` dispatches over the call-site list. By the time any resolver runs, the catalog is frozen and complete, so every callee resolution is either "found in catalog" or "unresolved" — never "not yet in catalog."

Each edge:

```ts
interface CallEdge {
  readonly to: readonly string[];     // bodyHashes of resolved targets
  readonly line: number;
  readonly column: number;
  readonly resolution: 'static' | 'method-dispatch' | 'jsx' | 'constructor' | 'unknown' | 'dynamic-string';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly text: string;              // verbatim call expression for debugging
  readonly discarded?: boolean;       // true if call appears as ExpressionStatement (return ignored)
}
```

`to` is always an array. A static call resolves to one element. Method-dispatch (`config.method()` where `method` is an interface member with multiple implementations) resolves to many. An unresolved call (`fs.writeFileSync(...)`) resolves to zero.

Resolver logic is split into one file per call shape in [`pipeline/edge-resolvers/`](../../../packages/graph/engine/src/pipeline/edge-resolvers/): direct calls, property-access calls, JSX elements, `new` expressions, polymorphic dispatch, and a catalog-fallback resolver that handles the long tail.

A single TypeScript `Program` is created in the orchestrator and shared across the unified walk and the resolver pass; `getTypeChecker()` is forced eagerly so parent pointers are populated before visitors walk parent chains. Total runtime on opensip-tools self-graph (~7,600 functions across ~700 files) is ~15 s for a cold full rebuild; subsequent runs hit the incremental path described under "Cache invalidation" below.

### Stage 3 — Index build

[`pipeline/indexes.ts`](../../../packages/graph/engine/src/pipeline/indexes.ts) performs a linear scan over the now-complete catalog and builds inverted indexes that rules need:

- `byBodyHash`: bodyHash → occurrence (single-entry lookup for the canonical occurrence)
- `bySimpleName`: simpleName → bodyHashes (for duplicated-name dispatch resolution)
- `callees`: bodyHash → bodyHash[] (forward edges; for reachability)
- `callers`: bodyHash → bodyHash[] (reverse edges; for orphan detection)

Indexes are in-memory only — never persisted. They rebuild on every run from the catalog, and the cost (~50ms) is negligible compared to stages 1+2.

### Stage 4 — Rules

[`rules/<rule-name>.ts`](../../../packages/graph/engine/src/rules/) — one file per rule. Each rule receives `(catalog, indexes, config)` and returns a list of typed `Signal`s. Rules don't import the parser, don't import each other, don't read files. They consume frozen data and emit findings. Detailed in [`02-rules-and-gating.md`](./02-rules-and-gating.md).

### Stage 5 — Render

[`render/`](../../../packages/graph/engine/src/render/) — one file per output mode:

- `table.ts` — terminal report (default): four sections — catalog summary, findings grouped by rule (top 10 per rule with overflow indicator), top 10 entry points, one-line summary.
- `json.ts` — `CliOutput` shape from `@opensip-tools/contracts`; same envelope `fit` uses.
- `sarif.ts` — SARIF 2.1.0 for `--gate-save` / `--gate-compare` / `--report-to`.

The CLI handler [`cli/graph.ts`](../../../packages/graph/engine/src/cli/graph.ts) picks the renderer based on flags and writes its output.

---

## Entry-point inference

Two rules — `orphan-subtree` and `test-only-reachable` — need to know which functions count as legitimate "starts of execution." A function with zero callers isn't an orphan if it's a bin entry, a tool registration, an exported library API, or a route handler.

Entry-point inference is its own module: [`rules/_entry-points.ts`](../../../packages/graph/engine/src/rules/_entry-points.ts). The leading underscore signals "shared by other rules in this directory, not a rule itself." The current heuristic chain produces a tagged `EntryPoint` for any occurrence matching one of:

| Reason | What it matches |
|---|---|
| `module-init` | Every file's synthetic `<module-init>` occurrence — top-level statements run on import. |
| `name-match` | Functions named `main`, `run`, `start`, `register`, `init`, `bootstrap`, `initialize`. |
| `no-callers-exported` | Exported functions with no in-project callers (assumed to be a library API). |

`bin-entry` (functions reachable from a `bin` field in a `package.json`) and `tool-registration` (functions a Tool's `register()` calls into) are deferred — they exist in the design but produce too many heuristic edges to ship in v0.2.

The two rules that consume entry-points only see the resulting `EntryPoint[]` — they don't know how it was built. That decoupling means we can refine the inference (or replace it with project-config-driven declarations) without touching any rule.

---

## The catalog on disk

The output of stages 1+2 is cached to [`<project>/opensip-tools/.runtime/cache/graph/catalog.json`](../../../packages/graph/engine/src/cache/) (gitignored). Format:

```jsonc
{
  "version": "2.0",
  "tool": "graph",
  "language": "typescript",
  "builtAt": "2026-05-17T12:00:00.000Z",
  "tsConfigPath": "tsconfig.json",
  "tsCompilerVersion": "5.7.3",
  "filesFingerprint": "694\n/abs/path/foo.ts|1715000000000|1234\n...",
  "functions": {
    "saveBaseline": [
      {
        "bodyHash": "a3f9c204...",
        "bodySize": 412,            // post-normalize char count, used by dup-body threshold
        "simpleName": "saveBaseline",
        "qualifiedName": "fitness/engine/src/gate.saveBaseline",
        "filePath": "src/gate.ts",
        "line": 99,
        "kind": "function-declaration",
        "calls": [
          {
            "to": ["b2c80..."],
            "line": 100,
            "resolution": "static",
            "confidence": "high",
            "discarded": false        // true if call's return value is dropped
          }
        ]
      }
    ],
    "<arrow:src/tool.ts:118:7>": [
      { "bodyHash": "...", "kind": "arrow", "calls": [...] }
    ],
    "<module-init:src/tool.ts>": [
      { "bodyHash": "...", "kind": "module-init", "calls": [...] }
    ]
  }
}
```

Notable shape choices:

- **Functions keyed by `simpleName`, not `bodyHash`.** The catalog file is meant to be `grep`-able. `grep -n '"saveBaseline"' catalog.json` lands you on the right entry; `grep -n 'a3f9c204'` does not.
- **Each value is an array.** Two functions named `analyze` in different files don't collide; the array holds both occurrences.
- **`calls[i].to` is always an array.** Static (one element), polymorphic (many), unresolved (zero). Consumers don't switch on shape.
- **Anonymous functions get angle-bracketed names** (`<arrow:...>`, `<module-init:...>`) so they can't collide with real identifiers.

## Cache invalidation

[`cache/invalidate.ts`](../../../packages/graph/engine/src/cache/invalidate.ts) classifies a cached catalog into one of three verdicts:

| Verdict | When | Action |
|---|---|---|
| `valid` | Compiler version, tsconfig path, and per-file fingerprint all match exactly. | Reuse the cached catalog as-is. |
| `incremental` | Compiler + tsconfig agree, but at least one file's mtime/size differs from the cache. | Re-walk the dependency closure of changed files and merge with cached entries from unchanged files. See "Incremental rebuild" below. |
| `invalid` | TypeScript upgrade, tsconfig path change, or no fingerprint in the cache. | Discard the cache; do a full rebuild. |

The fingerprint is per-file `path|mtimeMs|size`, computed by `computeFilesFingerprint`. Mtime is cheap to read and stable enough — the ones that lie (formatter passes, `touch`, git clean rebuilds) cause an unnecessary incremental rebuild that produces a byte-identical result, not a correctness bug.

Writes go through [`cache/write.ts`](../../../packages/graph/engine/src/cache/write.ts) and use the standard atomic pattern: `openSync(tmpPath); writeStreamed(fd, catalog); rename(tmpPath, catalogPath)`. The streamed writer (Phase 2 of the perf plan) emits the catalog entry-by-entry rather than as one materialised string, bounding the write peak by the largest single occurrence array. Output is byte-identical to the legacy `JSON.stringify(_, null, 2)` path so existing on-disk caches stay valid.

`--no-cache` skips both read and write — useful for the CI gate workflow and when investigating a suspected stale-catalog bug.

### Incremental rebuild

When `classifyCatalog` returns `incremental`, the orchestrator runs `buildAndResolveCatalogIncremental` in [`cli/orchestrate.ts`](../../../packages/graph/engine/src/cli/orchestrate.ts). The algorithm:

1. Build a TypeScript `Program` over **all** current files. Resolvers walk the full import graph, so a partial program produces wrong symbols.
2. Convert the absolute changed-files set to project-relative paths to match the catalog's `filePath` field.
3. Walk the closure (initially the changed set). Compute hashes that vanished from the new walk vs. the cache — these are function-shapes that were edited away.
4. Find unchanged files whose cached edges have any `to` referencing a vanished hash; add those files to the closure.
5. Iterate until the closure stops growing.
6. Merge: cached entries for files outside the closure + freshly-walked-and-resolved entries for files in the closure.
7. `resolveEdgesFromRecords` runs only over the closure's call sites; `restoreCachedCalls` re-stitches cached `calls` arrays for unchanged files (their bodyHashes are preserved by construction through the merge).

Correctness: every file whose cached edges might point at a stale hash is itself re-walked. After the fixpoint, no cached edge dangles. Byte-identical to a `--no-cache` full rebuild.

Performance: editing a single file in opensip-tools self-graph drops rebuild time from ~15 s (full) to ~2.5 s (incremental); cache-hit runs (no edits) complete in ~0.8 s.

### `--package` and `--packages`

Two scoping flags from Wave 1 + Wave 3 of the perf plan:

- **`graph --package <name|path>`** scopes a run to one workspace package's tsconfig. Cross-package call sites become unresolved (lower fidelity, much faster). Resolves a basename via [`cli/scope.ts`](../../../packages/graph/engine/src/cli/scope.ts) by searching `<cwd>/packages/**` for a directory with a `tsconfig.json`; an explicit path is also accepted.
- **`graph --packages`** fans the run out across every workspace package under `<cwd>/packages/**`. One child process per package, concurrency capped at `cpus()-1`. Each child has its own Node heap, so the per-package memory ceiling scales naturally. Implementation: [`cli/packages-runner.ts`](../../../packages/graph/engine/src/cli/packages-runner.ts).

Both flags trade cross-package edge fidelity for speed and memory. Use `--no-cache` (and a global run, no scope flag) for full-fidelity CI gates.

---

## What's next

- **[`02-rules-and-gating.md`](./02-rules-and-gating.md)** — the five rules that consume the catalog, the gate workflow, and the SARIF integration.
- **[`70-surfaces/01-cli-command-tree.md#graph`](../70-surfaces/01-cli-command-tree.md)** — the CLI flag reference.
- **[`../plans/graph-performance-improvements.md`](../../plans/graph-performance-improvements.md)** — the perf-plan history (waves 1-4): heap-sizing hint, freed Program, streamed write, sliced hashing, per-package scope, fused walk, parallel runner, transitive incremental rebuild.
