/**
 * @fileoverview Shared per-line template-literal boundary scanner for
 * regex-based checks that need to skip content inside multi-line template
 * literals while still scanning real code on the line that opens or closes
 * one.
 *
 * A line with an odd unescaped-backtick count changes template state
 * mid-line (the template opens or closes on that line) — code before the
 * opening backtick, or after the closing backtick, is still real code and
 * must be scanned; the rest of the line is template content and must not
 * be. Treating the whole line as one state (as a bare "toggle and skip if
 * even" check does) misses that split and either scans template contents
 * as code, or skips real code that shares a line with a template boundary.
 */

export interface LineTemplateLiteralSegment {
  /** The portion of the line that is NOT inside a template literal. */
  readonly text: string;
  /** The character offset of `text` within the original line. */
  readonly offset: number;
}

export interface LineTemplateLiteralScan {
  /** Zero or more non-template-literal segments of the line, in order. */
  readonly segments: readonly LineTemplateLiteralSegment[];
  /** Whether the line ends inside a template literal (state for the next line). */
  readonly inTemplateLiteral: boolean;
}

/**
 * Splits `line` into the segments that fall outside a template literal,
 * given whether the scan already started the line inside one. Only
 * unescaped backticks (not preceded by an odd run of backslashes) toggle
 * the template state, matching `countUnescapedBackticks`.
 */
export function scanLineOutsideTemplateLiteral(
  line: string,
  startInTemplateLiteral: boolean,
): LineTemplateLiteralScan {
  const segments: LineTemplateLiteralSegment[] = [];
  let inTemplateLiteral = startInTemplateLiteral;
  let cursor = 0;

  for (let ci = 0; ci < line.length; ci++) {
    if (line[ci] !== '`') continue;
    let backslashes = 0;
    for (let j = ci - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 !== 0) continue;

    if (!inTemplateLiteral) segments.push({ text: line.slice(cursor, ci), offset: cursor });
    inTemplateLiteral = !inTemplateLiteral;
    cursor = ci + 1;
  }

  if (!inTemplateLiteral) segments.push({ text: line.slice(cursor), offset: cursor });

  return { segments, inTemplateLiteral };
}
