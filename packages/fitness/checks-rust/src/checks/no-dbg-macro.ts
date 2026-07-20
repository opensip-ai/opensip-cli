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
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

// Matches `dbg!(` / `dbg![` / `dbg!{` — Rust macros accept any of the
// three delimiter pairs, with whitespace allowed between tokens. The
// XID_Continue guard follows Rust's Unicode identifier grammar so a custom
// macro such as `λdbg!()` is not mistaken for `dbg!()`. Requiring an opening
// delimiter after `!` keeps the `dbg != foo` operator case out.
const DBG_MACRO_PATTERN = /(?<!\p{XID_Continue})dbg\s*!\s*[([{]/gu;

/**
 * Pure analysis function. Exported so unit tests can exercise the
 * detection logic without standing up the full Check framework.
 */
export function analyzeDbgMacro(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  let line = 1;
  let cursor = 0;
  for (const match of content.matchAll(DBG_MACRO_PATTERN)) {
    const matchIndex = match.index;
    while (cursor < matchIndex) {
      if (content.codePointAt(cursor) === 10) line++;
      cursor++;
    }
    violations.push({
      message: "dbg!() is a debug-only macro and shouldn't ship",
      severity: 'warning',
      line,
      suggestion: 'Remove the dbg!() call or replace it with a structured log statement',
    });
  }
  return violations;
}

export const noDbgMacro = defineCheck({
  id: '1df601d7-ee5c-4ac2-8bd6-3a50b358e700',
  slug: 'rust-no-dbg-macro',
  description: "dbg!() is a debug-only macro and shouldn't ship",
  scope: { languages: ['rust'], concerns: [] },
  tags: ['quality', 'observability', 'rust'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content) => analyzeDbgMacro(content),
});
