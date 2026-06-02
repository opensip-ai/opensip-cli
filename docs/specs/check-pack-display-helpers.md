# Spec: Consolidate check-pack display/path helpers into the fitness engine

> Status: **PROPOSED** (2026-06-01).
> Surfaced by a real `graph` run: byte-identical `bodyHash` for three helper
> functions duplicated across `@opensip-tools/checks-typescript` and
> `@opensip-tools/checks-universal`.

## Objective

The graph tool's duplicated-function-body analysis flagged three helpers as
byte-identical twins across the two largest check packs:

- `createPathMatcher` (~190B)
- `getCheckDisplayName` (~123B)
- `getCheckIcon` (~109B)

Both packs already depend on `@opensip-tools/fitness`, which already hosts a
`check-utils/` consolidation area (`isCommentLine`, `isTestFile`, and — as of a
prior pass — `getCheckDisplayName` / `getCheckIcon`). The goal is to finish the
job: have a single canonical implementation of each shared *logic* helper in the
engine, with no byte-identical twins left in the check packs, while keeping
per-pack *data* (the `CHECK_DISPLAY` maps) where it belongs.

**Success:** the graph run no longer reports these three functions as cross-pack
body-twins; check-pack CLI/dashboard display output is byte-for-byte unchanged;
all gates green.

## Scope

### In scope

- Move `createPathMatcher` and its `PathPattern` type into the fitness engine's
  shared check-author utility area and re-export from the engine barrel.
- Repoint the three `createPathMatcher` call sites in the check packs to the
  engine export and delete the duplicated `utils/path-matching.ts` files.
- Confirm the already-consolidated `getCheckDisplayName` / `getCheckIcon`
  logic split (engine logic + per-pack data) is the intended end state and
  document it; remove any residual duplication if found.
- Update the `duplicate-utility-functions` allowlist entries to reflect the new
  reality (the display wrappers no longer need an allowance once the logic is
  centralized and only the thin per-pack binding remains).
- Update the local tests that import `../utils/path-matching.js` directly.

### Out of scope

- Creating a new package. This is consolidation **up** into the existing shared
  engine layer (`checks-* → fitness` is an allowed dependency), not a new layer.
- Touching the per-pack `CHECK_DISPLAY` data maps or any individual check's
  detection logic — display *output* must be unchanged.
- Other body-twins the graph run surfaces that are *intentionally* per-layer
  (see the `duplicate-utility-functions.ts` allowlist commentary, lines
  104–119): AST predicates, language-adapter parsers, discovery walkers. Those
  are forbidden from cross-importing by `.dependency-cruiser.cjs` and stay put.

## Technical Context

### Existing architecture

The fitness engine already owns a shared check-author utility barrel:

- `packages/fitness/engine/src/check-utils/index.ts` (lines 10–16) re-exports
  `isCommentLine`, `isTestFile`, `getCheckDisplayName`, `getCheckIcon`. Its
  fileoverview (lines 1–8) states the charter explicitly: "These helpers were
  previously copy-pasted between check packs ... Both packs depend on
  `@opensip-tools/fitness`, so the engine is the natural shared home."
- The engine barrel surfaces them publicly:
  `packages/fitness/engine/src/index.ts:144` re-exports
  `isCommentLine, isTestFile, getCheckDisplayName, getCheckIcon`; line 145
  re-exports the option types.

The display helpers are **already consolidated** as logic-in-engine /
data-in-pack:

- Engine logic: `packages/fitness/engine/src/check-utils/display.ts`.
  `getCheckIcon(displayMap, slug)` (lines 19–25) returns `displayMap[slug][0]`
  or the `DEFAULT_ICON` (`🔍`, line 13). `getCheckDisplayName(displayMap, slug)`
  (lines 31–41) returns `displayMap[slug][1]` or a kebab-to-title-case fallback.
  Both take the map as a parameter; the icon/name `CheckDisplayEntry` tuple type
  comes from `@opensip-tools/core` (line 10;
  `packages/core/src/plugins/types.ts:26` defines
  `readonly [icon, displayName]`).
- Per-pack data + thin binding:
  `packages/fitness/checks-typescript/src/display/index.ts` and
  `packages/fitness/checks-universal/src/display/index.ts` are themselves
  byte-identical bindings (lines 12, 36–43): import the engine impls, build a
  frozen `CHECK_DISPLAY` from the pack's category maps, and expose
  `getCheckIcon(slug)` / `getCheckDisplayName(slug)` closing over `CHECK_DISPLAY`.

The still-duplicated helper is `createPathMatcher`:

- `packages/fitness/checks-typescript/src/utils/path-matching.ts` and
  `packages/fitness/checks-universal/src/utils/path-matching.ts` are
  **byte-identical** (verified by `diff`). Each exports the
  `PathPattern = string | RegExp` type (line 12) and `createPathMatcher`
  (lines 39–41): `(path) => patterns.some(p => typeof p === 'string' ?
  path.includes(p) : p.test(path))`.
- Each pack's `utils/index.ts` is a one-line `export * from './path-matching.js'`
  (both files, line 5).

### Call sites

`createPathMatcher` has three production callers, all importing from the local
pack `utils/index.js`:

- `packages/fitness/checks-typescript/src/checks/quality/data-integrity/missing-input-validation.ts:12,37`
- `packages/fitness/checks-universal/src/checks/security/use-centralized-crypto.ts:9,173`
- `packages/fitness/checks-universal/src/checks/architecture/env-var-validation.ts:8,80`

Plus one test importing the local module directly:
`packages/fitness/checks-typescript/src/__tests__/coverage-branch-push.test.ts:1178`.

`PathPattern` is used **only** inside the two `path-matching.ts` files (grep
across both packs' `src/` returns no other usages) — so moving the type carries
no external surface beyond the matcher itself.

### Key dependencies

- `@opensip-tools/fitness` engine barrel (`engine/src/index.ts`) — the public
  surface check packs import.
- `@opensip-tools/fitness` `check-utils/` — the internal consolidation home.
- `@opensip-tools/core` — owns `CheckDisplayEntry` (already imported by
  `display.ts`); no change.
- `duplicate-utility-functions.ts` allowlist
  (`packages/fitness/checks-typescript/src/checks/quality/code-structure/`,
  lines 102–103) — currently allowlists `getCheckIcon` / `getCheckDisplayName`
  as "Display-helper wrappers (each check pack closes over its own
  CHECK_DISPLAY)".

### Constraints

- **Layering (dependency-cruiser):** `checks-* → fitness` is allowed;
  `checks-* → cli | contracts` and `lang-* ↔ lang-*` are not. Consolidating into
  the engine respects the layer graph. Do not introduce a new package.
- **ESM Node16:** internal imports keep `.js` extensions; workspace imports use
  the `@opensip-tools/fitness` barrel (no subpath imports — per CLAUDE.md,
  subpath exports are discouraged).
- **No behavior change:** `createPathMatcher` semantics (string→`includes`,
  RegExp→`test`, `some` across patterns) and display output must be identical.
- **Dogfood gate:** `pnpm fit:ci` must stay green; the moved helpers must not
  trip new fitness findings.

## Design Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Home for `createPathMatcher` + `PathPattern` | New `packages/fitness/engine/src/check-utils/path-matching.ts`; re-export from `check-utils/index.ts` and the engine barrel (`engine/src/index.ts`). | (a) Put it in `@opensip-tools/core`. (b) Leave one copy in a pack and have the other import it. (c) New shared package. | `check-utils` is the established, documented home for exactly this class of "copy-pasted across check packs" helper; it sits in the correct layer. Core is a strict kernel and this is fitness-shaped check-author tooling, not kernel. Cross-pack import (b) would violate the peer-pack boundary. A new package (c) is over-engineering for ~190B. |
| Check-pack call sites | Import `createPathMatcher` (and `PathPattern` if ever needed) from `@opensip-tools/fitness`; delete each pack's `utils/path-matching.ts` and the now-empty `utils/index.ts` barrel. | Keep `utils/index.ts` as a re-export shim of the engine symbol. | Deleting removes the duplicate entirely (the whole point) and the shim would re-introduce a (trivial) per-pack file with no data of its own. Callers importing the engine barrel directly is the same pattern already used for `isTestFile` / `isCommentLine`. |
| Display helpers (`getCheckDisplayName`, `getCheckIcon`) | **No further move** — logic already lives in `engine/check-utils/display.ts`; keep the per-pack `display/index.ts` thin bindings that own the pack-specific `CHECK_DISPLAY` data and close over it. | Move the per-pack wrapper functions too (e.g. a single `bindDisplay(map)` factory in the engine). | The byte-twin the graph run sees is the *binding wrapper*, but its purpose is to capture per-pack data; the underlying logic is already shared. Optionally collapse both wrappers into one engine `makeDisplayHelpers(map)` factory to erase the remaining wrapper twin (see Open Questions) — but the data/logic split is correct as-is and is the load-bearing decision. |
| Data vs. logic split | Logic (matching algorithm, fallback rules) → engine. Data (`CHECK_DISPLAY` per-pack maps, pattern arrays passed at each `createPathMatcher` call) → check packs. | Move data up too (a global display map / global exclude list). | Each pack legitimately owns its own display table and each call site passes its own pattern set (`EXCLUDED_PATH_SEGMENTS`, `CRYPTO_IMPL_PATTERNS`, `NON_RUNTIME_PATTERNS`). The function is generic; the configuration is local. Moving data up would couple packs and changes output. |
| `duplicate-utility-functions` allowlist | After the move, the display-wrapper allowlist entries (lines 102–103) are only needed if the per-pack wrapper twins remain; if the factory option is taken, remove them. `createPathMatcher` is not in the allowlist today and must not be added — the move eliminates it as a finding. | Add `createPathMatcher` to the allowlist instead of moving it. | Allowlisting is for *intentional* per-layer duplication (AST predicates, language parsers). This duplication is unintentional and fixable by consolidation, which is the preferred remedy per CLAUDE.md ("refactor the shared piece"). |

## Success Criteria (testable)

- [ ] Graph run (`pnpm graph` / duplicated-function-body analysis) reports **no**
      cross-pack body-twin for `createPathMatcher`. If the wrapper-factory option
      is taken, also none for `getCheckDisplayName` / `getCheckIcon`.
- [ ] `@opensip-tools/fitness` barrel exports `createPathMatcher` and
      `PathPattern`; both packs import them from the barrel.
- [ ] `packages/fitness/checks-typescript/src/utils/path-matching.ts` and
      `packages/fitness/checks-universal/src/utils/path-matching.ts` are deleted
      (and their `utils/index.ts` barrels removed or emptied appropriately).
- [ ] The three production call sites and the one test importer compile and pass
      against the engine export; the moved tests (or relocated engine tests)
      cover string-only, regexp-only, and mixed patterns (mirroring
      `coverage-branch-push.test.ts:1178–1185`).
- [ ] Check-pack display output is byte-for-byte unchanged: `getCheckIcon` /
      `getCheckDisplayName` return identical icon/name for every known slug and
      identical fallback (`🔍` / kebab-to-title-case) for unknown slugs
      (assert against existing fixtures in
      `checks-typescript/.../coverage-targeted-push.test.ts:1912+` and
      `checks-universal/.../coverage-boost.test.ts:1827+`).
- [ ] `pnpm typecheck && pnpm test && pnpm lint` all green (ESLint +
      dependency-cruiser 0-error); `pnpm fit` / `pnpm fit:ci` green with no
      net-new findings.

## Boundaries

- The matcher logic in the engine must remain configuration-free: it takes a
  pattern array and returns a predicate. All pattern *data* stays at the call
  site in each pack.
- No engine code may import from a check pack (would invert the layer). The flow
  is strictly pack → engine.
- `CheckDisplayEntry` continues to live in `@opensip-tools/core`; do not
  relocate it.
- Do not consolidate the intentionally-per-layer twins listed in the
  `duplicate-utility-functions` allowlist (AST predicates, language parsers,
  discovery walkers) — they are forbidden from cross-importing and are correct
  as duplicates.

## Open Questions

1. **Erase the display-wrapper twin too?** The remaining byte-identical
   `display/index.ts` wrappers exist only to bind per-pack `CHECK_DISPLAY`. A
   single engine factory — `makeDisplayHelpers(map): { getCheckIcon,
   getCheckDisplayName }` — would let each pack write `export const { getCheckIcon,
   getCheckDisplayName } = makeDisplayHelpers(CHECK_DISPLAY)` and erase the last
   wrapper twin. **Proposed:** yes, include it; it is small, removes the remaining
   twin and the two allowlist entries, and keeps the data/logic split intact.
   Flagging because it slightly widens scope beyond the literal three flagged
   functions.
2. **Keep `utils/index.ts` as an empty barrel or delete it?** Once
   `path-matching.ts` is gone, each pack's `utils/index.ts` has nothing to
   export. **Proposed:** delete the now-empty barrel and any references; do not
   leave dead files (zero-tech-debt).
3. **Where do the path-matcher tests live?** **Proposed:** add a canonical
   `check-utils/path-matching` test in the engine
   (`engine/src/__tests__/`), and update/remove the pack-local dynamic-import
   test at `coverage-branch-push.test.ts:1178` so coverage isn't lost.

## Applicable Conventions

- **Consolidate up, don't add a layer:** CLAUDE.md — "If you need to violate a
  rule, the right move is usually to refactor the shared piece into core" — here
  the correct shared layer is the fitness engine (`check-utils`), not core,
  because the helper is check-author tooling.
- **Imports:** workspace symbols via the `@opensip-tools/fitness` barrel; no
  subpath imports; internal relative imports keep `.js`; type-only imports use
  `import type`.
- **Testing:** Vitest, `*.test.ts` colocated; run via
  `pnpm --filter=@opensip-tools/fitness test` and the pack filters.
- **Before committing:** `pnpm typecheck && pnpm test && pnpm lint` (both ESLint
  and dependency-cruiser 0-error), and `pnpm fit` clean.
