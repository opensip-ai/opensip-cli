/**
 * Per-check fixture-coverage allowlist for checks-cpp (testing gap P0).
 *
 * `ALLOWLIST` names shipped checks that do NOT yet have clean+violation
 * fixtures in a co-located `__fixtures__/<slug>/` directory. It MUST shrink to `[]`
 * — each entry is a check whose pass/fail coverage is still owed. Once empty,
 * Phase 5 drops `allowNonEmptyAllowlist` so a new uncovered check fails CI.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to
 * external tools and cannot be exercised by writing a fixture file; they are
 * covered by the failure-mode / packed-smoke lanes instead (gap register).
 *
 * checks-cpp ships exactly one check today — `cpp-clang-tidy` — and it is a
 * command-mode passthrough to `clang-tidy`. There is therefore no fixture-
 * exercisable check in this pack: ALLOWLIST is already `[]`, and the sole
 * shipped check lives in COMMAND_EXEMPTIONS.
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal'

export const ALLOWLIST: CoverageAllowlist = []

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  'cpp-clang-tidy':
    "analysisMode:'command' — shells to clang-tidy; covered by failure-mode + packed-smoke lanes",
}

export const FILENAME_OVERRIDES: FilenameOverrides = {}
