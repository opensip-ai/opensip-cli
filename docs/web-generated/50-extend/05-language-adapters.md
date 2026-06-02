---
status: current
last_verified: 2026-05-26
release: v2.0.x
title: "Language adapters (fitness)"
audience: [contributors, plugin-authors]
purpose: "What the fitness LanguageAdapter is, the six bundled adapters, and how to author a new one."
source-files:
  - packages/core/src/languages/adapter.ts
  - packages/core/src/languages/registry.ts
  - packages/core/src/languages/content-filter-dispatch.ts
  - packages/core/src/languages/generic-types.ts
  - packages/languages/lang-typescript/src/adapter.ts
  - packages/languages/lang-rust/src/adapter.ts
  - packages/languages/lang-python/src/adapter.ts
related-docs:
  - ../00-start/05-vocabulary.md
  - ../10-concepts/03-modular-monolith.md
  - ../20-fit/02-targets-and-scope.md
  - ../40-graph/03-adding-a-language.md
---
# Language adapters (fitness)

> **Two adapter contracts, one ambiguous word.** opensip-tools has two distinct language-adapter interfaces, used by different subsystems:
>
> - **`LanguageAdapter`** (this doc) lives in [`@opensip-tools/core`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/core/src/languages/adapter.ts). Used by the **fitness** engine. Three required methods (`parse`, `stripStrings`, `stripComments`) plus an optional query API. Lets fitness checks operate on filtered (comment- and string-stripped) source. Implemented by the six `@opensip-tools/lang-*` packages.
> - **`GraphLanguageAdapter`** (separate, [`@opensip-tools/graph`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/graph/engine/src/lang-adapter/types.ts)) is used by the **graph** engine. Six methods (`discoverFiles`, `parseProject`, `walkProject`, `resolveCallSites`, `cacheKey`, optional `ruleHints`). Lets graph build call catalogs across languages. Implemented by the **five publishable `@opensip-tools/graph-*` packages** under `packages/graph/graph-{typescript,python,rust,go,java}/`, each marked with `opensipTools.kind: "graph-adapter"`.
>
> They are siblings, not the same thing. A given language has one of each (e.g. TypeScript has both a fitness `typescriptAdapter` shipped by `@opensip-tools/lang-typescript` and a graph `typescriptGraphAdapter` shipped by `@opensip-tools/graph-typescript`). For graph adapters, see [`40-graph/03-adding-a-language.md`](/docs/opensip-tools/40-graph/03-adding-a-language/). The rest of this doc covers the fitness `LanguageAdapter` only.

A check is a regex over `console.log`. The naive run flags `// console.log("debug")` (a comment) and `"console.log"` (a string literal). A `LanguageAdapter` is what makes the regex correct — it strips comments and string literals before the check sees the content.

That's the load-bearing part. Adapters also expose a richer query API (functions, imports, call sites) for AST-shaped checks, but that surface is opt-in. The minimum viable adapter is "given source, produce filtered source."

> **What you'll understand after this:**
> - The `LanguageAdapter` interface, in full.
> - How the framework dispatches per-file based on extension.
> - The six bundled adapters and what each implements.
> - What it takes to ship a seventh adapter.

---

## The contract

[`packages/core/src/languages/adapter.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/core/src/languages/adapter.ts):

```ts
interface LanguageAdapter<TTree = unknown, TNode = unknown> {
  readonly id: string;                                // 'typescript', 'rust', 'python', …
  readonly fileExtensions: readonly string[];          // ['.ts', '.tsx']
  readonly aliases?: readonly string[];                // ['ts'] for legacy matching

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

The framework's content-filter dispatcher ([`packages/core/src/languages/content-filter-dispatch.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/core/src/languages/content-filter-dispatch.ts)) maps the check's `contentFilter` setting to one of these:

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

The query API is for AST-shaped checks. A check that wants "every function with cyclomatic complexity > 25" calls `adapter.query.findFunctions(tree)` and inspects each function's body. The shapes (`GenericFunction`, `Import`, `Location`) are language-neutral — see [`packages/core/src/languages/generic-types.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/core/src/languages/generic-types.ts).

The query API is **optional**. An adapter that only implements `parse` + `stripStrings` + `stripComments` is fully functional for regex-shaped checks. Implementing `query` is what unlocks the cross-language check pattern — `@opensip-tools/checks-universal`'s complexity check calls `adapter.query?.findFunctions(...)` and runs against any language whose adapter ships a query API.

`lang-typescript` is currently the only bundled adapter with a full `query` implementation. The other five (rust, python, java, go, cpp) ship `parse` + the strip operations; query is on the roadmap.

### `warmup`

Reserved on the interface for adapters that will eventually need async initialization — tree-sitter WASM modules, for instance, would benefit from a single instantiate-once pass at process start. Adapters that don't need warmup leave the field undefined.

Today **no bundled adapter declares `warmup`** and the CLI does not invoke it. The field is part of the contract so a future adapter that needs eager init can opt in without a contract change; until that adapter exists, treat it as forward-compatible metadata.

---

## The registry

[`packages/core/src/languages/registry.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/core/src/languages/registry.ts) defines the `LanguageRegistry` class — an in-memory list keyed by id and indexed by extension. The CLI constructs a fresh instance per invocation and populates it during `bootstrapCli()`. Inside a tool, you read from it via `cli.scope.languages` (the per-invocation `RunScope`):

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

`LanguageAdapter` carries an `aliases` field on the type, but the registry today does not consult it during lookup — only the canonical `id` and the registered `extensions[]` are indexed. Treat aliases as forward-compatible metadata.

The CLI registers all six bundled adapters in `bootstrapCli()` before any Tool's `register()` runs. See [`packages/cli/src/bootstrap/register-language-adapters.ts`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/packages/cli/src/bootstrap/register-language-adapters.ts).

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

Each adapter ships in its own package. Each is a peer at Layer 3 of the [package graph](/docs/opensip-tools/10-concepts/03-modular-monolith/). The CLI imports all six directly; a Layer-5 dep on each.

`lang-typescript` is the largest and most capable — it leverages the TypeScript compiler API for both parsing (giving it a real AST) and a full `query` implementation. The other five use hand-written strip routines because adding the TypeScript compiler analogue (a real parser) for each language is a significant per-language investment, and the regex/strip-shaped checks that actually run don't need a full AST.

The trade-off: a check that *would* benefit from AST-aware analysis on Rust (say, "find every `unsafe` block longer than 10 lines") can't be expressed against `lang-rust` today. It can be written as a string-shaped check with limited precision, or it can wait for `lang-rust` to grow a `query` implementation. There's no in-between.

---

## The exception: `lang-typescript` → `fitness`

`@opensip-tools/lang-typescript` re-exports `filterContent`, `clearFilterCache`, and `FilteredContent` from `@opensip-tools/fitness`. This is the documented exception to the "lang packs depend only on core" layer rule — see [`80-implementation/05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/) and the named `lang-no-fitness-except-typescript` carve-out in [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.4.2/.dependency-cruiser.cjs).

The history: those symbols moved out of `core` during an earlier refactor but the typescript adapter still re-exports them for downstream consumers that grew used to importing them from `lang-typescript`. The exception is named (`lang-no-fitness-except-typescript`) so any *other* lang pack reaching into fitness trips the rule.

---

## Authoring a new adapter

For a hypothetical `lang-erlang`:

```ts
// packages/languages/lang-erlang/src/adapter.ts
import type { LanguageAdapter } from '@opensip-tools/core';

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

Register it from the CLI (a future fix or a CLI-level config that adds the import) or via a `lang` plugin shape:

```json
{
  "name": "@my-co/lang-erlang",
  "main": "dist/index.js",
  "opensipTools": { "kind": "lang" }
}
```

```ts
// dist/index.js
export const adapters = [erlangAdapter];   // matches LangPluginExports
```

Then a project's targets can declare `languages: ['erlang']` and a check's `scope: { languages: ['erlang'] }` will match.

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

- **[`04-check-pack-architecture.md`](/docs/opensip-tools/50-extend/04-check-pack-architecture/)** — how check packs build on adapters: scope filters, parameterization, the marketplace shape.
- **[`../70-reference/02-package-catalog.md`](/docs/opensip-tools/70-reference/02-package-catalog/)** — every adapter package, key exports, where to find them.
