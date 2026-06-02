# Spec: Shared scaffolding for the tree-sitter graph adapters

> Status: **PROPOSED** (2026-06-01).
> Sibling of [graph-per-package-coupling.md](./graph-per-package-coupling.md)
> and [graph-edge-import-constraint.md](./graph-edge-import-constraint.md).

## Objective

The four tree-sitter graph adapters — `@opensip-tools/graph-go`,
`graph-java`, `graph-python`, `graph-rust` — were each authored from the
same template (`graph-rust` first, then go/java/python "mirror graph-rust").
The template scaffolding has since drifted into **byte-identical copies of
the same production functions across packages**, which a real `graph` run
surfaces as cross-adapter body-twins (functions with identical `bodyHash`
in different packages):

| Function | Packages | ~bytes |
|---|---|---|
| `buildNameIndex` | go, java, python | 437 |
| `hashConfig` | go, java, rust | 370 |
| `synthesizeModuleInit` (skeleton) | go, java, python, rust | 253 |
| `record` | go, java, python, rust | 187 |
| `skipBlockComment` (non-nested) | go, java | 172 |
| `normalizeProjectDir` | go, java, python, rust | 149 |
| `skipToEndOfLine` | go, java, python, rust | 138 |
| `isTestFile` | go, java, rust | 114 |
| `cacheKey` (prefix wrapper) | go, java, python, rust | 104 |
| `realpathOrPath` | go, java, python, rust | 98 |
| `isGeneratedFile` | go, java, python, rust | 86 |
| `nameOf` | python, rust | — |

Beyond the named functions, the duplication is **structural across whole
modules**: `parse.ts`, `discover.ts`, and the `walkProject`/`record`/
`isTestFile`/`isGeneratedFile`/`synthesizeModuleInit` tail of `walk.ts` are
template clones whose only per-language inputs are a grammar binding, a few
regexes/glob lists, and a log tag.

Extract that scaffolding into a new shared package
(**`@opensip-tools/graph-adapter-common`**) that the four tree-sitter
adapters consume, leaving each adapter with only its genuinely
language-specific code (grammar binding, node-kind mapping, comment
grammar, resolver logic).

**Success:** the duplicated-function-body fitness/graph signal reports **0
cross-adapter body-twins** for the moved functions; each adapter shrinks to
its language-specific surface; all gates stay green; `graph-typescript` is
untouched (it uses the TS compiler, not tree-sitter, and shares none of
this skeleton).

## Scope

### In scope

- A new leaf package `@opensip-tools/graph-adapter-common` under
  `packages/graph/graph-adapter-common/`, depending only on
  `@opensip-tools/graph` (engine) and `@opensip-tools/core` (logger),
  plus `glob` and `tree-sitter` as runtime deps.
- Moving the structurally-shared scaffolding out of `graph-go`,
  `graph-java`, `graph-python`, `graph-rust`:
  - **`discover.ts`** — `normalizeProjectDir`, `realpathOrPath`, the
    glob+realpath+dedup+sort collect loop, and the `DiscoverOutput`
    assembly. Verified byte-identical at
    `packages/graph/graph-go/src/discover.ts:64-128`,
    `graph-rust/src/discover.ts:63-129`,
    `graph-python/src/discover.ts:66-129`,
    `graph-java/src/discover.ts:80-143`.
  - **`parse.ts`** — the entire `parseProject` body
    (`graph-go/src/parse.ts:38-91`, `graph-rust/src/parse.ts:38-91`,
    `graph-java/src/parse.ts:37-87`, `graph-python/src/parse.ts:41-94`),
    which differs only in the grammar import, the `setLanguage` cast, the
    `module` log tag, and the named `*ParsedFile`/`*ParsedProject` types.
  - **`cache-key.ts`** — the `hashConfig(configPathAbs)` helper
    (byte-identical in go/java/rust: `graph-go/src/cache-key.ts:25-39`,
    `graph-java/src/cache-key.ts:33-47`, `graph-rust/src/cache-key.ts:27-41`)
    and the `existsSync`/`missing:`/`unreadable:` config-fingerprint
    contract. Python's variant (`graph-python/src/cache-key.ts:38-59`)
    layers a `requires-python` extraction on top — see the seam below.
  - **`walk.ts` tail helpers** — `record`
    (`graph-go/src/walk.ts:401-405` and twins), `isTestFile` /
    `isGeneratedFile` (regex-parameterized;
    `graph-go/src/walk.ts:407-413` and twins), and the
    `walkProject` driver skeleton (`graph-go/src/walk.ts:70-95` and twins:
    build `occurrences`/`callSites`/`dependencySites`/`parseErrors`,
    filter+sort `input.files`, per-file try/catch → `ParseError`).
  - **`buildNameIndex`** from each adapter's resolver
    (`graph-go/src/resolve.ts:262-274`,
    `graph-java/src/resolve.ts:103-115`,
    `graph-python/src/resolve.ts:286`).
  - The **module-init synthesis skeleton** (`synthesizeModuleInit`,
    `graph-go/src/walk.ts:363-396` and twins): top-level-text join →
    `digestSyntheticBody` → `FunctionOccurrence` of `kind: 'module-init'`.
    Per-language pieces (the `qualifiedName` shape, the file-extension
    strip) inject as config.
- Updating `.dependency-cruiser.cjs` so the new package is a sanctioned
  upstream of the adapters and is itself disjoint from the engine cycle.
- Updating `RELEASING.md` (package table, count 29 → 30, publish order),
  `.github/workflows/release.yml` (preflight list + pack/publish steps),
  and `scripts/bootstrap-publish.sh` (`PACKAGES` array).
- Updating `CLAUDE.md`'s repository-structure tree.

### Out of scope (with reasons)

- **`graph-typescript`.** It is backed by the TypeScript compiler, not
  tree-sitter; it has no `parse.ts` grammar binding, its `cache-key.ts`
  (`graph-typescript/src/cache-key.ts`) and `normalize-project-dir.ts`
  differ, and it carries a wholly separate `edge-resolvers/` +
  `inventory-visitors/` architecture. Folding it in would force a false
  abstraction. It MUST NOT depend on the new package.
- **The comment-stripping grammars** (`stripGoComments`,
  `stripRustComments` with nested block comments + char-vs-lifetime
  heuristic, `stripPythonComments` + docstring strip,
  Java's stripper). These are genuinely per-language and stay in each
  adapter's `body-digest.ts`. Only the leaf `skipToEndOfLine` primitive
  (identical everywhere) and the `digestXBody = hashBody(normalizeWhitespace(strip…))`
  wiring pattern move; the strip function is **injected**.
- **Resolver bodies** (`resolve.ts` / `resolve-dependencies.ts`): call-target
  extraction, import-path decoding, receiver-type narrowing, edge keying.
  These are language-AST-specific (`graph-rust/src/walk.ts` alone is 25 KB
  of use-declaration handling). Only `buildNameIndex` — which operates on
  the language-agnostic `FunctionOccurrence` record — moves.
- **`rule-hints.ts`** and **`walk-metadata.ts`** (go/java only): per-language
  signal definitions; not duplicated across all four.
- **Changing the engine `GraphLanguageAdapter` contract**
  (`packages/graph/engine/src/lang-adapter/types.ts`). The new package is a
  *helper layer for implementing* that contract, not a change to it.
- **De-duplicating `body-digest.ts` digest aliasing** beyond extracting
  `skipToEndOfLine` and the wiring helper — the strippers diverge.

## Technical Context

### Existing architecture (with real refs)

- **The contract** every adapter implements:
  `GraphLanguageAdapter<P>` in
  `packages/graph/engine/src/lang-adapter/types.ts:235-250`, with input
  types `DiscoverInput`/`DiscoverOutput` (`:47-60`), `ParseInput`/
  `ParseOutput<P>` (`:67-92`), `WalkInput<P>`/`WalkOutput` (`:99-160`),
  `ResolveInput`/`ResolveOutput` (`:162-211`), `CacheKeyInput` (`:213`),
  `RuleHints` (`:231`).
- **Engine helpers already shared** (consume, don't re-create):
  `normalizeWhitespace`, `hashBody`, `BodyDigest` from
  `@opensip-tools/graph` (`packages/graph/engine/src/index.ts:138`);
  `FunctionOccurrence` (`:44`); `ownerEdgeKey` (`:165`); `CacheKeyInput`
  (`:100`). The new package builds **on top of** these.
- **Each adapter's `index.ts`** is a thin descriptor assembling six
  functions into a `GraphLanguageAdapter` and re-exporting
  `adapter`/`metadata` for plugin discovery
  (`graph-go/src/index.ts:32-50` and structurally-identical twins). This
  file stays per-adapter (it names the language) but its body becomes a
  call to a shared `defineTreeSitterAdapter({...})` factory.
- **Per-adapter file layout** (the template): `discover.ts`, `parse.ts`,
  `walk.ts`, `resolve.ts`(/`resolve-dependencies.ts`), `cache-key.ts`,
  `rule-hints.ts`, `body-digest.ts` (+ go/java `walk-metadata.ts`,
  java/python/rust `walk-dependencies.ts`).

### Key dependencies

- `@opensip-tools/graph` (engine) — types + body-digest + owner-key
  primitives. The new package depends on it (downstream of the engine,
  like the adapters).
- `@opensip-tools/core` — `logger` only (used by `parse`/`discover` log
  events).
- `glob` (discover), `tree-sitter` (parse). Currently direct deps of each
  adapter; become deps of the common package, retained in adapters only if
  still used for language-specific code.

### Constraints

- **`graph-adapters-disjoint` will fire on the obvious name.** The rule at
  `.dependency-cruiser.cjs:465-486` forbids any
  `^packages/graph/graph-[a-z0-9-]+/src/` file from importing any *other*
  `^packages/graph/graph-[a-z0-9-]+/` package. A package literally named
  `graph-adapter-common` placed under `packages/graph/` **matches that
  pattern**, so every adapter importing it would be flagged as a
  cross-adapter dependency. This is the single most load-bearing
  constraint — see DEC-1.
- **No engine → common edge.** `graph-engine-no-adapter-packs`
  (`.dependency-cruiser.cjs:440-451`) forbids `engine/src` → `graph-*`. The
  common package is downstream of the engine; the engine must never import
  it. This is naturally satisfied (the engine discovers adapters via the
  registry walker) and must be asserted by a rule.
- **Adapter isolation rules must still cover the common package**:
  no CLI dep (`graph-adapters-no-cli`, `:490-494`), no fitness/checks dep
  (`graph-adapters-no-fitness-or-checks`, `:500-506`;
  `graph-no-fitness`, `:524-534`). The common package, being under
  `packages/graph/`, is already caught by the pattern-based `from` clauses
  of `graph-no-fitness`; the `graph-adapters-*` rules use
  `graph-[a-z0-9-]+` and would also catch it — desirable, keep it.
- **Plugin discovery contract preserved.** Each adapter still exports
  `adapter` + `metadata` from its own `index.ts`; the CLI bootstrap
  registers them unchanged. The common package exports **no** `adapter`.
- **Release ordering.** The common package depends on the engine and is a
  dependency of the four adapters, so it publishes **after `graph`
  (engine) and before the adapter packs** (RELEASING.md step 11.5).
- **Brand-new npm package.** First release after this lands will 404 on
  `@opensip-tools/graph-adapter-common` until its trusted publisher exists;
  the bootstrap path (RELEASING.md "Bootstrapping a brand-new package")
  applies.

## Design Decisions

| Decision | Choice | Rationale | Alternatives (rejected) |
|---|---|---|---|
| **DEC-1: Package name / location vs. the disjoint rule** | Name it `@opensip-tools/graph-adapter-common`; place it at `packages/graph/graph-adapter-common/`; **refine `graph-adapters-disjoint`** to exempt this one well-known upstream via `to.pathNot` (add `^packages/graph/graph-adapter-common/` to the exclusion), and add a positive rule `graph-adapters-may-use-common`. | Keeps it visually grouped with the adapters; the disjoint rule's *intent* is "adapters don't couple to each other's *language* code", which a shared scaffolding layer doesn't violate. A precise carve-out is truthful to that intent. | (a) Name it `graph-shared` outside the `graph-` pattern — rejected: it would still need to live somewhere and `graph-adapter-common` is the clearest name; renaming to dodge a regex is the tail wagging the dog. (b) Put it under `packages/graph/engine/` as a subpath export — rejected: violates the engine-must-not-know-about-adapters layering and the "subpath exports discouraged" convention. (c) Fold into `@opensip-tools/graph` engine — rejected: engine must stay parser-agnostic (`graph-engine-no-adapter-packs`); pulling `glob`/`tree-sitter` wiring patterns into it re-couples it to the tree-sitter ecosystem. |
| **DEC-2: parse() seam** | Export `createTreeSitterParseProject({ grammar, languageId, makeFile })` returning a `parseProject(input): ParseOutput<P>`. The adapter passes its grammar (`tree-sitter-go` etc.), its `languageId` (for the `graph:parse:<id>` log tag), and a `makeFile(tree, source) => P['files'] extends ReadonlyMap<string, infer F> ? F : never` (trivially `{tree, source}` for all four today). | The body is byte-identical save grammar + log tag + named type; a factory parameterized on those is the minimal seam. Keeps `*ParsedProject` types nominally per-adapter (they're re-exported and consumed by resolvers). | Single shared `ParsedProject` type — rejected: each adapter re-exports its own `*ParsedProject` (e.g. `graph-rust/src/index.ts:66`) and tests import it by name; collapsing the type is a larger, separable change. |
| **DEC-3: discover() seam** | Export `createDiscover({ extension, excludedDirGlobs, configCandidates, languageId })` returning `discoverFiles(input): DiscoverOutput`. `configCandidates` is the ordered precedence list (`['go.sum','go.mod']`, `['Cargo.lock','Cargo.toml']`, the 4-entry Java list, `['pyproject.toml','setup.py']`). | The only per-language inputs to the discover template are the file extension, the exclude globs, the config-candidate precedence, and the log tag — all data, not behavior. Java already factors its candidates into a `CONFIG_CANDIDATES` const (`graph-java/src/discover.ts:48-53`); generalize it. | Inject a `resolveConfigPath` callback — rejected: a precedence list is sufficient and declarative; only Java needed >2 candidates and it's already list-shaped. |
| **DEC-4: cacheKey() seam** | Export `hashConfig(configPathAbs)` (the byte-identical helper) plus a `makeConfigCacheKey({ prefix })` that returns `cacheKey(input) => ` `${prefix}-${hashConfig(...)}`. Python keeps its own `cache-key.ts` but imports `hashConfig`/the `missing:`/`unreadable:` contract from common and layers `requires-python`/`sanitize` on top. | go/java/rust are identical (`hashConfig` + a 2-char prefix); python is `hashConfig` plus a version extraction. Extracting `hashConfig` removes the 3-way twin while letting python compose. | Make python's variant the base with an optional extractor — rejected: over-parameterizes the common case for one outlier; composition reads cleaner. |
| **DEC-5: walk() seam** | Export `record(out, occ)`, `makeFileClassifier({ testRe, generatedRe, testPathRe? })` → `{ isTestFile, isGeneratedFile }`, `runWalk({ input, walkFile })` driving the `walkProject` skeleton, and `synthesizeModuleInit({ file, filePathProjectRel, packageName?, inTestFile, definedInGenerated, digestSyntheticBody, qualifiedName, source, root })`. The per-language `walkFile`/`visit` stays in the adapter. | The walk driver, `record`, the classifier predicates, and the module-init occurrence skeleton are duplicated; `visit`/`walkFile` (the actual node traversal) are not. The classifier is regex-parameterized (each adapter declares `TEST_FILE_NAME_RE`/`GENERATED_PATH_RE` consts, e.g. `graph-go/src/walk.ts:67-68`). | Move `visit`/`walkFile` too — rejected: those are the language-specific core; moving them would gut the seam. |
| **DEC-6: `isTestFile` export site** | `rule-hints.ts` in each adapter currently does `import { isTestFile } from './walk.js'` (`graph-go/src/rule-hints.ts:15` and twins). After extraction, the adapter's `walk.ts` re-exports the classifier's `isTestFile` (bound to its regex) so `rule-hints.ts` keeps its local import path; OR `rule-hints.ts` imports the bound predicate directly. | Preserves the existing `./walk.js` import seam with zero churn in `rule-hints.ts`; the regex stays adapter-owned. | Move `rule-hints` too — out of scope (DEC, not duplicated). |
| **DEC-7: `buildNameIndex` home** | Move verbatim to common; it consumes only `Record<string, readonly FunctionOccurrence[]>` (engine type) and returns `ReadonlyMap<string, readonly string[]>` — fully language-agnostic. Each resolver imports it from common. | Byte-identical in go/java/python (`graph-go/src/resolve.ts:262`); rust builds its name index differently or inline — only the three that share it import it. | Leave it per-adapter — rejected: it's the largest single twin (437 B). |
| **DEC-8: dependency-cruiser changes** | (1) Add `^packages/graph/graph-adapter-common/` to the `to.pathNot` of `graph-adapters-disjoint`. (2) Add rule `graph-common-no-adapters`: `from ^packages/graph/graph-adapter-common/` MUST NOT import `^packages/graph/graph-[a-z0-9-]+/` other than the engine — prevents the common pkg from reaching back into a specific language pack. (3) Assert `graph-engine-no-adapter-packs` still excludes common from engine imports (it already matches `graph-` prefix; common is downstream so this is automatically correct). | Encodes the layering precisely: engine → common → adapters, with no back-edges. | A blanket disable of `graph-adapters-disjoint` — rejected: would re-open the exact drift the audit (`.dependency-cruiser.cjs:462`) closed. |

## Success Criteria (testable)

- [ ] New package `@opensip-tools/graph-adapter-common` exists at
      `packages/graph/graph-adapter-common/` with its own
      `package.json` (`opensipTools.kind` **absent** — it is a library,
      not a tool/adapter), `tsconfig.json`, and `src/index.ts` barrel.
- [ ] `graph-go`, `graph-java`, `graph-python`, `graph-rust` each declare
      `@opensip-tools/graph-adapter-common` in `dependencies` and import the
      moved helpers from it.
- [ ] **Duplicated-function-body signal reports 0 cross-adapter body-twins**
      for every moved function (`record`, `buildNameIndex`, `hashConfig`,
      `normalizeProjectDir`, `realpathOrPath`, `skipToEndOfLine`,
      `isTestFile`, `isGeneratedFile`, `cacheKey` wrapper,
      `synthesizeModuleInit` skeleton) — verified by re-running `graph` on
      this repo and confirming those names no longer appear as
      multi-package `bodyHash` twins.
- [ ] `graph-typescript` is unchanged (no diff under
      `packages/graph/graph-typescript/`).
- [ ] Engine contract `packages/graph/engine/src/lang-adapter/types.ts`
      is unchanged.
- [ ] Plugin discovery still works: each adapter's `index.ts` exports
      `adapter` + `metadata`; the common package exports neither.
- [ ] `.dependency-cruiser.cjs` updated per DEC-8; `pnpm lint`
      (ESLint + dependency-cruiser) is **0-error**, including the new
      `graph-common-no-adapters` rule passing.
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green.
- [ ] `pnpm fit` / `pnpm fit:ci` green (no net-new alerts).
- [ ] Adapter test suites pass unchanged (the helpers' behavior is
      byte-identical, so fixtures and golden output are stable).
- [ ] `RELEASING.md` package table shows **30** packages; the common
      package appears in publish order between `graph` (engine) and the
      adapter packs.
- [ ] `.github/workflows/release.yml` preflight loop (`:78-84`) and
      pack steps (`:137-141`) include `graph-adapter-common`;
      `scripts/bootstrap-publish.sh` `PACKAGES` array (`:61-72`) includes it.
- [ ] `verify-release` for the next version is green.
- [ ] `CLAUDE.md` repository-structure tree lists the new package.

## Boundaries

**Always:**
- Move helpers **verbatim** (byte-for-byte) where the function is already a
  cross-package twin, so the body-twin signal goes to zero with no
  behavioral risk.
- Keep each adapter's `index.ts`, comment-strippers, resolvers, and
  rule-hints in the adapter package.
- Depend only on `@opensip-tools/graph` and `@opensip-tools/core` from the
  common package.
- Update `.dependency-cruiser.cjs`, `RELEASING.md`, `release.yml`,
  `bootstrap-publish.sh`, and `CLAUDE.md` in the same change.

**Ask first:**
- Collapsing the four `*ParsedProject` / `*ParsedFile` nominal types into a
  single shared type (they're re-exported and imported by name across
  packages/tests; larger blast radius — DEC-2 keeps them per-adapter).
- Moving any resolver code beyond `buildNameIndex`.
- Renaming the package or relocating it outside `packages/graph/`.

**Never:**
- Touch `graph-typescript`.
- Change the `GraphLanguageAdapter` engine contract.
- Make the engine import the common package (would re-create the cycle
  `graph-engine-no-adapter-packs` forbids).
- Disable `graph-adapters-disjoint` wholesale instead of a precise carve-out.
- Add `opensipTools.kind` to the common package's `package.json` (it is not
  a discoverable tool/adapter).

## Open Questions

1. **Does `graph-rust` share `buildNameIndex`?** The grep found it in
   go/java/python `resolve.ts` but not in `graph-rust` (rust uses
   `resolve-dependencies.ts` + a larger `resolve.ts`). Confirm during
   implementation whether rust has an inline equivalent worth converging;
   if not, only three adapters import it from common — still correct.
   *Proposed default:* move it to common; rust adopts it iff it has a
   matching inline body.
2. **`synthesizeModuleInit` parameterization surface.** The skeleton is
   shared but the `qualifiedName` construction differs per language
   (`graph-go/src/walk.ts:376` strips `.go` and joins on package). Confirm
   the four `qualifiedName`/extension-strip shapes are cleanly expressible
   as a `(filePathProjectRel, packageName) => qualifiedName` callback vs.
   needing more structure. *Proposed default:* a callback injection.
3. **`nameOf` twin (python+rust).** Lower value (2 packages, small). Move it
   only if it's truly identical and language-agnostic; otherwise leave it.
   *Proposed default:* leave per-adapter unless byte-identical and
   AST-shape-agnostic (likely it is *not* — it reads tree-sitter field
   names).
4. **Should `tree-sitter` / `glob` be removed from adapter `dependencies`?**
   Only if the adapter no longer imports them directly after extraction.
   Some adapters still call `glob`/tree-sitter in language-specific code
   (e.g. rust's use-declaration walk). *Proposed default:* keep the dep in
   any adapter that still imports the module directly; both packages may
   legitimately list them.

## Applicable Conventions

- **Layering** (`CLAUDE.md` → Layering rules): the common package sits in
  the peer layer beneath the adapters: `core → … → graph (engine) →
  graph-adapter-common → graph-{go,java,python,rust}`. It must not import
  cli, contracts, fitness, simulation, or check packs.
- **Imports** (`CLAUDE.md` → Imports): workspace barrel imports
  (`@opensip-tools/graph`, never subpaths); internal relative imports carry
  the `.js` extension (ESM Node16); `import type` for type-only.
- **Registration is explicit** (`CLAUDE.md` → Per-run state): the common
  package exports `defineX`-style factories that return values; the adapter
  composes them. No module-import side effects, no module-level mutable
  state.
- **Testing** (`CLAUDE.md` → Testing): Vitest, `*.test.ts` next to source.
  The common package gets unit tests for the extracted helpers; adapter
  suites stay green unchanged.
- **Release** (`RELEASING.md`): tag-driven, OIDC trusted publishing,
  dependency-ordered; a brand-new package needs the one-time bootstrap
  (token publish → register trusted publisher → delete token).
- **Spec format**: this document follows the structure of
  [graph-per-package-coupling.md](./graph-per-package-coupling.md)
  (Objective / Scope / Technical Context / Design Decisions table /
  Success Criteria / Boundaries / Open Questions / Conventions).
