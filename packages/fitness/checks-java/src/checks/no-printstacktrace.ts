/**
 * @fileoverview Flag uses of `Throwable.printStackTrace()`.
 *
 * `e.printStackTrace()` writes to stderr, bypassing the application's
 * logging framework. Stack traces emitted that way miss correlation
 * IDs, log levels, and structured fields, and they typically don't
 * land in centralized log aggregation. Always log via the configured
 * logger (SLF4J/Log4j/etc.) and pass the throwable as the cause.
 *
 * The check uses the `strip-strings-and-comments` content filter so
 * the literal token "printStackTrace()" inside a string literal or
 * comment isn't reported.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const PRINT_STACK_TRACE_PATTERN = /\.\s*printStackTrace\s*\(\s*\)/g;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that
 * requires an ExecutionContext to invoke).
 */
export function analyzePrintStackTrace(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  let line = 1;
  let lineCursor = 0;
  PRINT_STACK_TRACE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRINT_STACK_TRACE_PATTERN.exec(content)) !== null) {
    let newline = content.indexOf('\n', lineCursor);
    while (newline !== -1 && newline < match.index) {
      line++;
      lineCursor = newline + 1;
      newline = content.indexOf('\n', lineCursor);
    }
    violations.push({
      message: 'e.printStackTrace() bypasses the logging framework — use a logger instead',
      severity: 'warning',
      line,
      suggestion: 'Replace with logger.error("...", e) so the trace lands in centralized logs',
    });
  }
  return violations;
}

export const noPrintStackTrace = defineCheck({
  id: '269ee25e-926d-4b0d-b105-ebd1019d1242',
  slug: 'java-no-print-stack-trace',
  description: 'e.printStackTrace() bypasses the logging framework — use a logger instead',
  scope: { languages: ['java'], concerns: [] },
  tags: ['quality', 'observability', 'java'],
  // Strip strings AND comments so the literal token inside a docstring
  // or example comment isn't false-flagged.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content) => analyzePrintStackTrace(content),
});
