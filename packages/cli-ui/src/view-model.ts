/**
 * View-model — the renderer-agnostic vocabulary that decouples *what* a
 * command shows from *how* it is rendered.
 *
 * A `ViewNode` describes output as a tree of line-oriented blocks. Two
 * interpreters consume the same tree: `renderToInk` (TTY, themed) and
 * `renderToText` (pipe/CI, zero ANSI). Because each piece of output is
 * expressed once as a `ViewNode`, the interactive and non-interactive
 * forms cannot structurally drift — there is no second definition to fall
 * out of sync. This generalizes the existing `formatProjectHeader` +
 * `ProjectHeader` pattern (format once, render twice) to all CLI output.
 *
 * Deliberately NOT a general layout engine: there is no flexbox, no
 * multi-column flow beyond the simple `table` node. Keep it line-oriented;
 * if a node needs richer layout, that is a signal to reconsider rather
 * than to grow this vocabulary.
 *
 * This module is pure data + types. It must stay free of `ink`/`react`
 * imports so `renderToText` (and its consumers on the piped path) never
 * pull React into the process.
 */

/**
 * Semantic color intent. The Ink interpreter maps each tone onto a
 * `DEFAULT_THEME` token; the text interpreter ignores tones entirely. The
 * theme remains the single source of color truth — producers never name
 * raw colors.
 */
export type Tone = 'brand' | 'success' | 'error' | 'warning' | 'info' | 'muted' | 'default';

/** An inline run of text within a line, optionally toned, bold, and/or dimmed. */
export interface Span {
  readonly text: string;
  readonly tone?: Tone;
  readonly bold?: boolean;
  /** Render this span muted (Ink `dimColor`). Dropped by the text interpreter. */
  readonly dim?: boolean;
}

/** A single hint in a footer strip: its text and which substrings to bold. */
export interface HintItem {
  readonly text: string;
  readonly bold?: readonly string[];
}

/**
 * Block-level output node. The interpreters switch on `kind`; every kind
 * is total in both interpreters (no node may render in one and throw in
 * the other).
 */
export type ViewNode =
  /** One line of styled spans. `dim` renders the whole line muted. */
  | { readonly kind: 'line'; readonly spans: readonly Span[]; readonly dim?: boolean }
  /** A section heading (e.g. `== Findings ==`). */
  | { readonly kind: 'heading'; readonly text: string; readonly tone?: Tone }
  /** A block of `label: value` pairs, one per line. */
  | {
      readonly kind: 'keyValues';
      readonly pairs: readonly { readonly label: string; readonly value: string }[];
    }
  /**
   * A column-aligned table. Each row is a list of cell spans — one span per
   * column (cell N styles column N). Both interpreters render it identically in
   * the canonical pipe style: cells joined by ` | `, and (when the header
   * shows) a `-|-` rule beneath it. Every cell is padded to its column's width
   * — the max of the header, all cells, and the optional per-column `minWidths`
   * — so the grid lines up in a TTY and a pipe alike. `align` is per-column
   * (`'right'` pads on the left — for numeric/duration columns); default left.
   *
   * This is the ONE terminal table renderer (ADR-0058): every tool's results
   * table and every host list (sessions/tools/history) flows through here, so
   * tables cannot diverge in style. Producers supply data (cells + column
   * specs); the interpreters own all separators, padding, and the header rule.
   */
  | {
      readonly kind: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly Span[])[];
      readonly align?: readonly ('left' | 'right')[];
      /** Per-column minimum width (floor); actual width still grows to fit content. */
      readonly minWidths?: readonly number[];
      /** When false, suppress the header row + rule (a bare aligned grid). Default true. */
      readonly showHeader?: boolean;
    }
  /** A next-step hint strip, ` | `-joined, with bolded flag substrings. */
  | { readonly kind: 'hints'; readonly items: readonly HintItem[] }
  /** A horizontal rule. */
  | { readonly kind: 'separator' }
  /** A single blank line. */
  | { readonly kind: 'spacer' }
  /** A container; children render in order, optionally indented. */
  | { readonly kind: 'group'; readonly children: readonly ViewNode[]; readonly indent?: number };

// ---------------------------------------------------------------------------
// Constructor helpers — keep producers terse without hiding the data shape.
// ---------------------------------------------------------------------------

/** A line from plain text (single default-toned span). */
export function text(value: string): Span {
  return { text: value };
}

/** A line node from spans (or a single string). */
export function line(spans: readonly Span[] | string, dim?: boolean): ViewNode {
  const resolved = typeof spans === 'string' ? [text(spans)] : spans;
  return dim === undefined
    ? { kind: 'line', spans: resolved }
    : { kind: 'line', spans: resolved, dim };
}

/** A group node from children, optionally indented. */
export function group(children: readonly ViewNode[], indent?: number): ViewNode {
  return indent === undefined ? { kind: 'group', children } : { kind: 'group', children, indent };
}

/**
 * Per-column display widths for a `table` node — the max of each column's header
 * and all its cells. Shared by both interpreters so the TTY and pipe forms pad
 * identically. Pure (no react), so `render-to-text` can use it too.
 */
export function tableColumnWidths(
  columns: readonly string[],
  rows: readonly (readonly Span[])[],
  minWidths?: readonly number[],
): number[] {
  const colCount = Math.max(columns.length, ...rows.map((r) => r.length), 0);
  return Array.from({ length: colCount }, (_, i) =>
    Math.max(
      columns[i]?.length ?? 0,
      minWidths?.[i] ?? 0,
      ...rows.map((r) => r[i]?.text.length ?? 0),
      0,
    ),
  );
}

/** Pad `value` to `width`; `'right'` pads on the left (numeric/duration columns). */
export function padTableCell(value: string, width: number, align: 'left' | 'right'): string {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

/** Per-column spec for {@link viewTable}: a header label, alignment, min width. */
export interface TableColumnSpec {
  readonly header: string;
  readonly align?: 'left' | 'right';
  /** Minimum column width (floor); the column still widens to fit content. */
  readonly minWidth?: number;
}

/**
 * Build a column-aligned `table` node. Columns may be plain header strings or
 * {@link TableColumnSpec}s (to right-align numeric columns). Each row is one
 * span per column (cell N styles column N); the interpreters pad every cell to
 * its column width so the grid lines up in a TTY and a pipe. This is the shared,
 * reusable table primitive — producers (history, session replay, per-unit
 * results) build one of these instead of hand-padding lines.
 */
export function viewTable(
  columns: readonly (string | TableColumnSpec)[],
  rows: readonly (readonly Span[])[],
  opts?: { readonly showHeader?: boolean },
): ViewNode {
  const specs = columns.map((c) => (typeof c === 'string' ? { header: c } : c));
  const minWidths = specs.map((s) => s.minWidth ?? 0);
  return {
    kind: 'table',
    columns: specs.map((s) => s.header),
    rows,
    align: specs.map((s) => s.align ?? 'left'),
    ...(minWidths.some((w) => w > 0) ? { minWidths } : {}),
    ...(opts?.showHeader === undefined ? {} : { showHeader: opts.showHeader }),
  };
}
