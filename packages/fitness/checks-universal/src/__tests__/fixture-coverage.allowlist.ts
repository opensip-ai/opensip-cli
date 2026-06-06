/**
 * Per-check fixture-coverage allowlist for checks-universal (testing gap P0).
 *
 * `ALLOWLIST` names shipped checks that do NOT have clean+violation fixtures in
 * a co-located `__fixtures__/<slug>/` directory. The goal is `[]`; the four
 * residual entries are checks that are STRUCTURALLY NOT fixture-exercisable —
 * each one's own analyze logic (self-defeating contentFilter, or scanning
 * `process.cwd()` instead of the supplied files) makes it impossible to drive a
 * deterministic finding from an on-disk fixture. Each carries an inline reason.
 * These are pre-existing check bugs, not missing coverage; closing them is a
 * fix to the check, after which the slug graduates off this list.
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

export const ALLOWLIST: CoverageAllowlist = [
  // auth-middleware-coverage: self-defeating under its own contentFilter — analyze()
  // strips string literals, then its route regex requires a non-empty quoted path,
  // so the path is blanked before the matcher runs. Cannot be exercised on disk.
  'auth-middleware-coverage',
  // dependency-version-consistency: ignores the FileAccessor and scans process.cwd()
  // directly, so an on-disk fixture cannot drive its input.
  'dependency-version-consistency',
  // env-var-validation: every `process.env.X` match contains the substring `env.X`,
  // which matches its own ENV_ACCESS "safe" pattern — so all accesses are treated
  // as safe and nothing can ever be flagged.
  'env-var-validation',
  // phantom-dependency-detection: extractImports() strips string literals (quotes
  // included) before matching the quoted import specifier `['"]([^'"]+)['"]`, so no
  // import is ever extracted and no phantom dependency can be detected.
  'phantom-dependency-detection',
]

export const COMMAND_EXEMPTIONS: CommandExemptions = {
  'dead-code': "analysisMode:'command' — runs knip; covered by failure-mode + packed-smoke lanes",
  'dependency-vulnerability-audit':
    "analysisMode:'command' — runs the package-manager audit; covered by packed-smoke",
  'semgrep-scan': "analysisMode:'command' — shells to semgrep; covered by packed-smoke",
}

export const FILENAME_OVERRIDES: FilenameOverrides = {
  // env-secret-exposure declares languages [json, typescript, yaml] but fileTypes
  // ['ts'] — only a .ts fixture is actually analysed, so pin a single ts pair.
  'env-secret-exposure': 'ts',
}
