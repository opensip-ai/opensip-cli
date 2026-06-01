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
export type Tone =
  | 'brand'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'muted'
  | 'default';

/** An inline run of text within a line, optionally toned and/or bold. */
export interface Span {
  readonly text: string;
  readonly tone?: Tone;
  readonly bold?: boolean;
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
  /** A simple column-aligned table. Each row is a list of cell spans. */
  | {
      readonly kind: 'table';
      readonly columns: readonly string[];
      readonly rows: readonly (readonly Span[])[];
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
  return dim === undefined ? { kind: 'line', spans: resolved } : { kind: 'line', spans: resolved, dim };
}

/** A group node from children, optionally indented. */
export function group(children: readonly ViewNode[], indent?: number): ViewNode {
  return indent === undefined ? { kind: 'group', children } : { kind: 'group', children, indent };
}
