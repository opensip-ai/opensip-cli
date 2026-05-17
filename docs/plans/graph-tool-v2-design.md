---
status: implemented
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
│   │   ├── graph.ts                      # `opensip-tools graph` action (unified report:
│   │   │                                 #   catalog summary + findings + entry points)
│   │   └── orchestrate.ts                # threads stages 0-5 together
│   ├── cache/
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── invalidate.ts
│   │   └── normalize.ts                  # shared (de)serialization helper (DRY-2)
│   ├── render/
│   │   └── types.ts                      # Renderer signature alias (PR-3)
│   ├── pipeline/
│   │   ├── inventory-visitors/
│   │   │   └── types.ts                  # InventoryVisitor signature alias (PR-5)
│   │   └── edge-resolvers/
│   │       └── types.ts                  # EdgeResolver signature alias (PR-4)
│   ├── errors.ts                         # graph-specific typed-error subclasses if needed (AC-7)
│   ├── gate.ts                           # baseline save/compare (calls into render/sarif)
│   └── __tests__/
│       └── (mirrors src/ structure, one test file per source file)
└── README.md
```

Roughly **40 source files**, each ≤ 200 LOC. Compare to v0.1's `builder.ts` at ~800 LOC. The total is similar; the *distribution* is what matters.

The signature-alias `types.ts` files under `render/`, `pipeline/inventory-visitors/`, and `pipeline/edge-resolvers/` are each tiny (≤ 10 LOC) — they exist to give the polymorphic dispatch sites a named compile-time-checked shape (PR-3, PR-4, PR-5). The package-level `types.ts` retains the `Catalog`, `FunctionOccurrence`, `CallEdge`, `Indexes` shapes; the localized `types.ts` files house only their respective signature aliases.

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
{
  name: 'graph-no-check-packs',
  severity: 'error',
  comment: 'Graph is in the tools/lang peer layer. It must not import any check pack.',
  from: { path: '^packages/graph/engine/src/' },
  to:   { path: '^@opensip-tools/checks-' },
},
{
  name: 'graph-visitors-resolvers-disjoint',
  severity: 'error',
  comment: 'Inventory visitors and edge resolvers may share helpers but not each other.',
  from: { path: '^packages/graph/engine/src/pipeline/inventory-visitors/' },
  to:   { path: '^packages/graph/engine/src/pipeline/edge-resolvers/' },
},
{
  name: 'graph-resolvers-visitors-disjoint',
  severity: 'error',
  comment: 'Symmetric counterpart of graph-visitors-resolvers-disjoint.',
  from: { path: '^packages/graph/engine/src/pipeline/edge-resolvers/' },
  to:   { path: '^packages/graph/engine/src/pipeline/inventory-visitors/' },
},
```

Plus the existing `graph-no-cli` and `graph-typescript-only-on-lang-typescript` rules from v0.1.

**Conditional rule (decided in Phase 4 of the pipeline review):** if v0.2 imports `buildSarifLog` / `chunkSarifRuns` / `reportToCloud` from `@opensip-tools/fitness` rather than reimplementing SARIF, add:

```js
// ONLY IF Phase 4 chooses fitness-imported SARIF.
{
  name: 'graph-may-import-fitness-sarif',
  severity: 'info',  // documentation, not enforcement
  comment: 'Graph imports SARIF helpers from fitness as a peer-layer dependency. Allowed cross-tool import.',
  from: { path: '^packages/graph/engine/src/render/sarif\\.ts$' },
  to:   { path: '^@opensip-tools/fitness$' },
},
```

---

## 10. Implementation phases

This is the build order an AI coder agent follows. Each phase is shippable as a working partial tool, finishes with the integrated functionality wired through every required surface, and has acceptance criteria that gate the next phase. v0.1 is scrapped — there are no compatibility shims, no migration adapters, no feature flags. Each phase produces clean code aligned with the v0.2 architecture.

**The user-facing integration surfaces every phase must consider** (the closure of "where new graph code touches the rest of the system"):

| Surface | File / location |
|---|---|
| Tool registration | `packages/cli/src/index.ts` — `defaultToolRegistry.register(graphTool)` |
| Tool contract | `packages/graph/engine/src/tool.ts` — `graphTool: Tool` |
| CLI subcommand | `packages/graph/engine/src/cli/graph.ts` (single unified command; orphans + entry-points are sections in its output) |
| Signal output | `packages/graph/engine/src/render/{table,json,sarif}.ts` consumed by `CliOutput` |
| Cache file | `<project>/opensip-tools/.runtime/cache/graph/catalog.json` |
| Path domain | `packages/core/src/lib/paths.ts` — `'graph'` PathDomain + `graphCacheDir`, `graphCatalogPath`, `graphBaselinePath` |
| Session persistence | `packages/contracts/src/persistence/store.ts` — `StoredSession.tool: 'fit' \| 'sim' \| 'graph'` |
| Dep-cruiser policy | `.dependency-cruiser.cjs` — rules from §9 |
| Dashboard | `packages/contracts/src/persistence/dashboard.ts` — Code Paths panel |
| Workspace declaration | `pnpm-workspace.yaml`, `packages/cli/package.json` (already present) |

A phase that introduces functionality but does not wire it into the relevant surface is **incomplete**. Phase acceptance requires the wiring to be present and exercised.

### Phase P0 — Skeleton, package wiring, Tool contract registration

**Goal.** A `pnpm --filter=@opensip-tools/graph build` succeeds, `opensip-tools graph --help` prints the subcommand, and the action handler returns immediately with exit code `EXIT_CODES.SUCCESS`. No analysis runs yet.

**Steps.**
1. Create `packages/graph/engine/{package.json, tsconfig.json, vitest.config.ts}`. `package.json` declares `opensipTools.kind = 'tool'` and `main`/`types` from `dist/`. Direct dependencies: `@opensip-tools/contracts`, `@opensip-tools/core`, `@opensip-tools/lang-typescript`, `commander`, `glob`, `typescript`.
2. Create `packages/graph/engine/src/types.ts` with the `Catalog`, `FunctionOccurrence`, `CallEdge`, `Param`, and `Indexes` interfaces from §2.2 and §2.4. No implementation yet.
3. Create `packages/graph/engine/src/index.ts` (public barrel) re-exporting `graphTool` from `./tool.js`.
4. Create `packages/graph/engine/src/tool.ts` with a minimal `graphTool: Tool` whose `metadata.id = 'graph'`, `metadata.version` matches `package.json`, and `register(cli, ctx)` mounts the single `graph` Commander subcommand dispatching to a no-op handler in `cli/graph.ts`.
5. Create `packages/graph/engine/src/cli/{graph,orchestrate}.ts` as no-op skeletons. The handler logs `evt: 'graph.cli.graph.start'` then returns `EXIT_CODES.SUCCESS`.
6. Create empty stage modules: `pipeline/{discover,inventory,edges,indexes}.ts`, `rules/registry.ts`, `render/{table,json,sarif}.ts`, `cache/{read,write,invalidate}.ts`, `gate.ts`. Each file exports the public function declared in §2 with a `throw new Error('not implemented')` body.
7. **Wire registration**: edit `packages/cli/src/index.ts` to add `import { graphTool } from '@opensip-tools/graph'` and `defaultToolRegistry.register(graphTool)`. Edit `packages/cli/package.json` to add `"@opensip-tools/graph": "workspace:*"`.
8. **Wire path domain**: edit `packages/core/src/lib/paths.ts` to extend `PathDomain` with `'graph'` and add `graphCacheDir`, `graphCatalogPath`, `graphBaselinePath` to `ProjectPaths`.
9. **Wire session persistence**: edit `packages/contracts/src/persistence/store.ts` to widen `StoredSession.tool` from `'fit' | 'sim'` to `'fit' | 'sim' | 'graph'`.
10. **Wire workspace**: confirm `pnpm-workspace.yaml` includes `packages/graph/*` (already present per §11).

**Acceptance.** `pnpm install && pnpm build` succeeds. `pnpm test` passes (no graph tests yet, existing 1308 tests unchanged). `opensip-tools graph --help` describes the unified subcommand. `opensip-tools graph` exits 0 and writes a session row with `tool: 'graph'`.

### Phase P1 — Stage 0 (discover) + Stage 1 (inventory)

**Goal.** `opensip-tools graph` walks the project's `tsconfig.json`, discovers source files, builds a complete catalog of function occurrences, and writes it to `catalog.json`. Edges are still empty.

**Steps.**
1. Implement `pipeline/discover.ts::discoverFiles` per §2.1. Decompose into the three internal helpers (`normalizeProjectDir`, `loadTsConfig`, `filterToSourceFiles`) — each in `pipeline/normalize-project-dir.ts` or inline. `normalizeProjectDir` lives in its own file because Stage 2 also uses it.
2. Implement `pipeline/inventory-helpers/{hash-body,synthesize-name,extract-params,extract-decorators,classify-visibility}.ts` per §2.2.
3. Implement `pipeline/inventory-visitors/{function-declaration,arrow-function,method-declaration,constructor-declaration,getter-setter,function-expression,module-init}.ts` per §2.2. Each visitor is ≤ 50 LOC, takes a `ts.Node` plus a `VisitorContext`, returns `FunctionOccurrence | null`.
4. Implement `pipeline/inventory.ts::buildInventory` per §2.2. Constructs the `ts.Program`, dispatches over node kinds to the visitors, calls `synthesizeModuleInit` once per file.
5. **Wire orchestration**: implement `cli/orchestrate.ts::runGraph` to call Stage 0 → Stage 1, then call `cache/write.ts` to persist the catalog (edges still empty). Edges resolution is a no-op pass-through this phase.
6. **Wire CLI handler**: `cli/graph.ts` constructs flags, calls `runGraph`, picks the renderer (table by default; JSON if `--json`), prints "Inventory built: N functions across M files", exits 0.
7. **Wire logger**: every visitor and helper emits structured events using `logger` from `@opensip-tools/core`. Event names: `graph.inventory.visit.<kind>`, `graph.inventory.complete`, `graph.discover.complete`.

**Acceptance.** Inventory completeness gate (§8.1) passes against `packages/fitness/engine`: catalog ≥ 91 files, ≥ 200 function occurrences, every function in `src/gate.ts` and `src/framework/define-check.ts` present. `catalog.json` written to `<project>/opensip-tools/.runtime/cache/graph/catalog.json`. Existing 1308 tests still pass.

### Phase P2 — Stage 2 (basic edge resolution)

**Goal.** Direct identifier calls, alias-followed imports, and `new X()` constructor calls resolve to catalog entries.

**Steps.**
1. Implement `pipeline/edge-helpers/{unalias-symbol,find-catalog-entry}.ts` per §2.3.
2. Implement `pipeline/edge-resolvers/{direct-call,new-expression,catalog-fallback}.ts` per §2.3. Each resolver is a pure function `(node, ctx) => ResolverVerdict`.
3. Implement `pipeline/edges.ts::resolveEdges` per §2.3. Walks every `FunctionOccurrence` body, finds call sites, dispatches to the right resolver via the kind switch, attaches `CallEdge[]` back to the (now-mutable-during-build) catalog. The output catalog is frozen on return.
4. **Wire orchestration**: `cli/orchestrate.ts::runGraph` now calls Stage 2 between Stage 1 and the cache write. The catalog written to disk includes resolved edges.
5. **Wire logger**: emit `graph.edges.resolve.<kind>`, `graph.edges.complete` with `resolutionStats`.

**Acceptance.** `alias-resolution.test.ts` and `constructor-calls.test.ts` pass against the v0.2 implementation. ResolutionStats reports ≥ 60% of call sites at `confidence: 'high'`. Existing 1308 tests pass.

### Phase P3 — Stage 2 (advanced edge resolution)

**Goal.** Property access (`obj.method()`), polymorphic dispatch (interface methods), JSX elements, and the catalog-fallback path resolve.

**Steps.**
1. Implement `pipeline/edge-resolvers/{property-access,jsx-element,polymorphic}.ts` per §2.3.
2. Extend `pipeline/edges.ts`'s dispatcher to route `PropertyAccessExpression`, `JsxElement`/`JsxSelfClosingElement`, and method calls on interface/abstract types to the new resolvers.
3. Wire `catalog-fallback.ts` as the last-resort resolver invoked when TS resolution returns no usable declaration. It uses the catalog's `simpleName` index.
4. **Wire integration**: no new surface changes; this phase enriches Stage 2 only.

**Acceptance.** `jsx-resolution.test.ts`, `interface-dispatch.test.ts`, `arrow-callback-resolution.test.ts`, `module-init.test.ts`, `projectdir-normalization.test.ts` pass. ResolutionStats reports ≥ 80% of call sites at `confidence: 'high'` or `'medium'`.

### Phase P4 — Stage 3 (indexes) + orphan-subtree rule

**Goal.** Indexes built from the catalog. The first rule (`graph:orphan-subtree`) emits Signals. The default `opensip-tools graph` command renders findings.

**Steps.**
1. Implement `pipeline/indexes.ts::buildIndexes` per §2.4. Four pure linear scans; no TS, no I/O.
2. Implement `rules/_entry-points.ts` (entry-point inference: binary, route-handler, name-match, external-caller).
3. Implement `rules/orphan-subtree.ts` per §2.5. Returns `Signal[]`.
4. Implement `rules/registry.ts` exporting an array `rules: Rule[]` containing only `orphanSubtreeRule` for now.
5. Implement `render/table.ts` and `render/json.ts` per §2.6. `render/sarif.ts` is deferred to P6.
6. **Wire orchestration**: `cli/orchestrate.ts::runGraph` now calls Stage 3 → for each rule in registry, call `rule.evaluate(catalog, indexes, config)` → concat Signals → return.
7. **Wire CLI handler**: `cli/graph.ts` chooses renderer based on `--json` flag. The default (non-JSON) output is the unified terminal report — catalog summary, findings grouped by rule (top 10 each, with overflow indicator), top 10 inferred entry points, and a one-line summary. `--json` emits the full `CliOutput` document.
8. **Wire exit codes**: handler sets `EXIT_CODES.SUCCESS` if no error-severity Signals, otherwise the appropriate code from `@opensip-tools/contracts`.

**Acceptance.** Dogfood gate passes: `opensip-tools graph` against opensip-tools itself reports ≤ 20 orphan-subtree findings. The unified `opensip-tools graph` report renders the orphans section and the entry-points section in one invocation. Existing 1308 tests pass.

### Phase P5 — Remaining rules

**Goal.** All five rules from §2.5 implemented.

**Steps.**
1. Implement `rules/duplicated-function-body.ts` (group by `bodyHash`, report groups > 1, min-line threshold).
2. Implement `rules/no-side-effect-path.ts` (transitive closure walk, flag pure subtrees).
3. Implement `rules/test-only-reachable.ts` (reachability from entry points, flag test-only).
4. Implement `rules/always-throws-branch.ts` (per-function CFG, flag always-throws branches).
5. Update `rules/registry.ts` to include all five rules.
6. **Wire integration**: no new surface; the registry change automatically surfaces the new rules through the existing orchestrator.

**Acceptance.** Each rule's per-rule fixture test passes. Total Signal count from a dogfood run is reasonable (no rule emits > 50 false positives).

### Phase P6 — Rendering, caching, gate

**Goal.** `--json`, `--report-to`, `--gate-save`, `--gate-compare` all work.

**Steps.**
1. Implement `render/sarif.ts` per §2.6. Decision per Phase 4 (DRY): either import from `@opensip-tools/fitness` or implement locally — settled in Phase 4 of the pipeline below; this phase implements whichever was decided.
2. Implement `cache/{read,write,invalidate}.ts` per §6. Atomic write via tmp + rename. Invalidation by `tsCompilerVersion`, `tsConfigPath` content hash, per-file `bodyHash` agreement.
3. Implement `gate.ts` (baseline save/compare). `--gate-save` writes the current Signal set to `<project>/opensip-tools/.runtime/cache/graph/baseline.json`. `--gate-compare` reads the baseline, diffs against current, exits non-zero if regressions.
4. **Wire orchestration**: `cli/orchestrate.ts::runGraph` consults the cache before running stages 1+2; if cache is valid, reuse. Stages 0, 3, 4, 5 always rerun.
5. **Wire CLI flags**: `cli/graph.ts` accepts `--json`, `--report-to`, `--gate-save`, `--gate-compare`, `--no-cache`. Each flag routes to the appropriate code path.

**Acceptance.** All v0.1 CLI flag behaviors reproduced on v0.2. SARIF output validates against the SARIF 2.1.0 schema. Cache hit on second run reduces wall time by ≥ 50%.

### Phase P7 — Dashboard panel + final wiring

**Goal.** The Code Paths dashboard panel exists; all integration surfaces are exercised; the package is release-ready.

**Steps.**
1. Add a `code-paths` panel to `packages/contracts/src/persistence/dashboard.ts` that consumes Signals tagged with the `graph:` prefix and renders a navigable callgraph view.
2. **Wire dashboard**: `opensip-tools dashboard` discovers graph sessions and includes the new panel.
3. Update `packages/graph/engine/README.md` with usage, flags, exit codes.
4. Verify all surfaces from the table at the top of §10 are exercised by at least one test.

**Acceptance.** End-to-end dogfood run produces a dashboard with the Code Paths panel populated. All seven acceptance fixtures pass. Existing 1308 tests pass.

### Phase T — Consolidated tests phase

This phase reorganizes every test obligation introduced by phases P0–P7, AC-1 through AC-12, PR-1 through PR-16, and DRY-1 through DRY-4 into a single coherent test plan. Each obligation is grouped by the originating phase that produced it, so a future maintainer can trace any test back to its rationale.

**Test execution.**
- `pnpm --filter=@opensip-tools/graph test` runs the package's tests.
- `pnpm test` at the workspace root runs everything (graph tests plus the 1308 existing tests).
- `pnpm typecheck` validates compile-time test seams (the `Renderer`, `EdgeResolver`, `InventoryVisitor`, `Rule` shape conformance from PR-3 / PR-4 / PR-5 / PR-1 are compile-time checks).
- `pnpm lint` runs ESLint plus dep-cruiser; the dep-cruiser run is itself a test of the new rules from §9.

**Test directory layout.**

```
packages/graph/engine/src/__tests__/
├── pipeline/
│   ├── discover.test.ts
│   ├── inventory.test.ts
│   ├── inventory-visitors/
│   │   ├── function-declaration.test.ts
│   │   ├── arrow-function.test.ts
│   │   ├── method-declaration.test.ts
│   │   ├── constructor-declaration.test.ts
│   │   ├── getter-setter.test.ts
│   │   ├── function-expression.test.ts
│   │   ├── module-init.test.ts
│   │   └── contract.test.ts                # PR-5: InventoryVisitor conformance
│   ├── inventory-helpers/
│   │   ├── hash-body.test.ts                # DRY-4
│   │   ├── synthesize-name.test.ts          # DRY-4
│   │   ├── extract-params.test.ts
│   │   ├── extract-decorators.test.ts
│   │   └── classify-visibility.test.ts
│   ├── edges.test.ts
│   ├── edge-resolvers/
│   │   ├── direct-call.test.ts
│   │   ├── property-access.test.ts
│   │   ├── jsx-element.test.ts
│   │   ├── new-expression.test.ts
│   │   ├── polymorphic.test.ts
│   │   ├── catalog-fallback.test.ts
│   │   └── contract.test.ts                # PR-4: EdgeResolver conformance
│   ├── edge-helpers/
│   │   ├── unalias-symbol.test.ts
│   │   └── find-catalog-entry.test.ts
│   ├── indexes.test.ts
│   └── normalize-project-dir.test.ts        # DRY-4
├── rules/
│   ├── orphan-subtree.test.ts
│   ├── duplicated-function-body.test.ts
│   ├── no-side-effect-path.test.ts
│   ├── test-only-reachable.test.ts
│   ├── always-throws-branch.test.ts
│   ├── _entry-points.test.ts
│   └── registry.test.ts                     # PR-1: Rule conformance
├── render/
│   ├── table.test.ts
│   ├── json.test.ts
│   ├── sarif.test.ts                        # DRY-4: SARIF integration test
│   └── contract.test.ts                     # PR-3: Renderer conformance
├── cache/
│   ├── read.test.ts
│   ├── write.test.ts
│   ├── invalidate.test.ts
│   └── normalize.test.ts                    # DRY-4
├── cli/
│   ├── graph.test.ts
│   ├── orchestrate.test.ts
│   └── exit-codes.test.ts                   # AC-12: exit-code mapping
├── tool.test.ts                             # AC-12: Tool contract conformance
├── gate.test.ts
├── architecture/
│   └── dep-cruiser-rules.test.ts            # AC-12: dep-cruiser rule unit tests
└── acceptance/
    ├── alias-resolution.test.ts
    ├── jsx-resolution.test.ts
    ├── interface-dispatch.test.ts
    ├── constructor-calls.test.ts
    ├── module-init.test.ts
    ├── arrow-callback-resolution.test.ts
    └── projectdir-normalization.test.ts
```

Plus, in fitness:

```
packages/fitness/checks-typescript/src/checks/architecture/__tests__/
├── graph-stage-language-isolation.test.ts   # AC-10
├── graph-stage-output-immutability.test.ts  # AC-10
└── graph-rule-shape.test.ts                 # AC-10
```

#### Group T-A — Tests required by P0–P7 (implementation phases)

- **Unit tests (Vitest)** — one test file per source file under `packages/graph/engine/src/`. Both ok and err paths covered for every exported function. Result-returning paths are not used (AC-8); throw-shaped error paths are tested via `expect(() => ...).toThrow(ConfigurationError)` etc.
- **Acceptance fixtures** — the seven v0.1 fixtures, ported under `__tests__/acceptance/`. Each contains a tiny synthetic project (a `fixture/` directory with `tsconfig.json` and ≤ 5 `.ts` files), runs the full pipeline against it, and asserts the resulting `Signal[]` or `Catalog` shape:
  - **`alias-resolution.test.ts`** — `import { foo }` from one file calling `foo()` resolves to the foreign declaration.
  - **`jsx-resolution.test.ts`** — `<Foo />` resolves to the component declaration; `<div />` is ignored.
  - **`interface-dispatch.test.ts`** — `config.method()` resolves through the interface to the value declaration.
  - **`constructor-calls.test.ts`** — `new MyClass()` resolves to the constructor.
  - **`module-init.test.ts`** — top-level statements own a `<module-init>` pseudo-node with the right `calls`.
  - **`arrow-callback-resolution.test.ts`** — calls inside anonymous arrows are recorded with the synthetic `<arrow:...>` name.
  - **`projectdir-normalization.test.ts`** — relative `--cwd` works correctly; symlinked paths resolve via realpath.
- **Per-stage acceptance** — Inventory completeness gate (§8.1) is a vitest test under `__tests__/acceptance/inventory-completeness.test.ts` that runs the inventory pass against `packages/fitness/engine` and asserts `≥ 91 files`, `≥ 200 occurrences`, plus the spot-check assertions on `gate.ts` and `define-check.ts`.
- **Workspace tests** — the existing 1308 fitness/cli/contracts/etc. tests must pass unchanged. Verified by `pnpm test` at the workspace root.

#### Group T-B — Tests required by §10A (architectural compliance, AC-1 through AC-12)

- **AC-2 (Tool contract)** — `tool.test.ts` asserts:
  - `graphTool.metadata.id === 'graph'`.
  - `graphTool.metadata.version` matches `package.json`'s `version` field at runtime.
  - `graphTool.commands` includes the single `graph` descriptor (orphans + entry-points are sections of its unified output, not separate subcommands).
  - The module that exports `graphTool` does not import from `@opensip-tools/cli` (compile-time test via `import { graphTool }` succeeding without `@opensip-tools/cli` installed).
- **AC-4 (Exit codes)** — `cli/exit-codes.test.ts` asserts each handler returns the correct `EXIT_CODES.*`:
  - Bad tsconfig → `CONFIGURATION_ERROR`.
  - Successful run, no error-severity Signals → `SUCCESS`.
  - Cache I/O failure → `RUNTIME_ERROR`.
  - `--report-to` upload failure → `REPORT_FAILED`.
  - `--gate-compare` with regression → `RUNTIME_ERROR` with `gateFailed: true` in `CliOutput.metadata`.
- **AC-5 (Logger conventions)** — sampled across the `__tests__` tree: each stage's test file installs a logger spy and asserts the expected `evt:` strings appear (e.g., `discover.test.ts` asserts `graph.discover.start` and `graph.discover.complete` fire).
- **AC-9 (Dep-cruiser rule additions)** — `architecture/dep-cruiser-rules.test.ts` programmatically runs dep-cruiser against synthetic violation files and asserts each rule fires:
  - `graph-stage-isolation` fires on a fake `pipeline/inventory.ts` that imports from `pipeline/edges.ts`.
  - `graph-rules-no-parser` fires on a fake `rules/foo.ts` that imports `typescript`.
  - `graph-renderers-no-pipeline` fires on a fake `render/table.ts` that imports from `pipeline/`.
  - `graph-no-check-packs` fires on a fake `pipeline/inventory.ts` that imports `@opensip-tools/checks-typescript`.
  - `graph-visitors-resolvers-disjoint` and the symmetric counterpart fire on cross-imports.
- **AC-10 (Fitness checks)** — under `packages/fitness/checks-typescript/src/checks/architecture/__tests__/`:
  - `graph-stage-language-isolation.test.ts` — positive fixture (a `pipeline/discover.ts` that uses `@opensip-tools/lang-typescript` only) passes; negative fixture (importing `typescript` directly) fails.
  - `graph-stage-output-immutability.test.ts` — positive fixture (return type uses `readonly`) passes; negative fixture (mutable return) fails.
  - `graph-rule-shape.test.ts` — positive fixture (rule exports `slug`, `defaultSeverity`, `evaluate`) passes; negative fixture (missing `slug`) fails.
- **AC-11 (Dependency policy)** — `architecture/package-deps.test.ts` reads `packages/graph/engine/package.json` and asserts the direct-deps list matches the AC-11 allow-list exactly (post-DRY-1 update: `@opensip-tools/contracts`, `@opensip-tools/core`, `@opensip-tools/fitness`, `@opensip-tools/lang-typescript`, `commander`, `glob`, `typescript`).

#### Group T-C — Tests required by §10B (software patterns, PR-1 through PR-16)

- **PR-1 (Rule interface)** — `rules/registry.test.ts` asserts every entry in `rules` has a non-empty `slug` starting with `graph:`, a valid `defaultSeverity` (`'error'` or `'warning'`), and a callable `evaluate`. Each entry is invoked with a minimal stub catalog and asserted to return `Signal[]`.
- **PR-3 (Renderer)** — `render/contract.test.ts` is a compile-time-only file that declares `const _table: Renderer = renderTable; const _json: Renderer = renderJson; const _sarif: Renderer = renderSarif;`. If any renderer drifts from the signature, `pnpm typecheck` fails.
- **PR-4 (EdgeResolver)** — `pipeline/edge-resolvers/contract.test.ts` is a compile-time-only file that declares each resolver export as `: EdgeResolver<...>`.
- **PR-5 (InventoryVisitor)** — `pipeline/inventory-visitors/contract.test.ts` is a compile-time-only file that declares the six conforming visitors as `: InventoryVisitor<...>`. `module-init.ts` is excluded with a comment explaining the deliberate exception.

#### Group T-D — Tests required by §10C (DRY, DRY-1 through DRY-4)

- **DRY-4 (Shared-helper tests)**
  - **`hash-body.test.ts`** — covers identical body collision (same hash), whitespace-only difference (same hash), comment-only difference (same hash, since `stripComments` runs first), and one-character body change (different hash).
  - **`synthesize-name.test.ts`** — covers `<arrow:filePath:line:column>` shape, `<module-init:filePath>` shape, and asserts angle-bracketed names cannot collide with valid TS identifiers.
  - **`normalize-project-dir.test.ts`** — covers absolute path passthrough, relative path resolution, symlink realpath, missing directory throws `ConfigurationError`.
  - **`cache/normalize.test.ts`** — round-trips a representative `Catalog` through `normalizeCatalogForSerialization` → JSON → parse → `normalize` and asserts byte-identical output.
  - **`render/sarif.test.ts`** — calls `renderSarif` against a fixture `CliOutput`, validates the result against the SARIF 2.1.0 schema (using a JSON schema validator), asserts the imported helpers from `@opensip-tools/fitness` are exercised.
- **DRY-1 (package reuse) audit** — `architecture/package-deps.test.ts` (already listed under T-B AC-11) doubles as the audit that no graph code reimplements logger/error/path/SARIF logic. Specifically, a static check: no file under `packages/graph/engine/src/` defines a function named `*Logger`, `*Error class extends Error`, `path.join(.runtime/cache/graph/...)`, or `buildSarifLog`. (Implemented as a small custom test, not a fitness check, since it's graph-specific.)

#### Group T-E — Negative-coverage and `.skip` audit

- No `.skip(...)` or `.todo(...)` allowed in any test file under `packages/graph/engine/src/__tests__/`. The CI test runner is configured (`vitest.config.ts`) to fail if any `.skip` or `.todo` is encountered in a test file. If a test cannot pass yet, the implementation is incomplete — fix the implementation, do not skip.
- All tests on code paths the plan removed (since v0.1 is scrapped) are absent — there is no v0.1 test file ported as-is. Every test under `__tests__/` is fresh against v0.2's structure.

#### Group T-F — Workspace regression

- `pnpm test` at the workspace root runs the full 1308 existing tests plus the new graph tests.
- `pnpm typecheck` runs across the workspace and validates the new graph types are compatible with consumers (`@opensip-tools/cli`, `@opensip-tools/contracts` if extended).
- `pnpm lint` runs ESLint plus dep-cruiser; both must be 0-error.

---

### Phase V — Consolidated validation phase

End-to-end exercise of the integrated tool against the **opensip-tools** workspace itself. Every flow is runnable from a clean shell via the CLI binary (`node packages/cli/dist/index.js graph ...`), produces deterministic output, and either passes (exit 0, expected output) or fails loudly (exit non-zero, actionable error message). Silent passes are not acceptable — the validation harness asserts both the exit code and the output shape.

The validation phase runs after **all implementation phases (P0–P7) are complete**. It is the final gate before the v0.2 release.

#### Validation flows (full set)

Each flow lists the originating phase that introduced it.

1. **`opensip-tools graph` dogfood** *(P4 acceptance)* — clean shell, no cache. Run produces ≤ 20 `graph:orphan-subtree` Signals. Asserts:
   - Exit code `EXIT_CODES.SUCCESS` (no error-severity unless gate engaged).
   - stdout matches the table renderer's expected shape.
   - Logger emits `graph.cli.graph.start` and `graph.cli.graph.complete`.

2. **`opensip-tools graph --json` dogfood** *(P4 acceptance)* — produces a parseable `CliOutput` (validated against the contracts JSON schema). The orphan-subtree section of the unified report contains only Signals with `ruleId === 'graph:orphan-subtree'`.

3. **Entry-points section dogfood** *(P4 acceptance)* — the unified `graph` report's "Entry points" section lists at least:
   - `fitnessTool` from `@opensip-tools/fitness`
   - `simulationTool` from `@opensip-tools/simulation`
   - `graphTool` from `@opensip-tools/graph`
   - The CLI's bin entry from `@opensip-tools/cli`

4. **All five rules dogfood** *(P5 acceptance)* — each rule emits at least one Signal and ≤ 50 false-positive-rate-acceptable Signals on the opensip-tools workspace. Specifically:
   - `graph:orphan-subtree` ≤ 20.
   - `graph:duplicated-function-body` ≤ 30.
   - `graph:no-side-effect-path` ≤ 50.
   - `graph:test-only-reachable` ≤ 20.
   - `graph:always-throws-branch` ≤ 10.

5. **Cache round-trip** *(P6 acceptance)* — run twice from the same shell:
   - First run: cold cache; populate `<project>/opensip-tools/.runtime/cache/graph/catalog.json`.
   - Second run: warm cache; wall time ≥ 50% reduction.
   - Output byte-identical between runs.
   - Logger emits `graph.cache.read.miss` then `graph.cache.read.hit`.

6. **Gate workflow** *(P6 acceptance)* —
   - `opensip-tools graph --gate-save` writes `<project>/opensip-tools/.runtime/cache/graph/baseline.json`. Exits `SUCCESS`.
   - `opensip-tools graph --gate-compare` against unchanged source exits `SUCCESS` with empty diff.
   - Introduce a synthetic regression (a new orphan function); `--gate-compare` exits non-zero with `gateFailed: true` in `CliOutput.metadata` and an actionable message identifying the new orphan.

7. **SARIF upload** *(P6 acceptance)* — `--report-to` against a mock cloud endpoint:
   - Produces a valid SARIF 2.1.0 document (validated against the SARIF schema).
   - Chunks at `MAX_FINDINGS_PER_CHUNK = 500` if the run produces ≥ 500 Signals (synthetic test).
   - On upload failure, exits `REPORT_FAILED`.

8. **Dashboard panel** *(P7 acceptance)* — `opensip-tools dashboard` produces an HTML report containing:
   - The Code Paths panel populated with graph Signals.
   - Navigation to specific functions referenced by the Signals.

9. **Architectural-compliance CI** *(AC-9, AC-10)* —
   - `pnpm lint` runs dep-cruiser; the new rules from §9 fire correctly.
   - `pnpm fit` runs the new fitness checks (`graph-stage-language-isolation`, `graph-stage-output-immutability`, `graph-rule-shape`); none fire on the v0.2 implementation, all fire on synthetic violations.

10. **Pattern-conformance CI** *(PR-3, PR-4, PR-5, PR-1)* — `pnpm typecheck` validates the compile-time test seams. If any renderer / resolver / visitor / rule drifts from its declared shape, typecheck fails.

11. **Surface coverage** *(P7 acceptance)* — every surface from the §10 integration-surface table is exercised by at least one validation flow above:
    - Tool registration → flow 1 (`graph` runs at all means registration succeeded).
    - Tool contract → flow 1 + AC-2 unit test.
    - CLI subcommands → flows 1, 2, 3.
    - Signal output → flows 1, 2, 4.
    - Cache file → flow 5.
    - Path domain → flows 5, 6 (paths resolved via `paths.graphCacheDir`, `paths.graphBaselinePath`).
    - Session persistence → flow 1 (session row written with `tool: 'graph'`).
    - Dep-cruiser policy → flow 9.
    - Dashboard → flow 8.

#### Validation harness

The validation harness lives at `packages/graph/engine/scripts/validate.ts`. It runs each flow in sequence, collects results, and prints a summary. CI invokes it via `pnpm --filter=@opensip-tools/graph validate`. Failure of any flow exits non-zero with a clear message.

P0–P4 plus Group T-A and T-B is the v0.2 ship target. P5–P7 plus the full Phase T (T-A through T-F) and Phase V is the v0.2 release gate.

---

### Phase D — Documentation sync

This phase runs **last**, after Phase V passes. Its purpose is to synchronize the opensip-tools project documentation with the as-built v0.2 system. The trigger is "v0.2 has shipped on `main` and the validation harness passes"; the deliverables are documentation edits that bring the published architecture docs in line with reality.

This phase is non-negotiable. A v0.2 release without these doc updates leaves the architecture catalog stale, the modular-monolith doc inaccurate, and the v0.1 spec misleadingly current.

#### D-1 — Documents to update (by absolute path)

Each entry lists the file, the change required, and the originating phase or section that drives it.

1. **`docs/architecture/70-reference/01-package-catalog.md`** — update `@opensip-tools/graph`'s entry:
   - "Role" line: "Static call-graph + dead-end analysis, six-stage staged pipeline (discover → inventory → edges → indexes → rules → render)."
   - "Key exports" line: `graphTool`, `Catalog`, `FunctionOccurrence`, `CallEdge`, `Indexes`, `Rule`, `Renderer`, `EdgeResolver`, `InventoryVisitor`.
   - "Direct dependencies" line: `@opensip-tools/contracts`, `@opensip-tools/core`, `@opensip-tools/fitness`, `@opensip-tools/lang-typescript`, `commander`, `glob`, `typescript`. Note the cross-tool import of fitness's SARIF helpers (decision DEC-3).
   - Driven by: §3 (module layout), §10A AC-11, §10C DRY-1.

2. **`docs/architecture/10-mental-model/03-modular-monolith.md`** — no layer change (graph stays in tools/lang peer layer), but update:
   - The package's role description in the layer narrative.
   - Add a sentence noting the cross-tool peer import (graph → fitness for SARIF) as a documented exception.
   - Driven by: §10A AC-1, §10C DRY-1, decision DEC-3.

3. **`docs/architecture/10-mental-model/02-tool-plugin-model.md`** — add `graphTool` to the list of first-party tools that implement the Tool contract. Currently lists `fitnessTool` and `simulationTool`.
   - Driven by: §10A AC-2.

4. **`docs/architecture/80-conventions/02-layer-policy.md`** — add the new dep-cruiser rules from §9 to the documented enforcement set:
   - `graph-stage-isolation`, `graph-rules-no-parser`, `graph-renderers-no-pipeline`, `graph-no-check-packs`, `graph-visitors-resolvers-disjoint`, `graph-resolvers-visitors-disjoint`, `graph-may-import-fitness-sarif`.
   - Note the rationale for each (one-line each).
   - Driven by: §9, §10A AC-9.

5. **`docs/architecture/50-subsystems/`** — add a new subsystem doc `04-graph-tool.md` that:
   - Describes the six-stage pipeline narratively (~3 pages).
   - Walks the data flow from §5.
   - Names the load-bearing decisions DEC-1 through DEC-5 (Appendix C).
   - Cross-references this design spec.
   - Driven by: §1, §2, §5, Appendix C. The narrative shape mirrors the existing `01-language-adapters.md`, `02-check-packs.md`, `03-architecture-gate.md`.

6. **`docs/architecture/60-surfaces/01-cli-command-tree.md`** — document the unified `graph` subcommand with its flag table. (v0.2 originally introduced `graph-orphans` and `graph-entry-points` as separate subcommands; both were folded into `graph`'s output. The doc records this history.)
   - Driven by: §10 P0 step 4, P4 step 7, P6 step 5.

7. **`docs/architecture/README.md`** — bump `last_verified` to the v0.2 release date. Add row(s) to the "How to read this" or "reading order" tables if the new subsystem doc justifies one.
   - Driven by: D-5 above.

8. **`docs/plans/graph-tool-design.md`** (the v0.1 spec) — update the frontmatter:
   ```yaml
   status: superseded
   superseded_by: ./graph-tool-v2-design.md
   superseded_on: <YYYY-MM-DD of v0.2 release>
   ```
   Add a top-of-document banner: "**Superseded by [`graph-tool-v2-design.md`](./graph-tool-v2-design.md).** This document is preserved as historical context for the v0.1 implementation that v0.2 replaced. Do not implement against this spec."
   - Driven by: §13.

9. **`docs/plans/graph-tool-v2-design.md`** (this file) — update its frontmatter on v0.2 ship:
   - `status: implemented`
   - `last_verified: <release date>`
   - Add the post-implementation checklist results (D-3 below) inline.

10. **`packages/graph/engine/README.md`** — package README created in P7 step 3. Documents:
    - Quick usage of all three subcommands.
    - Flags and exit codes (matrix from AC-4).
    - Cache and gate workflow.
    - Pointer to this design spec for architecture detail.

#### D-2 — Decisions captured in this document

The opensip-tools project does not have a `docs/decisions/` ADR directory. Per the Phase 6 prompt, load-bearing decisions are captured in **Appendix C of this document** rather than as separate ADR files. Future maintainers searching for the rationale of a graph design choice find it here. The list is in Appendix C below.

#### D-3 — Post-implementation checklist

The coder agent that builds v0.2 against this spec runs through this checklist at the end of P7, before tagging the release:

- [ ] All P0–P7 phases complete; each phase's acceptance criteria met.
- [ ] All Group T-A through T-F tests pass; `pnpm test` reports the new graph tests plus the existing 1308 tests all green.
- [ ] All 11 Phase V validation flows pass via `pnpm --filter=@opensip-tools/graph validate`.
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean (ESLint + dep-cruiser, including the seven new graph rules).
- [ ] `pnpm fit` clean (including the three new fitness checks from AC-10).
- [ ] All documents in D-1 above updated.
- [ ] v0.1 spec marked `status: superseded` (D-1 item 8).
- [ ] This v0.2 spec marked `status: implemented` with `last_verified` set.
- [ ] `packages/graph/engine/README.md` written.
- [ ] Architecture catalog reflects v0.2's exports.
- [ ] No `.skip(...)` or `.todo(...)` in any test file under `packages/graph/engine/`.
- [ ] No `console.log` in production paths.
- [ ] No raw `process.exitCode = ...` or `process.exit(...)` calls in graph.
- [ ] No generic `throw new Error(...)` in graph; every throw uses a typed error.
- [ ] All seven acceptance fixtures (§8.2) pass.
- [ ] Dogfood orphan count ≤ 20.
- [ ] Cache round-trip ≥ 50% wall-time reduction on second run.

A failure of any item blocks the release. Each item maps to a concrete check in `pnpm validate` or to a manual doc review.

---

## 10A. opensip-tools architectural compliance

The plan above must obey the codebase invariants documented in `CLAUDE.md` and enforced by `.dependency-cruiser.cjs`. This section names each invariant, locates where it applies in the v0.2 plan, and states the corrective change. Implementation phases reference back to this section by ID (e.g., "AC-3").

### AC-1 — Layer placement

`@opensip-tools/graph` sits in the **tools/lang peer layer**, alongside `@opensip-tools/fitness` and `@opensip-tools/simulation`. It depends downward on `@opensip-tools/core`, `@opensip-tools/contracts`, and `@opensip-tools/lang-typescript`. It does **not** depend on `@opensip-tools/cli`, on any check pack, or on the simulation package.

- `packages/graph/engine/src/**` — never imports from `@opensip-tools/cli`. Enforced by the existing `graph-no-cli` dep-cruiser rule (kept; see §9).
- `packages/graph/engine/src/**` — never imports from `@opensip-tools/checks-*`. Add a new rule `graph-no-check-packs` (see §9 below) to make this explicit, since check packs are conventionally above graph.
- The `@opensip-tools/lang-typescript` import is the **only** TS-shaped dependency; graph never reaches into another lang package directly.

**Locations.** Every step in P0–P7 that touches `package.json` or imports must respect this. Specifically: P0 step 1 (package.json deps), P1 step 1 (uses `@opensip-tools/lang-typescript` for `tsconfig`/program construction where possible), P4 step 7 (CLI handler imports only `@opensip-tools/contracts` types and `@opensip-tools/core` logger).

### AC-2 — Tool contract conformance

`graphTool` implements `Tool` from `@opensip-tools/core/src/tools/types.ts`. Required:
- `metadata.id = 'graph'` (stable across versions).
- `metadata.version` matches `packages/graph/engine/package.json`'s `version` field at runtime; do not hard-code.
- `commands: ToolCommandDescriptor[]` declares the single `graph` subcommand with its flags so the dispatcher can render `--help` without invoking `register`. (v0.2 originally registered `graph-orphans` and `graph-entry-points` as separate subcommands; both were folded into the unified `graph` output.)
- `register(cli, ctx)` is called once at CLI startup; it mounts Commander subcommands. The Tool itself **does not** import from `@opensip-tools/cli` — it consumes the shared `ToolCliContext` interface from `@opensip-tools/core`.

**Locations.** P0 step 4 (Tool object), P0 step 7 (registration in `packages/cli/src/index.ts`).

### AC-3 — Signal as the universal output type

Every rule emits `Signal[]` (from `@opensip-tools/core`'s `types/signal.ts`). The renderer consumes `Signal[]` via `CliOutput` from `@opensip-tools/contracts`. There is no graph-private finding shape exposed to consumers.

**Locations.** §2.5 (Rule.evaluate signature), §2.6 (renderer signatures), P4 step 3 (orphan-subtree returns `Signal[]`), P5 (all rules return `Signal[]`), P4 step 5 (renderers consume `Signal[]`).

### AC-4 — Exit codes via `EXIT_CODES`

Every CLI handler exits via `EXIT_CODES.SUCCESS | RUNTIME_ERROR | CONFIGURATION_ERROR | CHECK_NOT_FOUND | REPORT_FAILED` from `@opensip-tools/contracts`. No raw `process.exitCode = 1`. No raw `process.exit(1)`. The handler returns a `CommandResult` containing the exit code; the dispatcher applies it.

- `EXIT_CODES.SUCCESS` — analysis succeeded, no error-severity Signals.
- `EXIT_CODES.CONFIGURATION_ERROR` — bad tsconfig, missing project dir, malformed flags.
- `EXIT_CODES.RUNTIME_ERROR` — internal failure (parser crash, cache I/O failure).
- `EXIT_CODES.REPORT_FAILED` — `--report-to` failed to upload.
- Gate failure (regression detected) — `EXIT_CODES.RUNTIME_ERROR` with `gateFailed: true` in `CliOutput.metadata`, mirroring how `fit --gate-compare` signals.

**Locations.** P0 step 5, P4 step 8, P6 step 3, P6 step 5.

### AC-5 — Logger conventions

Every log event uses `logger` from `@opensip-tools/core` and emits a structured event with `evt: 'graph.<component>.<action>[.status]'`. Three-or-more-dot-separated. No `console.log` in production paths (test fixtures may use `console` for fixture output only).

Reserved event prefixes:
- `graph.cli.<command>.{start,complete,error}` — CLI handler lifecycle.
- `graph.discover.{start,complete,error}` — Stage 0.
- `graph.inventory.{visit.<kind>,complete,error}` — Stage 1.
- `graph.edges.{resolve.<kind>,complete,error}` — Stage 2.
- `graph.indexes.{build.complete}` — Stage 3.
- `graph.rules.<rule-slug>.{start,complete}` — Stage 4 per-rule.
- `graph.render.<format>.{start,complete}` — Stage 5.
- `graph.cache.{read,write,invalidate}.{hit,miss,error}` — cache operations.

**Locations.** P0 step 5 (skeleton handlers), P1 step 7, P2 step 5, every subsequent phase that adds new code.

### AC-6 — Path resolution via `resolveProjectPaths`

Every filesystem path graph touches goes through `resolveProjectPaths()` from `@opensip-tools/core/src/lib/paths.ts`. No `path.join(cwd, '...')` inline. The catalog file path, baseline path, and cache directory are obtained as `paths.graphCatalogPath`, `paths.graphBaselinePath`, `paths.graphCacheDir`.

This requires P0 step 8 to extend `PathDomain` and `ProjectPaths` accordingly. Every later cache/gate code path consumes the resolved paths, not raw strings.

**Locations.** P0 step 8 (extending paths.ts), P1 step 5 (cache write path), P6 step 2 (cache read/write/invalidate), P6 step 3 (gate baseline path).

### AC-7 — Typed errors only

Never throw a generic `Error`. Use `ValidationError`, `ConfigurationError`, `SystemError`, `TimeoutError`, or `NetworkError` from `@opensip-tools/core/src/lib/errors.ts`. If a graph-specific domain emerges (e.g., catalog corruption), define a new subclass `CatalogIntegrityError extends SystemError` in `packages/graph/engine/src/errors.ts`.

Reserved usage:
- `ConfigurationError` — bad tsconfig, missing project dir, conflicting flags.
- `ValidationError` — malformed cache file, malformed baseline.
- `SystemError` — unexpected I/O failure, parser internal error.

**Locations.** P0 step 5 (no-op handlers raise typed errors only), P1 step 1 (`discoverFiles` throws `ConfigurationError` on bad input), P6 step 2 (cache I/O wraps errors as `SystemError`).

### AC-8 — `Result<T, E>` is not introduced

The opensip-tools codebase exports `Result`, `ok`, `err` from core but uses them sparingly. Graph follows the codebase convention: rules return `readonly Signal[]` (no Result wrapper); pipeline stages return their declared output shape (no Result wrapper); failures throw typed errors. `Result` is only introduced if a future caller benefit emerges; speculative use is forbidden per the v2 architectural rule on narrow ports.

**Locations.** §2 (stage signatures stay throw-shaped), §2.5 (Rule.evaluate stays Signal[]-shaped).

### AC-9 — Dep-cruiser rule additions are sufficient and enforced

The plan's §9 declares three new rules: `graph-stage-isolation`, `graph-rules-no-parser`, `graph-renderers-no-pipeline`. Verification:

- **graph-stage-isolation** — covers the §1.1 invariant "stages don't import each other." The `pathNot` allow-list correctly exempts shared helpers (`inventory-helpers/`, `edge-helpers/`, `inventory-visitors/`, `edge-resolvers/`, `normalize-project-dir`).
- **graph-rules-no-parser** — covers the §1.4 invariant "rules don't see TypeScript." Sufficient.
- **graph-renderers-no-pipeline** — covers the §4.3 invariant "renderers don't read the catalog." Sufficient.
- **graph-no-cli** — kept; covers the AC-1 invariant.
- **graph-no-check-packs** (NEW; see below) — covers the AC-1 invariant "graph never imports from a check pack."
- **graph-typescript-only-on-lang-typescript** — kept; covers the AC-1 invariant "graph's TS dependency goes through `lang-typescript`."

The §4.4 visitors-vs-resolvers invariant is **not** covered by an existing dep-cruiser rule. Add **graph-visitors-resolvers-disjoint** (see §9 below). Without it, a contributor could create a slow regression where a visitor secretly references a resolver.

The §1.6 invariant "language coupling lives in stages 1 and 2 only" is partly covered by `graph-rules-no-parser` (no TS in rules) and `graph-renderers-no-pipeline` (no TS in renderers). Add a fitness check (see AC-10) to assert "Stage 0, Stage 3, Stage 4, Stage 5 don't import `typescript`."

### AC-10 — Fitness checks for non-dep-cruiser invariants

Every structural invariant the plan introduces must be enforced either by dep-cruiser or by a fitness check under `packages/fitness/checks-typescript/src/checks/architecture/`. Without enforcement, the rule erodes silently.

Required new fitness checks:

1. **`graph-stage-language-isolation`** (slug) — asserts files under `packages/graph/engine/src/pipeline/{discover,indexes}.ts`, `packages/graph/engine/src/render/**`, and `packages/graph/engine/src/rules/**` do not import the `typescript` package. Mirrors `graph-rules-no-parser` but expresses the broader §1.6 invariant.

2. **`graph-stage-output-immutability`** (slug) — asserts every public stage entry function declares its return type with `readonly` modifiers on top-level fields (a static check: parse the TS and require the declared type to use `readonly`). Enforces §1.1 "stages write immutable data."

3. **`graph-rule-shape`** (slug) — asserts every file under `packages/graph/engine/src/rules/*.ts` (excluding `_*.ts` and `registry.ts`) exports an object conforming to the `Rule` interface (has `slug`, `defaultSeverity`, `evaluate`).

These checks live in `packages/fitness/checks-typescript/src/checks/architecture/` next to the existing `circular-import-detection.ts`, `module-coupling-fan-out.ts`, etc. They are added to the default recipe so `pnpm fit` flags violations.

**Locations.** P0 acceptance and Phase T (tests) — define-check fixtures cover both the positive (compliant code) and negative (synthetic violation) cases.

### AC-11 — Dependency policy

Graph's `package.json` direct dependencies are limited to the v0.1 set:

- `@opensip-tools/contracts`
- `@opensip-tools/core`
- `@opensip-tools/lang-typescript`
- `commander`
- `glob`
- `typescript`

Adding any other direct dependency requires explicit justification in this section. Specifically:

- **No new direct dependencies are added in v0.2.** The plan introduces no functionality that requires a new dep. The catalog is JSON; SARIF construction is either shared with fitness (Phase 4 decision) or built with the existing `typescript` import.
- If Phase 4 (DRY) decides graph imports `buildSarifLog`/`chunkSarifRuns`/`reportToCloud` from `@opensip-tools/fitness`, that is a peer-layer dependency — both fitness and graph sit at the tools/lang peer layer in the dep-cruiser graph. Add an explicit dep-cruiser exception **graph-may-import-fitness-sarif** in §9 below if and only if Phase 4 chooses that direction.

**Locations.** P0 step 1 (deps list), Phase 4 (DRY) decision on SARIF.

### AC-12 — Tests for architectural assertions

The tests phase (Phase T) is extended to verify the architectural assertions this section introduces:

- **Dep-cruiser rule unit tests** — for each new rule (`graph-stage-isolation`, `graph-rules-no-parser`, `graph-renderers-no-pipeline`, `graph-no-check-packs`, `graph-visitors-resolvers-disjoint`), a test that runs dep-cruiser against a synthetic violation file and asserts the rule fires. Lives under `packages/graph/engine/src/__tests__/architecture/dep-cruiser-rules.test.ts`.
- **Fitness check tests** — each new fitness check (`graph-stage-language-isolation`, `graph-stage-output-immutability`, `graph-rule-shape`) ships with positive and negative fixtures under `packages/fitness/checks-typescript/src/checks/architecture/__tests__/`.
- **Tool contract test** — verifies `graphTool.metadata.id === 'graph'`, the three commands are registered, and the registration does not require `@opensip-tools/cli` at import time. Lives at `packages/graph/engine/src/__tests__/tool.test.ts`.
- **Exit-code mapping test** — verifies each CLI handler returns the correct `EXIT_CODES.*` for each failure shape. Lives at `packages/graph/engine/src/__tests__/cli/exit-codes.test.ts`.

These obligations are folded into the Phase T scaffold's "Architectural-compliance tests" bucket.

---

## 10B. Software patterns: SOLID & Gang of Four review

A pattern is justified by complexity that already exists, not by aesthetic preference. This section reviews each abstraction the plan introduces, flags any that appear over- or under-engineered, and prescribes the corrected shape. The codebase rule applies: **a new interface, abstract base, or pattern scaffold is only justified by a named test seam or a named compile-time invariant.**

### PR-1 — `Rule` interface (§2.5): justified, kept

**Status.** Five rules ship in v0.2 (`orphan-subtree`, `duplicated-function-body`, `no-side-effect-path`, `test-only-reachable`, `always-throws-branch`). Each is genuinely polymorphic over the same shape: `(catalog, indexes, config) => Signal[]`. The interface is consumed by the orchestrator's "for each rule, evaluate" loop, which is the **named compile-time invariant** that justifies the abstraction.

**Concrete check.** Every rule must conform to `Rule` exactly. No rule may extend the interface with side-channel parameters; if a rule needs more context, the `GraphConfig` parameter carries it. This keeps the orchestrator's `for (const rule of rules) { rule.evaluate(catalog, indexes, config); }` loop honest.

**Affirmed.** `Rule` stays as defined in §2.5. The fitness check `graph-rule-shape` from AC-10 enforces conformance at build time.

### PR-2 — Stage entry functions (§2.1–§2.4): not interfaces, just typed functions

**Status.** The plan declares a typed function for each stage (`discoverFiles`, `buildInventory`, `resolveEdges`, `buildIndexes`). It does **not** wrap them in a `Stage` interface. This is correct.

**Why no `Stage` interface.** Each stage takes a different input shape and returns a different output shape. There is no polymorphic call site; the orchestrator calls each stage by name, in order. A `Stage<Input, Output>` interface would obscure rather than clarify — the orchestrator's body would be the same six lines either way, and readers would lose the type information at the call site.

**Pattern called out and rejected.** Strategy with one strategy per stage is not a strategy; it's just a function. The plan correctly avoids it.

**Affirmed.** Stage entry points stay as typed functions. No `Stage` interface introduced.

### PR-3 — Renderers (§2.6): justified, kept; common signature documented

**Status.** Three renderers (`table`, `json`, `sarif`). Each conforms to `(signals: Signal[], context: RenderContext) => string`. The CLI handler (`cli/graph.ts`) picks one based on flags. The polymorphism is real and the call site is one line.

**Concrete check.** All three renderers must take `Signal[]` plus `RenderContext` and return `string`. The renderer registry is implicit (a switch in the CLI handler); a Map-keyed registry would be over-engineering for three values that change once per release.

**Decision.** Add a shared `Renderer` type alias in `packages/graph/engine/src/render/types.ts`:

```ts
export type Renderer = (signals: readonly Signal[], context: RenderContext) => string;
```

Each renderer declares its export as `: Renderer` to make conformance compile-time-enforced. No `Renderer` interface, no class hierarchy. The named compile-time invariant is "all three renderers have the same call signature."

### PR-4 — Edge resolvers (§2.3): polymorphic dispatch over a kind tag — pattern correctly applied

**Status.** Six resolvers (`direct-call`, `property-access`, `jsx-element`, `new-expression`, `polymorphic`, `catalog-fallback`). Each is a pure function `(node, ctx) => ResolverVerdict`. The dispatcher (`resolveCallSite`) is "one switch over node kind, calling the right classifier."

**Pattern call.** This is the canonical replacement-of-conditional-with-polymorphism pattern from GoF. The v0.1 implementation had a long `switch (node.kind)` chain with bodies inline; v0.2 splits each branch into a named function. The names are a documentation win.

**Concrete check.** Each resolver must:
1. Be a pure function (no module-level mutable state).
2. Take exactly `(node, ctx) => ResolverVerdict`.
3. Be safely callable in any order, in isolation.

**Decision.** Define the shared resolver signature in `packages/graph/engine/src/pipeline/edge-resolvers/types.ts`:

```ts
export type EdgeResolver<N extends ts.Node = ts.Node> = (node: N, ctx: ResolverContext) => ResolverVerdict;
```

Each resolver declares its export as `: EdgeResolver<...>`. No abstract base class. The dispatcher remains a switch — *not* a Map-keyed registry, because the keys are TS `SyntaxKind` numbers and the switch is the idiomatic shape for that.

### PR-5 — Inventory visitors (§2.2): polymorphic dispatch, same justification

**Status.** Seven visitors (`function-declaration`, `arrow-function`, `method-declaration`, `constructor-declaration`, `getter-setter`, `function-expression`, `module-init`). Each takes a `ts.Node` plus context and returns `FunctionOccurrence | null`.

**Pattern call.** Same as PR-4: replacing a long `switch (node.kind)` with named functions.

**Concrete check.** Add a shared `InventoryVisitor` signature in `packages/graph/engine/src/pipeline/inventory-visitors/types.ts`:

```ts
export type InventoryVisitor<N extends ts.Node = ts.Node> =
  (node: N, ctx: VisitorContext) => FunctionOccurrence | null;
```

`module-init.ts` is the **outlier** — it doesn't dispatch on a single node; it walks all top-level statements of a `ts.SourceFile` and emits exactly one synthetic `FunctionOccurrence`. Its signature is `(sourceFile: ts.SourceFile, ctx: VisitorContext) => FunctionOccurrence`. **It does not implement `InventoryVisitor`.** That's fine — it's a different pattern (one-per-file synthesis, not per-node visit), and forcing it into the same interface would require a fake `ts.Node` parameter and harm clarity.

**Decision.** Six of seven visitors conform to `InventoryVisitor`. `module-init.ts` is documented as an exception in its file header and in §2.2 of this spec.

### PR-6 — Rule registry (`rules/registry.ts`): plain array, not a Registry pattern

**Status.** §2.5 / P4 step 4 declares `rules/registry.ts` "exports the rule list."

**Decision.** This is a `const rules: readonly Rule[] = [orphanSubtreeRule, /* ... */]`. It is **not** a Registry singleton, has no `register()`/`get()`/`unregister()` methods, and never holds runtime mutable state. v0.2 does not support user-loaded rules at runtime (deferred to v0.3 per §12). When that ships, it will introduce a real registry; until then, an array is the correct shape.

**Concrete check.** `rules/registry.ts` exports exactly one symbol: `export const rules: readonly Rule[]`. No class, no factory, no singleton.

### PR-7 — Stage outputs and immutability (§1.1): structural enforcement

**Status.** Plan §1.1 says "stages write immutable data." TypeScript can express this via `readonly` modifiers on the output types. The plan's `Catalog`, `FunctionOccurrence`, `CallEdge`, `Indexes` already use `readonly`.

**Concrete check.** Every stage entry function's return type uses `readonly` on top-level fields and `readonly` arrays on collections. This is enforced by AC-10's `graph-stage-output-immutability` fitness check.

**Decision.** No new pattern. The existing `readonly` discipline plus the fitness check is sufficient.

### PR-8 — Orchestrator (`cli/orchestrate.ts`): straight-line code, not a Chain of Responsibility

**Status.** §5 documents the orchestrator as ~30 lines of straight-line code: `runGraph(input) → discover → inventory → edges → indexes → forEach(rule) → render`.

**Pattern called out and rejected.** Chain of Responsibility, Pipeline pattern with explicit `next()` calls, or a `Pipeline` class. None of these are justified — the call shape is fixed at design time, the stages are typed differently, and the call graph fits on a screen. A `Pipeline` abstraction would force every stage to share a type (PR-2 covers why this is wrong).

**Decision.** `runGraph` is a plain async function. No pattern.

### PR-9 — Cache (§6, P6 step 2): three small functions, not a Repository

**Status.** Plan §6 / P6 step 2 declares `cache/{read,write,invalidate}.ts`. Three functions, not a Cache class.

**Decision.** Each file exports one function: `readCatalog`, `writeCatalog`, `invalidateCatalog`. No Repository pattern, no `CacheManager` class. The cache directory path is resolved through `paths.graphCacheDir` (AC-6), the file format is the catalog JSON from §7, and the invalidation logic is content-keyed.

**Concrete check.** No mutable global. No class. Three pure functions. If a fourth piece of cache logic emerges, evaluate then.

### PR-10 — Single Responsibility audit per stage module

Reviewing each module for SRP violations:

- **`pipeline/discover.ts`** — does file discovery + tsconfig parsing. The two are coupled ("which files does this tsconfig declare?"); separating them would create a fake boundary. **OK.**
- **`pipeline/inventory.ts`** — orchestrates the visitors but does not implement them. The visitors live in `inventory-visitors/`, the helpers in `inventory-helpers/`. **OK.**
- **`pipeline/edges.ts`** — orchestrates the resolvers but does not implement them. **OK.**
- **`pipeline/indexes.ts`** — four linear scans, all purely indexing. **OK.**
- **`rules/orphan-subtree.ts`** — does entry-point inference (delegated to `_entry-points.ts`) plus orphan detection. **OK** with delegation in place.
- **`render/sarif.ts`** — produces SARIF JSON. If Phase 4 (DRY) decides graph imports `buildSarifLog` from fitness, this file becomes a 5-line wrapper. Either way, single-responsibility.

**Decision.** No SRP violations identified in the plan.

### PR-11 — Open/Closed audit (per SOLID)

The plan is open for extension where it should be (new rules, new resolvers, new visitors) and closed against modification (the `Rule` shape, the `Catalog` shape, the stage interfaces). New rules don't require touching the orchestrator; they're added to `rules/registry.ts`. New resolvers don't require touching `edges.ts`; they're added to the dispatcher's switch. The switch *is* a modification site for new resolvers, but the alternative — a Map-keyed dispatch — would require resolvers to know the syntax kinds they handle, which isn't a runtime property.

**Decision.** The plan's open/closed posture is correct as drafted.

### PR-12 — Liskov audit

No inheritance hierarchies in the plan. Visitors and resolvers are functions, not classes. Rules conform to an interface (not extend a base class). LSP is trivially satisfied.

### PR-13 — Interface Segregation audit

`Rule` exposes exactly three things: `slug`, `defaultSeverity`, `evaluate`. No optional methods, no kitchen-sink interface. `Tool` from `@opensip-tools/core` exposes `metadata`, `commands`, `register` — minimal and consumed by every Tool. **No ISP violations.**

### PR-14 — Dependency Inversion audit

The orchestrator depends on the `Rule` interface, not on concrete rule implementations. Renderers depend on `Signal[]`, not on the catalog. Stage interfaces are typed shapes, not concrete classes. **DI is correctly applied where it matters; not over-applied where it doesn't.**

### PR-15 — Anti-patterns explicitly rejected

The following patterns are **NOT** introduced; if a future maintainer is tempted, this is the documented rejection:

- **Visitor pattern (full GoF)** — the plan uses "visitor" colloquially (`visitFunctionDeclaration`) but does not implement the GoF Visitor with a double-dispatch `accept(visitor)` method. TS source nodes are not under our control; we can't add `accept`. The pattern would not buy anything here.
- **Strategy with one or two strategies** — every polymorphic site has ≥3 implementations. Strategy is not introduced for fewer.
- **Factory** — every constructor in the plan returns one concrete shape; no factory is needed. The cache `read/write/invalidate` functions are not factories — they are operations.
- **Singleton** — the `defaultToolRegistry` from `@opensip-tools/core` is the only singleton in the path, and it is owned by core, not graph.
- **Observer / Pub-sub** — the catalog → edges → indexes flow is synchronous and sequential. No observers.

### PR-16 — Tests for pattern conformance

Phase T (tests) is extended to cover the pattern decisions:

- **`Rule` conformance test** — `packages/graph/engine/src/__tests__/rules/registry.test.ts` asserts every entry in `rules` has a non-empty `slug` starting with `graph:`, a valid `defaultSeverity`, and a callable `evaluate`. (This is the test seam for the `Rule` polymorphism.)
- **`EdgeResolver` conformance test** — `packages/graph/engine/src/__tests__/pipeline/edge-resolvers/contract.test.ts` asserts every resolver export type-checks as `EdgeResolver<...>`. (Compile-time test seam.)
- **`InventoryVisitor` conformance test** — same shape, for the six conforming visitors.
- **`Renderer` conformance test** — `packages/graph/engine/src/__tests__/render/contract.test.ts` asserts each renderer typechecks as `Renderer`.

These obligations fold into Phase T's "Pattern-seam tests" bucket.

---

## 10C. DRY: package reuse and code-level deduplication

DRY operates at two scales. First, **package-level reuse** — does an existing opensip-tools package already provide this capability? Second, **code-level deduplication** — within graph itself, is the same concept expressed twice? Package-level reuse is the higher-leverage check; code-level dedup is governed by the rule of three (two occurrences are coincidence, three justify extraction).

### DRY-1 — Package reuse audit

For every capability the plan needs, check whether an existing package already provides it. Where one does, the plan must consume it rather than reinvent.

#### Logger, errors, IDs, retry, paths → `@opensip-tools/core`

- **Logger.** Use `logger` from `@opensip-tools/core` (AC-5). No reinvention.
- **Errors.** Use `ToolError`, `ValidationError`, `ConfigurationError`, `SystemError`, `NotFoundError`, `TimeoutError`, `NetworkError` from `@opensip-tools/core` (AC-7). No new error subclasses unless a graph-specific domain emerges.
- **IDs.** Use `generateId`, `generatePrefixedId`, `generateUUID` from `@opensip-tools/core` if any opaque identifier is needed (e.g., a session id when graph writes to the session store). Do not roll a custom id generator.
- **Retry.** Use `withRetry` from `@opensip-tools/core` for any I/O operation that needs retries (e.g., `--report-to` upload). Do not reimplement retry logic.
- **Paths.** Use `resolveProjectPaths` from `@opensip-tools/core/lib/paths.ts` (AC-6). The `'graph'` PathDomain extension and the `graphCacheDir` / `graphCatalogPath` / `graphBaselinePath` fields are added in P0 step 8.

**Plan adjustment.** Phase steps that mention paths or logging must explicitly call out the existing helpers. P1 step 7 already does for the logger; the cache and gate phases (P6 steps 2 and 3) must reference `paths.graphCacheDir` and `paths.graphBaselinePath` explicitly rather than constructing paths inline.

#### Signal types, exit codes, persistence helpers → `@opensip-tools/contracts`

- **`Signal`, `SignalSeverity`, `SignalCategory`, `CreateSignalInput`, `FixHint`** — all from `@opensip-tools/core` (re-exported through fitness for backward compat, but graph imports from core). Rules emit `Signal[]` (AC-3).
- **`EXIT_CODES`** — from `@opensip-tools/contracts` (AC-4). The `RUNTIME_ERROR_BY_REASON` table maps internal failure modes to exit codes; reuse it where applicable.
- **`CliOutput`** — from `@opensip-tools/contracts`. The renderer's JSON output is a `CliOutput`; do not invent a graph-specific JSON shape.
- **`StoredSession`** — from `@opensip-tools/contracts/persistence/store.ts`. P0 step 9 widens its `tool` field to include `'graph'`. Graph writes its session via the existing `persistSession()` helper, not via a custom path.
- **Dashboard generator** — from `@opensip-tools/contracts/persistence/dashboard.ts`. P7 step 1 extends the existing dashboard with a Code Paths panel; it does not stand up a parallel HTML generator.

#### TypeScript parsing + AST helpers → `@opensip-tools/lang-typescript`

`@opensip-tools/lang-typescript` already exports a rich set of AST utilities. Graph **must** consume them rather than reinvent equivalents:

- `getSharedSourceFile(filePath, content)` — produces a `ts.SourceFile`, cache-aware.
- `walkNodes`, `findCallExpressions`, `findBinaryExpressions`, `findTemplateLiterals` — visitor utilities.
- `getIdentifierName`, `getPropertyChain`, `getLineNumber`, `getColumn` — node introspection.
- `isPropertyAccess`, `isLiteral`, `isInStringLiteral`, `isInComment` — predicates.
- `stripStrings`, `stripComments`, `filterContent` — needed by §2.2's `hashFunctionBody` (specifically `stripComments`).
- `parseSource` — direct parsing fallback.
- `ts` — the TypeScript module re-export, for the rare case graph needs `ts.SyntaxKind` enum constants.

**Plan adjustment.** §2.2's `hashFunctionBody` declared:
```ts
const normalized = normalizeWhitespace(stripComments(text));
```
The `stripComments` import must come from `@opensip-tools/lang-typescript`. `normalizeWhitespace` is graph-local (no equivalent in lang-typescript), but the plan must justify it as a 5-line helper, not a new utility module.

§2.2's visitors that walk AST nodes must use `walkNodes` from `lang-typescript` rather than rolling their own `forEachChild` recursion. §2.3's resolvers that introspect call expressions must use `findCallExpressions`, `getIdentifierName`, `getPropertyChain` where their behaviors match.

The pipeline does **not** import the `typescript` package directly outside stages 1 and 2 (AC-1, AC-9, AC-10). Stages 1 and 2 may import `ts` from `@opensip-tools/lang-typescript` rather than from `typescript` to make the routing visible.

#### Cache file shape and conventions → match existing `parse-cache`

The fitness/core packages already operate AST and prewarm caches under `<project>/opensip-tools/.runtime/cache/{ast,glob}/`. Graph's cache lands at `<project>/opensip-tools/.runtime/cache/graph/catalog.json` (already declared in §6).

**Conventions to match:**
- **Atomic writes** via tmp + rename (already declared §6.3).
- **Content-keyed invalidation** (already declared §6.2). No mtime checks.
- **Logger event prefix** `graph.cache.<op>.<status>` (AC-5).
- **JSON serialization** with `JSON.stringify(catalog, null, 2)` for human readability (the existing AST cache is binary; the graph catalog is JSON because it is human-inspectable per Appendix A).

These are conventions — there is no shared cache-writing helper in core or contracts to reuse. Graph implements `cache/{read,write,invalidate}.ts` itself but follows the conventions above.

#### SARIF output → DECISION required

**Decision (Phase 4 picks one).**

Two options:
- **Option A: Import from `@opensip-tools/fitness`.** Reuse `buildSarifLog`, `chunkSarifRuns`, `reportToCloud` from `packages/fitness/engine/src/sarif.ts`. Zero duplicated code. Cross-tool dependency at the peer layer.
- **Option B: Reimplement locally** in `packages/graph/engine/src/render/sarif.ts`. No cross-tool dep. Duplicates ~100 LOC.

**Decision: Option A — import from `@opensip-tools/fitness`.**

**Rationale.**
1. The functions accept `CliOutput` (a `@opensip-tools/contracts` shape), which is exactly what graph produces. No shape adapter needed.
2. SARIF 2.1.0 schema compliance, chunking semantics (`MAX_FINDINGS_PER_CHUNK = 500`), and cloud upload retry behavior (`withRetry`) are non-trivial. Two implementations would drift.
3. Both fitness and graph sit at the tools/lang peer layer. A peer-to-peer import is allowed by dep-cruiser; only the kernel layer rules (`core` upward) are inviolable.
4. The deferred extraction to `@opensip-tools/sarif` (originally planned for v0.1) becomes mechanical when both consumers (fit and graph) already import from a single source. Splitting later is a refactor; rebuilding a parallel implementation is duplicate maintenance forever.

**Trade-off accepted.** Graph's `package.json` declares no `@opensip-tools/fitness` dep today; this option adds one. The cross-tool import is unconventional but documented (AC-11 conditional rule, §9 conditional dep-cruiser exception). The architectural ADR for this decision is captured in Appendix C.

**Plan implication for P6 step 1.** `render/sarif.ts` becomes a 5-line wrapper:
```ts
import { buildSarifLog, chunkSarifRuns, reportToCloud } from '@opensip-tools/fitness';
import type { CliOutput } from '@opensip-tools/contracts';

export function renderSarif(output: CliOutput): string {
  return JSON.stringify(buildSarifLog(output), null, 2);
}

export { chunkSarifRuns, reportToCloud };
```

**Plan implication for AC-11 / §9.** The conditional `graph-may-import-fitness-sarif` rule from §9 is now **active**, not conditional. Graph's `package.json` adds `"@opensip-tools/fitness": "workspace:*"` as a direct dep.

### DRY-2 — Code-level dedup audit

Apply the rule of three within graph. Two occurrences = coincidence; three or more = extract.

#### Shared helpers already declared (correctly)

- **`hashFunctionBody`** (§2.2) — used by stage 1 (every visitor, to compute the catalog entry's bodyHash) and stage 2 (resolver's `findCatalogEntry`). Two callers explicitly. **One more usage** (in the cache invalidation path, §6.2 "per-file `bodyHash` agreement") makes three. Lives at `pipeline/inventory-helpers/hash-body.ts`. Imported by visitors, by `find-catalog-entry.ts`, and by `cache/invalidate.ts`. **Affirmed: extract.**
- **`synthesizeSimpleName`** (§2.2) — every visitor calls into it for unnamed nodes. Seven callers. **Affirmed: extract.** Lives at `pipeline/inventory-helpers/synthesize-name.ts`.
- **`normalizeProjectDir`** (§2.1, also referenced by stage 2) — two callers (stage 0 and stage 2). **One more usage** (cache invalidation reads `tsConfigPath` and must normalize it the same way) makes three. **Affirmed: extract.** Lives at `pipeline/normalize-project-dir.ts`.

#### Helpers under scrutiny (rule of three)

- **`pipeline/inventory-helpers/extract-params.ts`** — extracts `Param[]` from a `ts.Node`. Used by visitors that produce `FunctionOccurrence`. The seven inventory visitors call this. **Affirmed: extract.**
- **`pipeline/inventory-helpers/extract-decorators.ts`** — extracts decorator strings. Used by visitors that emit `decorators`. Three potentially apply (`function-declaration`, `method-declaration`, `getter-setter`). **Affirmed: extract** — three is the threshold.
- **`pipeline/inventory-helpers/classify-visibility.ts`** — produces `'exported' | 'module-local' | 'private'`. Used by every visitor. Seven callers. **Affirmed: extract.**

#### Edge resolvers — parallel signatures, but each is genuinely different

The six resolvers (PR-4) take the same `(node, ctx) => ResolverVerdict` signature, but their bodies are not parallel. `direct-call` does symbol resolution; `property-access` walks the `getPropertyChain`; `jsx-element` looks at component identifiers; `new-expression` finds the constructor declaration; `polymorphic` collects all implementing classes; `catalog-fallback` does a simpleName lookup. **No further dedup justified.** The shared signature is the only commonality, and PR-4 already encodes that as the `EdgeResolver` type alias.

#### Inventory visitors — same answer

Six conforming visitors plus `module-init` (PR-5). Their bodies are not parallel — each handles a distinct AST shape. The shared `InventoryVisitor` type alias from PR-5 is sufficient.

#### Catalog read/write — single normalization step

Per the rule, both `cache/read.ts` and `cache/write.ts` (also `cache/invalidate.ts`) must agree on the catalog's normalized form. **Decision.** A single function `normalizeCatalogForSerialization(catalog: Catalog): SerializedCatalog` lives in `cache/normalize.ts` and is consumed by both write and read paths. Without it, the read path could subtly diverge from the write path (sorting differences, optional-field defaults).

This is an extraction with two callers today; the rule of three says wait. **Exception justified:** the named compile-time invariant is "what we wrote is exactly what we read" — a single shared function is the only way to compile-time-enforce that. **Affirmed: extract.**

#### TypeScript node walk — already provided

§2.2's visitors must NOT roll a custom `ts.forEachChild` recursion. Use `walkNodes` from `@opensip-tools/lang-typescript` (per DRY-1). This is a package-reuse extraction, not a graph-internal one.

#### Things explicitly NOT to dedup

- **Per-rule configuration shapes** — each rule's slice of `GraphConfig` is intentionally narrow. Do not introduce a base `RuleConfig` interface; each rule typing is its own concern.
- **Per-renderer output structure** — table renders ASCII, JSON renders nested objects, SARIF renders SARIF runs. Three different shapes; no shared helper.
- **Test fixtures** — the seven acceptance fixtures (§8.2) live in seven separate test files with seven separate fixture directories. Do not factor them through a "fixture factory" — each test's setup must be readable in one screen.

### DRY-3 — Plan-step adjustments

Concrete edits to the implementation phases triggered by the DRY audit:

- **P0 step 1.** `package.json` direct dependencies updated to:
  `@opensip-tools/contracts`, `@opensip-tools/core`, `@opensip-tools/fitness` (NEW, for SARIF helpers), `@opensip-tools/lang-typescript`, `commander`, `glob`, `typescript`. AC-11 is updated to permit the fitness dep with explicit rationale.
- **P1 step 2.** `inventory-helpers/{hash-body, synthesize-name, extract-params, extract-decorators, classify-visibility}.ts` import `stripComments`, `walkNodes`, `getLineNumber`, `getColumn`, `getIdentifierName` from `@opensip-tools/lang-typescript` rather than from `typescript` directly.
- **P1 step 3.** Each inventory visitor uses `walkNodes` for any sub-traversal of its node body. Visitors do not import `typescript` directly except where they must reference `ts.SyntaxKind` constants in a switch.
- **P2 step 1.** `edge-helpers/find-catalog-entry.ts` imports `hashFunctionBody` from `inventory-helpers/hash-body.ts`. No reimplementation.
- **P2 step 2.** Resolvers use `findCallExpressions`, `getPropertyChain`, `getIdentifierName` from `@opensip-tools/lang-typescript` where the existing helpers match.
- **P6 step 1.** `render/sarif.ts` imports `buildSarifLog`, `chunkSarifRuns`, `reportToCloud` from `@opensip-tools/fitness`. No SARIF construction logic in graph.
- **P6 step 2.** `cache/normalize.ts` is added (a new file beyond §3's module layout). Both `cache/read.ts` and `cache/write.ts` import it.
- **P6 step 3.** `gate.ts` imports `paths.graphBaselinePath` from `@opensip-tools/core` rather than constructing the path inline.

### DRY-4 — Tests for shared code

Phase T (tests) is extended to cover newly extracted shared code:

- **`hashFunctionBody` test** — `pipeline/inventory-helpers/__tests__/hash-body.test.ts` covers identical-body collision, whitespace-only difference, comment-only difference (must not change hash), and one-character-body change (must change hash).
- **`synthesizeSimpleName` test** — covers the angle-bracket naming (`<arrow:...>`, `<module-init:...>`) and ensures synthesized names don't collide with valid identifiers.
- **`normalizeProjectDir` test** — covers absolute path, relative path, symlink, missing directory (throws `ConfigurationError`).
- **`cache/normalize.ts` test** — round-trips a representative `Catalog` through write→read and asserts byte-identical output.
- **SARIF integration test** — calls `render/sarif.ts::renderSarif` against a fixture `CliOutput`, validates the result against the SARIF 2.1.0 schema. Verifies the import chain to `@opensip-tools/fitness` works at runtime.

These obligations fold into Phase T's "Shared-helper tests" bucket.

---

## 11. What changes outside `packages/graph/`

v0.2 introduces small but real changes to packages outside `packages/graph/`. Each is necessary; each is enumerated.

### 11.1 Source-code edits

- **`packages/cli/src/index.ts`** — add `import { graphTool } from '@opensip-tools/graph'` and `defaultToolRegistry.register(graphTool)`. (P0 step 7.)
- **`packages/cli/package.json`** — add `"@opensip-tools/graph": "workspace:*"` to dependencies. (P0 step 7.)
- **`packages/core/src/lib/paths.ts`** — extend `PathDomain` with `'graph'`; add `graphCacheDir`, `graphCatalogPath`, `graphBaselinePath` to `ProjectPaths`. (P0 step 8 / AC-6.)
- **`packages/contracts/src/persistence/store.ts`** — widen `StoredSession.tool` from `'fit' | 'sim'` to `'fit' | 'sim' | 'graph'`. (P0 step 9.)
- **`packages/contracts/src/persistence/dashboard.ts`** — add the Code Paths panel. (P7 step 1.)
- **`packages/fitness/checks-typescript/src/checks/architecture/`** — add three new fitness checks: `graph-stage-language-isolation.ts`, `graph-stage-output-immutability.ts`, `graph-rule-shape.ts`. Re-export from `architecture/index.ts`. (AC-10.)
- **`packages/fitness/checks-typescript/src/display/architecture.ts`** (or equivalent) — add display entries for the three new checks.

### 11.2 Configuration edits

- **`.dependency-cruiser.cjs`** — add the rules from §9: `graph-stage-isolation`, `graph-rules-no-parser`, `graph-renderers-no-pipeline`, `graph-no-check-packs`, `graph-visitors-resolvers-disjoint`, `graph-resolvers-visitors-disjoint`, `graph-may-import-fitness-sarif`. Existing `graph-no-cli` and `graph-typescript-only-on-lang-typescript` rules stay.
- **`.github/workflows/release.yml`** — `@opensip-tools/graph` is already wired; no change.
- **`pnpm-workspace.yaml`** — `packages/graph/*` already declared; no change.
- **Default fitness recipe** — ensure the three new architecture checks are included so `pnpm fit` runs them by default.

### 11.3 Documentation edits

The complete list of architecture-doc changes is captured in **Phase D, item D-1** above, since those edits are part of the documentation-sync phase rather than the implementation phases. Summary pointers:

- **`docs/architecture/70-reference/01-package-catalog.md`** — update graph's entry. (D-1 item 1.)
- **`docs/architecture/10-mental-model/03-modular-monolith.md`** — note the cross-tool peer import. (D-1 item 2.)
- **`docs/architecture/10-mental-model/02-tool-plugin-model.md`** — add `graphTool` to the first-party-tools list. (D-1 item 3.)
- **`docs/architecture/80-conventions/02-layer-policy.md`** — document the new dep-cruiser rules. (D-1 item 4.)
- **`docs/architecture/50-subsystems/04-graph-tool.md`** — new subsystem doc. (D-1 item 5.)
- **`docs/architecture/60-surfaces/01-cli-command-tree.md`** — add the three new subcommands. (D-1 item 6.)
- **`docs/architecture/README.md`** — bump `last_verified`; add subsystem to reading order. (D-1 item 7.)
- **`docs/plans/graph-tool-design.md`** (v0.1 spec) — mark `status: superseded`. (D-1 item 8.)
- **`packages/graph/engine/README.md`** — new package README. (D-1 item 10, P7 step 3.)

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

The implementation order is **P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → V → D**. Phase T (consolidated tests) runs concurrently with P0–P7; each implementation phase delivers its own test files. Phase V (validation) runs once after P7. Phase D (documentation sync) runs last, after V passes.

When the post-implementation checklist (D-3) is fully checked, this document's frontmatter is updated to `status: implemented` and the v0.1 spec at [`graph-tool-design.md`](./graph-tool-design.md) is updated to `status: superseded`. The v0.1 spec is preserved as historical context but does not get deleted.

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

## Appendix C — Load-bearing decisions (in-document ADRs)

opensip-tools does not maintain a `docs/decisions/` directory. The decisions below are the ones a future maintainer would be surprised by without rationale; they are recorded here in lieu of separate ADR files. Each has a short ID for cross-reference from the rest of this spec and from architecture docs (D-1 item 5).

### DEC-1 — Scrap v0.1 rather than refactor incrementally

**Context.** v0.1 ships, passes its tests, hits the ≤20 orphan gate. It is also a 569 → 20 bug-fix history of resolver patches stacked on a tangled base.

**Decision.** Scrap v0.1 entirely. Build v0.2 against the staged-pipeline shape described in §1. No compatibility shims, no migration adapters, no feature flags.

**Rationale.** The cost of clean reimplementation (~3.5–4.5 days) is at parity with the next two incremental refactor PRs that v0.1 would otherwise need, and the result is a foundation that the deferred-to-v0.3 features (rule plugins, confidence-aware output, incompleteness flags) can land on cleanly.

**Discussed in.** Appendix B above. Phase 1 of this pipeline review affirmed.

### DEC-2 — Name-keyed catalog over id-keyed catalog

**Context.** v0.1 keyed the catalog by a synthesized id reconstructed from `ts.Declaration` shape. Every resolver bug was a different way the reconstruction could fail.

**Decision.** v0.2's catalog is keyed by `simpleName` (string), with per-occurrence `bodyHash` for disambiguation. Resolution is a Map lookup, not a reconstruction.

**Rationale.** The catalog becomes the authority for ids; resolvers look ids up rather than synthesizing them. The cache file is also human-inspectable as a side benefit.

**Discussed in.** Appendix A above. §2.2.

### DEC-3 — Import SARIF helpers from `@opensip-tools/fitness` rather than reimplement

**Context.** Both fitness and graph need SARIF 2.1.0 output. Fitness already implements `buildSarifLog`, `chunkSarifRuns`, `reportToCloud` (with retry, chunking at 500, schema compliance). Reimplementing in graph would duplicate ~100 LOC and drift over time.

**Decision.** Graph imports the SARIF helpers from `@opensip-tools/fitness`. This is a peer-to-peer cross-tool import.

**Rationale.** Both packages sit at the tools/lang peer layer. Cross-tool imports are unconventional but allowed; only kernel-layer rules are inviolable. The eventual extraction to `@opensip-tools/sarif` is mechanical when there is one shared implementation; it would be a duplicate-maintenance refactor if there were two.

**Trade-off.** Adds a `@opensip-tools/fitness` dep to graph's `package.json`. Documented as a deliberate exception in `docs/architecture/10-mental-model/03-modular-monolith.md` (D-1 item 2). Enforced at the dep-cruiser level by an `info`-severity rule (`graph-may-import-fitness-sarif`, §9).

**Alternative considered.** Reimplement SARIF in graph. Rejected: ~100 LOC of duplicated, drift-prone serialization logic; two implementations to keep schema-compliant; two retry-policy implementations to keep aligned.

**Discussed in.** §10C DRY-1. Affects P0 step 1 (deps), P6 step 1 (renderer), AC-11 (deps allow-list), §9 (dep-cruiser rule).

### DEC-4 — Two-pass AST visitor (inventory then edges) accepted as a deliberate trade-off

**Context.** v0.1 conflated "find functions" and "find edges" in a single AST walk. The single-pass shape was faster but tangled — every bug in either step manifested in the other.

**Decision.** v0.2 walks the AST twice: once for stage 1 (inventory), once for stage 2 (edges). The `ts.Program` is reused between passes (constructed in stage 1, passed to stage 2 alongside the catalog) so the parse cost is paid once, but the AST traversal is paid twice.

**Trade-off.** Slightly slower than a single-pass implementation (~10–20% based on v0.1 profiling). Significantly cleaner — stage 1 has no awareness of stage 2's logic, stage 2 has access to a complete catalog rather than a half-built one. The architectural payoff (the single ordering rule of §1.2 eliminates a class of bugs) outweighs the runtime cost.

**Future.** If the wall-time cost ever becomes a problem at scale, a single-pass-with-deferred-edge-resolution variant is possible (collect edges as raw `(callerNode, callExpression)` pairs in pass 1, resolve them in a separate phase that consults the now-complete catalog). Not needed for v0.2.

**Discussed in.** §1.2, §2.2, §2.3.

### DEC-5 — Module structure: ~40 small files over ~5 large ones

**Context.** v0.1 had `builder.ts` at ~800 LOC. v0.2 splits the same logic across ~40 files. This is a deliberate cost trade.

**Decision.** Each visitor, helper, resolver, rule, renderer is its own file with a sharply scoped public API. The longest function is ≤ 50 LOC; the longest file is ≤ 200 LOC.

**Rationale.** Test isolation, comprehension at a glance, and the dep-cruiser invariants from §4 (which require file-level boundaries to enforce). The cost is more `import` lines and slightly more friction navigating the tree; the offsetting wins are that any single-file change is fully testable in isolation, and architectural invariants are enforceable by the build.

**Trade-off.** Higher file count and slightly more import boilerplate. Mitigated by a shared barrel `types.ts` and disciplined naming (the file `pipeline/inventory-visitors/arrow-function.ts` always exports a function called `visitArrowFunction`).

**Discussed in.** §1.5, §3.

### DEC-6 — Rule plugins deferred to v0.3

**Context.** The architecture supports user-authored rule plugins (rules are pure functions over typed inputs). Implementing the loader is straightforward.

**Decision.** v0.2 ships with the registry shape that admits external rules but does not expose the loader. Users cannot drop a `.mjs` rule into `<project>/opensip-tools/graph/checks/` and have it run.

**Rationale.** v0.2's scope is "ship a clean implementation of the five existing rules." Adding loader+config+versioning for external rules expands scope without buying anything for v0.2's customers. The deferral is clean — the registry shape is already plugin-shaped, so v0.3's loader work is additive, not a refactor.

**Discussed in.** §12. PR-6 (rule registry stays a const array, not a Registry singleton, until plugin loading lands).

### DEC-7 — `Result<T, E>` not introduced in graph

**Context.** opensip-tools exports `Result`, `ok`, `err` from `@opensip-tools/core` but uses them sparingly across the codebase.

**Decision.** Graph follows the codebase convention. Pipeline stages return their declared output shape; rules return `readonly Signal[]`; failures throw typed errors from `@opensip-tools/core`.

**Rationale.** Speculative use of `Result` is forbidden by the codebase rule on narrow ports. There is no caller in v0.2 that would benefit from a Result-shaped return — every error is either fatal (the CLI maps it to an exit code) or recoverable inside a single function. Introducing `Result` would ripple through every stage's signature without clarifying anything.

**Discussed in.** §10A AC-8.

### DEC-8 — Rendering choice via switch in CLI handler, not Map-keyed registry

**Context.** Three renderers (table, json, sarif). The CLI handler picks one based on flags.

**Decision.** A `switch (format)` in the CLI handler dispatches to the right renderer. No `RendererRegistry` Map keyed by `'table' | 'json' | 'sarif'`.

**Rationale.** Three is below the threshold for a registry. The flag-to-renderer mapping is a documentation surface (the CLI's `--help`); a switch makes the mapping a single readable function. A Map would scatter the mapping across module-level registrations and require the CLI handler to reach into a registry, which is more indirection without a corresponding win.

**Discussed in.** PR-3, PR-8.

---

## Pipeline coherence check

The findings of the post-Phase-6 final coherence pass.

### Phase output specifications — satisfied?

- **Phase 1 (Plan Structural Correctness).** Output: "phases ordered by true dependency, explicit implementation steps, enforced wiring in every phase, complete integration-surface coverage, and scaffolded tests/validation phases ready for later enrichment." **Satisfied.** §10 lists eight phases (P0–P7) plus scaffolded Phase T and Phase V. The integration-surface table at the top of §10 is concrete and references back to phases. Each phase has explicit "Steps" with named files. v0.1 has no compatibility shims anywhere; the spec is clean-slate.
- **Phase 2 (opensip-tools Architectural Compliance).** Output: "the plan with each architectural compliance issue named, its location identified, and the corrective change specified inline." **Satisfied.** §10A provides AC-1 through AC-12 with location callouts and corrective steps. §9 was extended with three additional dep-cruiser rules and a conditional rule (later activated by Phase 4's decision). Tests phase was extended with architectural-assertion tests (AC-12).
- **Phase 3 (Software Patterns: SOLID & GoF).** Output: "the plan with each pattern decision documented in-line." **Satisfied.** §10B covers PR-1 through PR-16: every interface, abstract pattern, and pattern rejection is named with rationale. Compile-time test seams are introduced (`Renderer`, `EdgeResolver`, `InventoryVisitor` type aliases) with corresponding contract tests.
- **Phase 4 (DRY: Package Reuse).** Output: "the plan with every existing-package opportunity identified by package name; every code-level extraction concretely specified; every extraction backed by ≥3 concrete callers." **Satisfied.** §10C covers DRY-1 (package reuse, by package: core, contracts, lang-typescript, fitness) and DRY-2 (code-level dedup with rule-of-three justification). The SARIF decision is settled (DEC-3, Option A: import from fitness). One exception to the rule of three is explicitly justified (`cache/normalize.ts`).
- **Phase 5 (Tests & Validation Coherence Sweep).** Output: "tests phase reorganized so each prior phase's contribution is clearly grouped, and the validation phase enumerating the end-to-end flows it exercises." **Satisfied.** Phase T is reorganized into Groups T-A through T-F, each labeled by the originating phase. Phase V lists 11 enumerated end-to-end flows, each labeled with its originating phase.
- **Phase 6 (Architecture Docs & Decision Records).** Output: "a final documentation phase that enumerates every architecture doc to create or update; every architectural decision made captured in-doc; a clear post-implementation checklist." **Satisfied.** Phase D enumerates 10 documentation deliverables in D-1, captures decisions in Appendix C (DEC-1 through DEC-8), and provides D-3 post-implementation checklist with 16 items.

### Cross-reference resolution

- AC references (AC-1 through AC-12) are used throughout; each is defined in §10A.
- PR references (PR-1 through PR-16) are used throughout; each is defined in §10B.
- DRY references (DRY-1 through DRY-4) are used throughout; each is defined in §10C.
- DEC references (DEC-1 through DEC-8) are used throughout; each is defined in Appendix C.
- Phase references (P0 through P7, T, V, D) are used throughout; each is defined in §10.
- Section references (§1 through §13, §10A, §10B, §10C) all resolve to existing headings.
- File path references (e.g., `pipeline/inventory.ts`, `cache/normalize.ts`, `render/types.ts`) all resolve against §3's module layout, with the exception of `cache/normalize.ts`, `render/types.ts`, `pipeline/inventory-visitors/types.ts`, `pipeline/edge-resolvers/types.ts`, and `errors.ts`, which are explicit additions documented in §3 (added to module layout) and DRY-3 (the rationale).

### Did any phase invalidate an earlier phase's work?

- **Phase 4 → Phase 1.** Phase 4 added a direct dep on `@opensip-tools/fitness` (DEC-3 / DRY-1 SARIF decision). Phase 1's P0 step 1 originally listed only the v0.1 deps. **Resolution.** Phase 4 explicitly updated P0 step 1 (DRY-3) to add the fitness dep and updated AC-11 to reflect the post-DRY allow-list. No invalidation; Phase 4 corrected Phase 1's placeholder.
- **Phase 4 → Phase 2.** Phase 2's AC-11 originally listed v0.1's deps as the allow-list and called the fitness import "conditional." **Resolution.** Phase 4 updated AC-11 to the post-DRY allow-list and made the conditional rule active.
- **Phase 5 → Phase 1.** Phase 1's Phase T scaffold was minimal. Phase 5 reorganized it into Groups T-A through T-F. **Resolution.** Phase 5 superseded the scaffold with a richer organization that subsumes it; no Phase 1 commitment was lost.
- **Phase 6 → Phase 1.** Phase 1's §11 was a brief "what changes outside packages/graph/" list. Phase 6 expanded it (§11.1, §11.2, §11.3) and added Phase D. **Resolution.** Phase 6 strictly extended Phase 1's commitments; nothing removed.
- **Phase 3 → Phase 1.** Phase 3 introduced three signature-alias `types.ts` files (PR-3, PR-4, PR-5). Phase 1's §3 module layout did not list them. **Resolution.** Phase 6's coherence pass updated §3 to include them, eliminating the inconsistency.

No phase invalidated an earlier phase's substantive work. Where phases produced corrections (Phase 4 to AC-11, Phase 6 to §3 layout), the corrections were applied consistently throughout the document.

### Internal consistency spot-checks

- **Module name `cache/normalize.ts`.** Used in §3 (module layout), §10C DRY-2 (declaration), §10C DRY-3 (P6 step 2 wiring), §10C DRY-4 (test name `cache/normalize.test.ts`), Phase T Group T-D (test path `cache/normalize.test.ts`). Consistent.
- **Direct deps allow-list.** Used in §10A AC-11, §10C DRY-1, §10C DRY-3, Phase T Group T-B `architecture/package-deps.test.ts`, DEC-3, D-1 item 1. Each location lists the same six (or seven, post-DRY) packages: `@opensip-tools/contracts`, `@opensip-tools/core`, `@opensip-tools/fitness`, `@opensip-tools/lang-typescript`, `commander`, `glob`, `typescript`. Consistent.
- **Test count `1308`.** Used 10 times for the existing-tests-must-pass assertion. The number `1366` appears once, in Appendix B, where it correctly describes v0.1's test count at the time it was scrapped. Consistent.
- **Logger event prefixes.** AC-5 lists the reserved prefixes; phases P1, P2, P4 reference them. Consistent.
- **Acceptance fixtures.** §8.2 lists seven fixtures; Phase T Group T-A names the same seven; Phase V flow 1 references "all seven acceptance fixtures pass" via D-3 checklist. Consistent.
- **Dogfood orphan count `≤ 20`.** Used in §8.3, P4 acceptance, Phase V flow 1, Phase V flow 4, D-3 checklist. Consistent.
- **Cache wall-time `≥ 50%`.** Used in P6 acceptance, Phase V flow 5, D-3 checklist. Consistent.
- **Six stages.** §1.1 says "six stages (0–5)." §2 enumerates Stage 0 through Stage 5. §5 trace step 9 ends at the renderer. §10 P0–P7 maps onto the same six stages plus skeleton/render/cache/dashboard. Consistent.
- **Cross-tool fitness dep.** DEC-3, DRY-1, AC-11, P0 step 1 (post-DRY-3 update), §9 (rule activated, not conditional), D-1 item 1 (catalog update notes it). Consistent.

### Findings

No invalidations. All cross-references resolve. All phase outputs are satisfied. The plan is internally consistent.

The structural quirk worth noting: §10A, §10B, §10C come **after** the phase definitions in §10 (Phase T, V, D) but are referenced by them. This is a forward reference; it is intentional because §10 is the implementation order (chronological) while §10A/B/C are the audits that govern what each phase must satisfy (cross-cutting). A reader must navigate forward to resolve the references. The TOC-shaped structure mitigates this — phase sections explicitly cite the AC-/PR-/DRY- IDs, and a reader following the cross-reference will land on a stable anchor.

One minor inapplicability handled: the Phase 6 prompt asks to update `docs/architecture/10-mental-model/03-modular-monolith.md` and notes "no layer change, but the package's role description updates." Phase 6 honored that — no layer change is in scope, but the cross-tool import (DEC-3) is documented as a peer-layer exception. This is the only place where a Phase 6 directive was nuanced rather than literal.

The plan is ready for the user's review.
