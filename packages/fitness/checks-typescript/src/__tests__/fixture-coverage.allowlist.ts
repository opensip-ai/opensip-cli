/**
 * Per-check fixture-coverage allowlist for checks-typescript (testing gap P0).
 *
 * `ALLOWLIST` names shipped checks that do NOT yet have clean+violation
 * fixtures in a co-located `__fixtures__/<slug>/` directory. It MUST shrink to `[]`
 * — each entry is a check whose pass/fail coverage is still owed. Once empty,
 * Phase 5 drops `allowNonEmptyAllowlist` so a new uncovered check fails CI.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to
 * external tools and cannot be exercised by writing a fixture file; this pack
 * ships none.
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal'

export const ALLOWLIST: CoverageAllowlist = [
  // package-json-exports-field: analyzeAll filters files.paths with
  // `p.startsWith('packages/')`, but the coverage harness supplies ABSOLUTE
  // temp-dir paths (targetFiles = join(root, p)), so the filter matches zero
  // package.json files and the check can never fire on a fixture. Not
  // fixture-exercisable without repo-relative paths; covered by the live
  // dogfood run instead.
  'package-json-exports-field',
  // typescript-frontend: analyzeAll shells out to `npx tsc --noEmit` in each
  // discovered apps/* dir (subprocess + network/toolchain dependent, like a
  // command-mode check). Not fixture-exercisable; covered by the live run.
  'typescript-frontend',
]

export const COMMAND_EXEMPTIONS: CommandExemptions = {}

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // Universal-domain checks (no checkScope.languages / fileTypes) default to a
  // `.txt` fixture; these analyze TypeScript, so pin the fixture extension to ts.
  'no-unbounded-concurrency': 'ts',
}
