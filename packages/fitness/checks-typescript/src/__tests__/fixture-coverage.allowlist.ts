/**
 * Per-check fixture-coverage allowlist for checks-typescript (testing gap P0).
 *
 * `ALLOWLIST` (migration-only) is `[]` — every shipped, fixture-exercisable
 * check has clean+violation fixtures, so the ratchet is fully live: a new check
 * with no fixtures fails CI.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks (none in this pack).
 * `KNOWN_UNFIXTURABLE` are non-command checks that still cannot be exercised by
 * an on-disk fixture (documented, permanent — fix the check to graduate it off).
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal'

export const ALLOWLIST: CoverageAllowlist = []

export const COMMAND_EXEMPTIONS: CommandExemptions = {}

export const KNOWN_UNFIXTURABLE: CommandExemptions = {
  // analyzeAll shells out to `npx tsc --noEmit` per discovered apps/* dir — a
  // subprocess + toolchain-dependent check, effectively command-mode; not
  // exercisable by a static fixture. Covered by the live dogfood run.
  // (package-json-exports-field was FIXED — its path filter now accepts absolute
  // paths — and now carries a real fixture, so it's no longer listed here.)
  'typescript-frontend': 'shells out to `npx tsc --noEmit` — effectively command-mode',
}

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // Universal-domain checks (no checkScope.languages / fileTypes) default to a
  // `.txt` fixture; these analyze TypeScript, so pin the fixture extension to ts.
  'no-unbounded-concurrency': 'ts',
}
