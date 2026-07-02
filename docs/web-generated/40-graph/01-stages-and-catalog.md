---
status: current
last_verified: 2026-06-07
release: v0.2.1
title: "Stages and catalog (graph)"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "How `graph` builds its picture of the codebase — the seven-stage pipeline, the catalog format, and the content-keyed cache."
source-files:
  - packages/graph/engine/src/tool.ts
  - packages/cli/src/bootstrap/load-tool-capabilities.ts
  - packages/graph/engine/src/lang-adapter/types.ts
  - packages/graph/engine/src/lang-adapter/registry.ts
  - packages/graph/graph-typescript/src/discover.ts
  - packages/graph/graph-typescript/src/walk.ts
  - packages/graph/graph-typescript/src/inventory-visitors
  - packages/graph/graph-typescript/src/edges.ts
  - packages/graph/graph-typescript/src/parse.ts
  - packages/graph/graph-typescript/src/cache-key.ts
  - packages/graph/graph-typescript/src/index.ts
  - packages/graph/graph-python/src/index.ts
  - packages/graph/graph-rust/src/index.ts
  - packages/graph/graph-go/src/index.ts
  - packages/graph/graph-java/src/index.ts
  - packages/graph/engine/src/pipeline/indexes.ts
  - packages/graph/engine/src/pipeline/features.ts
  - packages/graph/graph-adapter-common/src/parse.ts
  - packages/graph/engine/src/persistence/catalog-repo.ts
  - packages/graph/engine/src/persistence/schema.ts
  - packages/graph/engine/src/cache/invalidate.ts
  - packages/graph/engine/src/cache/engine-version.ts
  - packages/graph/engine/src/cli/orchestrate.ts
  - packages/graph/engine/src/cli/positional-paths.ts
  - packages/graph/engine/src/cli/workspace-runner.ts
  - packages/graph/engine/src/types.ts
related-docs:
  - ./02-rules-and-gating.md
  - ./03-adding-a-language.md
  - ../10-concepts/02-tool-plugin-model.md
  - ../50-extend/05-language-adapters.md
---
# Stages and catalog (graph)

The `graph` command is the static call-graph tool. Where `fit` answers "is the codebase clean?" and `sim` answers "does it behave correctly under stress?", `graph` asks: **"what is reachable from where?"** Orphans, side-effect chains, duplicated bodies, and test-only reachable code are all questions about the call graph, not any single file.

> **Naming.** CLI-facing docs and code use `graph`; the dashboard labels the same data **Code Paths**. The catalog lives in the project-local SQLite store at `<project>/opensip-cli/.runtime/datastore.sqlite` — see [Catalog in SQLite](#the-catalog-in-sqlite) below.

> **What you'll understand after this:**
> - The seven-stage pipeline graph uses to build its picture of the codebase.
> - Why inventory finishes before edges start, and why edges reference catalog entries by hash.
> - The catalog file format on disk and how cache invalidation works.
> - How entry points are inferred and why they're a separate concern from the rules that consume them.

---

## The seven-stage pipeline

```
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 0  —  DISCOVER FILES                                          │
│  adapter.discoverFiles({ cwd, configPathOverride? }).                │
│  TypeScript: walk tsconfig include/exclude.                          │
│  Python: read pyproject.toml / setup.py + **/*.py glob fallback.     │
│  Rust:   read Cargo.toml + **/*.rs glob fallback.                    │
│  Output: { projectDirAbs, files, configPathAbs?, compilerOptions? }  │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 1+2 — PARSE + UNIFIED WALK + RESOLVE                          │
│  adapter.parseProject + adapter.walkProject + adapter.resolveCallSites.│
│  Per file: one descent that emits FunctionOccurrences AND pre-       │
│  located CallSiteRecords (owner-keyed by bodyHash). Resolvers        │
│  dispatch over the flat record list — no second walk.                │
│  Output: Catalog (functions + resolved CallEdges) + ResolutionStats  │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 3  —  INDEX BUILD                                             │
│  Linear scan over Catalog. Build inverted indexes.                   │
│  Output: Indexes (in-memory, not persisted)                          │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 4  —  FEATURE BUILD                                          │
│  Derive feature columns from Catalog + Indexes — blast radius, SCC,  │
│  package coupling, reachability, bodyLines — lazily (only the        │
│  columns an enabled rule or the dashboard needs). Recomputed views   │
│  in-engine; materialized into the catalog only for the decoupled     │
│  dashboard (ADR-0006).                                               │
│  Output: FeatureTable (passed to rules; optionally persisted)        │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 5  —  RULES                                                   │
│  Each rule: (Catalog, Indexes, Config, features?) → Signal[]         │
│  Output: Signal[]                                                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Stage 6  —  ENVELOPE + RENDER (composition root)                   │
│  Signal[] → SignalEnvelope (build-envelope.ts); the root formats it  │
│  → terminal | JSON | SARIF | dashboard. Output: stdout, files, exit  │
└──────────────────────────────────────────────────────────────────────┘
```

Stages 0–2 are language-agnostic over the [`GraphLanguageAdapter`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/lang-adapter/types.ts) contract. The orchestrator looks up an adapter via [`lang-adapter/registry.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/lang-adapter/registry.ts), then dispatches `discoverFiles`, `parseProject`, `walkProject`, and `resolveCallSites` through it. Stage 3 (`buildIndexes`) lives in [`packages/graph/engine/src/pipeline/indexes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/indexes.ts) and Stage 4 (`buildFeatures`) in [`packages/graph/engine/src/pipeline/features.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/features.ts); stages 5–6 live in [`packages/graph/engine/src/rules/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/rules/) and [`packages/graph/engine/src/render/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/render/). The orchestrator instruments `discover`/`parse`/`walk`/`resolve`/`index`/`features`/`rules` as the `GRAPH_STAGES` spans.

The stage boundaries are deliberately narrow: each stage communicates through typed outputs instead of reaching into a neighbor's intermediate state. That isolation is the main design guarantee.

> **Adapter layer.** Five first-party adapters ship as publishable npm packages under the `@opensip-cli/graph-*` namespace: TypeScript ([`@opensip-cli/graph-typescript`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/index.ts)), Python ([`@opensip-cli/graph-python`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-python/src/index.ts)), Rust ([`@opensip-cli/graph-rust`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-rust/src/index.ts)), Go ([`@opensip-cli/graph-go`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-go/src/index.ts)), and Java ([`@opensip-cli/graph-java`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-java/src/index.ts)). Auto-discovery is **marker-based** and descriptor-driven (§5.3): the CLI walks `node_modules` for packages declaring `opensipTools.kind: "graph-adapter"` plus the `targetDomain: "graph-adapter"` / `targetDomainApiVersion` epoch (built-ins resolve from the CLI install tree) — or, if `plugins.graphAdapters` is set in `opensip-cli.config.yml`, exactly that explicit list. The generic capability loader ([`load-tool-capabilities.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/cli/src/bootstrap/load-tool-capabilities.ts)) drives discovery per command and routes each package's `adapter` export through graph's registrar. `pickAdapter(cwd)` chooses by file-extension dominance with a deterministic preference order on ties. Stages 3, 4, and 5 consume the catalog without knowing which adapter built it.

### Stage 0 — Discover

`adapter.discoverFiles({ cwd, configPathOverride? })` produces a sorted, deduplicated list of absolute file paths. The adapter chooses how — the TypeScript adapter ([`graph-typescript/discover.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/discover.ts)) resolves `tsconfig.json` and applies its `include` / `exclude`; the Python adapter ([`graph-python/discover.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-python/src/discover.ts)) reads `pyproject.toml` / `setup.py` and falls back to a `**/*.py` glob; the Rust adapter ([`graph-rust/discover.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-rust/src/discover.ts)) reads `Cargo.toml` and falls back to `**/*.rs`; the Go and Java adapters apply analogous module-file + glob fallbacks. No parser state is created here — that's stage 1's job. Stage 0 is purely about *what files exist*.

Output: `{ projectDirAbs, files, configPathAbs?, compilerOptions? }`. The optional `configPathAbs` and `compilerOptions` are adapter-private and thread through to `parseProject` / `cacheKey` unchanged.

You can run this stage in isolation — `graph --list-files` resolves and prints exactly this `files` set (relative to the project root) for the chosen scope and exits before stage 1, no catalog build. It honors `[paths...]`, `--workspace`, `--language`, and `--json`. Because it reuses `discoverFiles` verbatim, the printed set reflects the adapter's real view (for TypeScript: `.d.ts` excluded, extension-priority collisions collapsed, per-`tsconfig` `include`/`exclude` honored) — which makes it the authoritative way to confirm a repo's file set is being discovered as expected, or to diff that set against `git ls-files`. See [`70-reference/01-cli-commands.md`](/docs/opensip-cli/70-reference/01-cli-commands/#graph--static-call-graph--dead-end-analysis).

### Stage 1+2 — Parse, walk, resolve

`adapter.parseProject` builds adapter-internal parse state (TypeScript: a `ts.Program`; the checker is constructed lazily during exact edge resolution; Python, Rust, Go, Java: a `Map<filePath, tree-sitter Tree>` produced by a vendored `web-tree-sitter` WASM grammar — no native build at install). `adapter.walkProject` then walks every file from stage 0 exactly once and emits both:
- A **Catalog** — a flat, indexed list of every callable thing in the project. "Callable thing" is broader than function: function/method declarations, arrow functions / lambdas / closures, constructors, getter/setter pairs, function expressions, and one synthetic `<module-init>` entry per file that owns its top-level statements.
- A list of **CallSiteRecord**s — pre-located nodes that the resolver pass will dispatch over (call/new/jsx/identifier-in-value-position/shorthand assignment for TypeScript; `call`/`attribute`/`macro_invocation`/etc. for tree-sitter adapters). Each record carries the `bodyHash` of the enclosing function-shape, computed by the same walker pass, so the resolver dispatcher doesn't need to re-walk the AST or re-hash to find ownership.

`adapter.resolveCallSites({ project, catalog, callSites, projectDirAbs })` then runs over the flat record list and returns a `bodyHash → CallEdge[]` map. The TypeScript adapter's resolvers (under [`graph-typescript/edge-resolvers/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/edge-resolvers/)) dispatch by node shape using `getSymbolAtLocation` for high-confidence resolution; the tree-sitter adapters (Python, Rust, Go, Java) resolve by simple name (and impl-block / receiver context where applicable), producing `confidence: 'medium'` or `'low'` edges.

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

The TypeScript adapter's visitor logic lives in [`graph-typescript/inventory-visitors/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/inventory-visitors/) — one file per node kind. The helpers that compute body hashes, synthesize names for anonymous functions, classify visibility, and extract decorators live alongside in [`graph-typescript/inventory-helpers/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/inventory-helpers/). The shared dispatch table (`dispatchVisitor`, `isInlineCallable`) lives in [`graph-typescript/walk.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/walk.ts) so the TypeScript walk keeps node-shape detection centralized. The tree-sitter adapters (Python, Rust, Go, Java) keep a flatter layout (`walk.ts` / `resolve.ts` per adapter); see [`03-adding-a-language.md`](/docs/opensip-cli/40-graph/03-adding-a-language/) for the recommended layout. Shared edge-emission helpers (e.g. `appendEdge`) live at [`lang-adapter/edge-helpers.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/lang-adapter/edge-helpers.ts) so adapters do not duplicate edge construction.

**Why inventory finishes building before resolvers run.** Resolvers look up callees by name and bodyHash in the catalog. The walk emits all occurrences first, then the orchestrator builds the initial catalog, then `adapter.resolveCallSites` dispatches over the call-site list. By the time any resolver runs, the catalog is frozen and complete, so every callee resolution is either "found in catalog" or "unresolved" due to actual absence. This invariant is codified as I-4 ("`resolveCallSites` does not mutate its input catalog") in the [adapter contract](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/lang-adapter/types.ts).

Each edge:

```ts
interface CallEdge {
  readonly to: readonly string[];     // bodyHashes of resolved targets
  readonly line: number;
  readonly column: number;
  readonly resolution: 'static' | 'method-dispatch' | 'jsx' | 'constructor' | 'unknown' | 'dynamic-string';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly text: string;              // call expression text, truncated to ≤ 80 chars
  readonly discarded?: boolean;       // true if call appears as ExpressionStatement (return ignored)
}
```

`to` is always an array. A static call resolves to one element. Method-dispatch (`config.method()` where `method` is an interface member with multiple implementations) resolves to many. An unresolved call (`fs.writeFileSync(...)`) resolves to zero.

For the TypeScript adapter, resolver logic is split into one file per call shape in [`graph-typescript/edge-resolvers/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-typescript/src/edge-resolvers/): direct calls, property-access calls, JSX elements, `new` expressions, polymorphic dispatch, and a catalog-fallback resolver that handles the long tail. The tree-sitter adapters take the simpler approach — a single `resolve.ts` per adapter that does name-based lookup against the frozen catalog ([`graph-python/resolve.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-python/src/resolve.ts), [`graph-rust/resolve.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/graph-rust/src/resolve.ts), and equivalents for graph-go and graph-java).

For the TypeScript adapter, a single `ts.Program` is created in `parseProject` and shared across the walk and the resolver pass; `getTypeChecker()` is forced eagerly so parent pointers are populated before visitors walk parent chains. Cold full-rebuild runtime on the opensip-cli self-graph today is ~15 s; subsequent runs hit the incremental path described under "Cache invalidation" below. Tree-sitter adapters (Python, Rust, Go, Java) parse each file into a per-file `Tree` via a vendored `web-tree-sitter` WASM grammar — `Parser.init()` and `Language.load(<wasm>)` run once at module load — and never build a project-wide symbol table.

### Stage 3 — Index build

[`pipeline/indexes.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/indexes.ts) performs a linear scan over the now-complete catalog and builds inverted indexes that rules need:

- `byBodyHash`: bodyHash → occurrence (single canonical occurrence per body — content-dedup; identical bodies in different packages collapse here)
- `occurrencesByHash`: bodyHash → **all** occurrences sharing that body (preserves duplicates so a callee can be attributed to the right package)
- `bySimpleName`: simpleName → bodyHashes (for duplicated-name dispatch resolution)
- `callees`: bodyHash → bodyHash[] (forward edges; for reachability)
- `callers`: bodyHash → bodyHash[] (reverse edges; for orphan detection)
- `importedPackagesByFile`: filePath → package groups the file imports (from module-init `dependencies[]`; empty in `fast` mode)

Indexes are in-memory only — never persisted. They rebuild on every run from the catalog, and the cost (~50ms) is negligible compared to stages 1+2.

#### Package identity

Each occurrence carries a `package` — the `name` of its **nearest enclosing `package.json`** (e.g. `@opensip-cli/fitness`), or the top-level path segment when there's no manifest. It is stamped at build time by [`assignPackages`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/assign-packages.ts) (a post-walk catalog pass, before persistence) because the dashboard has no filesystem access. This is what the coupling grid buckets by, so it shows real packages on any repo layout (`packages/`, `apps/`+`libs/`, single-package, non-JS) rather than a `packages/<segment>` heuristic. Consumers read `occurrence.package` via the `pkgOf` helper, which falls back to the path heuristic when a catalog predates package stamps.

#### Cross-package edge attribution

Two corrections keep the coupling grid honest — every off-diagonal edge follows a real import.

**Per-occurrence edge keying.** A call edge's owner is keyed by `(bodyHash, filePath)` ([`ownerEdgeKey`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/owner-key.ts)), not `bodyHash` alone. Two functions with identical bodies in different files (a body-twin, e.g. `stripStrings` duplicated across the language adapters) share a hash; a hash-only bucket would union their edges, so each twin would appear to call every twin's callees. The composite key keeps each occurrence's edges its own, end to end (resolver → stitch → incremental merge → dependency attach).

**Collision-aware attribution + import constraint.** A call edge's *target* is still a `bodyHash`, so a callee is resolved to the occurrence the caller can *reach* via [`resolveCallee`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/resolve-callee.ts): the caller's own package → a package its module imports → lowest `qualifiedName`. Beyond that, a post-resolution pass — [`constrainCrossPackageEdges`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/constrain-edges.ts), applied to the built catalog before persistence in both the single-program and sharded paths — drops **name-guessed** edges (`resolution` ∈ `unknown` / `dynamic-string` / `syntactic`) whose target has no occurrence in a package the caller can reach (own ∪ imported), and never into another package's test file (never importable). Type-checker-backed edges (`static`, `method-dispatch`, `jsx`, `constructor`) are left untouched, so legitimate edges — including re-export indirection — are never dropped. The caller's import set comes from each module's `dependencies[]` **specifiers** (a workspace import specifier *is* the imported package's name, so it compares directly to `occurrence.package`): the TypeScript resolver points workspace imports at built `dist/*.d.ts` outside the catalog, so the resolved `dependencies[].to` is empty for cross-package imports and only the raw specifier is reliable. The pass is a no-op in `fast` mode (no `dependencies[]`). The same import constraint is applied at cross-shard boundary resolution ([`cross-shard-resolve.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts)).

### Stage 4 — Rules

[`rules/<rule-name>.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/rules/) — one file per rule. Each rule receives `(catalog, indexes, config)` and returns a list of typed `Signal`s. Rules don't import the parser, don't import each other, don't read files. They consume frozen data and emit findings. Detailed in [`02-rules-and-gating.md`](/docs/opensip-cli/40-graph/02-rules-and-gating/).

### Stage 5 — Render

Per [ADR-0011](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/docs/decisions/ADR-0011-signal-output-currency-formatter-sink.md), graph (like every tool) **no longer renders its own machine output**. Stage 5 ends by collapsing the run's `Signal[]` into one `SignalEnvelope` in [`cli/build-envelope.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cli/build-envelope.ts) (the same `SignalEnvelope` `fit` and `sim` emit). The graph engine returns that envelope via `CommandResult`; the **CLI composition root** maps flags to a (formatter × sink) pair:

- **Terminal report (default)** — the human/table formatter, derived from `envelope.units` + `envelope.signals`.
- **`--json`** — the host wraps the envelope in a `CommandOutcome` (the byte-identical envelope rides under `.envelope`) and serializes the whole outcome through the single `renderOutcome` seam. See [`70-reference/04-json-output-schema.md`](/docs/opensip-cli/70-reference/04-json-output-schema/).
- **SARIF** (`--gate-save` / `--gate-compare` / `--report-to`) — the shared `formatSignalSarif` formatter.

The old per-tool `render/json.ts` (which built the retired `CliOutput`) was **deleted**; graph keeps only graph-specific render helpers (e.g. `render/table.ts`, the OpenSIP rule-id mapping) under [`render/`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/render/). The CLI handler [`cli/graph.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cli/graph.ts) returns the envelope; the root renders/delivers it.

---

## Entry-point inference

Two rules — `orphan-subtree` and `test-only-reachable` — need to know which functions count as legitimate "starts of execution." A function with zero callers isn't an orphan if it's a bin entry, a tool registration, an exported library API, or a route handler.

Entry-point inference is its own module: [`rules/_entry-points.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/rules/_entry-points.ts). The leading underscore signals "shared by other rules in this directory, not a rule itself." The current heuristic chain produces a tagged `EntryPoint` for any occurrence matching one of:

| Reason | What it matches |
|---|---|
| `module-init` | Every file's synthetic `<module-init>` occurrence — top-level statements run on import. |
| `name-match` | Functions named `main`, `run`, `start`, `register`, `init`, `bootstrap`, `initialize`. |
| `no-callers-exported` | Exported functions with no in-project callers (assumed to be a library API). |

`bin-entry` functions from `package.json` and Tool-registration entry points are not recognized today; declare those through config if a rule needs to treat them as roots.

The two rules that consume entry-points only see the resulting `EntryPoint[]` — they don't know how it was built. That decoupling means we can refine the inference (or replace it with project-config-driven declarations) without touching any rule.

---

## The catalog in SQLite

The output of stages 1+2 is persisted to the project-local SQLite store at `<project>/opensip-cli/.runtime/datastore.sqlite` via [`CatalogRepo.replaceAll(catalog)`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/persistence/catalog-repo.ts). The catalog rides a single row in the `graph_catalog` table: cache-validity fields (language, cacheKey, filesFingerprint) live in typed columns; the function/occurrence/edge data is stored as a JSON payload preserving the launch wire shape exactly.

The reconstructed `Catalog` value returned by `CatalogRepo.loadFullCatalog()`
is the same shape consumed by dashboard view derivations, rules, and indexes.
The persisted fragment format carries a `language` field (the adapter id) and an
opaque `cacheKey` — the adapter's invalidation string prefixed with the running
engine version (`eng=<version>|…`, see [Cache invalidation](#cache-invalidation)
below).

```jsonc
{
  "version": "3.0",
  "tool": "graph",
  "language": "typescript",       // adapter id; Python catalog → "python", Rust → "rust", …
  "builtAt": "2026-05-18T12:00:00.000Z",
  "cacheKey": "eng=0.2.1|ts-5.7.3-9bb6ef4d07c08140", // engine version + adapter-supplied invalidation key
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

- **Functions keyed by `simpleName`, not `bodyHash`.** The keying is preserved
  for the in-memory `Catalog` shape that downstream views consume; switching to
  bodyHash-keyed in-memory would force every consumer to rewrite its lookups.
- **Each value is an array.** Two functions named `analyze` in different files don't collide; the array holds both occurrences.
- **`calls[i].to` is always an array.** Static (one element), polymorphic (many), unresolved (zero). Consumers don't switch on shape.
- **Anonymous functions get angle-bracketed names** (`<arrow:...>`, `<module-init:...>`) so they can't collide with real identifiers.
- **Optional `features` surface.** The catalog payload carries an optional `features` block (per-function `bodyLines` / `blast` / reachability, plus package-level `scc` and `packageCoupling` rows) computed by the engine's feature-derivation stage ([`pipeline/features.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/pipeline/features.ts)). Per [ADR-0006](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/docs/decisions/ADR-0006-derived-data-persistence-policy.md), features are a recomputed in-engine view for the rules and are **materialized into the catalog only when the producing run requests them** (for the decoupled dashboard); a default run persists no features.

## Cache invalidation

[`cache/invalidate.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cache/invalidate.ts) classifies a cached catalog into one of three verdicts:

| Verdict | When | Action |
|---|---|---|
| `valid` | `language` (adapter id), `cacheKey` (adapter-supplied invalidation key), and per-file fingerprint all match exactly. | Reuse the cached catalog as-is. |
| `incremental` | `language` + `cacheKey` agree, but at least one file's mtime/size differs from the cache. | Re-walk the dependency closure of changed files and merge with cached entries from unchanged files. See "Incremental rebuild" below. |
| `invalid` | Different adapter (`language` mismatch), `cacheKey` changed — including the **engine version** (opensip-cli was upgraded), the adapter's own key (tsconfig content edited or TS upgraded), the resolution tier — no fingerprint, or a legacy catalog format on disk. | Discard the cache; do a full rebuild. |

**Engine-version stamping.** The `cacheKey` is the adapter's invalidation string prefixed with the running graph engine's package version: `eng=<version>|<adapter-key>` ([`cache/engine-version.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cache/engine-version.ts), [ADR-0015](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/docs/decisions/ADR-0015-engine-version-cache-invalidation.md)). This guarantees that **upgrading opensip-cli invalidates the cache** even when your source is unchanged — so a new engine (with, say, improved edge resolution or body hashing) never replays a catalog built by the old one. The stamp is applied in the language-agnostic engine, so it covers every adapter (TypeScript and the tree-sitter languages) and both the full-catalog cache and the per-shard fragment cache. The visible consequence: the **first `graph` run after an upgrade is a full cold rebuild**; subsequent runs cache-hit as normal. This is deliberate over-invalidation — a one-time rebuild is always safe, whereas a stale cache is not.

The fingerprint is per-file `path|mtimeMs|size`, computed by `computeFilesFingerprint`. Mtime is cheap to read and stable enough — the ones that lie (formatter passes, `touch`, git clean rebuilds) cause an unnecessary incremental rebuild that produces a byte-identical result, not a correctness bug.

Writes go through [`CatalogRepo.replaceAll`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/persistence/catalog-repo.ts), an UPSERT into `graph_catalog` row 1 in a single transaction. SQLite's WAL mode + transactional semantics give the cache atomic replacement; concurrent reads (e.g. from `graph --workspace` child processes) don't see torn writes. Per-unit incremental writes are explicitly deferred to a follow-up `graph-catalog-perf` plan.

`--no-cache` skips both read and write — useful for the CI gate workflow and when investigating a suspected stale-catalog bug.

### Incremental rebuild

When `classifyCatalog` returns `incremental`, the orchestrator runs `buildAndResolveCatalogIncremental` in [`cli/orchestrate.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cli/orchestrate.ts). The algorithm:

1. Build a TypeScript `Program` over **all** current files. Resolvers walk the full import graph, so a partial program produces wrong symbols.
2. Convert the absolute changed-files set to project-relative paths to match the catalog's `filePath` field.
3. Walk the closure (initially the changed set). Compute hashes that vanished from the new walk vs. the cache — these are function-shapes that were edited away.
4. Find unchanged files whose cached edges have any `to` referencing a vanished hash; add those files to the closure.
5. Iterate until the closure stops growing.
6. Merge: cached entries for files outside the closure + freshly-walked-and-resolved entries for files in the closure.
7. `resolveEdgesFromRecords` runs only over the closure's call sites; `restoreCachedCalls` re-stitches cached `calls` arrays for unchanged files (their bodyHashes are preserved by construction through the merge).

Correctness: every file whose cached edges might point at a stale hash is itself re-walked. After the fixpoint, no cached edge dangles. Byte-identical to a `--no-cache` full rebuild.

Performance: editing a single file in opensip-cli self-graph drops rebuild time from ~15 s (full) to ~2.5 s (incremental); cache-hit runs (no edits) complete in ~0.8 s.

### Positional paths and `--workspace`

Three scoping shapes narrow expensive graph runs. The flag surface is language-neutral; each adapter implements its own `discoverWorkspaceUnits` hook (see [`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/core/src/languages/adapter.ts)). The TypeScript adapter ships with the hook implemented; other adapters opt in incrementally.

- **`graph <path> [<path>...]`** scopes a run to one or more existing directories. Cross-subtree call sites become unresolved (lower fidelity, much faster). Multiple paths run sequentially in-process and aggregate into one session (D12).
- **`graph --workspace`** fans the run out across every workspace unit returned by each detected adapter's `discoverWorkspaceUnits` hook. Polyglot per D8b: a repo with both `tsconfig.json` and `Cargo.toml` markers fans out across both adapters' units in one combined run. One child process per unit, concurrency capped at `cpus()-1` (override via `--concurrency`). Each child has its own Node heap, so the per-unit memory ceiling scales naturally. Implementation: [`cli/workspace-runner.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.1/packages/graph/engine/src/cli/workspace-runner.ts).
- **`graph --language <name>`** forces a specific adapter, suppressing marker-based detection. If the discovered file count is zero, exits 2 with a clear error (D14 mixed mismatch policy).

These shapes trade cross-subtree edge fidelity for speed and memory. Use `--no-cache` (and a global run, no scope flag) for full-fidelity CI gates.

---

## What's next

- **[`02-rules-and-gating.md`](/docs/opensip-cli/40-graph/02-rules-and-gating/)** — the eleven rules that consume the catalog, the gate workflow, and the SARIF integration.
- **[`70-reference/01-cli-commands.md#graph`](/docs/opensip-cli/70-reference/01-cli-commands/)** — the CLI flag reference.
- **`git -P log -- packages/graph`** — the perf-plan history landed in waves: heap-sizing hint, freed Program, streamed write, sliced hashing, per-package scope, fused walk, parallel runner, transitive incremental rebuild. The original perf plan documents were removed once each wave shipped; the commit history is the source of truth.
