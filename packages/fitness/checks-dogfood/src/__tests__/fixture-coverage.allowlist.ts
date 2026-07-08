/**
 * Per-check fixture-coverage allowlist for checks-dogfood.
 *
 * `ALLOWLIST` is `[]` — every dogfood check has clean+violation fixtures, so the
 * ratchet is fully live: a new dogfood check with no fixtures fails CI. None of
 * these checks are `analysisMode:'command'`, so `COMMAND_EXEMPTIONS` and
 * `KNOWN_UNFIXTURABLE` are both empty.
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-cli/test-support';

export const ALLOWLIST: CoverageAllowlist = [];

export const COMMAND_EXEMPTIONS: CommandExemptions = {};

export const KNOWN_UNFIXTURABLE: CommandExemptions = {};

export const FILENAME_OVERRIDES: FilenameOverrides = {};
