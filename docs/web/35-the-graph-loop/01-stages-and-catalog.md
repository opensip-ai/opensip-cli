---
status: current
last_verified: 2026-05-16
title: "Stages and catalog (graph)"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "How `graph` builds its picture of the codebase — the six-stage pipeline, the catalog format, and the content-keyed cache."
source-files:
  - packages/graph/engine/src/tool.ts
  - packages/graph/engine/src/pipeline/discover.ts
  - packages/graph/engine/src/pipeline/inventory.ts
  - packages/graph/engine/src/pipeline/edges.ts
  - packages/graph/engine/src/pipeline/indexes.ts
  - packages/graph/engine/src/cache/read.ts
  - packages/graph/engine/src/cache/write.ts
  - packages/graph/engine/src/types.ts
related-docs:
  - ./02-rules-and-gating.md
  - ../10-mental-model/02-tool-plugin-model.md
  - ../50-subsystems/01-language-adapters.md
  - ../../plans/graph-tool-v2-design.md
---
# Stages and catalog (graph)

The `graph` command is the static call-graph tool. Where `fit` answers "is the codebase clean?" with a regex-and-AST pass over each file in isolation, and `sim` answers "does it behave correctly under stress?" with a runtime simulation, `graph` answers a different shape of question: **"what is reachable from where?"** Orphans, side-effect chains, duplicated bodies, test-only reachable code — all are questions about the *shape* of the call graph, not the contents of any single file.

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
│  Stage 1  —  INVENTORY                                               │
│  Per file: parse, walk AST, extract every callable.                  │
│  Output: Catalog (functions only, no edges)                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 2  —  EDGE RESOLUTION                                         │
│  Per file: walk AST, find call sites, resolve to catalog entries.    │
│  Output: Catalog with `calls` populated on each occurrence           │
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

Each stage is one module in [`packages/graph/engine/src/pipeline/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/) (stages 0–3) or [`packages/graph/engine/src/rules/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/) and [`packages/graph/engine/src/render/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/render/) (stages 4–5). Stages communicate only through their typed outputs; a stage cannot import a sibling stage, cannot reach back to read its predecessor's intermediate state, cannot peek into the next stage's expectations. This isolation is the single most important property of the design — every other guarantee derives from it.

### Stage 0 — Discover

[`pipeline/discover.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/discover.ts) resolves the project's `tsconfig.json`, applies its `include` / `exclude` patterns, and produces a sorted, deduplicated list of absolute file paths. No TypeScript `Program` is created here — that's stage 1's job. Stage 0 is purely about *what files exist*.

Output: `{ projectDirAbs, tsConfigPathAbs, files, compilerOptions }`. Typical runtime on this repo: ~50ms.

### Stage 1 — Inventory

[`pipeline/inventory.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/inventory.ts) parses every file from stage 0, walks each AST, and emits a **Catalog** — a flat, indexed list of every callable thing in the project. "Callable thing" is broader than function: function declarations, arrow functions, methods, constructors, getter/setter pairs, function expressions, and one synthetic `<module-init>` entry per file that owns its top-level statements.

Each entry is a `FunctionOccurrence`:

```ts
interface FunctionOccurrence {
  readonly bodyHash: string;          // content hash of the function body
  readonly simpleName: string;        // 'analyze', or '<arrow:src/foo.ts:42:8>' for anonymous
  readonly qualifiedName: string;     // 'fitness/engine/src/gate.saveBaseline'
  readonly filePath: string;          // relative to projectDirAbs
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly kind: FunctionKind;        // 'function-declaration' | 'arrow' | 'method' | 'constructor' | …
  readonly params: readonly Param[];
  readonly returnType: string;        // best-effort TS type text, or 'unknown'
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: 'exported' | 'internal';
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly calls: readonly CallEdge[]; // empty after stage 1; populated by stage 2
}
```

The visitor logic lives in [`pipeline/inventory-visitors/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/inventory-visitors/) — one file per node kind. The helpers that compute body hashes, synthesize names for anonymous functions, classify visibility, and extract decorators live alongside in [`pipeline/inventory-helpers/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/inventory-helpers/). None of them know anything about edges — that's deliberate.

**Why inventory finishes before edges start.** Stage 2 resolves a call's `to` field by looking up the callee in the catalog. If the catalog is still being built when stage 2 runs, you get a class of bugs where callees in not-yet-processed files appear as unresolved. Splitting the two stages eliminates that whole category at the cost of one additional pass over the AST.

### Stage 2 — Edge resolution

[`pipeline/edges.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/edges.ts) walks every file's AST a second time, finds every call site, and writes a `CallEdge` to the corresponding `FunctionOccurrence`'s `calls` array. By this point the catalog is frozen and complete, so every callee resolution is either "found in catalog" or "unresolved" — never "not yet in catalog."

Each edge:

```ts
interface CallEdge {
  readonly to: readonly string[];     // bodyHashes of resolved targets
  readonly line: number;
  readonly column: number;
  readonly resolution: 'static' | 'polymorphic' | 'unknown';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly text: string;              // verbatim call expression for debugging
}
```

`to` is always an array. A static call resolves to one element. Polymorphic dispatch (`config.method()` where `method` is an interface member with multiple implementations) resolves to many. An unresolved call (`fs.writeFileSync(...)`) resolves to zero.

Resolver logic is split into one file per call shape in [`pipeline/edge-resolvers/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/edge-resolvers/): direct calls, property-access calls, JSX elements, `new` expressions, polymorphic dispatch, and a catalog-fallback resolver that handles the long tail.

The TypeScript `Program` from stage 1 is reused so the type checker doesn't re-initialize. This is the bulk of the runtime cost — `~5s` for the opensip-tools workspace itself (5,319 functions across 594 files).

### Stage 3 — Index build

[`pipeline/indexes.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/pipeline/indexes.ts) performs a linear scan over the now-complete catalog and builds inverted indexes that rules need:

- `byBodyHash`: hash → occurrences (for duplicated-body detection)
- `inboundEdges`: bodyHash → list of callers (for orphan detection)
- `byFile`: filePath → occurrences in that file
- `byKind`: function-kind → occurrences

Indexes are in-memory only — never persisted. They rebuild on every run from the catalog, and the cost (~50ms) is negligible compared to stages 1+2.

### Stage 4 — Rules

[`rules/<rule-name>.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/) — one file per rule. Each rule receives `(catalog, indexes, config)` and returns a list of typed `Signal`s. Rules don't import the parser, don't import each other, don't read files. They consume frozen data and emit findings. Detailed in [`02-rules-and-gating.md`](/docs/opensip-tools/35-the-graph-loop/02-rules-and-gating/).

### Stage 5 — Render

[`render/`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/render/) — one file per output mode:

- `table.ts` — terminal report (default): four sections — catalog summary, findings grouped by rule (top 10 per rule with overflow indicator), top 10 entry points, one-line summary.
- `json.ts` — `CliOutput` shape from `@opensip-tools/contracts`; same envelope `fit` uses.
- `sarif.ts` — SARIF 2.1.0 for `--gate-save` / `--gate-compare` / `--report-to`.

The CLI handler [`cli/graph.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/cli/graph.ts) picks the renderer based on flags and writes its output.

---

## Entry-point inference

Two rules — `orphan-subtree` and `test-only-reachable` — need to know which functions count as legitimate "starts of execution." A function with zero callers isn't an orphan if it's a bin entry, a tool registration, an exported library API, or a route handler.

Entry-point inference is its own module: [`rules/_entry-points.ts`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/rules/_entry-points.ts). The leading underscore signals "shared by other rules in this directory, not a rule itself." The current heuristic chain produces a tagged `EntryPoint` for any occurrence matching one of:

| Reason | What it matches |
|---|---|
| `module-init` | Every file's synthetic `<module-init>` occurrence — top-level statements run on import. |
| `name-match` | Functions named `main`, `run`, `start`, `register`, `init`, `bootstrap`, `initialize`. |
| `no-callers-exported` | Exported functions with no in-project callers (assumed to be a library API). |

`bin-entry` (functions reachable from a `bin` field in a `package.json`) and `tool-registration` (functions a Tool's `register()` calls into) are deferred — they exist in the design but produce too many heuristic edges to ship in v0.2.

The five rules that consume entry-points only see the resulting `EntryPoint[]` — they don't know how it was built. That decoupling means we can refine the inference (or replace it with project-config-driven declarations) without touching any rule.

---

## The catalog on disk

The output of stages 1+2 is cached to [`<project>/opensip-tools/.runtime/cache/graph/catalog.json`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/packages/graph/engine/src/cache/) (gitignored). Format:

```jsonc
{
  "version": "2.0",
  "tool": "graph",
  "language": "typescript",
  "builtAt": "2026-05-16T12:00:00.000Z",
  "tsConfigPath": "tsconfig.json",
  "tsCompilerVersion": "5.7.3",
  "functions": {
    "saveBaseline": [
      {
        "bodyHash": "a3f9c204...",
        "simpleName": "saveBaseline",
        "qualifiedName": "fitness/engine/src/gate.saveBaseline",
        "filePath": "src/gate.ts",
        "line": 99,
        "kind": "function-declaration",
        "calls": [
          {"to": ["b2c80..."], "line": 100, "resolution": "static", "confidence": "high"}
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

Three keys, content-based all the way down:

1. **`tsCompilerVersion`** — a TypeScript upgrade invalidates the whole catalog.
2. **`tsConfigPath` + its content hash** — a config change can move files in or out of the project.
3. **Per-file `bodyHash` agreement** — for any file present in the catalog, if its functions' `bodyHash`es still match what's on disk, reuse them. If any differ, re-do stages 1+2 for that file only.

There's no mtime check. File mtimes lie about what actually changed (formatter pass, `touch` invocations, git clean rebuilds). The body hash is the truth.

Writes go through `cache/write.ts` and use the standard atomic pattern: `writeFileSync(tmpPath); rename(tmpPath, catalogPath)`. Two concurrent `graph` runs cannot tear the file.

`--no-cache` skips both read and write — useful when investigating a suspected stale-catalog bug.

---

## What's next

- **[`02-rules-and-gating.md`](/docs/opensip-tools/35-the-graph-loop/02-rules-and-gating/)** — the five rules that consume the catalog, the gate workflow, and the SARIF integration.
- **[`60-surfaces/01-cli-command-tree.md#graph`](/docs/opensip-tools/60-surfaces/01-cli-command-tree/)** — the CLI flag reference.
- **[`../plans/graph-tool-v2-design.md`](https://github.com/opensip-ai/opensip-tools/blob/v1.0.10/docs/plans/graph-tool-v2-design.md)** — the full design spec; deeper than this doc, includes the acceptance gates, the v0.1 → v0.2 history, and the data-flow diagrams.
