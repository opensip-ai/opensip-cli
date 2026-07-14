---
status: deferred
last_verified: 2026-07-13
owner: opensip-cli
---

# ADR-0162: Defer TypeScript 7.x until its compiler API is stable

```yaml
id: ADR-0162
title: Defer TypeScript 7.x until its compiler API is stable
date: 2026-07-13
status: deferred
supersedes: []
superseded_by: null
related: [ADR-0010, ADR-0056, ADR-0118]
tags: [typescript, toolchain, performance, compiler-api]
enforcement: not-mechanizable
enforcement-reason: >
  Closing the gate depends on an upstream stable API commitment, ecosystem
  compatibility, capability probes, and measured migration evidence. Those are
  release-time judgments rather than a static repository invariant.
```

**Decision:** Keep every OpenSIP CLI TypeScript pin on `~6.0.3` and defer both a
TypeScript 7 build-compiler change and a runtime compiler-API migration. Reopen
the runtime migration only when a stable, supported top-level
`createProgram(rootFiles, compilerOptions)` API (or a documented equivalent)
exists and the complete capability and acceptance gates below pass.

The gate is deliberately **open**. `createProgram(rootFiles, compilerOptions)`
is the named candidate API, not an API that this ADR claims TypeScript 7.1 has
shipped. On 2026-07-13, an upstream maintainer described that top-level API as
something they expected to add eventually; the statement did not commit it to
7.1. If 7.1 ships without the supported contract, OpenSIP CLI waits for the
release that does provide it.

## Two independent TypeScript surfaces

“Upgrade TypeScript” currently describes two different changes and must not be
treated as one dependency bump:

| Surface | Current role | Readiness decision |
|---|---|---|
| Build compiler | Root and package `devDependencies` use `typescript ~6.0.3`; Turbo package scripts invoke that line's `tsc` for build and typecheck. | A future TypeScript 7 `tsc` experiment may measure build/typecheck throughput, but this ADR does not authorize it. It needs ecosystem support and every validation command below. |
| Runtime compiler API | Six runtime manifests depend on `typescript ~6.0.3`: `lang-typescript`, `graph-typescript`, `checks-typescript`, `checks-dogfood`, `fitness`, and `yagni`. Their shipped JavaScript imports compiler objects and functions. | Do not migrate until the stable public package/export and every capability row below are available. An internal or explicitly unstable subpath is not sufficient. |

The official TypeScript 7.0 guidance explicitly permits running the native
preview compiler beside `@typescript/typescript6` for code that still needs the
JavaScript compiler API. That can be useful for a future build-only experiment,
but it is not evidence that OpenSIP CLI's runtime API has migrated, and it must
not create an accidental mix of incompatible compiler-object identities.

## Required API and capability matrix

The candidate stable entry point is a top-level
`createProgram(rootFiles, compilerOptions)`. Program construction alone is
necessary but not sufficient: OpenSIP CLI uses TypeScript as a parsing, binding,
type-checking, and scanner substrate.

| Required stable capability | Current TypeScript 6 API shape | Representative consumers | Gate to close |
|---|---|---|---|
| Supported package and entry point | `import ts from 'typescript'` / `import * as ts from 'typescript'` | All TypeScript adapters and check engines | The upstream package must document a stable public programmatic API. A root export containing only `version`, or an `unstable/*` subpath, fails. |
| Program construction from explicit roots/options | `ts.createProgram({ rootNames, options })` | `packages/languages/lang-typescript/src/program-service.ts`; `packages/graph/graph-typescript/src/parse.ts` | A stable top-level `createProgram(rootFiles, compilerOptions)` or documented equivalent must preserve explicit roots, compiler options, source lookup, and project behavior. |
| Config discovery and expansion | `findConfigFile`, `parseConfigFileTextToJson`, `parseJsonConfigFileContent`, `sys` | `packages/languages/lang-typescript/src/program-service.ts` and graph project discovery | Stable equivalents must resolve `extends`, effective options, project roots, and filesystem hosts without importing compiler internals. |
| Standalone source parsing and traversal | `createSourceFile`, `forEachChild`, node parent chains, `ScriptKind` | `packages/languages/lang-typescript/src/parse.ts`; graph fast mode; TypeScript checks and YAGNI AST walks | Source-text parsing must support TS/TSX/JS/JSX with deterministic locations and parent/traversal behavior. |
| Scanner and trivia classification | `createScanner`, `SyntaxKind`, `LanguageVariant`, scanner token offsets | `packages/languages/lang-typescript/src/filter.ts` | Stable scanner behavior must preserve UTF-16 offsets, comment/string/template tokenization, and template rescanning. |
| Binding, diagnostics, and checker semantics | `Program.getTypeChecker`, syntactic diagnostics, `TypeChecker` symbol/type queries | `packages/graph/graph-typescript/src/parse.ts`, `edges.ts`, and `semantic-reference-facts.ts`; typed fitness checks | Exact graph resolution, cross-file declaration/reference facts, diagnostics, control-flow narrowing, and nullable-type checks must pass existing equivalence fixtures. |
| Public AST types, guards, flags, and enums | `Node`, `SourceFile`, `Symbol`, `Type`, `TypeFlags`, `is*` guards, and syntax/module enums | `lang-typescript`, `graph-typescript`, `checks-typescript`, `checks-dogfood`, `fitness`, and `yagni` | Public types and runtime values must cover existing call sites, or an approved adapter must provide equivalent behavior without unstable imports. |

## Upstream evidence and why the gate remains open

- The official [TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)
  says the native port does not yet expose a stable programmatic API and points
  API consumers at the TypeScript 6 compatibility package for side-by-side use.
- The tagged [TypeScript 7.0.2 native-preview README](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/README.md#L26-L52)
  marks its API as not ready, and its
  [package export map](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/_packages/native-preview/package.json#L38-L84)
  exposes only version information at the stable root while labelling other
  programmatic paths unstable.
- An upstream maintainer's [candidate API note](https://github.com/microsoft/typescript-go/issues/4503#issuecomment-4959823560)
  names the eventual top-level `createProgram(rootFiles, compilerOptions)`
  direction. It is useful design evidence, but it is neither an implemented
  export nor a 7.1 release commitment.
- At the verification commit, upstream `main` identified itself as
  [7.1.0-dev](https://github.com/microsoft/typescript-go/blob/8a749379d556f1bb4044218a1f94bc90fbfb6a03/internal/core/version.go#L1-L10)
  while its [README still marked the API as not ready](https://github.com/microsoft/typescript-go/blob/8a749379d556f1bb4044218a1f94bc90fbfb6a03/README.md#L26-L52).
  A development version label therefore does not close this gate.

These sources are the reason this ADR uses the repository-valid `deferred`
status rather than pretending a proposed or completed migration exists.

## Current pins and migration acceptance gates

At verification time, the root and normal workspace development pins are
`typescript ~6.0.3`; the six runtime packages named above use the same range;
the lockfile resolves the root compiler to 6.0.3. This decision changes no
manifest, lockfile, `tsconfig`, ESLint setting, emitted artifact, or runtime
command.

A future migration proposal must satisfy all of the following:

1. A stable upstream release and supported package export document the named
   program-construction API (or an explicitly mapped equivalent) and every
   capability-matrix row has a focused probe.
2. The proposal records separate build-compiler and runtime-API package names,
   versions, and ownership. All workspace pins move intentionally; there is no
   hidden mix of TypeScript object models across package boundaries.
3. `typescript-eslint`, the import resolver, Turbo tasks, declaration emit, and
   package build scripts support the selected compiler line.
4. A before/after `pnpm bench:toolchain -- --out <path>` comparison uses the
   same host, commit-equivalent sources, repetition count, command order, and
   explicit cache mode. The report covers `pnpm build`, `pnpm typecheck`, and
   the type-aware ESLint command.
5. `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and
   `pnpm graph:equivalence:ci` all pass. TypeScript graph exact/fast fixtures,
   scanner/filter fixtures, and typed fitness fixtures remain behaviorally
   equivalent.
6. Any compiler or diagnostic behavior change is documented as such. A faster
   compiler is developer/CI throughput evidence, **not** a claim that the built
   OpenSIP CLI runs faster.

The toolchain report emits JSON plus compact Markdown with min/median/p95,
explicit Turbo cache semantics, bounded child execution, and Node/pnpm/
TypeScript/CPU/OS/Git metadata. It is intentionally separate from runtime SLO
reports and budgets.

## Deferred stricter-checker candidates

Evaluate these only after the API gate passes and a same-machine toolchain
baseline exists. This ADR enables none of them.

| Candidate | Expected benefit | Likely error surface | Required validation |
|---|---|---|---|
| `skipLibCheck: false` | Detect incompatible or malformed dependency declarations. | Third-party `.d.ts` files and package-version skew across the workspace. | Full build, typecheck, lint, tests, and packed-package consumer fixtures. |
| `noUncheckedIndexedAccess: true` | Makes unchecked array/map/index-signature reads explicitly nullable. | Graph collectors, config maps, datastore row mapping, and test fixtures. | Full typecheck plus graph/fitness equivalence and persistence tests. |
| `exactOptionalPropertyTypes: true` | Distinguishes an absent property from a present `undefined` value. | Contracts, signal/session serialization, config composition, and test builders. | Full typecheck, contract fixtures, JSON/SARIF/session compatibility tests. |
| `noPropertyAccessFromIndexSignature: true` | Makes index-signature access intent explicit. | Config and parsed external-tool payload access. | Full typecheck and config/adapter fixture suites. |

**Alternatives:**

- Adopt the TypeScript 7 native preview now — rejected because its documented
  programmatic exports are unstable and do not satisfy the matrix.
- Switch only the build compiler now and keep the TypeScript 6 runtime API — a
  valid future experiment, but rejected for this optimization cycle until the
  package split, lint ecosystem, and baseline comparison are planned explicitly.
- Stay on TypeScript 6 indefinitely — rejected; the gate is evidence-based and
  should be revisited when upstream publishes a stable contract.

**Rationale:** OpenSIP CLI's customer-facing TypeScript analysis depends on
semantic equivalence, not only successful compilation. Humans and agents both
lose trust if an apparently faster toolchain silently weakens graph edges,
locations, diagnostics, or fitness findings. A named, testable gate preserves
that evidence while allowing runtime profiling and optimization work to proceed
independently.

**Consequences:** TypeScript 7.0 and uncommitted 7.1 preview APIs are outside
this performance program. The current 6.0.3 line remains the supported build
and runtime substrate. Future proposals can use the toolchain benchmark as
comparison evidence, but cannot use compiler throughput as a runtime win.

**Related specs / ADRs:** [ADR-0010](ADR-0010-lang-canonical-parse-substrate.md)
owns the canonical TypeScript parsing substrate; [ADR-0056](ADR-0056-architecture-audit-remediation.md)
records the supported frontier toolchain posture; [ADR-0118](ADR-0118-scale-and-performance-slos.md)
keeps runtime SLO evidence separate from this toolchain lane.
