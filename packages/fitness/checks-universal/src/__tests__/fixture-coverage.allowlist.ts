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
} from '@opensip-cli/test-support';

export const ALLOWLIST: CoverageAllowlist = [];

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  'dead-code': "analysisMode:'command' — runs knip; covered by failure-mode + packed-smoke lanes",
  'dependency-vulnerability-audit':
    "analysisMode:'command' — runs the package-manager audit; covered by packed-smoke",
  'semgrep-scan': "analysisMode:'command' — shells to semgrep; covered by packed-smoke",
};

// Non-command checks that cannot be exercised by an on-disk fixture. Empty:
// every defect fixture-coverage surfaced in this pack (auth-middleware-coverage,
// dependency-version-consistency, env-var-validation) has been FIXED and now
// carries real clean+violation fixtures. phantom-dependency-detection — whose
// regex/text extractor could not distinguish a real import from import-like text
// inside a string literal — was moved to checks-typescript and rewritten on the
// TypeScript AST (a string literal is never an ImportDeclaration), where it is
// fully fixtured.
export const KNOWN_UNFIXTURABLE: CommandExemptions = {
  // analyzeAll self-reads docs/public/50-extend from process.cwd() (the extend-docs
  // are excluded from the code-scan targets), so an on-disk __fixtures__ file is
  // never the thing it reads. Its teeth are proven by the analyzeBlessedSeam unit
  // test + the live dogfood run over the real extend-docs.
  'docs-teach-blessed-seam':
    'analyzeAll self-reads docs/public/50-extend from cwd; exercised by its unit test + the dogfood',
};

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // env-secret-exposure declares languages [json, typescript, yaml] but fileTypes
  // ['ts'] — only a .ts fixture is actually analysed, so pin a single ts pair.
  'env-secret-exposure': 'ts',
};
