/* eslint-disable sonarjs/fixme-tag -- this file's job is to detect TODO/FIXME markers; the words appear in identifiers and JSDoc by necessity */
// @fitness-ignore-file no-todo-comments -- this file's job is to detect TODO/FIXME/XXX/OPTIMIZE markers; the words appear in regex and JSDoc by design
/**
 * @fileoverview Cross-language TODO/FIXME comment detection.
 *
 * Uses the language adapter's `strip-strings` filter so TODO markers
 * appearing inside string literals don't false-fire. The filter
 * dispatches through the registered LanguageAdapter, so this check
 * works for any language whose adapter implements stripStrings.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

// HACK is intentionally excluded — `no-temporary-workarounds` owns HACK
// (with qualifier needles like "temporary"/"workaround"). Including HACK
// here as well caused duplicate findings on the same line; see the
// 2026-05-23 checks-universal architecture audit, NF1.
const TODO_PATTERN = /\b(TODO|FIXME|XXX|OPTIMIZE)\b/g;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that
 * requires an ExecutionContext to invoke).
 */
export function analyzeTodoComments(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line_] of lines.entries()) {
    const line = line_;
    let match: RegExpExecArray | null;
    TODO_PATTERN.lastIndex = 0;
    while ((match = TODO_PATTERN.exec(line)) !== null) {
      violations.push({
        message: `${match[1]} marker should be tracked in an issue, not left in source`,
        severity: 'warning',
        line: i + 1,
        suggestion: 'File an issue and remove the marker, or convert to a tracked work item',
      });
    }
  }
  return violations;
}

export const noTodoComments = defineCheck({
  id: 'a1b2c3d4-9876-4321-aaaa-100000000001',
  slug: 'no-todo-comments',
  description: 'TODO/FIXME/XXX/OPTIMIZE markers should not ship to production',
  scope: { languages: [], concerns: [] },
  tags: ['quality', 'documentation'],
  // Restrict to source files. Markdown files legitimately discuss TODO
  // markers (CONTRIBUTING examples, docs about the check itself); the
  // marker hygiene rule only applies to executable code.
  fileTypes: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'go',
    'java',
    'rs',
    'c',
    'cc',
    'cpp',
    'h',
    'hpp',
  ],
  // Use 'strip-strings' so the check sees comments but not string-literal
  // text. A literal value containing the word "TODO" is not a comment.
  contentFilter: 'strip-strings',
  analyze: (content, filePath) => {
    // Test files routinely contain TODO/FIXME markers as fixture content
    // or pedagogical examples (e.g. test cases for this very check).
    // The production-code hygiene rule does not apply to tests.
    if (isTestFile(filePath)) return [];
    return analyzeTodoComments(content);
  },
});
