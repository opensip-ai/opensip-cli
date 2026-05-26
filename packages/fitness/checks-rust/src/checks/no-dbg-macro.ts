/**
 * @fileoverview Flag dbg!() macro invocations.
 *
 * dbg!() is Rust's quick-debug macro — it prints expression and value
 * to stderr and is meant for interactive debugging, not production
 * code. Leftover dbg!() calls add unstructured stderr noise that
 * bypasses any logging discipline a service has.
 *
 * Uses the language adapter's `strip-strings-and-comments` filter so
 * the literal string `"dbg!("` inside a comment, regular string, or
 * raw string (e.g. `r#"dbg!(x)"#`) doesn't false-fire.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

// Matches `dbg!(` / `dbg![` / `dbg!{` — Rust macros accept any of the
// three delimiter pairs. `\b` anchors so `xdbg!(...)` doesn't match.
// Whitespace between `dbg` and `!` is technically legal but vanishingly
// rare in practice, so we require them adjacent to avoid the
// `dbg != foo` (binary !=) false-positive trap.
const DBG_MACRO_PATTERN = /\bdbg!\s*[([{]/g

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework.
 */
export function analyzeDbgMacro(content: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')
  for (const [i, line] of lines.entries()) {
    const matches = line.match(DBG_MACRO_PATTERN)
    if (!matches) continue
    violations.push(
      ...matches.map(() => ({
        message: "dbg!() is a debug-only macro and shouldn't ship",
        severity: 'warning' as const,
        line: i + 1,
        suggestion: 'Remove the dbg!() call or replace it with a structured log statement',
      })),
    )
  }
  return violations
}

export const noDbgMacro = defineCheck({
  id: 'e2f3a4b5-1234-4321-eeee-500000000001',
  slug: 'rust-no-dbg-macro',
  description: "dbg!() is a debug-only macro and shouldn't ship",
  scope: { languages: ['rust'], concerns: [] },
  tags: ['quality', 'observability', 'rust'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content) => analyzeDbgMacro(content),
})
