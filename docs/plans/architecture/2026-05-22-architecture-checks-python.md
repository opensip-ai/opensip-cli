---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-python"
package: "@opensip-tools/checks-python"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-python

## Summary

`@opensip-tools/checks-python` is a single-check Python pack
(`python-no-bare-except`). For its size, it is well-shaped: idiomatic
`defineCheck` usage, a clean line-based regex analyzer with a pure
`analyzeBareExcept` helper, well-documented intent, and zero stray
dependencies — only `@opensip-tools/fitness` is imported, exactly as
the layering rules require.

The pack is structurally identical to its small-pack siblings
(`checks-go`, `checks-java`, `checks-cpp`): same `index.ts → checks/ →
__tests__/` layout, same barrel idiom (`as const` array + `metadata`
literal + named re-export), same `defineCheck` shape with
`scope.languages = ['<lang>']`, `concerns = []`, language-tagged
`tags`, and a `contentFilter`. There is no drift relative to its
peers.

There are two genuine findings, both shared with siblings rather than
specific to this pack: the `metadata.version` literal is stale relative
to `package.json` (`0.6.1` vs `1.3.1`), and the two test files
(`analyze.test.ts` and `no-bare-except.test.ts`) materially overlap.
Neither is a correctness issue. The "should this pack even exist for
one check?" question is also worth flagging — but the existing answer
("yes, language-pack-per-language is the contract; it gives users a
clear opt-in via plugin config") is defensible and consistent with
how `checks-go`, `checks-java`, and `checks-cpp` are also structured.

## Existing patterns (correct usage)

- **Pure analyzer, framework wrapper.** `analyzeBareExcept(content)` is
  exported and unit-testable independent of the `Check` runtime, and
  `noBareExcept` is the `defineCheck`-wrapped check that the engine
  consumes. This matches the pattern in `checks-go/no-fmt-print.ts`
  and `checks-java/no-printstacktrace.ts`.
- **Content filtering at the right layer.** `contentFilter:
  'strip-strings'` is delegated to the language adapter via
  `applyContentFilter` in `define-check.ts` (line 108). The check
  doesn't try to parse Python — it just declares its filter intent.
- **Scope declaration is honest.** `scope: { languages: ['python'],
  concerns: [] }` is the correct shape: a Python-only check with no
  concern restriction. Tags include both `quality` and `python` so the
  check is discoverable by language tag and by intent tag.
- **Layering is correct.** Source imports are
  `@opensip-tools/fitness` only. No core, no contracts, no cli, no
  cross-pack imports. Architecture rules pass without exemption.
- **Pack barrel matches sibling lang-packs exactly.** The
  `index.ts → import → const checks → metadata → re-export` shape is
  byte-for-byte the same as `checks-go`, `checks-java`, and
  `checks-cpp` (modulo the check name) — diffing them yields only the
  per-pack identifiers.
- **Inline ESLint disable is justified.** The `sonarjs/slow-regex`
  comment correctly explains why the bounded leading-whitespace scan
  is safe. This is the project's preferred form.

## Findings

### `metadata.version` literal is stale and drifts from `package.json`

- **Files / code:**
  `packages/fitness/checks-python/src/index.ts:8` (`version: '0.6.1'`),
  `packages/fitness/checks-python/package.json:3` (`"version":
  "1.3.1"`).
- **Pattern / principle:** Single source of truth. The plugin
  metadata's `version` should reflect the published version, which
  lives in `package.json`.
- **Status:** Active drift. The same drift exists in `checks-go`,
  `checks-java`, and `checks-cpp` (all stuck at `0.6.1`), while
  `checks-typescript` and `checks-universal` are at `1.0.0` (also
  stale relative to `package.json`'s `1.3.1`, but less so).
- **Why it matters:** `metadata.version` is part of the
  `FitPluginExports` contract (`PluginMetadata`) and is observable
  through the plugin loader — it would surface in any "list installed
  plugins" UI. A stale value misrepresents the loaded code's actual
  release. Today nothing seems to read it for behavior, so the impact
  is cosmetic, but it's a footgun once it becomes load-bearing (e.g.
  for compatibility checks or the `plugin list` command).
- **Recommendation:** Replace the hardcoded literal with a build-time
  import from `package.json` (TypeScript supports
  `import pkg from '../package.json' with { type: 'json' }` under
  Node16 ESM resolution) or a generated `version.ts`. Apply the
  same fix consistently across all six `checks-*` packs in one CR so
  the pattern is uniform. This is a pack-shape issue, not specifically
  a `checks-python` issue, but it shows up in this audit.

### Two near-duplicate test files

- **Files / code:**
  `packages/fitness/checks-python/src/__tests__/analyze.test.ts`,
  `packages/fitness/checks-python/src/__tests__/no-bare-except.test.ts`.
- **Pattern / principle:** DRY for tests; clear test ownership per
  file.
- **Status:** Active duplication. Both files import
  `analyzeBareExcept` and assert essentially the same matrix:
  bare `except:`, `except Exception:`, multi-type tuple,
  whitespace-before-colon, indented bare except, multiple bare excepts.
  The third test file (`run.test.ts`) is genuinely different — it
  exists specifically to drive coverage through the closure that
  `defineCheck` builds for `noBareExcept.run()`.
- **Why it matters:** Two tests claiming to test the same thing means
  every fix to one needs the other inspected too, and code reviewers
  spend cycles reconciling near-equal tables. Mostly low-grade noise,
  but it is the only place in this pack where there's any obvious
  cleanup to do.
- **Recommendation:** Pick one (`analyze.test.ts` is the more concise
  of the two and uses one-line `\n`-joined source strings; the other
  uses template literals across multiple lines) and delete the other.
  Keep `run.test.ts` as-is; it covers a real gap. The siblings
  (`checks-go`, `checks-java`) likely have the same duplication —
  worth checking when cleaning this up.

### Pack-existence cost-benefit for a single check

- **Files / code:** The pack as a whole — 1 source check,
  3 test files, 1 barrel, 1 `package.json`, 1 `tsconfig.json`,
  1 `vitest.config.ts`.
- **Pattern / principle:** Cohesion — does a pack with one check earn
  its own publishing surface, version cadence, and discovery entry?
- **Status:** Intentional, by current design. The plugin-loader
  contract treats each `@opensip-tools/checks-<lang>` as a separate
  npm package that users opt into by listing it in `plugins.fit`. So
  the pack exists not for code-organization reasons but for
  *distribution* reasons: a Python project should be able to install
  one package and not pay for Java/Go/C++ checks. This is a real
  benefit, especially as packs grow.
- **Why it matters:** If we ever decide language packs *don't* need
  separate distribution — e.g. because the engine can lazy-load
  language groups inside a single `checks-bundled` package — then
  `checks-python` (and its small-pack siblings) collapse into folders
  in a larger pack. Today, with one check each, the per-pack overhead
  (tooling config, version coordination, separate publish step in
  `RELEASING.md`) is non-trivial relative to the code in them. But
  collapsing them now would also be premature: the contract as
  designed expects each language to grow its own check catalog.
- **Recommendation:** No change. Keep the pack as the seed for a Python
  catalog; a comment or a `README.md` (one-paragraph) noting "this is
  the Python check catalog; new Python checks land here, not in
  `checks-universal`" would make the intent explicit for contributors
  who otherwise wonder why a one-check package exists. Revisit only
  if Python check growth stalls and the pack still has ≤2 checks
  after another release cycle.

## Non-findings considered and dismissed

- **"Use `matchAll` instead of `lastIndex = 0` + `exec` loop."**
  Stylistic. The siblings (`checks-go`, `checks-java`) use the same
  idiom. Standardizing on `matchAll` would be a pack-wide change with
  no behavioral difference. Out of scope.
- **"`content.slice(0, match.index).split('\n').length` per match is
  O(n) per match."** True, but for files of realistic size (Python
  source files with bare `except:` are unlikely to have thousands of
  matches) it's fine. The siblings iterate per-line and avoid the
  reslice entirely; this pack could too, but it's a micro-optimization
  with no measurable user impact. Not worth a fix.
- **"Missing `display/` folder."** All four small lang packs are
  uniform in not having one. The CLI's kebab-to-title-case fallback
  applies (per CLAUDE.md). When this pack grows past 3-4 checks it
  will be worth adding `display/` for icons and pretty names; today
  it would be ceremony for one entry.
- **"Missing `docs:` field on the check."** None of the four small
  lang packs use `docs:`. The check's purpose is fully captured by
  `description` and the file's `@fileoverview`. Not a finding.
- **"Pack barrel doesn't use `collectCheckObjects` like `universal`
  and `typescript` do."** `collectCheckObjects` is a helper for packs
  with many checks discovered via `import * as allChecks`. For a
  one-check pack, the explicit `[noBareExcept] as const` literal is
  clearer and fully consistent with the other small-pack siblings.
- **"`scope.concerns: []` looks empty/wrong."** Empty `concerns` means
  "any concern" by the resolver's set-intersection rules. This is the
  correct way to say "this check applies to every Python file
  regardless of which target it's in," and matches every other
  language-tag check.
- **"Imports use a single workspace package, but `@opensip-tools/core`
  types like `CheckViolation` are re-exported from `fitness`."** The
  re-export is intentional: `defineCheck` lives in fitness, so its
  contract types travel with it. Importing the type from `fitness`
  alongside `defineCheck` is correct per CLAUDE.md ("`defineCheck`
  lives in `@opensip-tools/fitness`, NOT `@opensip-tools/core`").
