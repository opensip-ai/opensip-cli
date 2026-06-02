# Spec: Sharpen `graph:orphan-subtree` to surface only genuine dead code

> Status: **PROPOSED** (2026-06-01).
> Related: [graph-per-package-coupling.md](./graph-per-package-coupling.md),
> [graph-edge-import-constraint.md](./graph-edge-import-constraint.md),
> [graph-cross-package-edge-attribution.md](./graph-cross-package-edge-attribution.md).

## Objective

`graph:orphan-subtree` emits **45 findings on this repo**, all at `'medium'`
severity. **Every one is a false positive.** The rule's reachability model
("not reachable from any inferred entry point") flags three things that are
not dead code:

1. **Public API surface** — functions exported from a package barrel that
   have no caller *inside* their own package (the only caller lives in
   another package, and cross-package call edges don't resolve here — the
   known `dependencies[].to`-empty-for-`@scope/*` gap).
2. **Callees of public API** — module-local helpers reached only *through*
   such an exported barrel function, which is therefore never itself reached.
3. **Dynamic-dispatch / plugin-contract reachable** — helpers called only
   from inside a closure passed to `defineCheck(...)`/`defineTool(...)` (the
   plugin contract), where the closure→helper edge is the live path but the
   closure itself is never an entry point.
4. **Test-only-reachable** — a `module-local` helper called only from a
   `*.test.ts`. (Strictly the domain of the sibling `test-only-reachable`
   rule, but orphan-subtree currently double-flags them.)

This spec sharpens the rule so it earns a gate signal only when a finding is
**actionable** (a concrete fix exists: delete the function), **precise**
(remaining findings are real dead code, not intended public surface), and
**bounded** (a handful, not 45). Target: **45 → a small set of genuine
deletions** (expected 0–3 on this repo; see Success Criteria).

## Scope

### In

- Expanding `inferEntryPoints` (`packages/graph/engine/src/rules/_entry-points.ts`)
  so the seed set covers barrel/public-API exports, plugin-contract closures,
  and decorated entries — fixing reachability for **all** absence-based rules
  (orphan-subtree *and* test-only-reachable) in one place.
- Adding a precision filter in `orphanSubtreeRule.evaluate`
  (`packages/graph/engine/src/rules/orphan-subtree.ts`) so it flags only
  `module-local`/`private`, non-test, zero-caller, non-entry functions.
- New `GraphConfig` knobs for the sharpening behavior, with opinionated
  defaults.
- Unit + fixture tests proving the four buckets are no longer flagged and a
  genuinely-dead private helper still is.

### Out

- Fixing the underlying **workspace import resolution** (`dependencies[].to`
  empty for `@scope/*`, resolver points at `dist`) — tracked in
  `graph-edge-import-constraint.md`. This spec works *around* it by treating
  unresolved-export-with-no-internal-caller as a live entry point, exactly
  the conservative move that gap demands.
- Changing the `test-only-reachable` rule's own output. Expanding
  `inferEntryPoints` benefits it for free, but its semantics are unchanged.
- Raising/lowering `defaultSeverity` (stays `'warning'`; the emitted
  `severity` stays `'medium'`).
- Cross-package edge recovery for the sharded build (`crossShard` edges
  already exist; this spec doesn't touch the resolver).

## Technical Context (real refs)

- **The rule.** `packages/graph/engine/src/rules/orphan-subtree.ts`.
  `computeReachable` (L59–78) BFS-seeds from `inferEntryPoints(catalog,
  indexes)` (L60) ∪ `config.entryPointHashes` (L63), walking
  `indexes.callees` (forward, L72). Any `byBodyHash` occurrence not visited
  is emitted (L27–54), except `kind === 'module-init'` (L30) and empty
  `filePath` (L33). Emitted `severity: 'medium'` (L38),
  `category: 'quality'`, suggestion at L43. `approximateSuffix(catalog)`
  (L24) appends a fast-mode caveat.
- **Entry-point inference.** `packages/graph/engine/src/rules/_entry-points.ts`.
  `classify` (L46–65) returns one of three reasons: `module-init` (L58,
  every file's init), `name-match` (L59, against `NAME_HEURISTICS` =
  `{main,run,start,register,initialize,init,bootstrap}`, L18–26), and
  `no-callers-exported` (L60–63: `visibility === 'exported'` AND
  `indexes.callers.get(hash)?.length === 0`). The header comment (L1–14)
  explicitly notes bin-entry and Tool-`commands`-handler inference (#1, #2)
  are **deferred** "until cross-package call resolution is reliable."
- **The occurrence shape.** `packages/graph/engine/src/types.ts`,
  `FunctionOccurrence` (L150–203). Levers for precision:
  `visibility: 'exported' | 'module-local' | 'private'` (L186, L81–82),
  `package?: string` (L175, stamped by `assignPackages`),
  `inTestFile: boolean` (L187), `decorators: readonly string[]` (L185),
  `kind: FunctionKind` (L181). `byBodyHash` is **content-deduped** (one
  occurrence per hash; `Indexes` L301); `occurrencesByHash` (L308) preserves
  all twins — relevant to the body-twin orphan class below.
- **Package stamping.** `packages/graph/engine/src/pipeline/assign-packages.ts`
  (`assignPackages`, L26) sets `occurrence.package` to the nearest
  `package.json` `name`. Per-package barrel = the package's `index.ts` /
  `main` entry — i.e. the public surface boundary.
- **Plugin contract.** `defineCheck` is
  `packages/fitness/engine/src/framework/define-check.ts:221`; the closure
  passed as `analyze(content, filePath)` is the live dispatch path.
  Tool `register(cli)` lives at `packages/graph/engine/src/tool.ts:114`,
  `packages/simulation/engine/src/tool.ts:27`, invoked dynamically by
  `packages/cli/src/bootstrap/register-tools.ts:96`. `register` is already a
  `NAME_HEURISTICS` match, but the *callees of the closure body* are not.
- **Tests.** `packages/graph/engine/src/__tests__/rules/_entry-points.test.ts`
  (5 cases over the 3 reasons), `.../orphan-subtree-config.test.ts`
  (`entryPointHashes` override, empty-filePath, module-init),
  `packages/graph/graph-typescript/src/__tests__/rules/orphan-subtree.test.ts`
  (end-to-end fixture: `unusedHelper` flagged, `helper`/`entry` not). Test
  helpers: `.../rules/_helpers.ts` (`occ`, `staticCall`, `makeCatalog`).

### The 45, classified (empirical, `graph --json` on this repo)

| Bucket | Count | Representative | Why it's a false positive |
|---|---|---|---|
| **defineCheck-closure-reachable** | 18 | `analyzeFile` / `checkFunctionContract` / `getFunctionName` @ `packages/fitness/checks-typescript/src/checks/quality/api/api-contract-validation.ts` (L59, L216, L292) | All called from the `analyze(content,filePath)` closure passed to `defineCheck` (L347, `return analyzeFile(...)` L355). The closure arrow is never an entry; its callees never get reached. |
| **callees-of-exported-barrel** | 12 | `scan`/`isAsciiLetter`/`isIdentChar` @ `packages/languages/lang-python/src/strip.ts` (L192, L44, L50) | `scan` is called by exported `stripStrings`/`stripComments` (L237/L243). Those are `no-callers-exported` entry points — but their callees aren't reached. Compounded by body-twins: `scan` is duplicated across `lang-{cpp,go,java,python}/src/strip.ts`, deduped in `byBodyHash`. |
| **exported barrel + its private helpers** | 11 | `renderToText` + `spansToText`/`hintsToText`/`indentLines` @ `packages/cli-ui/src/render-to-text.ts` (L58, L22, L26, L44) | `renderToText` is in the cli-ui barrel (`packages/cli-ui/src/index.ts:33`) and called cross-package from `packages/cli/src/bootstrap/render.ts:56` — a real public API. The cross-package edge doesn't resolve, so `renderToText` AND its file-local helpers all look orphaned. |
| **test-only-reachable** | 4 | `analyze` @ `.../data-integrity/__tests__/null-safety-fp.test.ts:19` (calls exported `analyzeNullSafety`) | Module-local helper inside a `*.test.ts`. Belongs to the `test-only-reachable` rule, not orphan-subtree. |

**0 of the 45 are genuine dead code.** That is the noise to eliminate.

## Design Decisions

### D1 — Where to fix: expand inferEntryPoints AND filter-in-rule (both)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| (a) Only expand `inferEntryPoints` | Single source of truth; fixes test-only-reachable too; reachability stays the model | Doesn't stop the rule re-flagging test-only helpers (their own concern); a barrel export with a real internal-only-dead callee still slips if seeding is imperfect | Necessary, not sufficient |
| (b) Only filter in the rule | Cheap, local | Duplicates intent across every absence-based rule; doesn't help test-only-reachable; filtering by visibility alone can't tell "exported public API" from "exported but truly dead" | Insufficient |
| **(c) Both** (chosen) | Seeding fixes transitive reachability for all rules; the rule-level filter is the last-mile precision gate (only `module-local`/`private`, non-test, zero-caller, non-entry survive) | Two touch points | **Chosen** — defense in depth; each layer earns its keep |

**Rationale.** Seeding (`inferEntryPoints`) fixes buckets 1–3 *transitively*
(seed the closure / the barrel export → BFS reaches its callees). The
rule-level filter (D3) hard-excludes bucket 4 (test) and guarantees we never
flag intended public surface even if seeding misses an edge.

### D2 — New entry-point reasons (in `inferEntryPoints`)

Add to `EntryPoint['reason']` and `classify`:

| Reason | Predicate | Fixes |
|---|---|---|
| `barrel-export` | `visibility === 'exported'` AND the occurrence's file is its package's public barrel (file basename `index.ts`/`index.tsx`, or matches the package's `main`/`exports` entry; package known via `occurrence.package`). | Bucket 3 (`renderToText`) + transitively its helpers. Distinct from `no-callers-exported` so it fires even when a *same-package* caller exists but the real consumer is cross-package. |
| `plugin-contract-closure` | The occurrence is an arrow/function-expression passed as a property (`analyze`, `commands`, `run`, `register`, `scenario`) into a call to a known contract factory (`defineCheck`/`defineTool`/`defineScenario`/`defineToolTab`) — detected via the enclosing call expression captured at inventory time. | Bucket 1 (`api-contract-validation` helpers) transitively. |
| `decorated` | `occ.decorators.length > 0` (e.g. DI `@injectable`, framework route decorators — invoked by a framework, not a named caller). | Future-proofs decorated entry points; defensible default given the rubric ("dynamic dispatch ≠ unused"). |

**Note on detection feasibility.** `barrel-export` and `decorated` are pure
catalog reads (`package`, `filePath`, `decorators`) — no new inventory data.
`plugin-contract-closure` needs the enclosing-call name at the closure's
declaration site. If that is not already derivable from the catalog, the
fallback (recorded, not deferred silently) is to rely on D3's filter +
transitive seeding from the surrounding `defineCheck` *call statement*'s
module-init reachability; see Open Questions Q1.

### D3 — Rule-level precision filter (in `orphanSubtreeRule.evaluate`)

A function is emitted **only if all** hold:

- not reachable (existing);
- `kind !== 'module-init'` (existing, L30);
- `filePath` non-empty (existing, L33);
- **`visibility !== 'exported'`** — an exported symbol is public surface;
  absence of an *internal* caller is not evidence of death (cross-package
  resolution gap). Configurable via `flagExportedOrphans` (D4), default
  `false`;
- **`!occ.inTestFile`** — test-only helpers are the `test-only-reachable`
  rule's job. Configurable via `flagTestOrphans`, default `false`;
- **`occ.decorators.length === 0`** — decorated = framework-dispatched.

### D4 — Config knobs (added to `GraphConfig`, `types.ts` L327)

| Knob | Type | Default | Meaning |
|---|---|---|---|
| `flagExportedOrphans` | `boolean` | `false` | When `true`, exported functions with zero callers are eligible to be flagged (the old behavior, for repos where cross-package resolution is trustworthy). |
| `flagTestOrphans` | `boolean` | `false` | When `true`, `inTestFile` orphans are eligible (overlaps `test-only-reachable`; off by default to avoid double-reporting). |
| `extraContractFactories` | `readonly string[]` | `[]` | Additional `defineX`-style factory names whose closure args seed entry points (user plugin contracts). |

Existing `entryPointHashes` (L338) is unchanged and still the manual escape
hatch the suggestion text points at. **Opinionated default:** all three new
knobs default to the *quiet, precise* setting — the platform's contract is
"a finding means delete it," so the burden of proof is on the rule.

### D5 — Severity unchanged

Stays `'medium'` / `defaultSeverity: 'warning'`. The fix is precision, not
loudness. Once the rule is precise, `'medium'` correctly reads as "we are
fairly confident this is deletable."

## Success Criteria (testable)

- [ ] **Unit (`_entry-points.test.ts`):** a `barrel-export` occurrence
      (`visibility: 'exported'`, `filePath` ending `index.ts`, `package` set)
      classifies as `barrel-export`; a closure passed to `defineCheck`
      classifies as `plugin-contract-closure`; a decorated occurrence
      classifies as `decorated`. Existing 5 cases stay green.
- [ ] **Unit (`orphan-subtree-config.test.ts`):**
      - a `module-local`, zero-caller, non-test, non-decorated function **IS**
        flagged (the genuine-dead case must survive — guards against
        over-suppression);
      - an `exported` barrel function with no internal caller is **NOT**
        flagged (default `flagExportedOrphans: false`); its `module-local`
        callees are **NOT** flagged (reached transitively from the seed);
      - a function reachable only via a `defineCheck` closure is **NOT**
        flagged;
      - an `inTestFile` helper is **NOT** flagged by default; **IS** eligible
        with `flagTestOrphans: true`;
      - `flagExportedOrphans: true` restores flagging of the exported-orphan.
- [ ] **Fixture (`graph-typescript/.../orphan-subtree.test.ts`):** extend the
      fixture so `unusedHelper` (module-local, truly dead) is still flagged;
      add a barrel `index.ts` re-exporting an `exportedButExternal` fn whose
      only caller is a sibling file importing via the barrel — assert it is
      **NOT** flagged.
- [ ] **This repo:** `node packages/cli/dist/index.js graph --json` →
      `graph:orphan-subtree.violationCount` drops from **45** to a small set
      that, on manual spot-check, is **all genuine dead code** (expected
      **0–3**; if 0, the rule reports clean and that is the correct answer for
      this repo today). Each of the four documented buckets contributes **0**.
- [ ] **Gates green:** `pnpm typecheck && pnpm test && pnpm lint`
      (ESLint + dependency-cruiser, 0-error). `pnpm fit:ci` produces no
      net-new Code Scanning alerts. SARIF fixture
      `.../render/__fixtures__/sarif/orphan-subtree.json` regenerated if the
      message/metadata shape changes.

## Boundaries

- **No source edits in this spec** — design only.
- The `package` field is optional in the contract (`types.ts` L175); the
  `barrel-export` predicate MUST fall back gracefully when `package` is
  absent (treat basename `index.ts` as a barrel regardless), so the rule
  degrades on pre-`assignPackages` catalogs rather than crashing — mirroring
  the optional-field discipline in `graph-per-package-coupling.md`.
- Must not import from `lang-*` inside `rules/` (dep-cruiser
  `graph-pipeline-no-lang-import`); all signals come from the catalog/indexes
  already in scope.
- The body-twin compounding (bucket 2) is **mitigated, not solved** here:
  seeding the exported barrel fn reaches the deduped `scan` occurrence, which
  is sufficient to clear all twins because `byBodyHash` is what the rule
  iterates. If a future change makes the rule iterate `occurrencesByHash`,
  this assumption must be revisited.

## Open Questions

1. **Closure→factory linkage.** Can the catalog already tell that an arrow is
   the `analyze` property of a `defineCheck(...)` call at the closure's
   declaration site? If not, what is the cheapest inventory addition
   (enclosing-call-callee-name on the occurrence)? Fallback if too costly:
   treat any closure whose immediate enclosing call's callee name is in
   `{defineCheck, defineTool, defineScenario, defineToolTab,
   ...extraContractFactories}` as a seed — requires that one field.
2. **Barrel detection fidelity.** Is basename `index.{ts,tsx}` + `package`
   sufficient, or must we read each package's `package.json` `exports`/`main`
   to catch non-`index` barrels? Proposal: ship the basename heuristic
   (covers all 29 packages here), record `exports`-aware detection as a
   follow-up if a real barrel is missed.
3. **Overlap policy with `test-only-reachable`.** Default `flagTestOrphans:
   false` means orphan-subtree is silent on test helpers. Confirm
   `test-only-reachable` actually covers the 4 test cases so they aren't
   dropped entirely. (Quick check: run that rule's output on this repo.)

## Applicable Conventions

- Optional, forward-compatible contract fields with documented absent-value
  semantics (`types.ts` L160, L175, L202; this spec's D4 knobs).
- Rules read only frozen `catalog`/`indexes`/`config`; no module-level
  mutable state (CLAUDE.md "Per-run state lives on `RunScope`").
- `rules/` may not reach into `lang-*` (dep-cruiser
  `graph-pipeline-no-lang-import`).
- Tests are Vitest `*.test.ts` beside source; reuse `_helpers.ts`
  (`occ`/`makeCatalog`/`staticCall`).
- `defineX(...)` returns a value; registration is explicit — no import
  side effects (CLAUDE.md).
- Spec lives in `docs/specs/`; if any reader-facing rule behavior changes,
  update `docs/public/40-graph/*` and run `pnpm docs:build` in the
  implementing PR.
