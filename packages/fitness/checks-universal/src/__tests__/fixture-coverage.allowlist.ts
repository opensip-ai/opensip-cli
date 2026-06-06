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

// Non-command checks that fixture-coverage SURFACED as structurally
// un-exercisable — each is a pre-existing check defect (the check can never
// produce a deterministic finding from an on-disk fixture). Documented here as
// permanent exemptions; fixing the check graduates the slug off this list.
export const KNOWN_UNFIXTURABLE: CommandExemptions = {
  'auth-middleware-coverage':
    'self-defeating: analyze() strips string literals, but its route regex needs a non-empty quoted path',
  'dependency-version-consistency':
    'ignores the FileAccessor and scans process.cwd() directly — an on-disk fixture cannot drive it',
  'env-var-validation':
    'every `process.env.X` contains `env.X`, which matches its own "safe" ENV_ACCESS pattern — never flags',
  'phantom-dependency-detection':
    'extractImports() strips string-literal quotes before matching the quoted specifier — no import is ever extracted',
}

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // env-secret-exposure declares languages [json, typescript, yaml] but fileTypes
  // ['ts'] — only a .ts fixture is actually analysed, so pin a single ts pair.
  'env-secret-exposure': 'ts',
}
