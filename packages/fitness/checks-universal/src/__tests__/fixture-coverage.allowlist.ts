/**
 * Per-check fixture-coverage allowlist for checks-universal (testing gap P0).
 *
 * `ALLOWLIST` (migration-only) is `[]` — every shipped, fixture-exercisable
 * check has clean+violation fixtures, so the ratchet is fully live.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to
 * external tools and cannot be exercised by writing a fixture file (covered by
 * the failure-mode / packed-smoke lanes). `KNOWN_UNFIXTURABLE` are non-command
 * checks that fixture-coverage surfaced as structurally un-exercisable
 * pre-existing defects — documented, permanent until the check is fixed.
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal'

export const ALLOWLIST: CoverageAllowlist = []

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  'dead-code': "analysisMode:'command' — runs knip; covered by failure-mode + packed-smoke lanes",
  'dependency-vulnerability-audit':
    "analysisMode:'command' — runs the package-manager audit; covered by packed-smoke",
  'semgrep-scan': "analysisMode:'command' — shells to semgrep; covered by packed-smoke",
}

// Non-command checks that cannot be exercised by an on-disk fixture. The other
// three defects fixture-coverage surfaced here (auth-middleware-coverage,
// dependency-version-consistency, env-var-validation) plus this entry's sibling
// have been FIXED and now carry real clean+violation fixtures.
export const KNOWN_UNFIXTURABLE: CommandExemptions = {
  // The string-stripping bug (specifier blanked before extraction) was real, but
  // fixing it revealed a deeper flaw: the detection logic floods with false
  // positives on a pnpm monorepo (1439 "phantom" errors on this repo — it
  // doesn't account for workspace hoisting / root-declared deps / resolution).
  // Left dormant pending a proper workspace-aware rewrite, not a quick fix.
  'phantom-dependency-detection':
    'detection logic false-positive-floods on pnpm monorepos (1439 on self); needs a workspace-aware rewrite, not just the string-stripping fix',
}

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // env-secret-exposure declares languages [json, typescript, yaml] but fileTypes
  // ['ts'] — only a .ts fixture is actually analysed, so pin a single ts pair.
  'env-secret-exposure': 'ts',
}
