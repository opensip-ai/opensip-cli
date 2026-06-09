/**
 * renderToText — the non-interactive interpreter.
 *
 * Walks a `ViewNode` and returns a plain string for pipes, CI logs, and
 * `> file` redirection. It drops `Tone`, `bold`, and `dim` entirely: the
 * output carries no styling channel at all, which is stronger than
 * `NO_COLOR` (that only zeroes theme colors). The guarantee this module
 * upholds — and that its tests assert for every node kind — is that the
 * output never contains an ANSI escape sequence.
 *
 * Pure string work; no `ink`/`react` import, so the piped path stays
 * React-free (mirrors the cold-start discipline in the CLI render seam).
 *
 * Returns no trailing newline — the caller (the render seam) owns the
 * final line break, matching how the Ink path appends one.
 */

import { padTableCell, tableColumnWidths } from './view-model.js';

import type { HintItem, Span, ViewNode } from './view-model.js';

const SEPARATOR_WIDTH = 60;

function spansToText(spans: readonly Span[]): string {
  return spans.map((s) => s.text).join('');
}

function hintsToText(items: readonly HintItem[]): string {
  // Two-space indent + " | "-joined, matching the RunFooterHints strip.
  // Bold substrings are a styling concern and carry no plain-text marker.
  return `  ${items.map((h) => h.text).join(' | ')}`;
}

/**
 * Column-aligned table rendering: every cell is padded to its column width
 * (shared `tableColumnWidths`, so the pipe form lines up exactly as the TTY
 * form). Trailing whitespace is trimmed to keep the ANSI-free output clean.
 */
function tableToText(
  columns: readonly string[],
  rows: readonly (readonly Span[])[],
  align: readonly ('left' | 'right')[] | undefined,
  showHeader: boolean,
): string {
  const widths = tableColumnWidths(columns, rows);
  const alignOf = (i: number): 'left' | 'right' => align?.[i] ?? 'left';
  const renderRow = (cells: readonly { text: string }[]): string =>
    widths.map((w, i) => padTableCell(cells[i]?.text ?? '', w, alignOf(i))).join('  ').trimEnd();
  const lines = showHeader ? [renderRow(columns.map((c) => ({ text: c })))] : [];
  for (const cells of rows) lines.push(renderRow(cells));
  return lines.join('\n');
}

function indentLines(block: string, by: number): string {
  if (by <= 0) return block;
  const pad = ' '.repeat(by);
  return block
    .split('\n')
    .map((l) => (l.length > 0 ? pad + l : l))
    .join('\n');
}

/**
 * Render a view-model node to a plain string (no ANSI, no styling). The
 * non-interactive counterpart to {@link renderToInk}; both consume the
 * same `ViewNode`, so the piped and TTY forms cannot drift.
 */
export function renderToText(node: ViewNode): string {
  switch (node.kind) {
    case 'line': {
      return spansToText(node.spans);
    }
    case 'heading': {
      return `== ${node.text} ==`;
    }
    case 'keyValues': {
      return node.pairs.map((p) => `${p.label}: ${p.value}`).join('\n');
    }
    case 'table': {
      return tableToText(node.columns, node.rows, node.align, node.showHeader !== false);
    }
    case 'hints': {
      return hintsToText(node.items);
    }
    case 'separator': {
      return '─'.repeat(SEPARATOR_WIDTH);
    }
    case 'spacer': {
      return '';
    }
    case 'group': {
      return indentLines(node.children.map(renderToText).join('\n'), node.indent ?? 0);
    }
  }
}
