/**
 * Per-check fixture-coverage allowlist for checks-cpp (testing gap P0).
 *
 * `ALLOWLIST` is currently empty: there are no shipped, fixture-exercisable
 * checks missing clean+violation fixtures. A future entry would mean a check
 * whose pass/fail fixture coverage is still owed.
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
} from '@opensip-tools/test-support';

export const ALLOWLIST: CoverageAllowlist = [];

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  'cpp-clang-tidy':
    "analysisMode:'command' — shells to clang-tidy; covered by failure-mode + packed-smoke lanes",
};

export const FILENAME_OVERRIDES: FilenameOverrides = {};

export const KNOWN_UNFIXTURABLE: CommandExemptions = {};
