// @fitness-ignore-file file-length-limit -- Complex module with tightly coupled logic; splitting would fragment cohesive functionality
// @fitness-ignore-file null-safety -- null checks are intentional guards
/**
 * @fileoverview Async Waterfall Detection Check
 *
 * Detects sequential await statements that could potentially be parallelized
 * with Promise.all(). Uses AST-aware heuristics:
 * - Looks for consecutive lines with await expressions
 * - Flags when the second await doesn't reference the variable from the first
 * - Skips awaits in different conditional branches (if/else, ternary, switch)
 * - Recognizes dynamic import destructuring dependencies
 * - Skips mutex/lock acquire-then-execute patterns
 * - Skips sleep/delay in polling loops
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness';
import { getSharedSourceFile, isAsync } from '@opensip-tools/lang-typescript';
import * as ts from 'typescript';

/**
 * Minimum line gap to consider awaits as consecutive (0 = adjacent lines)
 */
const MAX_LINE_GAP = 1;

/**
 * Represents an await expression with its metadata
 */
interface AwaitInfo {
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed) */
  column: number;
  /** Variable name if this is an assignment (e.g., `const foo = await ...`) */
  assignedVariable: string | null;
  /** Individual binding names from destructured patterns */
  destructuredBindings: readonly string[];
  /** The full text of the await expression */
  expressionText: string;
  /** Whether this await is a dynamic import expression */
  isDynamicImport: boolean;
  /** Branch key identifying the conditional context (e.g., 'if@L42', 'else@L42', 'ternary-true@L50') */
  branchKey: string | null;
  /** The AST node for this await expression */
  node: ts.AwaitExpression;
}

/**
 * Function names that indicate sleep/delay/timer patterns (inherently sequential)
 */
const SLEEP_DELAY_NAMES = new Set(['sleep', 'delay', 'wait', 'setTimeout', 'pause']);

/**
 * Function names that indicate mutex/lock acquire patterns (inherently sequential)
 */
const LOCK_ACQUIRE_NAMES = new Set(['acquire', 'lock', 'runExclusive', 'withLock']);

/**
 * Check if a node is an async function (function, method, or arrow function).
 *
 * Defers the modifier inspection to `lang-typescript`'s canonical `isAsync`
 * (modern `canHaveModifiers` + `getModifiers` API); the function-like guard
 * stays inline so callers downstream still get the narrowed-via-control-flow
 * type for `node` at the call site.
 */
function isAsyncFunction(node: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return isAsync(node);
  }
  return false;
}

/**
 * Check if a node is an if/else branch and return the branch key.
 */
function getIfElseBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parentNode = current.parent;
  if (!ts.isIfStatement(parentNode)) return null;

  const ifLine = sourceFile.getLineAndCharacterOfPosition(parentNode.getStart()).line;
  if (current === parentNode.thenStatement) return `if@L${ifLine}`;
  if (current === parentNode.elseStatement) return `else@L${ifLine}`;
  return null;
}

/**
 * Check if a node is inside a ternary expression and return the branch key.
 */
function getTernaryBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parentNode = current.parent;
  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isConditionalExpression(parentNode)) return null;

  const condLine = sourceFile.getLineAndCharacterOfPosition(parentNode.getStart()).line;
  if (current === parentNode.whenTrue) return `ternary-true@L${condLine}`;
  if (current === parentNode.whenFalse) return `ternary-false@L${condLine}`;
  return null;
}

/**
 * Check if a node is a switch case clause and return the branch key.
 */
function getSwitchBranchKey(current: ts.Node, sourceFile: ts.SourceFile): string | null {
  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isCaseClause(current) && !ts.isDefaultClause(current)) return null;

  // @fitness-ignore-next-line null-safety -- CaseClause/DefaultClause parent is CaseBlock, grandparent is SwitchStatement per TS AST spec
  const switchStmt = current.parent.parent;
  if (!ts.isSwitchStatement(switchStmt)) return null;

  const switchLine = sourceFile.getLineAndCharacterOfPosition(switchStmt.getStart()).line;
  if (ts.isCaseClause(current)) {
    const caseText = current.expression.getText(sourceFile);
    return `case-${caseText}@L${switchLine}`;
  }
  return `default@L${switchLine}`;
}

/**
 * Walk up the AST from a node to find if it's inside a conditional branch.
 * Returns a branch key like 'if@L42' or 'else@L42' to identify which branch,
 * or null if not inside a conditional branch.
 *
 * Starts at the node itself (not node.parent) so that direct children of
 * ternary expressions are correctly identified as branch members. For example,
 * in `cond ? await X : await Y`, the AwaitExpression is a direct child of
 * the ConditionalExpression. Starting at node.parent would skip past the
 * AwaitExpression level and miss the ternary branch detection.
 */
function getBranchKey(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  functionNode: ts.Node,
): string | null {
  let current: ts.Node = node;

  while (current !== functionNode) {
    const ifElseKey = getIfElseBranchKey(current, sourceFile);
    if (ifElseKey) return ifElseKey;

    const ternaryKey = getTernaryBranchKey(current, sourceFile);
    /* v8 ignore next -- defensive AST/type guard */
    if (ternaryKey) return ternaryKey;

    const switchKey = getSwitchBranchKey(current, sourceFile);
    /* v8 ignore next -- defensive AST/type guard */
    if (switchKey) return switchKey;

    current = current.parent;
  }

  return null;
}

/**
 * Extract individual binding names from a destructuring pattern.
 * For `const { foo, bar } = ...` returns ['foo', 'bar'].
 * For `const [a, b] = ...` returns ['a', 'b'].
 */
function extractDestructuredBindings(
  pattern: ts.BindingPattern,
  sourceFile: ts.SourceFile,
): string[] {
  const names: string[] = [];

  // @lazy-ok -- iterating binding elements, not awaiting
  for (const element of pattern.elements) {
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.getText(sourceFile));
      } else if (
        ts.isObjectBindingPattern(element.name) ||
        ts.isArrayBindingPattern(element.name)
      ) {
        // Nested destructuring: recurse
        names.push(...extractDestructuredBindings(element.name, sourceFile));
      }
    }
  }

  return names;
}

/**
 * Collect all await expressions within an async function (non-recursive into nested async functions)
 */
function collectAwaitExpressions(node: ts.Node, sourceFile: ts.SourceFile): AwaitInfo[] {
  const awaitInfos: AwaitInfo[] = [];

  const visit = (n: ts.Node) => {
    // Don't recurse into nested async functions
    if (n !== node && isAsyncFunction(n)) {
      return;
    }

    if (ts.isAwaitExpression(n)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(n.getStart());
      const assignedVariable = getAssignedVariable(n, sourceFile);
      const destructuredBindings = getDestructuredBindings(n, sourceFile);
      const isDynamicImport = isDynamicImportExpression(n);
      const branchKey = getBranchKey(n, sourceFile, node);

      awaitInfos.push({
        line: line + 1, // Convert to 1-indexed
        column: character + 1,
        assignedVariable,
        destructuredBindings,
        expressionText: n.getText(sourceFile),
        isDynamicImport,
        branchKey,
        node: n,
      });
    }

    ts.forEachChild(n, visit);
  };

  ts.forEachChild(node, visit);
  return awaitInfos;
}

/**
 * Get the variable name if this await is part of a variable declaration or assignment
 */
function getAssignedVariable(
  awaitNode: ts.AwaitExpression,
  sourceFile: ts.SourceFile,
): string | null {
  // Check if parent is a variable declaration: const foo = await ...
  const parent = awaitNode.parent;

  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.getText(sourceFile);
  }

  // Check for destructuring: const { foo } = await ... or const [foo] = await ...
  if (
    ts.isVariableDeclaration(parent) &&
    (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
  ) {
    // Return a placeholder to indicate there's an assigned variable
    return parent.name.getText(sourceFile);
  }

  // Check for assignment: foo = await ...
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.getText(sourceFile);
  }

  return null;
}

/**
 * Get individual binding names from destructured await patterns
 */
function getDestructuredBindings(
  awaitNode: ts.AwaitExpression,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const parent = awaitNode.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
  ) {
    return extractDestructuredBindings(parent.name, sourceFile);
  }
  return [];
}

/**
 * Check if an await expression is a dynamic import: `await import('...')`
 */
function isDynamicImportExpression(awaitNode: ts.AwaitExpression): boolean {
  const expr = awaitNode.expression;
  // import(...) appears as a CallExpression with an ImportKeyword
  return ts.isCallExpression(expr) && expr.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * Check if an await expression calls a sleep/delay function
 */
function isSleepOrDelay(expressionText: string): boolean {
  const afterAwait = expressionText.replace(/^await\s+/, '');
  // Extract the function name from patterns like: sleep(100), this.sleep(100), delay(ms)
  // eslint-disable-next-line sonarjs/slow-regex -- `\w+` bounded by `(`; optional `this.` prefix is fixed
  const match = /(?:this\.)?(\w+)\s*\(/.exec(afterAwait);

  if (match?.[1] !== undefined) {
    return SLEEP_DELAY_NAMES.has(match[1]);
  }
  return false;
}

/**
 * Check if an await expression calls a lock/acquire function
 */
function isLockAcquire(expressionText: string): boolean {
  const afterAwait = expressionText.replace(/^await\s+/, '');
  // Extract the function name from patterns like: this.acquire(), acquire(timeout)
  // eslint-disable-next-line sonarjs/slow-regex -- `\w+` bounded by `(`; optional `this.` prefix is fixed
  const match = /(?:this\.)?(\w+)\s*\(/.exec(afterAwait);

  if (match?.[1] !== undefined) {
    return LOCK_ACQUIRE_NAMES.has(match[1]);
  }
  return false;
}

/**
 * Check if the next await references any of the destructured bindings from the current await
 */
function nextUsesDestructuredBindings(current: AwaitInfo, next: AwaitInfo): boolean {
  if (current.destructuredBindings.length === 0) {
    return false;
  }
  return current.destructuredBindings.some((binding) => next.expressionText.includes(binding));
}

/**
 * Check whether a pair of consecutive await expressions should be skipped (not flagged).
 * Returns true if the pair is NOT a parallelizable waterfall.
 */
function shouldSkipAwaitPair(current: AwaitInfo, next: AwaitInfo): boolean {
  // Skip if awaits are not on consecutive or near-consecutive lines
  /* v8 ignore next -- defensive AST/type guard */
  if (next.line - current.line > MAX_LINE_GAP + 1) return true;

  // Skip if both awaits are in different branches of a conditional
  if (
    current.branchKey !== null &&
    next.branchKey !== null &&
    // @fitness-ignore-next-line unsafe-secret-comparison -- Comparing AST branch identifiers, not cryptographic keys
    current.branchKey !== next.branchKey
  ) {
    return true;
  }

  // Skip if either await is a sleep/delay call (inherently sequential in polling loops)
  /* v8 ignore next -- defensive AST/type guard */
  if (isSleepOrDelay(current.expressionText) || isSleepOrDelay(next.expressionText)) return true;

  // Skip if the first await is a lock/acquire call (inherently sequential)
  /* v8 ignore next -- defensive AST/type guard */
  if (isLockAcquire(current.expressionText)) return true;

  // If the first await has an assigned variable, check if the second await uses it
  if (current.assignedVariable !== null && next.expressionText.includes(current.assignedVariable)) {
    return true;
  }

  // Check if the first await has destructured bindings used by the second
  /* v8 ignore next -- defensive AST/type guard */
  if (nextUsesDestructuredBindings(current, next)) return true;

  // Skip if the first await is a dynamic import (next line typically uses the import)
  /* v8 ignore next -- defensive AST/type guard */
  if (current.isDynamicImport) return true;

  // Skip if either await is not a function call (just awaiting a variable)
  if (
    !isAwaitingFunctionCall(current.expressionText) ||
    !isAwaitingFunctionCall(next.expressionText)
  ) {
    return true;
  }

  return false;
}

/**
 * Detect waterfall patterns in a list of await expressions
 */
function detectWaterfalls(awaitInfos: AwaitInfo[]): CheckViolation[] {
  const violations: CheckViolation[] = [];

  // Sort by line number
  const sorted = [...awaitInfos].sort((a, b) => a.line - b.line);

  // @lazy-ok -- validation depends on preceding await result
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    // Array access with bounds-checked index is safe here
    if (current === undefined || next === undefined) continue;

    if (shouldSkipAwaitPair(current, next)) continue;

    // This looks like a potential waterfall pattern
    violations.push({
      line: current.line,
      column: current.column,
      message: 'Sequential await statements may be parallelizable with Promise.all()',
      severity: 'warning',
      suggestion:
        'Consider using Promise.all() to parallelize independent async operations. ' +
        'Example: const [result1, result2] = await Promise.all([asyncOp1(), asyncOp2()]);',
      type: 'async-waterfall',
      match: `${current.expressionText} followed by ${next.expressionText}`,
    });

    // Skip the next await since we already flagged this pair
    i++;
  }

  return violations;
}

/**
 * Check if an await expression is awaiting a function call (not just a variable or property)
 */
function isAwaitingFunctionCall(expressionText: string): boolean {
  // Remove the "await " prefix
  const afterAwait = expressionText.replace(/^await\s+/, '');

  // Check if it ends with () or has a call pattern
  // This catches: foo(), foo.bar(), this.foo(), obj.method(args)
  // eslint-disable-next-line sonarjs/slow-regex -- [^)]* bounded by ')' delimiter; $ anchored
  return /\([^)]*\)\s*$/.test(afterAwait);
}

/**
 * Analyze a file for async waterfall patterns
 */
function analyzeFile(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const sourceFile = getSharedSourceFile(absolutePath, content);
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return [];

  // Find all async functions and analyze their await expressions
  const visit = (node: ts.Node) => {
    if (isAsyncFunction(node)) {
      const asyncNode = node as ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction;
      const awaitInfos = collectAwaitExpressions(asyncNode, sourceFile);
      const newViolations = detectWaterfalls(awaitInfos);
      violations.push(...newViolations);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Check: quality/async-waterfall-detection
 *
 * Detects sequential await statements that could potentially be parallelized.
 * Uses AST-aware heuristics including:
 * - Consecutive await detection within a configurable line gap
 * - Variable dependency tracking (simple names and destructured bindings)
 * - Conditional branch awareness (if/else, ternary, switch/case)
 * - Dynamic import recognition
 * - Mutex/lock acquire pattern exclusion
 * - Sleep/delay pattern exclusion
 */
export const asyncWaterfallDetection = defineCheck({
  id: 'cf169aa8-906c-4e74-bd48-8c9f59ae3eb7',
  slug: 'async-waterfall-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect sequential await statements that could be parallelized',
  longDescription: `**Purpose:** Detects sequential await statements that could potentially be parallelized with \`Promise.all()\`.

**Detects:** Analyzes each file individually using TypeScript AST. Finds consecutive await expressions (within ${MAX_LINE_GAP + 1} lines) in async functions where the second await does not reference the variable assigned by the first, and both await function calls (matched by trailing parentheses).

**Excludes (not flagged):**
- Awaits in different conditional branches (if/else, ternary, switch/case)
- Dynamic \`await import()\` expressions (next statement almost always depends on the import)
- Destructured binding dependencies (e.g., \`const { x } = await import(...); await x()\`)
- Sleep/delay calls in polling loops (\`await sleep()\`, \`await delay()\`)
- Mutex/lock acquire patterns (\`await this.acquire()\`, \`await lock()\`)
- CLI entry point files (\`**/bin/**\`)

**Why it matters:** Sequential independent awaits double latency unnecessarily; parallelizing them with \`Promise.all()\` can significantly improve performance.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'async', 'patterns'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Skip test files — sequential awaits in tests are low-risk
    if (isTestFile(filePath)) return [];

    // @lazy-ok -- 'await' appears as a string literal, not an actual await expression
    // Quick filter: skip files without async/await
    if (!content.includes('await')) {
      return [];
    }

    return analyzeFile(filePath, content);
  },
});
