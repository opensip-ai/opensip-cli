/**
 * Canonical TypeScript test-file predicate.
 *
 * Single source of truth for "is this project-relative path a test
 * file?" within the TypeScript adapter. Three callers used to roll
 * their own copies:
 *
 *   - walk.ts (file-walker) — stamped `inTestFile` on every occurrence
 *     during stage 1+2 descent.
 *   - inventory.ts (legacy buildInventory) — same job, narrower regex.
 *   - index.ts (RuleHints.isTestFile) — the canonical answer wired
 *     into rule evaluation, with broader recall.
 *
 * The 2026-05-23 audit (M-1) flagged the divergence: three predicates
 * at three layer altitudes drifting silently. This module is the one
 * place to extend the rule.
 *
 * Two anchored patterns instead of one alternation; avoids
 * catastrophic backtracking on pathological inputs.
 */
const TEST_TESTS_DIR_RE = /(?:^|\/)__tests__\//;
const TEST_FILE_SUFFIX_RE = /\.test\.(?:ts|tsx|js|jsx)$|_test\.(?:ts|tsx|js|jsx)$/;

/**
 * Returns true if `filePathProjectRel` is a TypeScript / JS test
 * file by path convention. Path is project-relative with `/`
 * separators (the same shape `Catalog.functions[*].filePath` carries).
 */
export function isTypescriptTestFile(filePathProjectRel: string): boolean {
  return TEST_TESTS_DIR_RE.test(filePathProjectRel) || TEST_FILE_SUFFIX_RE.test(filePathProjectRel);
}
