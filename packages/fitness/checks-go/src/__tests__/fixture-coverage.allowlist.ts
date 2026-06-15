/**
 * Per-check fixture-coverage allowlist for checks-go (testing gap P0).
 *
 * `ALLOWLIST` is currently empty: every shipped, fixture-exercisable check
 * has clean+violation fixtures. A future entry would mean a check whose
 * pass/fail fixture coverage is still owed.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to
 * external tools and cannot be exercised by writing a fixture file; they are
 * covered by the failure-mode / packed-smoke lanes instead (gap register).
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-cli/test-support';

export const ALLOWLIST: CoverageAllowlist = [];

export const COMMAND_EXEMPTIONS: CommandExemptions = {};

export const FILENAME_OVERRIDES: FilenameOverrides = {};

export const KNOWN_UNFIXTURABLE: CommandExemptions = {};
