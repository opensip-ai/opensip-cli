---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-go"
package: "@opensip-tools/checks-go"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-go

## Summary

`@opensip-tools/checks-go` is a single-check pack: it ships exactly one
fitness check, `go-no-fmt-print`, that flags `fmt.Print` / `Println` /
`Printf` calls. The pack is small, internally consistent, and
structurally identical to its sibling single-check packs (checks-python,
checks-java). It correctly depends on `@opensip-tools/fitness` only,
so it sits cleanly inside the layering enforced by
`.dependency-cruiser.cjs`. The `defineCheck` usage is idiomatic and
matches the patterns established in checks-python and checks-java.

The pack has three minor issues, all minor cosmetic / hygiene rather
than architectural smells:

1. The hand-maintained `metadata.version` constant in `src/index.ts`
   (`0.6.1`) drifts from `package.json` (`1.3.1`).
2. The `__tests__/` directory has two test files (`analyze.test.ts` and
   `no-fmt-print.test.ts`) that both target the pure `analyzeFmtPrint`
   function and overlap heavily — they could be a single file.
3. The pack is the right shape today, but the question of whether one
   check justifies a whole package is a workspace-wide policy decision,
   not a defect specific to checks-go (the same shape is repeated for
   python, java, cpp).

The pack does **not** need a `display/` directory: that is a
convenience layer for packs with many checks (checks-typescript,
checks-universal). For one check the kebab-to-title-case fallback is
sufficient and matches what the other small language packs do.

## Existing patterns (correct usage)

- **`defineCheck` is used idiomatically.** `noFmtPrint` provides
  `id` (UUID), `slug` (`go-no-fmt-print`, language-prefixed),
  `description`, `scope: { languages: ['go'], concerns: [] }`,
  `tags: ['quality', 'observability', 'go']`, and a `contentFilter:
  'strip-strings-and-comments'`. The `analyze` callback is a thin
  delegate to a pure exported function. This matches the
  recommendation in the package CLAUDE.md ("`defineCheck` lives in
  `@opensip-tools/fitness`") and the pattern set by
  `noPrintStackTrace` in checks-java.
- **Pure analyzer separation.** `analyzeFmtPrint` is exported
  separately from the `noFmtPrint` Check object so unit tests can
  exercise it without standing up the full execution context. The
  source comment makes this intent explicit and the test files use it.
  This is a sound pattern that reduces test surface and keeps detection
  logic independently verifiable.
- **Content filter use.** The check declares
  `contentFilter: 'strip-strings-and-comments'`, dispatched through the
  language adapter for `.go` files, so a literal `"fmt.Println("`
  inside a Go string literal or `//` comment doesn't false-fire. This
  is the right hook to use, applied at the right layer (the framework
  applies the filter; the check declares its preference).
- **Dependency hygiene.** `package.json` declares one runtime
  dependency: `@opensip-tools/fitness`. No imports from `cli`,
  `contracts`, `core`, sibling check packs, or other lang packs. This
  satisfies the `checks-no-deps-on-cli-or-contracts` and the implicit
  cross-pack independence rules in `.dependency-cruiser.cjs`.
- **Pack shape vs. single-check siblings.** checks-go mirrors
  checks-python and checks-java exactly: same `package.json` skeleton,
  same `tsconfig.json`, same `vitest.config.ts`, same `src/index.ts`
  layout (a `checks` array + a re-export + a `metadata` constant), no
  `display/` or `utils/` directories. Symmetry across siblings is good
  — it makes the next pack predictable to add.
- **Plugin discoverability.** The barrel exports a `checks` array AND
  a named `noFmtPrint` re-export. The plugin loader in
  `packages/fitness/engine/src/plugins/loader.ts` supports both styles
  and deduplicates by check id, so the redundant publication is
  harmless and matches the documented "two authorship styles" contract.

## Findings

### Hand-maintained `metadata.version` drifts from `package.json`

- **Files / code:**
  - `packages/fitness/checks-go/src/index.ts` (lines 6–10):
    ```ts
    export const metadata = {
      name: '@opensip-tools/checks-go',
      version: '0.6.1',
      description: 'Go fitness checks',
    }
    ```
  - `packages/fitness/checks-go/package.json` line 3: `"version": "1.3.1"`.
- **Pattern / principle:** Single source of truth. `package.json`
  already carries `name`, `version`, and `description`; duplicating
  them in a hand-maintained source constant guarantees drift the moment
  the next release ships.
- **Status:** Pre-existing. The same drift exists in checks-python,
  checks-java, and checks-cpp — it is a pack-system-wide hygiene issue,
  not a checks-go-specific defect. The plugin loader treats `metadata`
  as a reserved export name (skipped in named-export scans in
  `loader.ts`) but does not actually read it, so the wrong value has
  no functional effect today.
- **Why it matters:** Low. Cosmetic. But it's a footgun for any future
  consumer that decides to surface the metadata constant — they'd be
  rendering a 0.6.x version of a 1.3.x package.
- **Recommendation:** Either drop the `metadata` export altogether
  (no consumer reads it) or generate it at build time from
  `package.json`. If you keep it, the cleanest fix is to centralize
  the pattern in fitness (e.g. a `definePackMetadata({ url })` helper
  that reads `package.json` via `import.meta`). Apply the chosen fix
  uniformly across all four single-check packs in one CR.

### Two overlapping test files for the same pure function

- **Files / code:**
  - `packages/fitness/checks-go/src/__tests__/analyze.test.ts`
  - `packages/fitness/checks-go/src/__tests__/no-fmt-print.test.ts`
  Both files open with `describe('analyzeFmtPrint', ...)` and import
  the same `analyzeFmtPrint` symbol. Their `it(...)` cases overlap
  ~70%; the unique cases between them are minor variants ("flags
  multiple occurrences on one line" vs "reports correct line numbers
  across multiple matches", "does not flag fmt.Sprint or fmt.Errorf"
  vs "does not flag fmt.Sprintf (different method)").
- **Pattern / principle:** DRY for tests. Two files with the same
  `describe` block and the same import are a strong signal of accidental
  duplication, probably from two authors landing similar tests at
  different times.
- **Status:** Pre-existing. The same shape exists in checks-python and
  checks-java, suggesting the tests were copy-pasted as part of the
  pack template.
- **Why it matters:** Low. The duplication adds maintenance cost
  (changing `analyzeFmtPrint`'s signature touches both files) and adds
  cognitive noise (a reader has to decide which file to extend). It
  doesn't affect coverage materially because both files exercise the
  same function.
- **Recommendation:** Merge the two files into one
  (`src/__tests__/no-fmt-print.test.ts` is the more conventional name —
  matches the source file). Apply the same merge to checks-python and
  checks-java in the same CR for consistency. The third file
  (`run.test.ts`) is genuinely separate — it exercises the full
  `noFmtPrint.run()` path through the framework — and should stay.

### Small `metadata` re-export adds noise without value

- **Files / code:** `packages/fitness/checks-go/src/index.ts`:
  ```ts
  export const checks = [noFmtPrint] as const

  export const metadata = {
    name: '@opensip-tools/checks-go',
    version: '0.6.1',
    description: 'Go fitness checks',
  }

  export {noFmtPrint} from './checks/no-fmt-print.js'
  ```
- **Pattern / principle:** Don't export what nobody imports. There
  are zero consumers of the `metadata` export in the workspace
  (`grep -rn "from '@opensip-tools/checks-go'"` returns nothing — the
  pack is consumed only by the plugin loader, which doesn't read
  `metadata`). Same for the named `noFmtPrint` re-export: the plugin
  loader's "Style 2" picks it up automatically when it appears in the
  `checks` array. The duplicate named export is dead surface.
- **Status:** Pre-existing across all four single-check packs.
- **Why it matters:** Low. It's three extra lines of code per pack
  multiplied by four packs. The duplicate named export occasionally
  catches the eye of contributors who wonder whether they need to add
  one for each new check.
- **Recommendation:** A single-line `export const checks = [noFmtPrint]
  as const` (with a `noFmtPrint` import at the top) is sufficient.
  Drop both the `metadata` constant and the `export { noFmtPrint }`
  re-export. This is a tiny CR and again worth applying uniformly to
  all four single-check packs to keep the pack template clean.

## Non-findings considered and dismissed

- **"One check is too few for a separate package."** Considered and
  dismissed. The pack-per-language layout exists so users can pick
  exactly the language coverage they want via `plugins.fit:` lists, and
  so each language's check surface can grow independently without
  bloating the others. checks-python, checks-java, and checks-cpp are
  also small today and are expected to grow as language-specific checks
  accrete. Consolidating would couple their lifecycles and break the
  current "ship a new lang pack to add a language" pattern. The right
  question to ask in twelve months is "are any of these still
  one-check packs?", and if so, only then to revisit.
- **"checks-go should depend on `@opensip-tools/lang-go`."** Considered
  and dismissed. The check uses the `'go'` language ID via the
  framework's content filter dispatch, which goes through
  `applyContentFilter()` in core's language registry. The CLI registers
  `goAdapter` into `defaultLanguageRegistry` at startup; checks-go does
  not need a direct dependency on the lang pack. (checks-java does
  depend on `@opensip-tools/lang-java`, but only because its **test**
  imports `stripComments` and `stripStrings` directly from the pack —
  this is a documented sibling deviation, not a pattern checks-go
  should adopt.)
- **"Missing `display/` directory."** Considered and dismissed.
  `display/` is a convenience layer that packs with many checks
  (checks-typescript: 66 checks, checks-universal: 92 checks) use to
  associate pretty names and icons with check slugs. checks-go has one
  check, gets the kebab-to-title-case fallback for free, and matches
  what checks-python / checks-java / checks-cpp do. Adding a
  `display/` directory here would be ceremony, not value.
- **`analyze` closure captures `FMT_PRINT_PATTERN` which is module-level
  with `g` flag and shared `lastIndex`.** The code resets
  `FMT_PRINT_PATTERN.lastIndex = 0` at the start of each line iteration,
  which is the right defensive move. Multi-threading isn't a concern in
  Node's event loop. No bug.
- **`scope.concerns: []` is empty.** Considered and dismissed. The
  empty `concerns` array is the documented "no concern restriction"
  signal — checks-python and checks-java do the same thing for the same
  reason. The match logic in fitness uses set intersection; `[]` means
  the language alone gates the match, which is what we want for a
  `fmt.Print` check that should fire in every Go file regardless of
  whether the user tagged the file as "backend", "tooling", etc.
- **No `recipes` export.** checks-go has no
  `export const recipes = [...]`. Recipes are a fitness-engine concept
  for grouping checks; nothing forces a single-check pack to ship one.
  The engine's plugin loader explicitly supports packs without recipes.
