/**
 * @fileoverview Flag direct fmt.Print/Println/Printf calls.
 *
 * fmt.Print* writes unstructured output to stdout, bypassing the
 * structured logger. Production Go services should use a logger
 * (slog, zap, zerolog, etc.) so log records carry context, levels,
 * and machine-parseable fields.
 *
 * Uses the language adapter's `strip-strings-and-comments` filter so
 * the literal string `"fmt.Println("` inside a doc-string or comment
 * doesn't false-fire.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const FMT_PRINT_PATTERN = /\bfmt\.(Print|Println|Printf)\s*\(/g;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework
 * (defineCheck wraps `analyze` into an `execute` closure that
 * requires an ExecutionContext to invoke).
 */
export function analyzeFmtPrint(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line_] of lines.entries()) {
    const line = line_;
    let match: RegExpExecArray | null;
    FMT_PRINT_PATTERN.lastIndex = 0;
    while ((match = FMT_PRINT_PATTERN.exec(line)) !== null) {
      const method = match[1];
      violations.push({
        message: `fmt.${method} bypasses the structured logger and shouldn't ship`,
        severity: 'warning',
        line: i + 1,
        suggestion: 'Use the structured logger (slog, zap, zerolog) instead of fmt.Print*',
      });
    }
  }
  return violations;
}

export const noFmtPrint = defineCheck({
  id: '438e1324-0a85-4c21-a405-79bb12cfcf6e',
  slug: 'go-no-fmt-print',
  description: "fmt.Print/Println/Printf bypass the structured logger and shouldn't ship",
  scope: { languages: ['go'], concerns: [] },
  tags: ['quality', 'observability', 'go'],
  // strip-strings-and-comments so a literal "fmt.Println(" embedded in a
  // docstring or comment does not false-fire.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content) => analyzeFmtPrint(content),
});
