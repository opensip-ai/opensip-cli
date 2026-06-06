/**
 * Per-check fixture-coverage allowlist for checks-go (testing gap P0).
 *
 * `ALLOWLIST` names shipped checks that do NOT yet have clean+violation
 * fixtures in a co-located `__fixtures__/<slug>/` directory. It MUST shrink to `[]`
 * — each entry is a check whose pass/fail coverage is still owed. Once empty,
 * Phase 5 drops `allowNonEmptyAllowlist` so a new uncovered check fails CI.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to
 * external tools and cannot be exercised by writing a fixture file; they are
 * covered by the failure-mode / packed-smoke lanes instead (gap register).
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal'

export const ALLOWLIST: CoverageAllowlist = []

export const COMMAND_EXEMPTIONS: CommandExemptions = {}

export const FILENAME_OVERRIDES: FilenameOverrides = {}

export const KNOWN_UNFIXTURABLE: CommandExemptions = {}
