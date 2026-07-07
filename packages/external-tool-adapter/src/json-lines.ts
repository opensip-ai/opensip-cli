import { safeParseJson } from './ingest-json.js';

export interface JsonLine {
  readonly line: number;
  readonly value: unknown;
}

export interface JsonLineParseError {
  readonly line: number;
  readonly message: string;
  readonly preview: string;
}

export interface JsonLinesResult {
  readonly values: readonly JsonLine[];
  readonly errors: readonly JsonLineParseError[];
}

export interface ParseJsonLinesOptions {
  readonly tolerateNonJson?: boolean;
  readonly maxPreviewChars?: number;
}

function preview(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max)}...`;
}

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
