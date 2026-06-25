/**
 * Canonical TS/JS test-file predicate — single-sourced so every producer of a
 * `CloneCandidate.inTestFile` flag (graph's TS walk, yagni's TS inventory) classifies
 * test files IDENTICALLY. A divergence here is exactly the filter-divergence class
 * ADR-0064 prevents (it would split the cross-tool parity test on `inTestFile`).
 *
 * Anchored patterns instead of one alternation; avoids catastrophic backtracking on
 * pathological inputs. `__fixtures__/` counts as test scaffolding by convention.
 *
 * Relocated verbatim from `graph-typescript/src/test-file.ts` (the regexes are unchanged
 * — classification is byte-stable).
 */
const TEST_TESTS_DIR_RE = /(?:^|\/)__tests__\//;
const TEST_FIXTURES_DIR_RE = /(?:^|\/)__fixtures__\//;
const TEST_FILE_SUFFIX_RE = /\.test\.(?:ts|tsx|js|jsx)$|_test\.(?:ts|tsx|js|jsx)$/;

/**
 * Returns true if `filePathProjectRel` is a TypeScript / JS test file (or test fixture)
 * by path convention. Path is project-relative with `/` separators (the same shape
 * `CloneCandidate.filePath` carries).
 */
export function isTestFilePath(filePathProjectRel: string): boolean {
  return (
    TEST_TESTS_DIR_RE.test(filePathProjectRel) ||
    TEST_FIXTURES_DIR_RE.test(filePathProjectRel) ||
    TEST_FILE_SUFFIX_RE.test(filePathProjectRel)
  );
}
