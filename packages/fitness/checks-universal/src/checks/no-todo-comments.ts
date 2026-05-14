/**
 * @fileoverview Cross-language TODO/FIXME comment detection.
 *
 * Uses the language adapter's `strip-strings` filter so TODO markers
 * appearing inside string literals don't false-fire. The filter
 * dispatches through the registered LanguageAdapter, so this check
 * works for any language whose adapter implements stripStrings.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b/g

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that
 * requires an ExecutionContext to invoke).
 */
export function analyzeTodoComments(content: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let match: RegExpExecArray | null
    TODO_PATTERN.lastIndex = 0
    while ((match = TODO_PATTERN.exec(line)) !== null) {
      violations.push({
        message: `${match[1]} marker should be tracked in an issue, not left in source`,
        severity: 'warning',
        line: i + 1,
        suggestion: 'File an issue and remove the marker, or convert to a tracked work item',
      })
    }
  }
  return violations
}

export const noTodoComments = defineCheck({
  id: 'a1b2c3d4-9876-4321-aaaa-100000000001',
  slug: 'no-todo-comments',
  description: 'TODO/FIXME/XXX/HACK markers should not ship to production',
  scope: { languages: [], concerns: [] },
  tags: ['quality', 'documentation'],
  // Use 'strip-strings' so the check sees comments but not string-literal
  // text. A literal value containing the word "TODO" is not a comment.
  contentFilter: 'strip-strings',
  analyze: (content) => analyzeTodoComments(content),
})
