/**
 * Canonical TypeScript test-file predicate.
 *
 * Single source of truth for "is this project-relative path a test
 * file?" within the TypeScript adapter. Callers used to roll their
 * own copies:
 *
 *   - walk.ts (file-walker) — stamped `inTestFile` on every occurrence
 *     during stage 1+2 descent.
 *   - index.ts (RuleHints.isTestFile) — the canonical answer wired
 *     into rule evaluation, with broader recall.
 *
 * The 2026-05-23 audit (M-1) flagged the divergence — at the time a
 * third copy lived in the now-removed `inventory.ts` — three
 * predicates at three layer altitudes drifting silently. This module
 * is the one place to extend the rule.
 *
 * Anchored patterns instead of one alternation; avoids catastrophic
 * backtracking on pathological inputs.
 *
 * `__fixtures__/` is included: it is test scaffolding by convention (synthetic
 * inputs for tests, e.g. the orchestrator's `__fixtures__/multi-pkg/` mini-repo),
 * not production code. Without this, reachability/size/cycle rules treat fixture
 * functions as real code and over-trigger (e.g. a fixture helper with no caller
 * reads as a `graph:orphan-subtree`). A `__fixtures__/` dir nested under
 * `__tests__/` is already covered by the first pattern; this also catches the
 * ones that sit beside the code under test.
 */
const TEST_TESTS_DIR_RE = /(?:^|\/)__tests__\//;
const TEST_FIXTURES_DIR_RE = /(?:^|\/)__fixtures__\//;
const TEST_FILE_SUFFIX_RE = /\.test\.(?:ts|tsx|js|jsx)$|_test\.(?:ts|tsx|js|jsx)$/;

/**
 * Returns true if `filePathProjectRel` is a TypeScript / JS test
 * file (or test fixture) by path convention. Path is project-relative with `/`
 * separators (the same shape `Catalog.functions[*].filePath` carries).
 */
export function isTypescriptTestFile(filePathProjectRel: string): boolean {
  return (
    TEST_TESTS_DIR_RE.test(filePathProjectRel) ||
    TEST_FIXTURES_DIR_RE.test(filePathProjectRel) ||
    TEST_FILE_SUFFIX_RE.test(filePathProjectRel)
  );
}
