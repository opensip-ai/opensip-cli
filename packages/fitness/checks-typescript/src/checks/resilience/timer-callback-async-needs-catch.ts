/**
 * timer-callback-async-needs-catch — flag fire-and-forget promise chains inside
 * a timer callback (`setInterval` / `setTimeout` / `setImmediate`) that lack a
 * `.catch` (or a two-argument `.then`).
 *
 * **Why:** a timer callback runs detached from any caller. If a promise it
 * starts rejects and nothing handles the rejection, Node treats it as an
 * unhandled rejection and (by default, Node 15+) **terminates the host
 * process**. A `setInterval` heartbeat that crashes the process is exactly the
 * class of bug that produces a bare `ELIFECYCLE` / worker crash with no
 * assertion.
 *
 * **The gap this closes:** ESLint's `no-floating-promises` treats a leading
 * `void` as an explicit opt-out, and the sibling `detached-promises` check
 * treats `.finally` as "handled" — so `void p.finally(...)` slips through both
 * even though `.finally` re-throws a rejection. This check is scoped to timer
 * callbacks (high signal, where an unhandled rejection is fatal) and, unlike
 * those, does NOT accept `void` or `.finally` as sufficient — only a real
 * rejection handler (`.catch`, or `.then(onFulfilled, onRejected)`) counts.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** Detached async schedulers whose callback runs with no caller to catch a rejection. */
const TIMER_NAMES = new Set(['setInterval', 'setTimeout', 'setImmediate']);

/** True when `expr`'s outermost call is a promise-chain method (`.then`/`.catch`/`.finally`). */
function isPromiseChain(expr: ts.Expression): expr is ts.CallExpression {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    (expr.expression.name.text === 'then' ||
      expr.expression.name.text === 'catch' ||
      expr.expression.name.text === 'finally')
  );
}

/**
 * Walk the promise-method chain from the outside in; true if any link actually
 * handles a rejection — a `.catch(...)` or a `.then(onFulfilled, onRejected)`.
 * A `.finally(...)` does NOT count (it re-throws).
 */
function chainHasRejectionHandler(expr: ts.Expression): boolean {
  let cursor: ts.Expression = expr;
  while (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
    const method = cursor.expression.name.text;
    if (method === 'catch') return true;
    if (method === 'then' && cursor.arguments.length >= 2) return true;
    cursor = cursor.expression.expression;
  }
  return false;
}

/**
 * If `expr` (optionally wrapped in `void`) is a promise chain with no rejection
 * handler, return the offending chain expression; otherwise `undefined`.
 */
function unguardedPromiseChain(expr: ts.Expression): ts.Expression | undefined {
  const inner = ts.isVoidExpression(expr) ? expr.expression : expr;
  if (!isPromiseChain(inner)) return undefined;
  if (chainHasRejectionHandler(inner)) return undefined;
  return inner;
}

/** The callback body of a `setInterval`/`setTimeout`/`setImmediate(fn, …)` call, if `fn` is inline. */
function timerCallbackBody(call: ts.CallExpression): ts.ConciseBody | undefined {
  if (!ts.isIdentifier(call.expression) || !TIMER_NAMES.has(call.expression.text)) return undefined;
  const callback = call.arguments[0];
  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    return callback.body;
  }
  return undefined;
}

function record(
  chain: ts.Expression,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: CheckViolation[],
): void {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(chain.getStart(sourceFile));
  violations.push({
    line: line + 1,
    column: character + 1,
    message:
      'Fire-and-forget promise in a timer callback has no `.catch` — a rejection here crashes the process',
    severity: 'warning',
    type: 'timer-async-uncaught',
    suggestion:
      'Add a `.catch` (a `.finally` does not handle rejections, and `void` only silences the linter). ' +
      'A timer callback runs detached, so an unhandled rejection terminates the host process.',
    match: chain.getText(sourceFile).slice(0, 200),
    filePath,
  });
}

/** Scan one timer callback body (not descending into nested function scopes). */
function scanCallbackBody(
  body: ts.ConciseBody,
  sourceFile: ts.SourceFile,
  filePath: string,
  violations: CheckViolation[],
): void {
  // Expression-bodied arrow: `setInterval(() => p.finally(…), t)` — the returned
  // promise is dropped by the timer, so it is fire-and-forget too.
  if (!ts.isBlock(body)) {
    const chain = unguardedPromiseChain(body);
    if (chain) record(chain, sourceFile, filePath, violations);
    return;
  }
  const visit = (node: ts.Node): void => {
    // A nested function is its own async context — do not attribute it to this timer.
    if (
      node !== body &&
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
    ) {
      return;
    }
    if (ts.isVoidExpression(node)) {
      const chain = unguardedPromiseChain(node);
      if (chain) record(chain, sourceFile, filePath, violations);
    } else if (ts.isExpressionStatement(node) && !ts.isVoidExpression(node.expression)) {
      const chain = unguardedPromiseChain(node.expression);
      if (chain) record(chain, sourceFile, filePath, violations);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

/** Direct detection entry (no test-file skip) — exported for unit tests. */
export function analyzeTimerCallbacks(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const body = timerCallbackBody(node);
        if (body) scanCallbackBody(body, sourceFile, filePath, violations);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  } catch {
    // @swallow-ok Skip files that fail to parse; other checks report parse errors.
  }
  return violations;
}

export const timerCallbackAsyncNeedsCatch = defineCheck({
  id: '8f1c6d2a-4e7b-4a3c-9d5e-2b6f0a1c8e7d',
  slug: 'timer-callback-async-needs-catch',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'cli'],
  },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description:
    'Timer-callback promises must have a `.catch` (an unhandled rejection on a timer crashes the process)',
  longDescription: `**Purpose:** Prevent unhandled promise rejections inside \`setInterval\` / \`setTimeout\` / \`setImmediate\` callbacks, which terminate the host process (Node 15+).

**Detects:** a fire-and-forget promise chain in a timer callback — \`void p.finally(...)\`, \`p.then(...)\`, an expression-bodied \`() => p.finally(...)\`, etc. — whose chain contains no real rejection handler (a \`.catch\`, or a two-argument \`.then\`).

**Why the existing guardrails miss it:** ESLint's \`no-floating-promises\` accepts a leading \`void\`, and the \`detached-promises\` check treats \`.finally\` as "handled". A \`.finally\` re-throws, so \`void p.finally(...)\` slips through both while still being able to crash the process.

**Fix:** add a \`.catch\` at the timer boundary (swallow or log). A \`.finally\` may still reset state, but it must not be the only handler.

**Scope:** inline timer callbacks only; per-file TypeScript AST parsing.`,
  tags: ['resilience', 'async', 'promises'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return [];
    return analyzeTimerCallbacks(content, filePath);
  },
});
