/**
 * Per-check fixture-coverage allowlist for checks-typescript (testing gap P0).
 *
 * `ALLOWLIST` (migration-only) is `[]` — every shipped, fixture-exercisable
 * check has clean+violation fixtures, so the ratchet is fully live: a new check
 * with no fixtures fails CI.
 *
 * `COMMAND_EXEMPTIONS` are `analysisMode:'command'` checks that shell out to an
 * external tool and cannot be exercised by a static fixture (covered by the
 * dogfood / packed-smoke lanes). `KNOWN_UNFIXTURABLE` are non-command checks that
 * still cannot be exercised by an on-disk fixture (documented, permanent — fix
 * the check to graduate it off); empty here.
 */

import type {
  CommandExemptions,
  CoverageAllowlist,
  FilenameOverrides,
} from '@opensip-tools/fitness/internal';

export const ALLOWLIST: CoverageAllowlist = [];

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  // Runs `tsc --noEmit` in each discovered apps/* directory (an external
  // toolchain invocation) and parses the output — now correctly modelled as
  // analysisMode:'command'. Covered by the live dogfood run.
  'typescript-frontend':
    "analysisMode:'command' — runs tsc --noEmit per apps/* dir; covered by the dogfood run",
};

export const KNOWN_UNFIXTURABLE: CommandExemptions = {};

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // Universal-domain checks (no checkScope.languages / fileTypes) default to a
  // `.txt` fixture; these analyze TypeScript, so pin the fixture extension to ts.
  'no-unbounded-concurrency': 'ts',
};
