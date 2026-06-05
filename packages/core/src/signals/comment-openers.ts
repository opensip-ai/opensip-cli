/**
 * @fileoverview Shared comment-opener table for inline-directive scanning.
 *
 * The kernel home (ADR-0014) of the comment-opener prefixes the inline
 * suppression scanner recognizes. Fitness's directive parsers re-export this
 * table so there is a single source of truth across the platform — the two
 * lists historically drifted (the suppression parser recognized `//`, `/*`,
 * `<!--`, and `#` while the inventory only recognized `//` and `/*`), causing
 * HTML/hash-style directives to suppress findings yet vanish from the
 * inventory. One table prevents that.
 *
 * Tuple shape: `[opener, length]`. The length is encoded once so scanners
 * don't repeat it per opener — `<!--` is 4 chars; the others are 1 or 2.
 */

/**
 * Comment-opener prefixes the directive scanner recognizes:
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
] as const;

/**
 * Strip a comment opener from the start of a (trimmed) line. Returns `null`
 * when the line doesn't start with any known opener.
 */
export function stripCommentOpener(trimmedLine: string): string | null {
  for (const [opener, length] of COMMENT_OPENERS) {
    if (trimmedLine.startsWith(opener)) {
      return trimmedLine.slice(length);
    }
  }
  return null;
}
