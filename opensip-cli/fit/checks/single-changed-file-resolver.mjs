/**
 * @fileoverview single-changed-file-resolver — only the core git changed-file
 *               resolver may derive changed files. Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it
 * encodes opensip-cli local facts: it cites ADR-0085 and hardcodes the
 * first-party resolver path (`packages/core/src/lib/git-changed-files.ts`) and
 * the `repo-identity.ts` allowance. A consumer repo has none of those facts, so
 * the rule is opensip-internal, not universal — `shipped-checks-must-be-generic`
 * steers exactly this kind of pure-text dogfood check to a project-local .mjs.
 *
 * WHY: `resolveChangedFiles` in `packages/core/src/lib/git-changed-files.ts` is
 * the single host-owned resolver (ADR-0085). Tools must not shell out for
 * changed-file derivation independently, or `--since`/`--changed` semantics drift.
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

const RESOLVER_PATH = 'packages/core/src/lib/git-changed-files.ts';

/** Allowed git argv patterns that are NOT changed-file derivation. */
const ALLOWED_GIT_PATTERNS = [
  /rev-parse\s+HEAD/,
  /config\s+--get\s+remote\.origin\.url/,
  /rev-parse\s+--is-inside-work-tree/,
  /rev-parse\s+--verify/,
];

function isChangedFileDerivation(line) {
  const lower = line.toLowerCase();
  if (!lower.includes('git') && !lower.includes('execfilesync') && !lower.includes('spawn')) {
    return false;
  }
  const hasDiffNameOnly =
    lower.includes('--name-only') || (lower.includes('diff') && lower.includes('name-only'));
  const hasLsOthers = lower.includes('--others') && lower.includes('ls-files');
  return hasDiffNameOnly || hasLsOthers;
}

function isAllowedGitCall(line) {
  return ALLOWED_GIT_PATTERNS.some((re) => re.test(line));
}

export function analyzeSingleChangedFileResolver(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.includes(RESOLVER_PATH)) return [];
  if (isTestFile(filePath)) return [];
  if (normalized.includes('repo-identity.ts')) return [];

  const violations = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!isChangedFileDerivation(line)) continue;
    if (isAllowedGitCall(line)) continue;
    violations.push({
      message:
        'Changed-file git derivation must use resolveChangedFiles from @opensip-cli/core — do not shell out independently (ADR-0085)',
      line: i + 1,
      column: 1,
      severity: 'error',
      suggestion: `Import resolveChangedFiles from '@opensip-cli/core' instead of ad-hoc git diff in ${normalized}`,
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    slug: 'single-changed-file-resolver',
    description:
      'Only the core git changed-file resolver may shell out for changed-file derivation (ADR-0085)',
    scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
    tags: ['architecture'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeSingleChangedFileResolver(content, filePath),
  }),
];
