# Spec: Extract the comment/string-strip mechanics from the five lang adapters

> Status: **PROPOSED** (2026-06-01).
> Related: [graph-per-package-coupling.md](./graph-per-package-coupling.md) —
> the body-twin edge-keying work that surfaced this duplication
> (`stripStrings`/`stripComments` duplicated across the 5 language adapters
> were the canonical example of byte-identical functions in different files).

## Objective

The non-TypeScript language adapters — `@opensip-tools/lang-cpp`, `lang-go`,
`lang-java`, `lang-python`, `lang-rust` — each ship a `src/strip.ts` whose
*scaffolding* is byte-identical: the same `stripStrings` body, the same
`stripComments` body, the same `interface Scan` shape. Only the per-language
`scan()` tokenizer differs (each has a distinct `bodyHash`, confirmed by a
real `graph` run). The duplication is a template-method pattern that was
never factored: the **mechanics** (drive `scan`, overlay regions) are shared;
the **scanner** (comment/string syntax) is the variable part.

Extract the shared mechanics behind a template-method seam so each adapter
declares only its language-specific `scan` and inherits `stripStrings` /
`stripComments` from one place. The per-adapter externally-observable strip
behavior must not change — the five existing `strip.test.ts` suites are the
oracle.

**Success:** all five adapters import the strip mechanics from a single
upstream location and supply only their `scan`; the verbatim
`stripStrings`/`stripComments`/`interface Scan` copies disappear; every
existing strip test passes unchanged; no new cross-package dependency edge
violates the layering gate.

## Scope

### In

- A shared factory/seam (`makeStripper` — see Design) that, given a
  language-specific scanner producing `{ stringRegions, commentRegions }`,
  returns the `{ stripStrings, stripComments }` pair.
- A shared `ScanResult` (the current per-pack `interface Scan`) contract that
  the scanner must produce.
- Migrating all five adapters (`lang-cpp`, `lang-go`, `lang-java`,
  `lang-python`, `lang-rust`) to consume the seam and delete their local
  `stripStrings` / `stripComments` / `interface Scan`.
- A dependency-cruiser-visible decision on **where the seam lives** (see
  Design Decision D1).

### Out

- **Rewriting any `scan()`.** Each adapter keeps its tokenizer verbatim; this
  is a mechanics extraction, not a scanner unification. The five `scan`s stay
  byte-for-byte as they are (modulo the import/return-type rename).
- **Unifying the C-family scanner helpers** (`scanRegularString`,
  `scanLineComment`, `scanBlockCommentNonNesting`, `scanBlockCommentNesting`,
  `scanCharLiteral`). Those already live in `@opensip-tools/core`
  (`packages/core/src/languages/strip-utils.ts`) and are out of scope here.
- **Moving `Region` or `applyRegions`.** They already live in core and are
  re-exported from the core barrel (see Technical Context). The seam consumes
  them; it does not relocate them.
- **`lang-typescript`.** Its content stripping is AST-driven (`filterContent`
  lives in `@opensip-tools/lang-typescript`, per the paid-down
  `lang-no-fitness-except-typescript` exception) — it has no `strip.ts` of the
  region-overlay shape and is not part of this duplication set.
- **Python's `isIdentChar` / `isAsciiLetter` / `matchStringStart` and cpp's
  `isIdentChar` / prefix matchers.** These are *scanner-internal* helpers, not
  strip mechanics. `isIdentChar` is duplicated in exactly two packs
  (`lang-cpp` and `lang-python`) and is used only by each pack's own
  prefix-matching scanner; it is a candidate for a separate, smaller follow-up
  (Open Question Q3), not part of the template-method seam.

## Technical Context

### Existing architecture (real refs)

The five adapter strip files are structurally identical down to the helper
imports. Each follows the same three-part shape:

1. `interface Scan { readonly stringRegions: Region[]; readonly commentRegions: Region[] }`
   — duplicated verbatim in all five:
   - `packages/languages/lang-cpp/src/strip.ts:28-31`
   - `packages/languages/lang-go/src/strip.ts:21-24`
   - `packages/languages/lang-java/src/strip.ts:23-26`
   - `packages/languages/lang-python/src/strip.ts:33-36`
   - `packages/languages/lang-rust/src/strip.ts:28-31`

2. `function scan(src: string): Scan { ... }` — **the variable part.** Each is
   a distinct hand-written lexer with a distinct `bodyHash`:
   - `lang-cpp` `scan` (`strip.ts:34-134`): raw strings with encoding prefixes,
     char literals with five opener forms, line-splice line comments.
   - `lang-go` `scan` (`strip.ts:27-95`): backtick raw strings, rune literals.
   - `lang-java` `scan` (`strip.ts:29-135`): text blocks (`"""`), char literals.
   - `lang-python` `scan` (`strip.ts:192-234`): `#` comments, eight ASCII string
     prefixes, triple-quoted strings; brings its own `scanSingleString` /
     `scanTripleString` (Python is the C-family outlier — see the deliberate
     note at `strip.ts:20-29`).
   - `lang-rust` `scan` (`strip.ts:34-173`): `r#"..."#` raw/byte-raw strings,
     nested block comments, lifetime-vs-char disambiguation.

3. The two **byte-identical** public functions, verbatim in all five
   (the prompt's evidence: `stripStrings` ~141B, `stripComments` ~182B,
   identical `bodyHash` across packages):

   ```ts
   export function stripStrings(content: string): string {
     const { stringRegions } = scan(content)
     return applyRegions(content, stringRegions)
   }
   export function stripComments(content: string): string {
     const { stringRegions, commentRegions } = scan(content)
     return applyRegions(content, [...stringRegions, ...commentRegions])
   }
   ```

   - `lang-cpp/src/strip.ts:201-210`
   - `lang-go/src/strip.ts:98-107`
   - `lang-java/src/strip.ts:138-147`
   - `lang-python/src/strip.ts:237-246`
   - `lang-rust/src/strip.ts:176-185`

Each adapter re-exports the pair from its package barrel
(`export { stripStrings, stripComments } from './strip.js'`):
`packages/languages/lang-{cpp,go,java,python,rust}/src/index.ts`.

`Region` and `applyRegions` already live upstream in
`packages/core/src/languages/strip-utils.ts` (`Region` at `:52-55`,
`applyRegions` at `:359-369`) and are re-exported through
`packages/core/src/languages/index.ts` (which the core barrel re-exports at
`packages/core/src/index.ts:6`). All five adapters already import them from
`@opensip-tools/core`. The `strip-utils.ts` file header
(`:40-48`) already articulates the "mechanics live in core, lexer is
language-specific" rationale — this spec finishes that thought by also moving
the `stripStrings`/`stripComments` glue that the header describes but does not
yet host.

### Key dependencies

- `@opensip-tools/core` — already a dependency of all five adapters
  (`packages/languages/lang-cpp/package.json` `dependencies` →
  `@opensip-tools/core: workspace:*`; same in the other four). Already exports
  `Region` and `applyRegions`.
- Vitest strip suites (the behavioral oracle), one per adapter:
  `packages/languages/lang-{cpp,go,java,python,rust}/src/__tests__/strip.test.ts`
  (14 / 11 / 12 / 14 / 23 test cases respectively). Each imports
  `{ stripStrings, stripComments } from '../strip.js'` — the import path the
  migration must keep valid.

### Constraints (from CLAUDE.md)

- **`lang-*` packs must NOT import each other.** This is the load-bearing
  constraint that rules out hosting the seam in any one adapter. Enforced by
  dependency-cruiser rule `lang-no-cli-or-contracts`
  (`.dependency-cruiser.cjs:339-353`) and `lang-no-fitness` (`:354-363`).
- **`lang-*` may depend only on `core`** (for the `LanguageAdapter` contract
  and the shared scanner primitives). `core` is the kernel and must import
  nothing from the workspace (`core-imports-nothing-workspace`,
  `.dependency-cruiser.cjs:85-103`).
- **Core is a strict kernel.** Per CLAUDE.md, "Anything fitness-shaped lives
  in fitness." Text-stripping mechanics, however, are already sanctioned in
  core — `strip-utils.ts:40-48` records the explicit decision that
  language-agnostic strip glue belongs in core because (a) it is
  language-agnostic by construction, (b) the layering forbids peer adapters
  from importing each other, and (c) future adapters will need it.
- ESM Node16: internal relative imports use `.js`; cross-package imports use
  the package barrel (`@opensip-tools/core`). Type-only imports use
  `import type`.
- A new publishable package raises the release count from **29** to **30**
  (`RELEASING.md:10`, "The 29 packages"), with ordering/OIDC implications.

## Design Decisions

### D1 — Where the shared seam lives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Add to `@opensip-tools/core` `strip-utils.ts`** (alongside `Region`/`applyRegions`) | Zero new package (stays at 29). All five already depend on core and already import `Region`/`applyRegions` from it — no `package.json` churn. Co-located with the helpers the seam orchestrates and with the file header that already documents this exact rationale (`strip-utils.ts:40-48`). No new dependency-cruiser edge — `lang-*→core` is already the only allowed adapter dep. | Adds ~10 lines of "mechanics" (not just primitives) to the kernel. But this is glue over existing kernel primitives, not domain logic — it does not pull anything new into core's dependency closure. | **CHOSEN** |
| B. New `@opensip-tools/lang-strip` package, depended on by all five | Cleanest conceptual home ("strip toolkit"). | 30th publishable package (`RELEASING.md` ordering, OIDC, version-bump surface) for ~10 lines. New dep-cruiser allowance (`lang-*→lang-strip`) plus a guard that `lang-strip` itself imports only core. Net new release/maintenance drag grossly disproportionate to the payload. | Rejected |
| C. Host in one adapter (e.g. `lang-cpp`) and have the others import it | No new package. | **Violates the load-bearing `lang-*` mutual-non-import rule** (`lang-no-cli-or-contracts`); would require a bespoke exception exactly like the `lang-no-fitness-except-typescript` exception the team deliberately *paid down*. | Rejected outright |

**Decision:** put the seam in `@opensip-tools/core`, in
`packages/core/src/languages/strip-utils.ts`, exported through the existing
`languages/index.ts` → core barrel chain. This matches the precedent already
set for `Region`/`applyRegions` and the rationale the file header already
states. It keeps the package count at 29.

### D2 — The injection seam (how the per-lang scanner plugs in)

| Option | Shape | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Factory `makeStripper(scan)`** | `makeStripper(scan: (src: string) => ScanResult) => { stripStrings, stripComments }` | Closes over `scan` once; adapter writes `const { stripStrings, stripComments } = makeStripper(scan)`. Returns plain functions with the exact existing signatures, so barrels re-export unchanged. Classic template-method-as-closure; no class, no `this`. | Adapter destructures two names from one call (trivial). | **CHOSEN** |
| B. Two free functions taking `scan` as first arg | `stripStringsWith(scan, content)` / `stripCommentsWith(scan, content)` | No factory. | Every call threads `scan`; barrels would need wrapper arrows to preserve the `(content) => string` public signature — reintroduces per-pack boilerplate, defeating the point. | Rejected |
| C. Config object / class with abstract `scan` | `class Stripper { abstract scan(); stripStrings(); }` | OO-orthodox template method. | Heavier than the functional codebase warrants; `this`-binding friction when barrels re-export methods. | Rejected |

**Decision:** a `makeStripper(scan)` factory in core. Each adapter keeps its
`scan` exactly as written and replaces its two `export function strip*` bodies
with:

```ts
// per adapter, after defining `scan`
const stripper = makeStripper(scan)
export const stripStrings = stripper.stripStrings
export const stripComments = stripper.stripComments
```

(or an equivalent destructure). The public `(content: string) => string`
signatures are preserved verbatim, so the package barrels and the test imports
need no change.

### D3 — The shared `ScanResult` contract

| Decision | Choice | Rationale |
|---|---|---|
| Replace the five duplicated `interface Scan` | Export one `ScanResult` from `strip-utils.ts`: `{ readonly stringRegions: Region[]; readonly commentRegions: Region[] }` (the byte-identical shape from all five). | Single source of truth for the scanner→mechanics contract. `makeStripper`'s `scan` parameter is typed `(src: string) => ScanResult`. Each adapter's `scan` return annotation changes from `Scan` to `ScanResult` (import from core) — the only edit to the otherwise-untouched scanner. |
| Naming | `ScanResult` (not `Scan`) | Avoids collision with the verb sense and matches the existing `*Result` naming in `strip-utils.ts` (`RegStrResult`, `ScanCommentResult`, `ScanCharLiteralResult`). |

## Success Criteria (testable)

- [ ] `stripStrings` and `stripComments` are defined in **exactly one** place
      (`packages/core/src/languages/strip-utils.ts`, via `makeStripper`); zero
      `export function stripStrings` / `stripComments` bodies remain under
      `packages/languages/lang-*/src/strip.ts`. (Verify: `grep -rn
      'function stripStrings\|function stripComments' packages/languages` → 0.)
- [ ] `interface Scan` is gone from all five adapters; each `scan` returns the
      shared `ScanResult`. (Verify: `grep -rn 'interface Scan' packages/languages`
      → 0.)
- [ ] **Behavioral oracle:** all five existing strip suites pass **unchanged**
      — `packages/languages/lang-{cpp,go,java,python,rust}/src/__tests__/strip.test.ts`
      (14/11/12/14/23 cases) are not edited and remain green. This is the proof
      that each adapter's strip behavior is byte-for-byte preserved.
- [ ] A real `graph` run no longer reports the verbatim
      `stripStrings`/`stripComments` body-twins across the five packs (the
      duplication that motivated this spec collapses to the single core
      definition).
- [ ] No new dependency-cruiser edge: every adapter still depends only on
      `@opensip-tools/core`; `pnpm lint` (ESLint + dependency-cruiser) is
      0-error. Specifically `lang-no-cli-or-contracts` and `lang-no-fitness`
      stay satisfied with no new exception.
- [ ] `pnpm typecheck && pnpm test && pnpm lint` green; `pnpm fit` shows no
      regression in finding count attributable to this change.
- [ ] Release count unchanged at 29 packages (no new publishable package).

## Boundaries

- **Do not touch the scanners.** Each `scan()` body stays byte-identical;
  the only permitted edit inside a scanner is the return-type annotation
  (`: Scan` → `: ScanResult`) and dropping the now-unused local `interface
  Scan`. The `sonarjs/cognitive-complexity` suppressions on the scanners
  (e.g. `lang-cpp/src/strip.ts:33`) stay attached to the scanner, untouched.
- **Do not relocate `Region` / `applyRegions`.** They stay in core; the seam
  consumes them.
- **Do not change public signatures or barrels.** `stripStrings` /
  `stripComments` remain `(content: string) => string`, re-exported from each
  adapter's `src/index.ts` as today. External consumers and the test imports
  (`from '../strip.js'`) keep working.
- **Python stays the C-family outlier.** Its `scan` keeps its private
  `scanSingleString` / `scanTripleString` / `matchStringStart`; only its
  duplicated `stripStrings`/`stripComments`/`interface Scan` are removed. The
  deliberate "this pack does not consume the C-family scanners" note
  (`lang-python/src/strip.ts:20-29`) remains accurate and stays.

## Open Questions

- **Q1 — Does the seam belong in `strip-utils.ts` or a sibling file?**
  Proposed: same file, since it orchestrates `applyRegions` defined there and
  the header already frames the whole "mechanics in core" story. Alternative:
  a new `strip-template.ts` in the same `languages/` dir if reviewers prefer
  to keep `strip-utils.ts` purely primitive. Either way, exported through
  `languages/index.ts`. (Author's lean: same file.)
- **Q2 — Should `makeStripper` also expose the raw `scan` result** (e.g.
  return `{ scan, stripStrings, stripComments }`) for future callers that want
  the regions without re-blanking? No current consumer needs it; propose
  returning only the two strip functions and adding `scan` passthrough later
  if a real consumer appears (YAGNI, matches the codebase's
  "lift-on-second-adopter" convention seen at `lang-python/src/strip.ts:25-29`).
- **Q3 — `isIdentChar` (cpp + python, identical body):** out of scope for the
  template-method seam (it is scanner-internal, not strip mechanics), but it is
  a genuine 2-pack duplicate. Track as a separate, smaller follow-up:
  promote a `isAsciiIdentChar` predicate into `strip-utils.ts` and have both
  packs' scanners import it. Flagged here so it is not lost, deliberately not
  bundled into this change to keep the seam migration mechanical and the oracle
  clean.

## Applicable Conventions

- **Layering (CLAUDE.md / dependency-cruiser):** `lang-* → core` only; adapters
  never import each other. The chosen home (core) is the only location that
  satisfies this without a bespoke exception.
- **Core is a strict kernel**, but language-agnostic strip glue is already a
  sanctioned core resident (`strip-utils.ts:40-48`); this change is consistent
  with that precedent, not an expansion of core's remit.
- **Imports:** cross-package via the `@opensip-tools/core` barrel; internal
  core relative imports with `.js`; `import type` for `ScanResult` / `Region`.
- **Testing:** Vitest, `*.test.ts` beside source; the existing strip suites are
  the regression oracle and must pass unedited.
- **Lift-on-second-adopter:** the codebase only hoists shared scanner pieces
  into core once there is a real second consumer
  (`lang-python/src/strip.ts:25-29`). The strip mechanics already have five
  consumers, so hoisting now is squarely within that convention.
- **Before committing:** `pnpm typecheck && pnpm test && pnpm lint` (both
  ESLint and dependency-cruiser 0-error).
