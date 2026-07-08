import { safeParseJson } from './ingest-json.js';

/** One successfully parsed JSONL record: its 1-based source line and decoded value. */
export interface JsonLine {
  readonly line: number;
  readonly value: unknown;
}

/**
 * A JSONL line that failed to decode: its 1-based source line, the parse error
 * message, and a length-capped preview of the offending text.
 */
export interface JsonLineParseError {
  readonly line: number;
  readonly message: string;
  readonly preview: string;
}

/** The outcome of parsing a JSONL blob: the decoded values and any per-line parse errors. */
export interface JsonLinesResult {
  readonly values: readonly JsonLine[];
  readonly errors: readonly JsonLineParseError[];
}

/**
 * Options for {@link parseJsonLines}. `tolerateNonJson` silently skips non-empty
 * lines that don't start with `{` or `[` (e.g. log preamble) instead of
 * recording them as errors; `maxPreviewChars` caps the error preview length
 * (default 160).
 */
export interface ParseJsonLinesOptions {
  readonly tolerateNonJson?: boolean;
  readonly maxPreviewChars?: number;
}

function preview(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max)}...`;
}

/**
 * Parse newline-delimited JSON (`\n` or `\r\n`), decoding each non-blank line
 * independently. Blank lines are skipped; a bad line becomes a
 * {@link JsonLineParseError} rather than aborting the whole parse, so a single
 * malformed record never discards the rest.
 */
export function parseJsonLines(raw: string, opts: ParseJsonLinesOptions = {}): JsonLinesResult {
  const maxPreviewChars = opts.maxPreviewChars ?? 160;
  const values: JsonLine[] = [];
  const errors: JsonLineParseError[] = [];
  const lines = raw.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = safeParseJson(trimmed);
    if (parsed.ok) {
      values.push({ line: index + 1, value: parsed.value });
      continue;
    }
    if (opts.tolerateNonJson === true && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      continue;
    }
    errors.push({
      line: index + 1,
      message: parsed.error,
      preview: preview(trimmed, maxPreviewChars),
    });
  }
  return { values, errors };
}
