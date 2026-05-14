# ESLint cleanup summary

Drove the workspace from **~465 violations** down to **0 errors / 7 warnings** (all `sonarjs/no-duplicate-string`, which is a configured `warn`, not an `error`).

## Final lint output

```
✖ 7 problems (0 errors, 7 warnings)
```

## Build / test / parity gate

- `pnpm -r build`: clean (no `error TS`, no `ERR_PNPM`).
- `pnpm -r typecheck`: clean.
- `pnpm -r test`: 560+ tests pass across 16 packages
  - `packages/core` 118 passed
  - `packages/fitness/engine` 188 passed
  - `packages/cli` 107 passed
  - `packages/simulation/engine` 31 passed
  - language packs: 12+12+10+15+13+8 = 70 passed
  - check packs: 6+6+7+6+15+6 = 46 passed
- DART parity gate: **120 Passed, 0 Failed (0 Errors, 11 Warnings)** — bit-for-bit unchanged.

## Per-rule action summary

### Rules cleared by **refactor** (changed code, no disable)

- `unicorn/text-encoding-identifier-case` (38) — `'utf-8'` → `'utf8'` across all src files.
- `unicorn/prefer-string-slice` (23) — `.substring(a,b)` → `.slice(a,b)` in 11 fitness check files.
- `@typescript-eslint/prefer-nullish-coalescing` (11) — `||` → `??`, `??=` for assignment forms.
- `unicorn/prefer-single-call` (11) — collapsed multiple `Array#push(...x); push(...y);` into single calls.
- `unicorn/prefer-number-properties` (4) — `isNaN` → `Number.isNaN`.
- `unicorn/prefer-code-point` (5) — `charCodeAt` → `codePointAt`.
- `unicorn/prefer-spread` (5) — left in place; see "per-line disable" below.
- `unicorn/no-for-loop` (8) — left in place with disable; see below.
- `@typescript-eslint/consistent-type-imports` (9) — converted `typeof import('…')` annotations to top-level type imports.
- `import/no-duplicates` (4) — consolidated dup imports.
- `import/order` (5) — reorganized imports.
- `@typescript-eslint/no-unsafe-*` (~117) — biggest single category, mostly resolved by **removing redundant defensive `Array.isArray(...)` guards** on already-typed array params. The negative-narrowing of `Array.isArray` against `readonly T[]` widens to `any[]`, which then propagates `any` through every member access in the function. Removing the redundant guards restored the source types. Cases driven by external JSON (`JSON.parse(...)`, npm audit output, package.json shapes) were given concrete `as <Type>` casts with shape-specific interfaces — never `as any`.
- `sonarjs/no-empty-function` (14) — added bodies (`/* swallow logged warning */`) or per-file disables for test scenario hooks.
- `sonarjs/no-nested-conditional` (14) — extracted intermediate `let X; if/else if/else` blocks; added named helpers (e.g. `getTypeRefName`, `rowStatus`, `getParamIdentifierName`).
- `@typescript-eslint/no-unused-vars` / `sonarjs/no-unused-vars` / `sonarjs/unused-import` (~25) — dropped dead destructure entries, removed dead imports, removed `let` declarations that were never read.
- `sonarjs/deprecation` (10) — fixed via rename for false positives (`matchDeprecatedTag` → `isLegacyJsdocLine`; rephrased a JSDoc that contained `@deprecated` as a doc reference). Cases that genuinely use deprecated types (the legacy `LegacyLoadResultPayload` back-compat path) got per-line disables with a "this IS the legacy compat surface" rationale.
- `unicorn/consistent-function-scoping` (9) — hoisted ANSI helpers in `clear.ts` to module scope, extracted `escapeForScriptContext` in dashboard generator, extracted `getParamIdentifierName`. Test file describe-scoped factories that close over outer state got per-line disables.
- `sonarjs/no-duplicate-string` — left as warnings (per the brief: "zero errors"; no-duplicate-string is configured as `warn`).
- `sonarjs/redundant-type-aliases` (6) — kept as semantic aliases (`CheckSlug`, `CheckConcern`, `CheckLanguage`, `CheckId`, `Severity`, `PersonaType`) with per-line disables that document why the alias exists.
- `prefer-const` (3) — converted `let X; X = …;` to `const X = …;`; merged ternaries.
- `@typescript-eslint/no-redundant-type-constituents` (3) — removed `unknown |` from a `unknown | null` return type; kept `SignalCategory | string` with disable (intentional extensibility hook).
- `unicorn/no-array-reverse` (2) — wanted `Array#toReversed()` (ES2023) but the workspace targets ES2022. Per-line disable on `.reverse()` calls citing target.
- `@typescript-eslint/no-base-to-string` (3) — used `recipeOrName.name` and `JSON.stringify(type)` for object-shaped union members.
- `unicorn/no-immediate-mutation` (2) — replaced `const arr = []; arr.push(...x)` with `const arr = [...x]`.
- `sonarjs/no-nested-template-literals` (3) — extracted intermediate vars.
- `sonarjs/no-unenclosed-multiline-block` (4) — fixed indentation of `if (!sourceFile) return []` to align with the surrounding try block.
- `sonarjs/single-character-alternation` / `sonarjs/single-char-in-character-classes` (4) — `(?:\*|\{)` → `[*{]`; `[\w]+` → `\w+`.
- `unicorn/no-await-expression-member` (1) — extracted `const raw = await prompt(); const answer = raw.trim()…`.
- `unicorn/prefer-top-level-await` (1) — replaced `main().catch(…)` with top-level `try { await main() } catch …`.
- `unicorn/prefer-default-parameters` (1) — `formatValidatedColumn(…, itemType = 'items')`.
- `unicorn/prefer-structured-clone` (1) — `JSON.parse(JSON.stringify(x))` → `structuredClone(x)`.
- `sonarjs/no-redundant-assignments` (1) — removed redundant `sliceLen = 2` reassignment.
- `sonarjs/no-undefined-argument` — per-line disable on the test that explicitly exercises the undefined-argument behavior.
- `sonarjs/reduce-initial-value` (1) — supplied initial value to `reduce`.
- `sonarjs/prefer-regexp-exec` (1) — `.match(re)` → `re.exec(str)` for non-global regex.
- `sonarjs/no-empty-collection` (1) — per-line disable on `WORKSPACE_PREFIXES.some(...)` (the constant is intentionally empty for project-config population).
- `sonarjs/no-extra-arguments` (1) — typed the initial `getCheckIcon` value with the slug parameter that callers actually pass.
- `unicorn/no-unreadable-array-destructuring` (1) — replaced `[, , a, , b, c, d] = match` with explicit `match[2]`/`match[4]`/etc.
- `react-hooks/exhaustive-deps` (1) — removed an `eslint-disable-line react-hooks/exhaustive-deps` comment for a rule the workspace eslint config doesn't load.
- `sonarjs/prefer-read-only-props` (1) — wrapped React component props with `Readonly<…>`.
- `@typescript-eslint/no-floating-promises` (1) — added `void` before an IIFE inside `useEffect`.
- `@typescript-eslint/restrict-template-expressions` (1) — `JSON.stringify(type)` for object members in template literals.

### Rules cleared by **per-line eslint-disable with rationale**

#### `@typescript-eslint/require-await` (39)

Pattern: `async` functions that satisfy a Promise-returning interface contract but currently have no internal `await`. Two flavors:

1. **AnalyzeAllCheckConfig conformance** — fitness checks declare `analyzeAll(...): Promise<CheckViolation[]>`. Several implementations are synchronous internally. Per-line disable on each implementation; rationale: "AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous". Affected files (8):
   - `packages/fitness/checks-universal/src/checks/architecture/dependencies/no-duplicate-packages.ts`
   - `packages/fitness/checks-universal/src/checks/architecture/modules/empty-package-detection.ts`
   - `packages/fitness/checks-universal/src/checks/architecture/project-readme-existence.ts`
   - `packages/fitness/checks-universal/src/checks/architecture/stale-build-artifacts.ts`
   - `packages/fitness/checks-universal/src/checks/quality/dependency-version-consistency.ts`
   - `packages/fitness/checks-universal/src/checks/testing/test-convention-consistency.ts`
   - `packages/fitness/checks-universal/src/checks/testing/test-file-naming.ts`
2. **Public async APIs and scenario phase hooks** — `pluginSync/Add/RemoveFromConfig` (CLI), `processCheckResult` (parallel-execution), test-mock execute/run signatures, predicate registry callbacks. Per-line disables on each; rationale: "callers `await` this; preserving async signature in case future processors become async".
3. **Per-file disables in test scenarios** — `define-invariant.test.ts` and `legacy-define-scenario.test.ts` exercise the full scenario lifecycle hook contract (`setup/act/assert: () => Promise<void>`). Most fixtures are intentionally sync-only. Per-file disable + `no-empty-function` is appropriate; alternative was 14+ per-line disables.

#### `unicorn/no-for-loop` (7 files)

Pattern: index-bearing scans where the loop variable `i` is used as a UTF-16 offset in a result array (line-start tables, word-end indices). `for...of [...src].entries()` would split by code points, breaking offsets for surrogate pairs. Per-line disable on each scanner with rationale "offset-bearing scan, not pure iteration":
- `packages/languages/lang-go/src/parse.ts`
- `packages/languages/lang-java/src/parse.ts`
- `packages/languages/lang-python/src/parse.ts`
- `packages/languages/lang-rust/src/parse.ts`
- `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts`
- `packages/fitness/engine/src/framework/content-filter.ts` (2 occurrences)
- `packages/fitness/engine/src/framework/pattern-detector.ts`

**Note**: this is **>5 files for the same rule**, but the pattern is identical across all and the rationale is identical (UTF-16 offset preservation). Per the brief I'm flagging it explicitly — the right systemic move is for the orchestrator to consider whether `unicorn/no-for-loop` deserves a per-language-pack override in the eslint config rather than per-file disables. I did not modify the eslint config.

#### `unicorn/prefer-spread` (5 files, language strippers)

Pattern: `src.split('')` on the language tokenizers. Spread (`[...src]`) and `Array.from(src)` both split by code points; we need UTF-16 unit indexing for offset-preserving stripping. Per-line disable on each:
- `packages/languages/lang-{cpp,go,java,python,rust}/src/strip.ts`

Same caveat as `no-for-loop`: 5 files for the same justified pattern. Surfaced.

#### `sonarjs/cognitive-complexity` (33 sites)

These are state machines (token scanners, lexers), AST walkers, CLI command flow, multi-format dispatchers. Each disable carries a rationale specific to the function:

- `packages/languages/lang-{cpp,go,java,python,rust}/src/strip.ts::scan` — token state machine
- `packages/languages/lang-rust/src/strip.ts::scanRegularString` — Rust raw-string scanner
- `packages/fitness/engine/src/framework/strip-literals.ts::stripStringsAndCommentsPreservingPositions` — single-pass tokenizer
- `packages/fitness/engine/src/framework/import-graph.ts::strongConnect` — iterative Tarjan SCC
- `packages/fitness/engine/src/framework/content-filter.ts::filterContentImpl` — TS scanner driver
- `packages/fitness/engine/src/plugins/loader.ts::loadPlugin` — plugin domain dispatcher
- `packages/fitness/engine/src/plugins/check-package-discovery.ts::autoDiscoverChecks/readCheckPackageMetadata` — npm exports-map walker
- `packages/fitness/engine/src/cli/fit.ts::executeFit` — top-level CLI flow
- `packages/fitness/engine/src/sarif.ts::buildSarifRuns/chunkSarifRuns/reportToCloud` — SARIF assembly
- `packages/fitness/engine/src/gate.ts::renderGateCompareOutput` — multi-section diff renderer
- `packages/cli/src/commands/init.ts::generateInitConfig` — multi-shape config emitter
- `packages/cli/src/commands/project-plugins.ts::pluginSync` — domain dispatcher
- `packages/core/src/plugins/{discover,tool-package-discovery}.ts` — exports-map resolution
- `packages/fitness/checks-typescript/src/checks/architecture/{drizzle-orm-migration-guardrails,missing-type-exports}.ts` — multi-pattern guardrails
- `packages/fitness/checks-typescript/src/checks/quality/patterns/{toctou-race-condition,throws-documentation,async-patterns}.ts` — AST-shape-driven heuristics
- `packages/fitness/checks-typescript/src/checks/resilience/context-safety.ts::collectContextLeakage` — module/class-level walker
- `packages/fitness/checks-universal/src/checks/architecture/heavy-import-detection.ts` — bundler-aware patterns
- `packages/fitness/checks-universal/src/checks/resilience/sentry/{sentry-helpers,sentry-pii-scrubbing}.ts` — multi-line bracket scanner; tiered detector
- `packages/simulation/engine/src/kinds/chaos/executor.ts::runWindow` — chaos load window driver
- `packages/simulation/engine/src/kinds/fix-evaluation/executor.ts::placeholderVerdict` — recursive verdict builder

**Note**: 33 sites is well over the >5 threshold. Surfaced for the orchestrator. The cognitive-complexity threshold (15, the sonar default) is conservative. The orchestrator may want to either raise the threshold per package or accept these as legitimate state-machine/dispatcher patterns. I did not modify the config.

#### `sonarjs/slow-regex` (5 sites)

All regexes are anchored, bounded, or run against single lines. Per-line disables with regex-shape rationale.

#### `sonarjs/regex-complexity` (4 sites)

Multi-shape SQL DML/DDL pattern, `class … extends … implements …`, `'use client'` directive scanner with comment-prefix handling, validator/parser name prefix list. Per-line disables.

#### `sonarjs/os-command` (4 sites)

`spawn` / `execSync` calls where the command argument is from an internal allowlist (`ORPHAN_CANDIDATE_PROCESSES`) or developer-supplied check command (not user input). Per-line disables.

#### `sonarjs/publicly-writable-directories` (3 sites)

`/tmp/...` literals appearing as **string fixtures** in tests, never used in actual filesystem ops. Per-line disables.

#### `sonarjs/fixme-tag` (2 sites)

Files whose job is to detect FIXME markers. The keyword appears in JSDoc and regex literals by necessity. One per-file disable on `no-todo-comments.ts`, one on `no-stub-tests.ts`.

#### `sonarjs/redundant-type-aliases` (6 sites)

Semantic aliases (`CheckSlug = string`, `PersonaType = string`, etc.) that exist for documentation. Per-line disables; rationale "semantic alias documents intent (a slug vs raw string)".

#### `unicorn/filename-case` (5 React component test files + 2 hook files)

React component test files mirror the PascalCase component filenames; renaming them would diverge from the React/component convention. React `useXxx` hooks use camelCase. Per-file disables.

### Per-file disable inventory (with rationale)

| File | Rule(s) disabled | Rationale |
|---|---|---|
| `packages/cli/src/__tests__/ui/components/Banner.test.tsx` | `unicorn/filename-case` | mirrors PascalCase React component name |
| `packages/cli/src/__tests__/ui/components/ErrorMessage.test.tsx` | `unicorn/filename-case` | mirrors PascalCase React component name |
| `packages/cli/src/__tests__/ui/components/Findings.test.tsx` | `unicorn/filename-case` | mirrors PascalCase React component name |
| `packages/cli/src/__tests__/ui/components/ResultsTable.test.tsx` | `unicorn/filename-case` | mirrors PascalCase React component name |
| `packages/cli/src/__tests__/ui/components/Summary.test.tsx` | `unicorn/filename-case` | mirrors PascalCase React component name |
| `packages/cli/src/ui/hooks/useClock.ts` | `unicorn/filename-case` | React `useXxx` hook convention |
| `packages/cli/src/ui/hooks/useSpinner.ts` | `unicorn/filename-case` | React `useXxx` hook convention |
| `packages/fitness/checks-universal/src/checks/no-todo-comments.ts` | `sonarjs/fixme-tag` | this file's job is to detect TODO/FIXME markers |
| `packages/fitness/checks-universal/src/checks/testing/no-stub-tests.ts` | `sonarjs/fixme-tag` | this file's job is to detect FIXME markers in test bodies |
| `packages/simulation/engine/src/__tests__/define-invariant.test.ts` | `@typescript-eslint/require-await`, `@typescript-eslint/no-empty-function` | scenario phase hooks must match `() => Promise<void>` shape; sync-only stubs |
| `packages/simulation/engine/src/__tests__/registry-cross-kind.test.ts` | `@typescript-eslint/no-empty-function` | scenario phase hook stubs |
| `packages/simulation/engine/src/__tests__/legacy-define-scenario.test.ts` | `sonarjs/deprecation` | this is the test suite for the deprecated `defineScenario` back-compat path |
| `packages/simulation/engine/src/kinds/invariant/executor.ts` | `@typescript-eslint/require-await` | driver stubs match the `() => Promise<T>` contract; throw synchronously until Phase 7 |
| `packages/fitness/checks-typescript/src/checks/quality/patterns/toctou-race-condition.ts::classifyFunctionCalls` | `sonarjs/cognitive-complexity` (block) | TOCTOU classifier and inner AST visitor; flatter shape would hide read/update pairing |

(All other disables are per-line.)

## Constraint compliance

- **Eslint config not modified.**
- **Working tree from auto-fix not reverted.** The two protected re-export files (`packages/fitness/engine/src/{framework/ast-utilities.ts,index.ts}` and `packages/languages/lang-typescript/src/ast-utilities.ts`) had been broken by the auto-fix pass — `import * as _ts; export { _ts as ts }` got replaced with `export * as ts from 'typescript'`, which is invalid because the `typescript` module uses `export =`. I restored the working pattern with the appropriate `eslint-disable` block (`unicorn/import-style`, `unicorn/prefer-export-from`, `import/order`, `import/first`). This was the only path to a green build.
- **No `as any` casts introduced.** Only typed `as <Type>` casts with shape-specific interfaces (audit JSON, package.json shape, plugin recipes array).
- **No tests deleted or modified to satisfy lint.**
- **No `// @ts-expect-error` introduced.**
- **All disable comments include a `--` rationale.**

## Items surfaced for orchestrator decision

1. **`unicorn/no-for-loop`** (7 files): same pattern across language parsers and content scanners — UTF-16 offset preservation. Could be cleaner as a per-language-pack rule override.
2. **`unicorn/prefer-spread`** (5 files): same pattern (`split('')` for UTF-16 indexing). Same suggestion.
3. **`sonarjs/cognitive-complexity`** (33 sites): default threshold of 15 is conservative for this codebase's state-machine and dispatcher style. Consider raising to 20 for fitness-checks packages or accepting per-file disables as documented design.
4. **`sonarjs/no-duplicate-string`** (7 warnings): these are YAML config emissions and YAML quote-style strings (`'      - "**/*.ts"'`). Sonarjs would have me extract them, but the resulting code is harder to read. Left as configured warnings.
