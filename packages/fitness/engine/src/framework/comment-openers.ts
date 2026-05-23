/**
 * @fileoverview Shared comment-opener table for directive parsing
 *
 * Both `directive-parsing.ts` (the suppression scanner) and
 * `directive-inventory.ts` (the inventory walker) used to maintain
 * their own list of comment opener prefixes. The two lists drifted —
 * the suppression parser recognized `//`, `/*`, `<!--`, and `#` while
 * the inventory only recognized `//` and `/* `. The result was that
 * HTML and hash-style directives correctly suppressed findings but
 * silently vanished from the inventory.
 *
 * This module is the single source of truth. Adding a new opener (e.g.
 * `--` for SQL) means editing one table.
 *
 * Tuple shape: `[opener, length]`. The length is encoded once so
 * scanners don't repeat it per opener — `<!--` is 4 chars; the others
 * are 1 or 2.
 */

/**
 * Comment-opener prefixes the directive parsers recognize:
 *
 *   - `//`   — TypeScript / JavaScript / C-family
 *   - `/* `  — same family, block form
 *   - `<!--` — Markdown / HTML doc files (READMEs, arch docs)
 *   - `#`    — shell / YAML / Python configs and scripts
 */
export const COMMENT_OPENERS: readonly (readonly [string, number])[] = [
  ['//', 2],
  ['/*', 2],
  ['<!--', 4],
  ['#', 1],
] as const

/**
 * Strip a comment opener from the start of a (trimmed) line. Returns
 * `null` when the line doesn't start with any known opener.
 *
 * Used by the directive inventory to normalize "the part of the line
 * after the comment marker" before checking for a `@fitness-ignore-*`
 * directive keyword.
 */
export function stripCommentOpener(trimmedLine: string): string | null {
  for (const [opener, length] of COMMENT_OPENERS) {
    if (trimmedLine.startsWith(opener)) {
      return trimmedLine.slice(length)
    }
  }
  return null
}
