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

/**
 * Advance past one character inside a quoted string, honouring backslash escapes
 * so `\"` / `\'` do not end the string early (M6).
 * Returns the next index and whether the string closed.
 */
function advanceInQuotedString(
  line: string,
  i: number,
  quote: string,
): { next: number; closed: boolean } {
  const ch = line[i];
  // M6: honour backslash escapes so an escaped quote cannot end the string early
  // (regression covered in suppress.test — escaped-quote mid-string cases).
  if (ch === '\\' && i + 1 < line.length) {
    return { next: i + 2, closed: false };
  }
  if (ch === quote) {
    return { next: i + 1, closed: true };
  }
  return { next: i + 1, closed: false };
}

/**
 * Find the first comment opener that is not inside a string literal.
 * This prevents matching `//` inside "http://..." or "foo//bar" or directives
 * hidden inside string literals (false positives) and ensures trailing
 * directives after code-with-embedded-// are found (false negatives).
 */
export function findFirstRealCommentOpener(line: string): { index: number; length: number } | null {
  let i = 0;
  const len = line.length;
  let inString: string | null = null; // ' or "
  while (i < len) {
    const ch = line[i];
    if (inString) {
      const stepped = advanceInQuotedString(line, i, inString);
      if (stepped.closed) inString = null;
      i = stepped.next;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      i++;
      continue;
    }
    // check for openers
    for (const [opener, length] of COMMENT_OPENERS) {
      if (line.startsWith(opener, i)) {
        return { index: i, length };
      }
    }
    i++;
  }
  return null;
}

/**
 * Text after the first REAL comment opener on `line` (the same string-aware
 * scan the suppression matcher uses), or `null` when the line has no comment.
 * Exported so directive-audit reconstructions (fitness's `appliedDirectives`
 * inventory) recognize exactly the set of directives the suppressor honours —
 * including trailing comments after code, which a start-of-line-only parse
 * misses.
 */
export function commentTextAfterOpener(line: string): string | null {
  const openerHit = findFirstRealCommentOpener(line);
  if (!openerHit) return null;
  return line.slice(openerHit.index + openerHit.length);
}
