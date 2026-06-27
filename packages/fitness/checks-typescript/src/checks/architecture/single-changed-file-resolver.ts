/**
 * @fileoverview Only the core git changed-file resolver may derive changed files.
 *
 * ADR-0085: `resolveChangedFiles` in `packages/core/src/lib/git-changed-files.ts`
 * is the single host-owned resolver. Tools must not shell out for changed-file
 * derivation independently.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

const RESOLVER_PATH = 'packages/core/src/lib/git-changed-files.ts';

/** Allowed git argv patterns that are NOT changed-file derivation. */
const ALLOWED_GIT_PATTERNS = [
  /rev-parse\s+HEAD/,
  /config\s+--get\s+remote\.origin\.url/,
  /rev-parse\s+--is-inside-work-tree/,
  /rev-parse\s+--verify/,
];

function isChangedFileDerivation(line: string): boolean {
  const lower = line.toLowerCase();
  if (!lower.includes('git') && !lower.includes('execfilesync') && !lower.includes('spawn')) {
    return false;
  }
  const hasDiffNameOnly =
    lower.includes('--name-only') || (lower.includes('diff') && lower.includes('name-only'));
  const hasLsOthers = lower.includes('--others') && lower.includes('ls-files');
  return hasDiffNameOnly || hasLsOthers;
}

function isAllowedGitCall(line: string): boolean {
  return ALLOWED_GIT_PATTERNS.some((re) => re.test(line));
}

export function analyzeSingleChangedFileResolver(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.includes(RESOLVER_PATH)) return [];
  if (isTestFile(filePath)) return [];
  if (normalized.includes('repo-identity.ts')) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line_] of lines.entries()) {
    const line = line_;
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

export const singleChangedFileResolverCheck = defineCheck({
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  slug: 'single-changed-file-resolver',
  description:
    'Only the core git changed-file resolver may shell out for changed-file derivation (ADR-0085)',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  tags: ['architecture'],
  analyze: (content, filePath) => analyzeSingleChangedFileResolver(content, filePath),
});
