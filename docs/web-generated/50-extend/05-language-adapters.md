---
status: current
last_verified: 2026-06-16
release: v0.1.9
title: "Language adapters (fitness)"
audience: [contributors, plugin-authors]
purpose: "What the fitness LanguageAdapter is, the six bundled adapters, and how to author a new one."
source-files:
  - packages/core/src/languages/adapter.ts
  - packages/core/src/languages/registry.ts
  - packages/core/src/languages/content-filter-dispatch.ts
  - packages/core/src/languages/generic-types.ts
  - packages/languages/lang-typescript/src/adapter.ts
  - packages/languages/lang-typescript/src/filter.ts
  - packages/languages/lang-rust/src/adapter.ts
  - packages/languages/lang-python/src/adapter.ts
  - packages/graph/graph-adapter-common/src/parse.ts
related-docs:
  - ../00-start/05-vocabulary.md
  - ../10-concepts/03-modular-monolith.md
  - ../20-fit/02-targets-and-scope.md
  - ../40-graph/03-adding-a-language.md
---
# Language adapters (fitness)

> **Two adapter contracts, one ambiguous word.** opensip-cli has two distinct language-adapter interfaces, used by different subsystems:
>
> - **`LanguageAdapter`** (this doc) lives in [`@opensip-cli/core`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/core/src/languages/adapter.ts). Used by the **fitness** engine. Three required methods (`parse`, `stripStrings`, `stripComments`) plus an optional query API. Lets fitness checks operate on filtered (comment- and string-stripped) source. Implemented by the six `@opensip-cli/lang-*` packages.
> - **`GraphLanguageAdapter`** (separate, [`@opensip-cli/graph`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/graph/engine/src/lang-adapter/types.ts)) is used by the **graph** engine. Six methods (`discoverFiles`, `parseProject`, `walkProject`, `resolveCallSites`, `cacheKey`, optional `ruleHints`). Lets graph build call catalogs across languages. Implemented by the **five publishable `@opensip-cli/graph-*` packages** under `packages/graph/graph-{typescript,python,rust,go,java}/`, each marked with `opensipTools.kind: "graph-adapter"`. The four tree-sitter adapters (python, rust, go, java) load **vendored `web-tree-sitter` WASM grammars** (a `.wasm` file in each adapter's `wasm/` dir) and share scaffolding from [`@opensip-cli/graph-adapter-common`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/graph/graph-adapter-common/src/parse.ts); `graph-typescript` is TypeScript-compiler-backed (not tree-sitter). There is no native build step — no node-gyp, no prebuilt `.node`.
>
> They are siblings, not the same thing. A given language has one of each (e.g. TypeScript has both a fitness `typescriptAdapter` shipped by `@opensip-cli/lang-typescript` and a graph `typescriptGraphAdapter` shipped by `@opensip-cli/graph-typescript`). For graph adapters, see [`40-graph/03-adding-a-language.md`](/docs/opensip-cli/40-graph/03-adding-a-language/). The rest of this doc covers the fitness `LanguageAdapter` only.

## How adapters reach the CLI (registration asymmetry)

Fitness and graph use **different registration paths** by design:

| Subsystem | Registration | Adding a bundled adapter |
|-----------|--------------|-------------------------|
| **Fitness** `LanguageAdapter` | Static import in [`register-language-adapters.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/cli/src/bootstrap/register-language-adapters.ts) at CLI startup | Edit that file + add `@opensip-cli/lang-*` to `opensip-cli` `package.json` dependencies |
| **Graph** `GraphLanguageAdapter` | Capability discovery via each tool's `capabilityRegistrars` (`graph-adapter` domain) | Ship `@opensip-cli/graph-*` with `opensipTools.kind: "graph-adapter"`; no CLI source edit |

Fitness adapters are always required for check execution (string/comment stripping), so the CLI wires all six in one place and keeps fitness free of hard deps on every `lang-*` pack. This is a product boundary, not a forgotten plugin seam: adding a fitness language adapter is a CLI release today. Graph adapters are optional per language and load only when the graph tool's capability loader runs for an admitted `graph-*` package.

A check is a regex over `console.log`. The naive run flags `// console.log("debug")` (a comment) and `"console.log"` (a string literal). A `LanguageAdapter` is what makes the regex correct — it strips comments and string literals before the check sees the content.

That's the load-bearing part. Adapters also expose a richer query API (functions, imports, call sites) for AST-shaped checks, but that surface is opt-in. The minimum viable adapter is "given source, produce filtered source."

> **What you'll understand after this:**
> - The `LanguageAdapter` interface, in full.
> - How the framework dispatches per-file based on extension.
> - The six bundled adapters and what each implements.
> - What it takes to ship a seventh adapter.

---

## The contract

[`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/core/src/languages/adapter.ts):

```ts
interface LanguageAdapter<TTree = unknown, TNode = unknown> {
  readonly id: string;                                // 'typescript', 'rust', 'python', …
  readonly fileExtensions: readonly string[];          // ['.ts', '.tsx']
  readonly aliases?: readonly string[];                // ['c'] → canonicalized to this id

  parse(content: string, filePath: string): TTree | null;
  stripStrings(content: string): string;
  stripComments(content: string): string;

  readonly query?: LanguageQueryAPI<TTree, TNode>;
  warmup?(): Promise<void>;
}
```

Three required methods: `parse`, `stripStrings`, `stripComments`. Two optional surfaces: a `query` API for AST-shaped queries, and a `warmup` hook for adapters with one-time initialization (tree-sitter WASM, etc.).

The `TTree` and `TNode` generics are *opaque to core*. The adapter chooses its native tree representation; downstream consumers (checks that opt into the query API) receive the tree by reference and operate on it through `query`. Core never inspects the tree itself.

### `stripStrings` and `stripComments`

The two filter operations are the spine of the content-filter system. Both must:

1. **Preserve length.** Replacement is whitespace of equal length, so line and column numbers stay correct after stripping.
2. **Be deterministic.** Same input → same output, every time.
3. **Handle malformed input gracefully.** A file with an unterminated string literal still produces *some* output — checks shouldn't crash on syntactically invalid code.

The names describe what's left, not what's stripped: `stripStrings` removes strings (comments preserved), `stripComments` removes both strings *and* comments. The asymmetry is intentional: a check that reads comment-based directives (e.g. `// @fitness-ignore-next-line`) wants strings stripped but comments kept, while a check that scans for identifier patterns (e.g. `console.log`) wants both stripped.

The framework's content-filter dispatcher ([`packages/core/src/languages/content-filter-dispatch.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/core/src/languages/content-filter-dispatch.ts)) maps the check's `contentFilter` setting to one of these:

| Check declares | Adapter call |
|---|---|
| `contentFilter: 'raw'` (default) | none — pass through |
| `contentFilter: 'strip-strings'` | `adapter.stripStrings(content)` |
| `contentFilter: 'strip-strings-and-comments'` | `adapter.stripComments(content)` |

If no adapter is registered for the file's extension, the framework falls back to passing content through unchanged — a fail-safe that matches "raw" mode rather than crashing the check.

### The query API

```ts
interface LanguageQueryAPI<TTree, TNode> {
  findFunctions(tree: TTree): readonly GenericFunction<TNode>[];
  findImports(tree: TTree): readonly Import[];
  findCallsTo(tree: TTree, name: string): readonly TNode[];
  findStringLiterals(tree: TTree): readonly { value: string; location: Location }[];
  getLocation(tree: TTree, node: TNode): Location;
  getText(tree: TTree, node: TNode): string;
}
```

The query API is for AST-shaped checks. A check that wants "every function with cyclomatic complexity > 25" calls `adapter.query.findFunctions(tree)` and inspects each function's body. The shapes (`GenericFunction`, `Import`, `Location`) are language-neutral — see [`packages/core/src/languages/generic-types.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/core/src/languages/generic-types.ts).

The query API is **optional**. An adapter that only implements `parse` + `stripStrings` + `stripComments` is fully functional for regex-shaped checks. Implementing `query` is what unlocks the cross-language check pattern — `@opensip-cli/checks-universal`'s complexity check calls `adapter.query?.findFunctions(...)` and runs against any language whose adapter ships a query API.

`lang-typescript` is currently the only bundled adapter with a full `query` implementation. The other five (rust, python, java, go, cpp) ship `parse` + the strip operations; query is on the roadmap.

### `warmup`

Reserved on the interface for adapters that will eventually need async initialization — tree-sitter WASM modules, for instance, would benefit from a single instantiate-once pass at process start. Adapters that don't need warmup leave the field undefined.

Today **no bundled adapter declares `warmup`** and the CLI does not invoke it. The field is part of the contract so a future adapter that needs eager init can opt in without a contract change; until that adapter exists, treat it as forward-compatible metadata.

---

## The registry

[`packages/core/src/languages/registry.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/core/src/languages/registry.ts) defines the `LanguageRegistry` class — an in-memory list keyed by id and indexed by extension. The CLI constructs a fresh instance per invocation and populates it during `bootstrapCli()`. Inside a tool, you read from it via `cli.scope.languages` (the per-invocation `RunScope`):

```ts
const langs = cli.scope.languages;

langs.register(typescriptAdapter);
langs.register(rustAdapter);
// ... four more

langs.forFile('src/foo.ts');  // → typescriptAdapter (lookup by file extension)
langs.get('rust');            // → rustAdapter (lookup by adapter id)
langs.has('rust');            // → boolean
langs.list();                 // → readonly LanguageAdapter[]
```

`LanguageAdapter` carries an optional `aliases` field. The registry indexes each alias into an `aliasIndex` (alias → canonical id) alongside the id and extension indices, and exposes `canonicalize(idOrAlias)` to resolve an alias like `'c'`, `'rs'`, `'py'`, or `'golang'` back to its canonical adapter id (`'cpp'`, `'rust'`, `'python'`, `'go'`). Scope-matching and target-language resolution call `canonicalize` (via the scope's `languages.canonicalize`) so a target written with `languages: ['c']` matches a check scoped to `cpp`. An alias that collides with another adapter's canonical id, or one already claimed by an earlier adapter, is ignored with a structured warning (canonical id wins; first claimant wins).

The CLI registers all six bundled adapters in `bootstrapCli()` before any tool is admitted and mounted. See [`packages/cli/src/bootstrap/register-language-adapters.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/cli/src/bootstrap/register-language-adapters.ts).

If a file's extension matches no registered adapter, dispatch falls through to "pass content unchanged." This is the fail-safe — a YAML file or a Markdown file goes through every check unmodified, and checks that target text content (TODO scanners, secret scanners) still work. Checks that depend on language-specific filtering and don't have an adapter for the file simply don't filter.

---

## The six bundled adapters

| Adapter | Path | Extensions | Implementation |
|---|---|---|---|
| `lang-typescript` | `packages/languages/lang-typescript/` | `.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs` | TypeScript compiler API + custom strip routines |
| `lang-rust` | `packages/languages/lang-rust/` | `.rs` | Strip routines + line-offset metadata (tree-sitter integration deferred) |
| `lang-python` | `packages/languages/lang-python/` | `.py`, `.pyi` | Hand-written strip routines |
| `lang-java` | `packages/languages/lang-java/` | `.java` | Hand-written strip routines |
| `lang-go` | `packages/languages/lang-go/` | `.go` | Hand-written strip routines |
| `lang-cpp` | `packages/languages/lang-cpp/` | `.cpp`, `.cc`, `.cxx`, `.c++`, `.hpp`, `.hh`, `.hxx`, `.h`, `.c` | Hand-written strip routines |

Each adapter ships in its own package. Each is a peer at Layer 3 of the [package graph](/docs/opensip-cli/10-concepts/03-modular-monolith/). The CLI imports all six directly; a Layer-5 dep on each.

`lang-typescript` is the largest and most capable — it leverages the TypeScript compiler API for both parsing (giving it a real AST) and a full `query` implementation. The other five use hand-written strip routines because adding the TypeScript compiler analogue (a real parser) for each language is a significant per-language investment, and the regex/strip-shaped checks that actually run don't need a full AST.

The trade-off: a check that *would* benefit from AST-aware analysis on Rust (say, "find every `unsafe` block longer than 10 lines") can't be expressed against `lang-rust` today. It can be written as a string-shaped check with limited precision, or it can wait for `lang-rust` to grow a `query` implementation. There's no in-between.

---

## Lang packs depend only on core

`@opensip-cli/lang-typescript` *owns* `filterContent`, `clearFilterCache`, and `FilteredContent` ([`packages/languages/lang-typescript/src/filter.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/languages/lang-typescript/src/filter.ts)) — the TS-aware string/comment stripping lives alongside the rest of the adapter. There is no longer any lang-pack → `fitness` edge; the historical `lang-typescript → fitness` exception was paid down by moving those symbols into the adapter package itself. The flat `lang-no-fitness` rule in [`.config/dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/.config/dependency-cruiser.cjs) now applies uniformly: *no* lang pack reaches up into fitness. See [`80-implementation/05-layer-policy.md`](/docs/opensip-cli/80-implementation/05-layer-policy/).

---

## Authoring a new adapter

For a hypothetical `lang-erlang`:

```ts
// packages/languages/lang-erlang/src/adapter.ts
import type { LanguageAdapter } from '@opensip-cli/core';

interface ErlangTree { /* whatever you choose */ }
type ErlangNode = unknown;

export const erlangAdapter: LanguageAdapter<ErlangTree, ErlangNode> = {
  id: 'erlang',
  fileExtensions: ['.erl', '.hrl'],

  parse(content, filePath) {
    return parseErlang(content) ?? null;
  },

  stripStrings(content) {
    // Replace "..." literals with same-length whitespace.
    return content.replace(/"(?:[^"\\]|\\.)*"/g, m => ' '.repeat(m.length));
  },

  stripComments(content) {
    // Strip strings + Erlang line comments (% ...).
    return this.stripStrings(content).replace(/%.*$/gm, m => ' '.repeat(m.length));
  },
};

// packages/languages/lang-erlang/src/index.ts
export { erlangAdapter } from './adapter.js';
```

Register it in the host composition root by adding the bundled package to the CLI's language-adapter imports. Language adapters are the canonical parse substrate, not runtime-discovered plugins: there is intentionally no `opensipTools.kind: "lang"` package marker or `plugins.lang` project config path. A future external-adapter model would need a new ADR that defines adapter-set identity and cache/baseline invalidation.

Once the adapter is bundled and registered, a project's targets can declare `languages: ['erlang']` and a check's `scope: { languages: ['erlang'] }` will match.

The tests for an adapter live in `packages/languages/lang-<name>/src/__tests__/`. Two shapes are essential:

1. **Strip-correctness tests** — for every comment/string syntax in the language, the strip preserves length, removes content, and leaves identifiers intact.
2. **Round-trip tests** — every check that runs against this language gets the right answer when the adapter is in play vs. not.

---

## Where the example lands

For `acme-api`:

- `services/api/src/routes/orders.ts` — the `lang-typescript` adapter's `stripComments` removes `"console.log"` from a string literal and `// console.log("debug")` from a comment. The `no-console-log` regex finds the bare `console.log(...)` call on line 118 and nothing else.
- `pipelines/etl/scripts/main.py` — the `lang-python` adapter's `stripComments` removes `print(...)` from a triple-quoted docstring. The `no-print-outside-pipelines` check (which targets concern `data-pipeline`) wouldn't even run here, but if it did, the adapter is what keeps the docstring text from being a false positive.
- `infra/lib/stack.ts` — the `lang-typescript` adapter again, this time on infra-tagged code. Same adapter, different target.

The adapter doesn't know any of this. It just receives a path + content and returns filtered content. The check, the target, and the project are all someone else's problem.

---

## What's next

- **[`04-check-pack-architecture.md`](/docs/opensip-cli/50-extend/04-check-pack-architecture/)** — how check packs build on adapters: scope filters, parameterization, the marketplace shape.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-cli/70-reference/02-package-catalog/)** — every adapter package, key exports, where to find them.
