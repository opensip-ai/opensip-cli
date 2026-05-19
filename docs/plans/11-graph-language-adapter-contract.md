---
status: proposed
last_verified: 2026-05-18
title: "graph Tool — GraphLanguageAdapter contract"
audience: [contributors, maintainers]
purpose: "The interface every language adapter implements to participate in graph. Method-by-method, with TypeScript reference behavior, behavioral invariants, and the test contract each adapter must pass."
related-docs:
  - ./10-graph-language-pluggability.md
  - ./12-graph-language-pluggability-prs.md
---

# graph Tool — GraphLanguageAdapter contract

This is the technical heart of [`10-graph-language-pluggability.md`](./10-graph-language-pluggability.md). Read that first for the motivation and PR sequencing; come here for the interface.

The contract is intentionally minimal: six methods. Each one corresponds to a real responsibility the engine has today; the adapter takes that responsibility for its language. Methods that the engine doesn't currently expose (e.g. "resolve symbol declarations") are left out — they're per-adapter implementation details.

---

## 1. The interface

```ts
import type { CallEdge, FunctionOccurrence, ParseError } from '../types.js';

/**
 * Native parse output. Opaque to the engine; adapters route it through
 * their own walk/resolve methods. TypeScript adapter holds a ts.Program;
 * a tree-sitter adapter would hold a SourceFile per file plus a project
 * index.
 */
export type ParsedProject = unknown;

/**
 * One adapter per language. Registered in the lang-adapter registry; the
 * orchestrator looks up the adapter by id and routes the run through it.
 */
export interface GraphLanguageAdapter<P = ParsedProject> {
  /**
   * Stable identifier. Stored in Catalog.language. Adapters with the
   * same id must produce interoperable catalogs.
   */
  readonly id: string;

  /**
   * Lowercase file extensions including the leading dot. Used by
   * file-discovery filtering and project auto-detection.
   * Examples: ['.ts', '.tsx'] for TypeScript; ['.py'] for Python;
   * ['.rs'] for Rust.
   */
  readonly fileExtensions: readonly string[];

  /**
   * Optional human-readable name. Surfaced in --help and dashboard.
   * Defaults to id if absent.
   */
  readonly displayName?: string;

  // ── method 1 ─────────────────────────────────────────────────

  /**
   * Resolve which files belong to this project for the given cwd.
   * Reads whatever language-specific config exists (tsconfig.json,
   * pyproject.toml, Cargo.toml, go.mod, pom.xml, etc.); falls back
   * to a glob over fileExtensions if no config is found.
   *
   * Returns absolute, realpath-normalized, sorted file paths.
   * Symlinks resolved.
   */
  discoverFiles(input: DiscoverInput): DiscoverOutput;

  // ── method 2 ─────────────────────────────────────────────────

  /**
   * Parse the project. The shape of P is adapter-internal; the engine
   * never inspects it. The engine passes P back to walk() and
   * resolve() unchanged.
   *
   * Adapters typically build cross-file structures here (a TS Program,
   * a tree-sitter SourceFile-per-file map plus a project-wide call
   * graph hint, etc.).
   *
   * Parse errors per file are returned in `parseErrors`; they do not
   * abort the run.
   */
  parseProject(input: ParseInput): ParseOutput<P>;

  // ── method 3 ─────────────────────────────────────────────────

  /**
   * Walk the parsed project once and emit:
   *  - one FunctionOccurrence per callable thing (function, method,
   *    arrow, constructor, getter/setter, plus one synthetic
   *    module-init per file that owns top-level statements);
   *  - a flat list of CallSiteRecord — pre-located nodes the
   *    engine will pass to resolveCallSites() in step 4.
   *
   * The walk runs after parseProject() and before any resolution.
   * Each CallSiteRecord carries the bodyHash of the enclosing
   * function-shape it belongs to; the adapter computes that hash
   * during this walk so the engine never re-hashes.
   *
   * P is the same value parseProject() returned.
   */
  walkProject(input: WalkInput<P>): WalkOutput;

  // ── method 4 ─────────────────────────────────────────────────

  /**
   * Resolve the pre-collected CallSiteRecord list against the
   * frozen catalog. Returns one CallEdge per record (or omits the
   * record if it doesn't produce an edge).
   *
   * The engine has already built `catalog` from walkProject()'s
   * occurrences; resolveCallSites() may consult it for catalog-
   * fallback by name. Adapters with richer resolution (TypeScript
   * has a typechecker; Rust could have rust-analyzer) consult their
   * own infrastructure here.
   *
   * Each edge carries a `confidence` so rules know how much to
   * trust it. TypeScript symbol-resolved edges are 'high'; tree-
   * sitter name-matched edges are typically 'medium' or 'low'.
   */
  resolveCallSites(input: ResolveInput<P>): ResolveOutput;

  // ── method 5 ─────────────────────────────────────────────────

  /**
   * Compute a per-adapter cache key. Stored in Catalog.cacheKey;
   * compared against the current adapter's cacheKey on cache load
   * to invalidate when the adapter's analysis would produce
   * different output.
   *
   * Examples:
   *   TypeScript: `ts-${ts.version}-${tsconfigContentHash}`
   *   Python:     `py-tree-sitter-${grammarVersion}-${pyprojectHash}`
   *   Rust:       `rs-${cargoTomlHash}-${rustcVersion?}`
   *
   * Different adapters MUST produce different prefixes so a
   * Python-built catalog never matches a TypeScript adapter's
   * cacheKey.
   */
  cacheKey(input: CacheKeyInput): string;

  // ── method 6 ─────────────────────────────────────────────────

  /**
   * Optional. Declare which files this adapter considers tests, and
   * which "side-effect primitives" exist in this language. Consumed
   * by the test-only-reachable and no-side-effect-path rules.
   *
   * Sensible default: tests are files matching `**\/*.test.{ext}`,
   * `**\/__tests__/**`, `**\/*_test.{ext}`. Side-effect primitives
   * default to an empty list (rules that depend on them produce
   * 'low' confidence on this adapter).
   *
   * Adapters that omit this run with the default.
   */
  readonly ruleHints?: RuleHints;
}
```

---

## 2. Method I/O shapes

### `discoverFiles`

```ts
interface DiscoverInput {
  readonly cwd: string;                      // absolute, realpath-normalized
  readonly configPathOverride?: string;      // user-supplied via CLI flag, optional
}

interface DiscoverOutput {
  readonly projectDirAbs: string;            // = cwd (normalized)
  readonly files: readonly string[];         // absolute, realpath, sorted, deduped
  readonly configPathAbs?: string;           // tsconfig.json / pyproject.toml / etc.
  readonly compilerOptions?: unknown;        // adapter-internal; passed to parseProject as input
}
```

### `parseProject`

```ts
interface ParseInput {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions?: unknown;        // from DiscoverOutput
}

interface ParseOutput<P> {
  readonly project: P;                       // opaque to engine
  readonly parseErrors: readonly ParseError[];
}
```

### `walkProject`

```ts
interface WalkInput<P> {
  readonly project: P;
  readonly projectDirAbs: string;
  readonly files: readonly string[];
}

interface WalkOutput {
  readonly occurrences: Record<string, FunctionOccurrence[]>;
  readonly callSites: readonly CallSiteRecord[];
  readonly parseErrors: readonly ParseError[];
}

interface CallSiteRecord {
  /** Opaque adapter handle to the call expression's AST node. */
  readonly nodeRef: unknown;
  /** Opaque adapter handle to the source file containing the call. */
  readonly sourceFileRef: unknown;
  /** bodyHash of the enclosing function-shape that owns this call. */
  readonly ownerHash: string;
  /** 'call' (resolver dispatches) | 'creation' (emit static high-conf edge). */
  readonly kind: 'call' | 'creation';
  /** For 'creation' kind, the bodyHash of the nested callable. */
  readonly childHash?: string;
}
```

### `resolveCallSites`

```ts
interface ResolveInput<P> {
  readonly project: P;
  readonly catalog: Catalog;                 // built from walkProject's occurrences
  readonly callSites: readonly CallSiteRecord[];
  readonly projectDirAbs: string;
}

interface ResolveOutput {
  readonly edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>;
  readonly stats: ResolutionStats;
}
```

### `cacheKey`

```ts
interface CacheKeyInput {
  readonly projectDirAbs: string;
  readonly configPathAbs?: string;
  readonly compilerOptions?: unknown;
}
```

### `ruleHints`

```ts
interface RuleHints {
  /** Predicate: is this file a test? Path is project-relative. */
  readonly isTestFile?: (filePathProjectRel: string) => boolean;
  /** Globs treated as generated code. Functions inside are flagged in occurrences. */
  readonly generatedFilePatterns?: readonly string[];
  /** Side-effect primitives — fully-qualified names (e.g. 'fs.writeFileSync') */
  readonly sideEffectPrimitives?: readonly string[];
  /** Throw-statement detection regex for `always-throws-branch`. */
  readonly throwSyntaxRegex?: RegExp;
}
```

---

## 3. Behavioral invariants

These are not hints. The contract test suite validates each one. An adapter that violates any of them is broken.

### I-1. `walkProject` is deterministic

For the same `(project, projectDirAbs, files)`, two calls return:
- The same `occurrences` (key set, occurrence count per key, each occurrence's `bodyHash`).
- The same `callSites` (same order, same `ownerHash`, same `kind`, same `childHash`).

Non-determinism in walks breaks the catalog cache and the byte-identical-output gate.

### I-2. `bodyHash` collisions are intentional duplicates

Two `FunctionOccurrence` records may share a `bodyHash` if and only if their normalized bodies are byte-identical. Anonymous functions assigned different names get different `bodyHash` only if their bodies actually differ.

### I-3. Every `CallSiteRecord.ownerHash` exists in `WalkOutput.occurrences`

The call site is enclosed by some function-shape; that function-shape was emitted in the same walk; its `bodyHash` is the `ownerHash`. Module-init synthetic occurrences own top-level call sites — i.e. the file's module-init `bodyHash` is a valid `ownerHash`.

### I-4. `resolveCallSites` doesn't mutate `catalog`

The catalog is frozen by the time it reaches the resolver. Adapters that need name-lookup helpers compute them once at the start of `resolveCallSites` and discard them; they don't write back into `catalog.functions`.

### I-5. `CallEdge.to` references valid `bodyHash` values or is empty

Every entry in a `CallEdge.to` array is either a `bodyHash` that exists in `catalog.functions[*]` OR the array is empty (`resolution: 'unknown'`). No "to: ['notInCatalog']" — that's a contract violation; the rule pipeline assumes targets are catalog-resident.

### I-6. `cacheKey` is stable for stable input

Two calls with identical `(projectDirAbs, configPathAbs, compilerOptions)` and unchanged config-file contents return the same string. The cacheKey is the cache's invalidation lever; instability causes spurious cache misses or — worse — false hits across incompatible toolchain versions.

### I-7. `parseProject` is total over `files`

For every file in `files`, `parseProject` either:
- Successfully parses it (the result is reachable from `project`), OR
- Records a `parseErrors` entry naming the file and a human-readable error.

Silent file drops are not allowed. The engine treats `parseErrors` as a logged-but-non-fatal report.

### I-8. Adapter is single-language

`adapter.id` matches the language family the adapter handles. A TypeScript adapter doesn't also handle JavaScript — they're separate registrations even if the underlying parser is the same. (TypeScript's existing adapter does handle both `.ts` and `.js` because the TS compiler natively does; adapters that don't have such unification ship one per language.)

### I-9. Adapter is referentially transparent

`discoverFiles`, `parseProject`, `walkProject`, `resolveCallSites`, and `cacheKey` are pure with respect to their inputs. Side effects to disk (caching, etc.) happen only through engine code, not adapter code.

---

## 4. Why these six methods

Mapping the contract back to the engine's current responsibilities:

| Engine responsibility today | Adapter method |
|---|---|
| Stage 0: read tsconfig, enumerate files | `discoverFiles` |
| Build `ts.Program` | `parseProject` |
| Stage 1+2 unified walk: emit occurrences + call-site records | `walkProject` |
| Body hashing | (inside `walkProject`) |
| Stage 2 resolver dispatch (5 resolvers) | `resolveCallSites` |
| Cache invalidation key (`tsCompilerVersion + tsconfigContentHash`) | `cacheKey` |
| `isTestFile`, generated-file detection, side-effect primitives | `ruleHints` |

Notably absent from the contract:
- **Index building.** The engine builds `Indexes` from the catalog after the adapter's walk; same mechanism for every language.
- **Rule evaluation.** Rules consume `(Catalog, Indexes, Config)`; they don't talk to adapters.
- **Cache I/O.** The engine reads/writes catalogs; adapters don't touch disk for caching.
- **CLI flags.** `--package`, `--packages`, `--gate-save`, etc. live in the engine. Per-adapter flags (e.g. "Python --venv") would be a future extension; not in the v1 contract.
- **Streamed write, incremental rebuild.** Both consume `Catalog`; both work for any adapter that conforms.

This split is the value of the refactor. Six methods × N languages, instead of N copies of the engine.

---

## 5. The contract test suite

Lives at `packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts`. Every adapter — first-party or third-party — runs against it. Validates each of I-1 through I-9 against a per-language fixture project the adapter author supplies.

Test outline:

```ts
describe('GraphLanguageAdapter contract — TypeScript', () => {
  const adapter = typescriptGraphAdapter;
  const fixture = makeFixture('lang-typescript');

  // I-1: determinism
  it('walkProject is deterministic across two runs', () => {
    const r1 = adapter.walkProject(...);
    const r2 = adapter.walkProject(...);
    expect(canonicalize(r1)).toEqual(canonicalize(r2));
  });

  // I-3: ownership integrity
  it('every call site\'s ownerHash is in the catalog', () => { ... });

  // I-5: edge target integrity
  it('every CallEdge.to references a catalog bodyHash', () => { ... });

  // I-6: cacheKey stability
  it('cacheKey is stable across two calls with same input', () => { ... });

  // I-7: parseProject totality
  it('every file in files is either parsed or in parseErrors', () => { ... });

  // ...
});
```

Each adapter ships its own `describe` block referencing the same invariants but its own fixture. Future "did the contract change?" review questions become "did all adapters' contract tests still pass?"

---

## 6. The TypeScript adapter as reference implementation

`packages/graph/engine/src/lang-typescript/index.ts` exports `typescriptGraphAdapter: GraphLanguageAdapter`. After PR 3 of the master plan, every method maps to existing engine code:

| Method | Implementation source |
|---|---|
| `discoverFiles` | `lang-typescript/discover.ts` (was `pipeline/discover.ts`) |
| `parseProject` | `lang-typescript/parse.ts` (new file; lifts `ts.createProgram` out of the orchestrator) |
| `walkProject` | `lang-typescript/walk.ts` (was `pipeline/walk.ts`) |
| `resolveCallSites` | `lang-typescript/edges.ts:resolveEdgesFromRecords` (was `pipeline/edges.ts`) |
| `cacheKey` | `lang-typescript/cache-key.ts` (new file; combines `ts.version` + tsconfig content hash, which today are stored as separate catalog fields) |
| `ruleHints.isTestFile` | `lang-typescript/walk.ts:isTestFile` (was inside the walker; promoted to a hint) |
| `ruleHints.sideEffectPrimitives` | New: a list of well-known TS/JS side-effect calls (`fs.*`, `console.*`, `process.*`, `Math.random`, …) |

PR 3 of the master plan extracts these without changing behavior. The byte-identical-catalog gate proves it.

---

## 7. Per-language sketch (informative only)

These are not commitments; they're feasibility checks for contract design. If any language can't be expressed cleanly through the contract, the contract is wrong.

### Python
- `discoverFiles`: read `pyproject.toml` `tool.opensip-graph.include` if present; else recurse `**/*.py` excluding `**/__pycache__/**`, `.venv/**`, `venv/**`.
- `parseProject`: tree-sitter-python; one parsed tree per file in a `Map<filePath, Tree>`.
- `walkProject`: tree-sitter query for function/method/lambda definitions and call expressions. Module-init synthetic occurrence per file.
- `resolveCallSites`: name-based via catalog. No symbol table.
- `cacheKey`: `py-${pythonVersionFromPyproject}-${pyprojectContentHash}`.
- `ruleHints.isTestFile`: matches `test_*.py`, `*_test.py`, `**/tests/**`.

Estimated effort: 3-5 days.

### Rust
- `discoverFiles`: read `Cargo.toml` workspace members; recurse `src/**/*.rs` per crate. Honor `[lib]` / `[[bin]]` paths.
- `parseProject`: tree-sitter-rust per file.
- `walkProject`: tree-sitter query for `fn`, `impl` methods, closures, and call/method-call expressions.
- `resolveCallSites`: name-based, with `impl` block context for method receivers.
- `cacheKey`: `rs-${cargoLockHash}-${rustVersion?}`.

Estimated effort: 5-7 days. `impl` blocks and trait dispatch are the wrinkle.

### Go
- `discoverFiles`: read `go.mod`; recurse `**/*.go` excluding `_test.go` if user opts out (keep them in by default).
- `parseProject`: tree-sitter-go.
- `walkProject`: function declarations, method declarations on receivers, function literals, call expressions.
- `resolveCallSites`: name-based; receiver type carries info that helps disambiguation but not via symbol table.

Estimated effort: 3-4 days. Probably cleanest of the non-TS targets.

### Java
- `discoverFiles`: read `pom.xml` / `build.gradle` for source sets; fall back to `src/**/*.java`.
- `parseProject`: tree-sitter-java.
- `walkProject`: method declarations within class declarations, lambda expressions, method invocations.
- `resolveCallSites`: name-based; class context is rich (everything is in a class).
- `cacheKey`: `java-${pomHash || gradleHash}`.

Estimated effort: 5-7 days. `pom.xml` parsing is the unloved part.

### C/C++
- `discoverFiles`: `CMakeLists.txt` if present; fall back to `**/*.{c,cc,cpp,cxx,h,hpp,hxx}`.
- `parseProject`: tree-sitter-cpp / tree-sitter-c.
- `walkProject`: function definitions, method definitions in classes, call expressions.
- `resolveCallSites`: name-based; namespace + class context disambiguates partially.

Estimated effort: 5-7 days. Header/source duplication and namespace resolution are the wrinkles.

---

## 8. Open contract questions

These are deliberately deferred to the PR-2/PR-3 implementation phase. Putting them here so they don't get lost.

1. **Should `CallSiteRecord` carry source-text snippets, or should resolvers extract them on demand?** Today's TypeScript code stores `CallEdge.text` (≤ 80 chars) — extracted from the AST. For a tree-sitter adapter, retrieving text from a node requires the source string. Either ship the snippet eagerly in `walkProject` (more memory) or pass the source string into `resolveCallSites` (more parameters). Probably eager.

2. **Adapter cancellation.** The orchestrator passes an `AbortSignal` for cooperative cancellation today. Should the contract require adapters to honor it inside `parseProject` and `walkProject`? Yes — but the test for "honors signal" is hard to write without simulating slow parses. Defer to PR 5; ship without the requirement, add if needed.

3. **Streaming walk.** For very large projects, `walkProject` returning the full `occurrences` map up-front means peak memory grows with project size. An async-iterator-shaped variant (`walkProject` yields chunks) would let the engine pipeline serialization. Out of scope for the v1 contract; revisit if a real workload demands it.

4. **Multiple adapter versions per id.** If `lang-typescript@2` ships with a behavior change, and a project's catalog was built with `lang-typescript@1`, does the cache invalidate? `cacheKey` solves this within a single adapter version, but cross-version invalidation requires the registry to track adapter version too. Defer; for now, adapters bumping internal logic must also bump their cacheKey prefix.

5. **Per-rule capability flags.** Should the adapter declare "I can support rule X with confidence Y," letting the rule registry filter by capability? Or should rules just gracefully do nothing on adapters that lack what they need? Today's leaning: rules degrade silently (output zero findings if no edges meet `minConfidence`). Revisit if the silent-degradation UX is bad in practice.

---

## 9. References

- [`10-graph-language-pluggability.md`](./10-graph-language-pluggability.md) — the master plan: motivation, sequencing, acceptance gates.
- [`12-graph-language-pluggability-prs.md`](./12-graph-language-pluggability-prs.md) — PR-2 and PR-3 file-by-file diff plan.
- [`docs/architecture/40-the-graph-loop/01-stages-and-catalog.md`](../architecture/40-the-graph-loop/01-stages-and-catalog.md) — current pipeline architecture; will need an adapter-layer follow-up after PR 3.
