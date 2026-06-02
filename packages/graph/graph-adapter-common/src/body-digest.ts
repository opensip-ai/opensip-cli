/**
 * Shared body-digest leaf primitives.
 *
 * The per-language comment strippers (`stripGoComments`,
 * `stripRustComments` with nested block comments + char-vs-lifetime
 * heuristic, `stripPythonComments` + docstring strip, Java's stripper)
 * stay in each adapter's `body-digest.ts` — they are genuinely
 * language-specific. Only the byte-identical `skipToEndOfLine` primitive
 * (scan from `start` to the next newline) is shared here; each adapter's
 * `digestXBody = hashBody(normalizeWhitespace(stripXComments(text)))`
 * wiring and its `digestSyntheticBody` alias remain adapter-owned.
 */

/** Advance from `start` to the index of the next `\n` (or end of text). */
export function skipToEndOfLine(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

/**
 * Skip a NON-nesting C-style block comment: from `start` (just past the
 * opening `/*`), scan to and past the first `*\/`. Returns the index
 * immediately after the closing delimiter, or end-of-text if unterminated.
 *
 * This is the Go / Java / C-style form, where block comments do NOT nest.
 * Languages whose block comments DO nest (e.g. Rust's `/* /* *\/ *\/`)
 * need their own depth-tracking variant and must not use this one.
 */
export function skipBlockComment(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (text.slice(i, i + 2) === '*/') return i + 2;
    i++;
  }
  /* v8 ignore next */
  return i;
}
