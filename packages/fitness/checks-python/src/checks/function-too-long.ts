/**
 * @fileoverview Flag Python functions that exceed a line budget.
 *
 * The FIRST AST-level Python check (ADR-0010) — proof that the tree-sitter
 * substrate is authorable. Unlike the regex-based `no-bare-except`, this parses
 * via `@opensip-tools/lang-python`'s `getSharedTree` (cached, shared with the
 * graph adapter) and walks the real tree-sitter AST: every `function_definition`
 * whose line span exceeds the budget is reported. Long functions are harder to
 * read and test; extracting helpers keeps them in scope.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';
import {
  getLineNumber,
  getSharedTree,
  isFunction,
  nameOf,
  walkNodes,
} from '@opensip-tools/lang-python';

const MAX_FUNCTION_LINES = 50;

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic directly.
 */
export function analyzeFunctionTooLong(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const parsed = getSharedTree(filePath, content);
  // Defensive: tree-sitter recovers from any string into a (partial) tree, so
  // getSharedTree never returns null here — unreachable from a string input.
  /* v8 ignore start */
  if (!parsed) return violations;
  /* v8 ignore stop */

  walkNodes(parsed.tree.rootNode, (node) => {
    if (!isFunction(node)) return;
    const span = node.endPosition.row - node.startPosition.row + 1;
    if (span <= MAX_FUNCTION_LINES) return;
    // Defensive: a Python `function_definition` node always carries a `name`
    // field (without it tree-sitter does not classify the node as a function),
    // so the `?? '<anonymous>'` fallback arm is unreachable in practice.
    /* v8 ignore start */
    const name = nameOf(node) ?? '<anonymous>';
    /* v8 ignore stop */
    violations.push({
      message: `Function \`${name}\` is ${span} lines long (max ${MAX_FUNCTION_LINES}).`,
      severity: 'warning',
      line: getLineNumber(node),
      suggestion: 'Extract helpers to bring the function under the line budget.',
    });
  });

  return violations;
}

export const pythonFunctionTooLong = defineCheck({
  id: 'a7f3c1d2-4b5e-4c6a-9d8e-300000000002',
  slug: 'python-function-too-long',
  description: 'Python functions should stay under a line budget for readability and testability',
  scope: { languages: ['python'], concerns: [] },
  tags: ['quality', 'python', 'complexity'],
  analyze: (content, filePath) => analyzeFunctionTooLong(content, filePath),
});
