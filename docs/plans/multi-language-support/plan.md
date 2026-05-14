# Multi-Language Support Plan

Extend opensip-tools beyond TypeScript/JavaScript to Rust, Python, Java, Go, and C++ via a `LanguageAdapter` abstraction. New languages plug in as separate packages; existing TS checks continue working unmodified under a strangler migration. Ships the adapter API, the first new language end-to-end (Rust), and a path for the rest.

## Problem

Today the framework is structurally language-agnostic — `CheckLanguage = string`, target matching is set-intersection on language names — but TypeScript leaks through several seams:

- `packages/core/src/framework/parse-cache.ts:10` imports `typescript` at the top of core and the cache returns `ts.SourceFile`.
- `packages/core/src/framework/ast-utilities.ts:9` lives in core, imports `typescript`, and exposes `walkNodes(ts.Node, ...)` etc.
- `packages/core/src/framework/content-filter.ts:11` uses the TS scanner to strip strings/comments — Python `#` comments and Rust raw strings are not handled.
- `packages/core/package.json` and `packages/checks-builtin/package.json` both declare `typescript` as a runtime dependency.
- **48 files** under `packages/checks-builtin/src/checks/` import `typescript` directly; ~15 of them also import `getSharedSourceFile` from `@opensip-tools/core/framework/parse-cache.js`.

A check author who wants to analyse a Rust file has no first-class way to obtain a parse tree or to declare a parser dependency. Every built-in check that walks an AST is TS-specific by construction. There is no `LanguageRegistry`, no per-file adapter dispatch, no parser-agnostic content filter, and no plugin domain for language packs.

## Target State

A `LanguageAdapter<TTree, TNode>` interface in core defines what it means to be a "supported language": parse, strip strings, strip comments, expose an optional `LanguageQueryAPI` for cross-language primitives. A `LanguageRegistry` resolves the adapter for a given file by extension, mirroring the existing `CheckRegistry` and `TargetRegistry`. The parse cache is keyed by `(languageId, filePath, contentFingerprint)` and delegates parsing to the adapter.

Language packs ship as independent npm packages (`@opensip-tools/lang-typescript`, `@opensip-tools/lang-rust`, etc.) that register their adapter via the existing plugin discovery mechanism extended with a `'lang'` domain. The `opensip-tools.config.yml` `targets` block already declares `languages:`; from those declarations the runtime computes the set of adapters to load. A project that uses only Rust pays no cost for Python or Java.

Existing TS checks continue working: `@opensip-tools/lang-typescript` re-exports `getSharedSourceFile` and `parseSource` from the same paths they live at today as a compatibility shim. New TS checks (and migrated old ones) reach the same functions through the adapter. Tree-sitter (`web-tree-sitter`, WASM grammars) powers Rust/Python/Java/Go; C++ uses `clang-tidy` via the existing `CommandConfig` mode.

A "hello world" Rust check ships as part of this plan as proof-of-design — it loads, dispatches, parses, and emits a violation against a fixture `.rs` file under `packages/cli/__fixtures__/multi-lang/`. Python/Java/Go packs land in a later phase using the same template. C++ ships as the last new language because it uses a fundamentally different (process-shell) parser path.

## Design Principles

**Strangler migration over big-bang.** The adapter API is added alongside the existing TS-direct surface. Both work in parallel. Existing checks are not rewritten in this plan. The `typescript` dep stays in `core` for the duration of this plan; removing it is a follow-up.

**Config-driven adapter loading.** Adapters load only for languages declared in the project's targets. A project that ships no Rust target never loads `tree-sitter-rust`. Cold start scales with declared languages, not installed packages.

**Hybrid AST exposure.** The adapter exposes its native parse tree opaquely (full fidelity for the language's own checks), plus an optional minimal `LanguageQueryAPI` with cross-language primitives (`findFunctions`, `findImports`, `findCallsTo`, `findStringLiterals`). Power users escape to the native AST; common patterns ride the query API.

**Parser choice per language, hidden behind the adapter.** TS keeps the `typescript` compiler (no regression on 47 existing AST checks). New syntactic languages use tree-sitter via `web-tree-sitter`. C++ shells out to `clang-tidy`. Replacing any of these later only touches one adapter file.

**No backwards compatibility for check authors writing NEW checks.** New TS/JS checks must use the adapter API. Existing TS checks keep their direct `typescript` imports indefinitely (Phase 7 sets up the migration path; the actual long-tail migration is a separate plan).

## Phases

| Phase | Name | Description | Depends On |
|-------|------|-------------|------------|
| 0 | Languages module scaffold | Create `packages/core/src/languages/` with empty interfaces, types, and a registry skeleton. No callers yet. | — |
| 1 | Registry & language-aware parse cache | Implement `LanguageRegistry`, refactor `parse-cache.ts` to be language-aware, wire `'lang'` plugin domain. | 0 |
| 2 | Extract `@opensip-tools/lang-typescript` | New package re-exports `parseSource`, `getSharedSourceFile`, AST utilities; registers the TS adapter; existing checks keep using current import paths via compat shim. | 1 |
| 3 | `@opensip-tools/lang-rust` + proof check | Tree-sitter Rust adapter, lazy WASM grammar, one "hello world" check that triggers on `unwrap()` in a fixture. End-to-end proof of design. | 2 |
| 4 | Adapter-driven content filter + first universal checks | Move `stripStrings` / `stripComments` to adapter; port two regex-based built-in checks into a new `@opensip-tools/checks-universal` package. | 3 |
| 5 | `lang-python`, `lang-java`, `lang-go` | Three more language packs in parallel using the Phase 3 template. One "hello world" check per language. | 3 |
| 6 | `lang-cpp` via clang-tidy `CommandConfig` | C++ adapter wraps `clang-tidy`; the `parse()` method returns `null` and the adapter declares itself as command-only. One demo check. | 1, 2 |
| 7 | TS-migration bridge | Document the migration shape for the 48 TS-direct checks. Migrate exactly two checks as worked examples. Long-tail migration deferred to a follow-up plan. | 2, 4 |
| 8 | Tests | Unit + integration tests for the registry, parse cache, content-filter dispatch, plugin domain, Rust end-to-end fixture run. | 0-7 |
| 9 | Validation | CLI smoke runs against a multi-language fixture repo. Verify per-language dispatch, error messages on missing adapters, fail-loud on unknown languages declared in targets. | All |

## Dependency Graph

```
Phase 0 (Languages module scaffold)
└── Phase 1 (Registry & parse cache)
      ├── Phase 2 (lang-typescript)
      │     ├── Phase 3 (lang-rust + proof)
      │     │     ├── Phase 4 (content filter + universal)
      │     │     └── Phase 5 (python, java, go)        ← parallel with Phase 4
      │     └── Phase 6 (lang-cpp)                       ← parallel with Phase 3
      │           └── Phase 7 (TS migration bridge)      ← also depends on Phase 4
      │                 └── Phase 8 (Tests)
      │                       └── Phase 9 (Validation)
      └── Phase 6 (lang-cpp)
```

Parallelization opportunities:
- Phase 3 and Phase 6 are independent (both depend only on Phase 2) and can run concurrently.
- Phase 4 and Phase 5 are independent once Phase 3 ships.
- Phase 5's three language packs are independent of each other.

## File Change Summary

| Phase | New Files | Modified Files |
|-------|-----------|----------------|
| 0 | `packages/core/src/languages/adapter.ts`, `registry.ts`, `generic-types.ts`, `index.ts`, `__tests__/registry.test.ts` | `packages/core/src/index.ts` (export `./languages`) |
| 1 | `packages/core/src/languages/parse-cache.ts` | `packages/core/src/framework/parse-cache.ts` (re-export from new location), `packages/core/src/recipes/service.ts:16,167,266` (init/clear calls), `packages/core/src/plugins/types.ts` (add `'lang'` to `PluginDomain`), `packages/core/src/plugins/discover.ts`, `packages/core/src/plugins/loader.ts` |
| 2 | `packages/lang-typescript/package.json`, `tsconfig.json`, `src/index.ts`, `src/adapter.ts`, `src/parse.ts`, `src/query.ts`, `src/strip.ts`, `src/__tests__/adapter.test.ts` | `packages/core/src/framework/parse-cache.ts` (becomes thin re-export shim from `@opensip-tools/lang-typescript`), `packages/core/src/framework/ast-utilities.ts` (becomes thin re-export shim), `pnpm-workspace.yaml` (no change — `packages/*` already covers it), root `package.json` if needed |
| 3 | `packages/lang-rust/package.json`, `tsconfig.json`, `src/index.ts`, `src/adapter.ts`, `src/parse.ts`, `src/query.ts`, `src/strip.ts`, `src/grammar-loader.ts`, `src/__tests__/adapter.test.ts`; `packages/checks-rust/package.json`, `tsconfig.json`, `src/index.ts`, `src/checks/no-unwrap.ts`, `src/__tests__/no-unwrap.test.ts`; `packages/cli/__fixtures__/multi-lang/sample.rs` | — |
| 4 | `packages/checks-universal/package.json`, `tsconfig.json`, `src/index.ts`, `src/checks/no-todo-comments.ts`, `src/checks/file-length-limit.ts`, `src/__tests__/*.test.ts` | `packages/core/src/languages/adapter.ts` (add `stripStrings`/`stripComments` already in Phase 0 — Phase 4 wires call sites), `packages/core/src/framework/define-check.ts:107-115` (dispatch to adapter), `packages/core/src/framework/content-filter.ts` (becomes adapter-backed for TS; new public API stays the same) |
| 5 | `packages/lang-python/**`, `packages/lang-java/**`, `packages/lang-go/**`, three minimal `checks-<lang>` packages (each: `package.json`, `tsconfig.json`, `src/index.ts`, one hello-world check, one fixture file) | — |
| 6 | `packages/lang-cpp/package.json`, `tsconfig.json`, `src/index.ts`, `src/adapter.ts`, `src/clang-tidy.ts`; `packages/checks-cpp/package.json`, `tsconfig.json`, `src/index.ts`, `src/checks/clang-tidy-passthrough.ts` | — |
| 7 | `docs/plans/multi-language-support/migration-guide.md` (worked-example migration of two TS checks) | Two TS check files migrated from `import ts from 'typescript'` + `getSharedSourceFile` to `ctx.lang.parse(content, filePath)` |
| 8 | `packages/core/src/languages/__tests__/registry.test.ts` (already in Phase 0), `packages/core/src/languages/__tests__/parse-cache.test.ts`, `packages/core/src/plugins/__tests__/lang-domain.test.ts`, fixture-driven integration test in `packages/cli/src/__tests__/multi-lang.test.ts` | — |
| 9 | `packages/cli/__fixtures__/multi-lang/` (sample.rs, sample.py, sample.java, sample.go, sample.cpp, sample.ts, `opensip-tools.config.yml`) | — |

## Critical Files Reference

| File | Role | Key Structures |
|------|------|----------------|
| `packages/core/src/framework/check-config.ts` | Check config types and Zod schemas | `CheckLanguage` (line 64), `CheckScope` (line 81), `CheckViolation` (line 96), `FileAccessor` (line 119), `CommandConfig` (line 135), `AnalyzeCheckConfig` (line 249), `AnalyzeAllCheckConfig` (line 254), `CommandCheckConfig` (line 259), `UnifiedCheckConfig` (line 264) |
| `packages/core/src/framework/define-check.ts` | Check execution pipeline | `executeAnalyzeMode` (line 87) dispatches the per-file analyze loop with `contentFilter` handling at lines 107–115; this is the call site Phase 4 modifies to invoke the adapter |
| `packages/core/src/framework/parse-cache.ts` | Module-level TS parse cache | `class ParseCache` (line 16), `getSharedSourceFile` (line 86), `initParseCache` (line 59), `clearParseCache` (line 72); imported as `@opensip-tools/core/framework/parse-cache.js` by 15+ checks |
| `packages/core/src/framework/ast-utilities.ts` | TS AST helpers in core | `parseSource` (line 19), `walkNodes` (line 35), `getIdentifierName` (line 50), `getPropertyChain` — all return/take `ts.Node`/`ts.SourceFile` |
| `packages/core/src/framework/content-filter.ts` | TS-scanner-based string/comment stripping | `FilteredContent` (line 19), `filterContent` — produces `{ code, codeNoComments }` consumed by `define-check.ts:109-112` |
| `packages/core/src/framework/registry.ts` | Check registry pattern (template for `LanguageRegistry`) | `class CheckRegistry` (line 15), `defaultRegistry` (line 123); register/resolve/list pattern Phase 0 mirrors |
| `packages/core/src/targets/target-registry.ts` | Target registry with `findByScope(languages, concerns)` | `TargetRegistry.findByScope` (line 80) — already does language-set intersection; no change needed |
| `packages/core/src/plugins/types.ts` | Plugin contract | `PluginDomain` (line 69) currently `'fit' \| 'sim' \| 'asm'` — Phase 1 adds `'lang'` |
| `packages/core/src/plugins/discover.ts` | Plugin discovery for `~/.opensip-tools/<domain>/` | `discoverPlugins` (line 112), `resolvePluginDir` (line 52); already supports project-local + user-level dirs |
| `packages/core/src/recipes/service.ts` | Lifecycle owner of parse cache | calls `initParseCache` at line 266, `clearParseCache` at line 167 — Phase 1 broadens to per-language caches |
| `packages/core/src/languages/adapter.ts` (new — Phase 0) | `LanguageAdapter` interface and `LanguageQueryAPI` | The contract every language pack implements |
| `packages/core/src/languages/registry.ts` (new — Phase 0) | `LanguageRegistry` + `defaultLanguageRegistry` | `register(adapter)`, `forFile(filePath)`, `get(id)`, `list()`; parallel to `CheckRegistry` |
| `packages/lang-typescript/src/adapter.ts` (new — Phase 2) | The TS implementation of `LanguageAdapter` | Wraps `ts.createSourceFile`; re-exports `parseSource`/`getSharedSourceFile` for compat |
| `packages/lang-rust/src/adapter.ts` (new — Phase 3) | The Rust implementation of `LanguageAdapter` | Wraps `web-tree-sitter` with lazy WASM grammar load |

## Per-Task Verification Standard

At the end of every task, run:

```bash
pnpm build && pnpm typecheck && pnpm test
```

Phase-specific verification commands are listed in each phase file. Validation phase (Phase 9) additionally runs CLI smoke commands against the multi-language fixture repo.

## Notes on the absent plan-improvements pipeline

This repository does not contain `docs/ai-helpers/prompts/plan-improvements/plan-improvements.md`. The 11-phase enrichment pipeline that the `backend-plan` skill normally chains into (covering architectural compliance, observability, hardening, audit, and DEC entries) is therefore **not run**. The plan above is the final artifact. If the user wants pipeline-style enrichment in the future, port the pipeline prompts into this repo first.
