---
status: draft
last_verified: 2026-05-16
title: "graph Tool — design spec (v2)"
audience: [contributors, plugin-authors]
purpose: "Implementation spec for @opensip-tools/graph, rewritten with a strict staged architecture: inventory first, edges second, indexes third, rules fourth. Replaces graph-tool-design.md (v1)."
related-docs:
  - ./graph-tool-design.md
  - ../architecture/10-mental-model/02-tool-plugin-model.md
  - ../architecture/10-mental-model/03-modular-monolith.md
---
# `graph` Tool — design spec (v2)

A clean-slate rewrite of the `graph` Tool, organized as a strict pipeline of small, single-purpose stages. Each stage produces immutable output for the next. No stage looks back; no stage races ahead. Replaces [`graph-tool-design.md`](./graph-tool-design.md), which is preserved as historical context.

> **Why this exists.** v0.1 conflated parsing, symbol resolution, and edge construction into one ~800-line module. Bugs in any step manifested as bugs in the others; debugging required understanding the whole. v0.2 separates these concerns by construction. Stage 1 (inventory) cannot have bugs caused by stage 2 (edges); stage 4 (rules) cannot accidentally read mid-pass parser state. Each stage is independently testable.

> **What you'll know after this:** the six stages, their data shapes, the import-graph that enforces decoupling, the acceptance gates, and the order of work to ship v0.2.

---

## 1. Architectural principles

The non-negotiables. Every design decision below derives from these.

### 1.1 Stages are isolated

The pipeline is six stages (0–5). Each stage:

- **Reads** the previous stage's output as immutable data.
- **Writes** new immutable data for the next stage.
- **Has zero awareness** of any other stage's internals.
- **Lives in its own module** with a sharply scoped public API (one function in / one shape out).

A stage cannot import a sibling stage. A stage cannot reach back to read its predecessor's intermediate state. Stages communicate only through their typed outputs.

### 1.2 Inventory before edges

Stage 1 (inventory) **finishes** before stage 2 (edges) **starts**. The catalog of every callable thing in the project is complete before any edge resolution begins. This single ordering rule is what removes the entire class of bugs v0.1 spent days chasing.

### 1.3 Edges reference catalog entries by hash

Every edge's `to` field is a `bodyHash` that already exists in stage 1's output. The catalog *is* the graph; edges are pointers within it. There are no string-keyed callee lookups, no path-and-line reconstructions, no synthesized identifiers. The hash is the lookup; the lookup is the hash.

### 1.4 Rules consume frozen data

Rules (stage 4) receive `(catalog, indexes, config)` as immutable inputs and return `Signal[]`. They have no other dependencies. A rule cannot invoke the parser, cannot call into TypeScript, cannot read files. This makes rules unit-testable in 10 lines and pluggable as project-local `.mjs` files when we want.

### 1.5 Small functions, one purpose

The whole tool is composed of functions that fit on a screen. The longest function in v0.1's `builder.ts` was over 100 lines. The corresponding code in v0.2 is split: AST visitors, symbol classifiers, hash computers, edge resolvers — each is its own function, named for what it does, tested independently.

### 1.6 Language coupling lives in stages 1 and 2 only

Stage 0 (file discovery), stage 3 (indexes), stage 4 (rules), stage 5 (render) are language-neutral. Adding Rust support is "swap stages 1 and 2 for a Rust implementation"; nothing else changes. We don't have to do it, but the architecture preserves the option.

---

## 2. The six stages

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
│  Output: Catalog with `calls` populated on each FunctionOccurrence   │
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
│  Signal[] → terminal table | JSON | SARIF | dashboard                │
│  Output: stdout, files, exit code                                    │
└──────────────────────────────────────────────────────────────────────┘
```

Each stage is one module, exporting one entry function.

### 2.1 Stage 0 — Discover files

**Purpose.** Resolve the project's `tsconfig.json` and produce an absolute, realpath'd list of source files to process.

**Module.** `packages/graph/engine/src/pipeline/discover.ts`

**Public surface.**

```ts
interface DiscoveryInput {
  readonly projectDir: string;       // may be relative; will be normalized
  readonly tsConfigPath?: string;    // optional override; defaults to <projectDir>/tsconfig.json
}

interface DiscoveryOutput {
  readonly projectDirAbs: string;    // realpath'd, absolute
  readonly tsConfigPathAbs: string;  // realpath'd, absolute
  readonly files: readonly string[]; // absolute, realpath'd, .ts/.tsx only, deduplicated, sorted
  readonly compilerOptions: ts.CompilerOptions;
}

export function discoverFiles(input: DiscoveryInput): DiscoveryOutput;
```

**Internals.** Three small functions:
- `normalizeProjectDir(p: string): string` — realpath + resolve, throws on missing dir
- `loadTsConfig(path: string): {options, fileNames}` — wraps `ts.parseJsonConfigFileContent`, handles errors
- `filterToSourceFiles(fileNames: string[]): string[]` — keep `.ts/.tsx`, drop `.d.ts`, dedupe via realpath, sort

No TypeScript Program is created here — that's stage 1's job. Stage 0 is purely about *what files exist*.

### 2.2 Stage 1 — Inventory

**Purpose.** Walk every file's AST and emit a complete catalog of callable functions. No edges, no resolution. Just "every function that exists, with its metadata."

**Module.** `packages/graph/engine/src/pipeline/inventory.ts`

**Public surface.**

```ts
interface InventoryInput {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

interface InventoryOutput {
  readonly catalog: Catalog;          // functions only; calls[] is empty
  readonly program: ts.Program;       // returned for stage 2's reuse
  readonly parseErrors: readonly ParseError[];
}

export function buildInventory(input: InventoryInput): InventoryOutput;
```

**The Catalog shape (frozen as the v2 contract).**

```ts
/** A single callable function or method, by simple name + per-occurrence record. */
interface FunctionOccurrence {
  readonly bodyHash: string;            // sha256(normalized body) — primary id
  readonly simpleName: string;          // "saveBaseline", "<arrow:gate.ts:42:7>"
  readonly qualifiedName: string;       // "fitness/engine/src/gate.saveBaseline"
  readonly filePath: string;            // project-relative
  readonly line: number;                // 1-based, function start
  readonly column: number;              // 0-based
  readonly endLine: number;
  readonly kind:
    | 'function-declaration'
    | 'function-expression'
    | 'arrow'
    | 'method'
    | 'constructor'
    | 'getter'
    | 'setter'
    | 'module-init';                    // synthesized one per file for top-level statements
  readonly params: readonly Param[];
  readonly returnType: string | null;   // string-rendered TS type, when available
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: 'exported' | 'module-local' | 'private';
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly calls: readonly CallEdge[];  // populated by stage 2; empty after stage 1
}

interface Param {
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** A resolved call from one function to another. Populated by stage 2. */
interface CallEdge {
  readonly to: readonly string[];       // bodyHash[] (one for static, many for polymorphic, empty for unknown)
  readonly line: number;
  readonly column: number;
  readonly resolution: 'static' | 'method-dispatch' | 'jsx' | 'constructor' | 'unknown' | 'dynamic-string';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly text: string;                // raw call expression, ≤ 80 chars
}

/** The catalog: functions keyed by simple name. Multiple occurrences per name. */
interface Catalog {
  readonly version: '2.0';
  readonly tool: 'graph';
  readonly language: 'typescript';
  readonly builtAt: string;             // ISO 8601
  readonly tsConfigPath: string;
  readonly tsCompilerVersion: string;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
}
```

**Internals.** Stage 1 is composed of small visitors. Each visitor handles **one shape** of function declaration:

- `visitFunctionDeclaration` — `function foo() {}`
- `visitArrowFunction` — `() => {}` and friends, including anonymous callbacks
- `visitMethodDeclaration` — class methods, static methods
- `visitConstructorDeclaration` — class constructors (one per class with `constructor() {}`)
- `visitGetterSetter` — `get x()` / `set x()`
- `visitFunctionExpression` — `const x = function() {}`, including IIFEs
- `synthesizeModuleInit` — produces ONE `module-init` occurrence per file, owning all top-level call sites discovered in stage 2

Each visitor is its own function, ≤ 50 LOC, takes a `ts.Node` plus a context, returns a `FunctionOccurrence | null`.

A separate `synthesizeSimpleName(node: ts.Node, kind: Kind, location: Loc): string` function names anonymous arrows deterministically: `<arrow:filePath:line:column>`. This is the **only** name-synthesis logic; every visitor calls into it for unnamed nodes.

**Body hashing.**

```ts
function hashFunctionBody(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node.getText(sourceFile);
  const normalized = normalizeWhitespace(stripComments(text));
  return sha256(normalized);
}
```

Two invariants:
- Same body in two files → same hash. (DRY-detection via `bySimpleName`.)
- Body changed by one character → new hash. (Cache invalidation.)

Tiebreaker for collisions: if two functions in the catalog have the same `bodyHash` (genuinely identical bodies), they're stored as separate occurrences under the same `simpleName`. Their bodyHash *intentionally* collides — that's what `graph:duplicated-function-body` looks for.

**What stage 1 explicitly does NOT do.**
- Resolve any call. (Stage 2.)
- Compute any caller index. (Stage 3.)
- Look at `import` statements except to determine `visibility`. (Stage 2 cares about imports for resolution.)
- Touch the filesystem beyond what `program.getSourceFiles()` already loaded. (Stage 0 did the filesystem work.)

### 2.3 Stage 2 — Edge resolution

**Purpose.** Walk every function's body. Find every call site. Resolve each to a list of catalog entries (by bodyHash). Append edges to the appropriate `FunctionOccurrence.calls`.

**Module.** `packages/graph/engine/src/pipeline/edges.ts`

**Public surface.**

```ts
interface EdgeResolutionInput {
  readonly catalog: Catalog;            // from stage 1, calls[] empty
  readonly program: ts.Program;
  readonly projectDirAbs: string;
}

interface EdgeResolutionOutput {
  readonly catalog: Catalog;            // calls[] populated
  readonly resolutionStats: ResolutionStats;
}

interface ResolutionStats {
  readonly totalCallSites: number;
  readonly resolvedHigh: number;        // confidence: 'high'
  readonly resolvedMedium: number;
  readonly resolvedLow: number;
  readonly unresolved: number;
}

export function resolveEdges(input: EdgeResolutionInput): EdgeResolutionOutput;
```

**Internals.** A resolver is composed of small classifiers:

```ts
// Each takes a CallExpression / NewExpression / JsxElement and returns 0+ bodyHashes.
function resolveDirectCall(node, ctx): ResolverVerdict;
function resolvePropertyAccessCall(node, ctx): ResolverVerdict;
function resolveJsxElement(node, ctx): ResolverVerdict;
function resolveNewExpression(node, ctx): ResolverVerdict;
function resolvePolymorphicCall(node, ctx): ResolverVerdict;     // method calls on interfaces/abstract classes
function resolveAliased(symbol, ctx): ts.Symbol;                  // walks getAliasedSymbol chain
function resolveByCatalogFallback(simpleName, ctx): ResolverVerdict; // when TS resolution fails
```

The dispatcher (`resolveCallSite`) is one switch over node kind, calling the right classifier.

**The fallback path.** When TypeScript's resolver returns no symbol (or returns a symbol with no usable declaration), the resolver falls back to a name-based catalog lookup:

```ts
function resolveByCatalogFallback(simpleName: string, ctx: ResolverContext): ResolverVerdict {
  const candidates = ctx.catalog.functions[simpleName] ?? [];
  if (candidates.length === 0) return UNRESOLVED;
  if (candidates.length === 1) {
    return { to: [candidates[0].bodyHash], resolution: 'unknown', confidence: 'medium' };
  }
  // Multiple candidates; can't disambiguate without TS info.
  return UNRESOLVED;
}
```

This is the named-name fallback the v0.1 implementation never had. It recovers many of the cross-package `dist/*.d.ts` cases for free.

**Where the bodyHash comes from.** When the resolver finds a declaration, it computes that declaration's bodyHash *the same way stage 1 did*. Same input, same hash function, same output. The catalog already contains the entry; the resolver finds it via:

```ts
function findCatalogEntry(decl: ts.Node, sourceFile: ts.SourceFile, catalog: Catalog): string | null {
  const bodyHash = hashFunctionBody(decl, sourceFile);
  const simpleName = simpleNameOfDeclaration(decl, sourceFile);  // mirrors stage 1's logic
  const candidates = catalog.functions[simpleName] ?? [];
  return candidates.find(c => c.bodyHash === bodyHash)?.bodyHash ?? null;
}
```

If stage 1 was correct, this lookup *always* succeeds when the declaration is in the project. That's the architectural payoff.

### 2.4 Stage 3 — Index build

**Purpose.** Compute O(1) lookups over the catalog.

**Module.** `packages/graph/engine/src/pipeline/indexes.ts`

**Public surface.**

```ts
interface Indexes {
  readonly byBodyHash: ReadonlyMap<string, FunctionOccurrence>;
  readonly bySimpleName: ReadonlyMap<string, readonly string[]>;     // → bodyHash[]
  readonly callees: ReadonlyMap<string, readonly string[]>;          // → bodyHash[] (forward)
  readonly callers: ReadonlyMap<string, readonly string[]>;          // → bodyHash[] (reverse)
}

export function buildIndexes(catalog: Catalog): Indexes;
```

**Internals.** Four pure linear scans, one per index. No TypeScript imports; no AST; no filesystem. Just data → data.

**Not persisted.** Indexes are rebuilt from the catalog on every run. They're cheap (linear in catalog size) and storing them would duplicate the catalog's information.

### 2.5 Stage 4 — Rules

**Purpose.** Each rule consumes the catalog and indexes; emits Signals.

**Module.** `packages/graph/engine/src/rules/<rule-name>.ts` (one file per rule)

**Rule shape.**

```ts
interface Rule {
  readonly slug: string;                                // e.g. 'graph:orphan-subtree'
  readonly defaultSeverity: 'error' | 'warning';
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
  ) => readonly Signal[];
}
```

**Rules in v0.2.** The same five we planned for v0.1, but each is now a self-contained file:

- `rules/orphan-subtree.ts` — find functions with zero callers (and no entry-point ancestors)
- `rules/duplicated-function-body.ts` — group catalog by bodyHash; report groups of size > 1 (with a min-line threshold to skip trivial bodies)
- `rules/no-side-effect-path.ts` — transitive closure walk; flag pure subtrees
- `rules/test-only-reachable.ts` — walk reachability from inferred entry points; flag functions reached only via test files
- `rules/always-throws-branch.ts` — per-function CFG analysis; flag branches where every path throws

Rules import only `@opensip-tools/contracts` (for Signal) and the catalog/indexes types from this package's local `types.ts`. They do **not** import TypeScript, the parser, or each other.

**Entry-point inference** is its own module (`rules/_entry-points.ts`) consumed by orphan-subtree and test-only-reachable. It's a heuristic chain (binary, route-handler, name-match, external-caller) with the same shape as in the v0.1 spec.

### 2.6 Stage 5 — Render

**Purpose.** Turn `Signal[]` into output the user sees.

**Module.** `packages/graph/engine/src/render/`

Three renderers, one per output mode:

- `render/table.ts` — terminal Ink table (default)
- `render/json.ts` — `CliOutput` shape from `@opensip-tools/contracts`
- `render/sarif.ts` — SARIF 2.1.0 (for `--gate-save` / `--gate-compare` / `--report-to`)

Each is a pure function: `(signals: Signal[], context: RenderContext) => string`. The CLI handler (`cli/graph.ts`) picks the right renderer based on flags.

---

## 3. Module layout

The complete directory structure:

```
packages/graph/engine/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                          # public barrel
│   ├── tool.ts                           # Tool contract impl, registers commands
│   ├── types.ts                          # Catalog, FunctionOccurrence, CallEdge, Indexes
│   ├── pipeline/
│   │   ├── discover.ts                   # Stage 0
│   │   ├── inventory.ts                  # Stage 1 — top-level orchestrator
│   │   ├── inventory-visitors/
│   │   │   ├── function-declaration.ts
│   │   │   ├── arrow-function.ts
│   │   │   ├── method-declaration.ts
│   │   │   ├── constructor-declaration.ts
│   │   │   ├── getter-setter.ts
│   │   │   ├── function-expression.ts
│   │   │   └── module-init.ts
│   │   ├── inventory-helpers/
│   │   │   ├── hash-body.ts
│   │   │   ├── synthesize-name.ts
│   │   │   ├── extract-params.ts
│   │   │   ├── extract-decorators.ts
│   │   │   └── classify-visibility.ts
│   │   ├── edges.ts                      # Stage 2 — top-level orchestrator
│   │   ├── edge-resolvers/
│   │   │   ├── direct-call.ts
│   │   │   ├── property-access.ts
│   │   │   ├── jsx-element.ts
│   │   │   ├── new-expression.ts
│   │   │   ├── polymorphic.ts
│   │   │   └── catalog-fallback.ts
│   │   ├── edge-helpers/
│   │   │   ├── unalias-symbol.ts
│   │   │   └── find-catalog-entry.ts
│   │   ├── indexes.ts                    # Stage 3
│   │   └── normalize-project-dir.ts      # shared utility (realpath + resolve)
│   ├── rules/
│   │   ├── _entry-points.ts              # shared by orphan-subtree, test-only-reachable
│   │   ├── orphan-subtree.ts
│   │   ├── duplicated-function-body.ts
│   │   ├── no-side-effect-path.ts
│   │   ├── test-only-reachable.ts
│   │   ├── always-throws-branch.ts
│   │   └── registry.ts                   # exports the rule list
│   ├── render/
│   │   ├── table.ts
│   │   ├── json.ts
│   │   └── sarif.ts
│   ├── cli/
│   │   ├── graph.ts                      # `opensip-tools graph` action
│   │   ├── graph-orphans.ts              # `opensip-tools graph-orphans` action
│   │   ├── graph-entry-points.ts         # `opensip-tools graph-entry-points` action
│   │   └── orchestrate.ts                # threads stages 0-5 together
│   ├── cache/
│   │   ├── read.ts
│   │   ├── write.ts
│   │   └── invalidate.ts
│   ├── gate.ts                           # baseline save/compare (calls into render/sarif)
│   └── __tests__/
│       └── (mirrors src/ structure, one test file per source file)
└── README.md
```

Roughly **40 source files**, each ≤ 200 LOC. Compare to v0.1's `builder.ts` at ~800 LOC. The total is similar; the *distribution* is what matters.

---

## 4. The decoupling rules (enforced)

These are wired into `.dependency-cruiser.cjs` so the build fails if violated.

### 4.1 Stage modules don't import each other

```
pipeline/discover.ts       cannot import from  pipeline/{inventory,edges,indexes}
pipeline/inventory.ts      cannot import from  pipeline/{edges,indexes}
pipeline/edges.ts          cannot import from  pipeline/{indexes}
pipeline/indexes.ts        imports nothing from pipeline/
```

The orchestrator (`cli/orchestrate.ts`) is the *only* module that imports from multiple stages. It's the wiring layer.

### 4.2 Rules don't import the parser

```
rules/*.ts                 cannot import from  pipeline/* or 'typescript'
```

Rules import only `types.ts`, `@opensip-tools/contracts`, and each other for shared helpers (`_entry-points.ts`).

### 4.3 Renderers don't read the catalog directly

```
render/*.ts                cannot import from  pipeline/* or rules/*
```

Renderers consume `Signal[]` and a `RenderContext`. They have no view of the catalog.

### 4.4 Visitors and resolvers are siblings

```
pipeline/inventory-visitors/*.ts       cannot import from  pipeline/edge-resolvers/*
pipeline/edge-resolvers/*.ts           cannot import from  pipeline/inventory-visitors/*
```

A visitor knows about declarations; a resolver knows about call sites. They share helpers (`hash-body.ts`, `synthesize-name.ts`) but not logic.

### 4.5 The `tool.ts` and `cli/*.ts` boundary

The Tool contract registration in `tool.ts` is thin. It does Commander wiring and dispatches to `cli/*.ts` action handlers. The CLI handlers call into `cli/orchestrate.ts`. None of the stages know about Commander.

---

## 5. Data flow

The whole thing in one trace, for the dogfood case `opensip-tools graph`:

```
1. CLI parses argv, dispatches to cli/graph.ts.
2. cli/graph.ts calls cli/orchestrate.ts::runGraph({cwd, ...flags}).
3. orchestrate calls pipeline/discover.ts::discoverFiles({projectDir})
   → DiscoveryOutput { projectDirAbs, files, compilerOptions }
4. orchestrate calls pipeline/inventory.ts::buildInventory({projectDirAbs, files, compilerOptions})
   → InventoryOutput { catalog, program, parseErrors }
5. orchestrate calls pipeline/edges.ts::resolveEdges({catalog, program, projectDirAbs})
   → EdgeResolutionOutput { catalog (now with calls), resolutionStats }
6. orchestrate calls pipeline/indexes.ts::buildIndexes(catalog)
   → Indexes
7. orchestrate calls each rule.evaluate(catalog, indexes, config)
   → Signal[] (concatenated)
8. cli/graph.ts picks renderer based on flags, calls render/{table,json,sarif}::render(signals)
   → stdout
9. cli/graph.ts sets exit code via cli.setExitCode(...)
```

The orchestrator is ~30 lines of straightline code. It's readable in one screen. Every interesting decision happens *inside* one of the stages.

---

## 6. Caching

Caching gets simpler with the staged design.

### 6.1 What's cached

```
<project>/opensip-tools/.runtime/cache/graph/
  catalog.json    — stages 1+2 output (FunctionOccurrence with edges)
```

That's it. Stages 0, 3, 4, 5 are not cached:
- Stage 0 (discover) is cheap (~50ms); rerun every time.
- Stage 3 (indexes) is in-memory; rebuilt from catalog on every run.
- Stage 4 (rules) is the user's interesting work; should always rerun.
- Stage 5 (render) is the output; never cached.

### 6.2 Invalidation

Three keys:
- `tsCompilerVersion` — TS upgrade invalidates everything.
- `tsConfigPath` (and its content hash) — config changes can move files in/out.
- Per-file `bodyHash` agreement — for any file present in the catalog, if its functions' bodyHashes still match, reuse them; if any differ, re-do stages 1+2 for that file.

The cache is content-keyed all the way down. There's no file-modtime check; mtime lies about what actually changed.

### 6.3 Atomic writes

`writeFileSync(tmpPath); rename(tmpPath, catalogPath)`. Prevents torn writes if two `graph` runs race.

---

## 7. The catalog file format

```jsonc
{
  "version": "2.0",
  "tool": "graph",
  "language": "typescript",
  "builtAt": "2026-05-16T12:00:00.000Z",
  "tsConfigPath": "packages/fitness/engine/tsconfig.json",
  "tsCompilerVersion": "5.7.3",
  "functions": {
    "saveBaseline": [
      {
        "bodyHash": "a3f9c204...",
        "simpleName": "saveBaseline",
        "qualifiedName": "fitness/engine/src/gate.saveBaseline",
        "filePath": "src/gate.ts",
        "line": 99,
        "column": 0,
        "endLine": 113,
        "kind": "function-declaration",
        "params": [
          {"name": "output", "optional": false, "rest": false},
          {"name": "baselinePath", "optional": false, "rest": false}
        ],
        "returnType": "void",
        "enclosingClass": null,
        "decorators": [],
        "visibility": "exported",
        "inTestFile": false,
        "definedInGenerated": false,
        "calls": [
          {"to": ["b2c80...", "c4d20..."], "line": 100, "column": 9, "resolution": "static", "confidence": "high", "text": "buildSarifLog(output)"},
          {"to": [],                       "line": 105, "column": 4, "resolution": "unknown", "confidence": "low",  "text": "fs.writeFileSync(...)"}
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
- Functions keyed by `simpleName` (string, not hash). Readable by humans grep-ing the cache file.
- Each value is an array — handles both "one function with this name" and "many functions with this name."
- `calls[i].to` is always an array (one element for static, many for polymorphic, empty for unresolved). Consumers don't switch on shape.
- `<arrow:...>` and `<module-init:...>` use angle-bracketed names so they can't collide with real identifiers.

---

## 8. Acceptance gates

The v0.2 implementation must pass all of these. They're carried forward from v0.1's debug history.

### 8.1 Inventory completeness

For `packages/fitness/engine`:
- Catalog must contain ≥ 91 files (every `.ts` under `src/`, including tests).
- Catalog must contain ≥ 200 function occurrences (function-declaration, arrow, method, etc.).
- Manual spot-check: every function defined in `src/gate.ts` (9 functions) is in the catalog.
- Manual spot-check: every function in `src/framework/define-check.ts` (6+ functions) is in the catalog.

### 8.2 Edge correctness

The fixtures from v0.1 carry forward as acceptance tests:
- `alias-resolution.test.ts` — `import { foo }; foo()` resolves.
- `jsx-resolution.test.ts` — `<Foo />` resolves; `<div />` does not.
- `interface-dispatch.test.ts` — `config.method()` on an interface resolves to the value declaration.
- `constructor-calls.test.ts` — `new MyClass()` resolves to the constructor.
- `module-init.test.ts` — top-level statements own a `<module-init>` pseudo-node.
- `arrow-callback-resolution.test.ts` — calls inside anonymous arrows are recorded.
- `projectdir-normalization.test.ts` — relative `--cwd` works correctly.

All seven fixtures (or their v0.2 equivalents, with the same semantics) must pass.

### 8.3 The dogfood gate

`opensip-tools graph` against opensip-tools itself: **≤ 20 orphan-subtree findings**. Same number v0.1 hit. v0.2 must not regress.

If v0.2 ships ≤ 10, that's a real improvement (the catalog-fallback path picks up cross-package `dist/*.d.ts` cases).

### 8.4 Workspace tests

All existing 1308 fitness/cli/contracts/etc. tests pass unchanged. v0.2 is internal to `@opensip-tools/graph`; it doesn't touch other packages' surfaces.

### 8.5 Lint and typecheck

`pnpm lint` (eslint + dep-cruiser) and `pnpm typecheck` clean. The dep-cruiser config gets the rules from §4 added.

---

## 9. The new dep-cruiser rules

Added to `.dependency-cruiser.cjs`:

```js
{
  name: 'graph-stage-isolation',
  severity: 'error',
  comment: 'Pipeline stages must not import each other; only orchestrate.ts wires them.',
  from: { path: '^packages/graph/engine/src/pipeline/(?!orchestrate)' },
  to:   {
    path: '^@opensip-tools/graph/.+/(?!orchestrate)',
    pathNot: '^packages/graph/engine/src/pipeline/(inventory-helpers|edge-helpers|inventory-visitors|edge-resolvers|normalize-project-dir)',
  },
},
{
  name: 'graph-rules-no-parser',
  severity: 'error',
  comment: 'Rules consume catalog/indexes only. No TypeScript imports.',
  from: { path: '^packages/graph/engine/src/rules/' },
  to:   { path: '^typescript$' },
},
{
  name: 'graph-renderers-no-pipeline',
  severity: 'error',
  comment: 'Renderers consume Signal[]. They do not read the catalog.',
  from: { path: '^packages/graph/engine/src/render/' },
  to:   { path: '^packages/graph/engine/src/(pipeline|rules)/' },
},
```

Plus the existing `graph-no-cli` and `graph-typescript-only-on-lang-typescript` rules from v0.1.

---

## 10. Implementation order

A coder agent picking this up should build in this order. Each phase is shippable as a working partial tool.

| Phase | What ships | Acceptance |
|---|---|---|
| **P0 — Skeleton** | Package structure, types.ts, Tool contract, empty pipeline modules, `graph` command runs and prints "no-op" | All packages still build; existing tests pass |
| **P1 — Stage 0 + Stage 1** | discoverFiles + buildInventory work end-to-end on fitness/engine | Inventory completeness gate (§8.1) passes |
| **P2 — Stage 2 (basic)** | Direct identifier calls, alias-following, constructor calls | `alias-resolution.test.ts`, `constructor-calls.test.ts` pass |
| **P3 — Stage 2 (advanced)** | Property access, polymorphic, JSX, interface dispatch, catalog fallback | `jsx-resolution.test.ts`, `interface-dispatch.test.ts` pass |
| **P4 — Stage 3 + orphan rule** | Indexes built; orphan-subtree rule fires | Dogfood orphan count ≤ 20 |
| **P5 — Remaining rules** | duplicated-function-body, no-side-effect-path, test-only-reachable, always-throws-branch | Each rule's fixture tests pass |
| **P6 — Rendering + cache + gate** | Table/JSON/SARIF render; cache; --gate-save / --gate-compare | All v0.1 acceptance criteria from spec §11 |
| **P7 — Dashboard panel + cleanup** | Code Paths panel in @opensip-tools/contracts; final docs | Architecture catalog updated; spec dated |

P0–P4 is the v0.2 ship target. P5+ is gravy.

---

## 11. What changes outside `packages/graph/`

Minimal. v0.2 is a rewrite of the graph package itself; the integration points are unchanged from v0.1.

- `packages/cli/src/index.ts` — same `import { graphTool } from '@opensip-tools/graph'` and `defaultToolRegistry.register(graphTool)` lines.
- `packages/cli/package.json` — same `@opensip-tools/graph: workspace:*`.
- `packages/core/src/lib/paths.ts` — keep the `'graph'` PathDomain extension and the `graphCacheDir` / `graphCatalogPath` / `graphBaselinePath` fields.
- `packages/contracts/src/persistence/store.ts` — keep `StoredSession.tool: 'fit' | 'sim' | 'graph'`.
- `.dependency-cruiser.cjs` — add the new rules from §9; existing graph-related rules stay.
- `.github/workflows/release.yml` — `@opensip-tools/graph` is already wired; no change.
- `pnpm-workspace.yaml` — `packages/graph/*` already declared.

The architecture docs need a small update:
- `docs/architecture/70-reference/01-package-catalog.md` — `@opensip-tools/graph`'s "Key exports" line should reflect v0.2's exports.
- `docs/architecture/10-mental-model/03-modular-monolith.md` — no change; layer placement is the same.

---

## 12. What's deliberately deferred to v0.3+

Calling out things that are *good ideas* but not v0.2 scope:

- **Push-based ParserClient seam** (Sourcetrail-style). v0.2 has the *staged* shape but stages 1 and 2 still use `ts.Node` directly. Future: introduce an event stream so the catalog never sees a TS node. Cost-benefit unclear until we have a second language to support.
- **Project-references / `ts.SolutionBuilder`**. Today, cross-package calls between workspace packages may still resolve through `dist/*.d.ts` and produce false-positive orphans. The catalog-fallback path mitigates this, but a proper fix needs `SolutionBuilder` integration. Track as known limitation.
- **User-authored rule plugins** (`<project>/opensip-tools/graph/checks/*.mjs`). Architecture supports it (rules are pure functions over typed inputs); we just don't expose the loader yet.
- **Confidence-aware rule output.** Rules currently emit `severity: 'error' | 'warning'`. The catalog has per-edge confidence, but rules don't yet propagate "the orphan determination is medium-confidence because some callees were unresolved." Add in v0.3.
- **Incompleteness flags.** A `file.complete` boolean per FunctionOccurrence indicating "this file had unresolved imports / `// @ts-ignore` / etc." Surfaces in dashboard. v0.3.

---

## 13. Status

Draft. Ready for user review. No code in `packages/graph/` yet on this branch (`feat/graph-v2`). After review and any edits, a coder agent (or focused human work) builds against this spec phase-by-phase.

The v0.1 spec at [`graph-tool-design.md`](./graph-tool-design.md) is preserved for historical context. v0.2 supersedes it. When v0.2 ships, that doc gets a status update marking it superseded but doesn't get deleted.

---

## Appendix A — Why a name-keyed catalog beats an id-keyed one

The v0.1 catalog was an array of `FunctionNode[]` keyed by a synthesized id. Every call resolution involved reconstructing the id from a `ts.Declaration` and searching for it. This is what produced the 569 → 20 bug-fix cycle: every resolver bug was a different way the id reconstruction could fail.

The v0.2 catalog is keyed by `simpleName`, with per-occurrence `bodyHash`. Resolution becomes: "find the simpleName, then narrow by bodyHash." Both halves are direct map lookups; neither involves reconstruction.

The user's framing forced this shape. It's structurally better for one reason: **the catalog is the authority.** The resolver doesn't synthesize ids; it looks them up. Stage 1 wrote them; stage 2 reads them. There's only one source of truth for any function's id, and it's the catalog.

This also makes the catalog **inspectable**. A user (or a future tool) can read `catalog.json` and answer "what functions named `foo` exist in this project?" in one keystroke. The id-keyed shape required parsing every entry.

## Appendix B — Why we're scrapping v0.1

The v0.1 implementation works (passes its 1366 tests, hits the ≤20 orphan gate on opensip-tools). It is also a coil of patches on a fundamentally entangled base. The four resolver bug classes (alias-following, JSX, interface-dispatch, constructor calls) were each surgical fixes; together they total ~600 LOC of patching logic that wouldn't be needed in v0.2.

Carrying v0.1 forward means carrying that complexity. Future bug fixes (cross-package `dist/*.d.ts` identity, the inevitable next set we haven't seen yet) compound on the existing patches, not on a clean base. v0.2 starts the rule additions (P4–P7 from the v0.1 spec) on a foundation that's been designed for them rather than retrofitted.

The user's call to scrap is correct. The cost (3.5–4.5 days of focused work for the rewrite) is roughly the same as the cost of the next two refactor PRs would have been. The end state is meaningfully better.
