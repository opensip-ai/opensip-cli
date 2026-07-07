/**
 * ResultSummary — the shared 3-way (pass / fail / fault) result block used by
 * every run surface: a single-tool run (fit / graph / sim), a suite aggregate,
 * and third-party tools. It is the display face of the one verdict source of
 * truth (`deriveOutcome` in contracts): a `faulted` outcome — a RUNTIME error, a
 * unit that threw — is shown distinctly from a `failed` findings result, so a
 * crash never masquerades as "the code failed the gate".
 *
 * The block is two parts (ADR — Phase B fault taxonomy):
 *   1. a count line — `{p}/{n} passed · {f}/{n} failed · {x}/{n} faulted`
 *   2. a bulleted per-item list — one glyph-led line per item.
 *
 * The bullet list honours a filter (Option C): by default only the items that
 * need attention (failed + faulted) are listed, with the full per-item list
 * behind `showAll` (a suite always lists every step; a single run lists every
 * unit under `--verbose`). When nothing needs attention the block says so
 * instead of rendering an empty list.
 *
 * Like {@link viewRunSummary} this lives once as a renderer-agnostic view-model
 * producer so the Ink (TTY) and text (pipe/CI) interpreters cannot drift, and it
 * stays free of `contracts` imports (cli-ui is layer 2) — the CLI maps
 * contracts' `RunOutcome` onto {@link ResultOutcome} at the render boundary.
 */

import { group, line, type Span, type Tone, type ViewNode } from './view-model.js';

/**
 * A run/step/unit outcome for display. Mirrors contracts' `RunOutcome`,
 * redeclared locally because cli-ui (layer 2) must not import contracts.
 */
export type ResultOutcome = 'passed' | 'failed' | 'faulted';

/** One row of the bulleted result list. */
export interface ResultSummaryItem {
  /** Display label — a step's `tool command`, or a unit's slug. */
  readonly label: string;
  readonly outcome: ResultOutcome;
  /** Optional trailing detail: a location, a fault message, or a count note. */
  readonly detail?: string;
}

export interface ResultSummaryProps {
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly faulted: number;
  };
  readonly items: readonly ResultSummaryItem[];
  /**
   * When false (default) only failed + faulted items are listed — the
   * attention-only view (Option C). When true every item is listed (a suite's
   * all-steps view, or a single run under `--verbose`).
   */
  readonly showAll?: boolean;
}

const OUTCOME_TONE: Record<ResultOutcome, Tone> = {
  passed: 'success',
  failed: 'error',
  faulted: 'warning',
};

const OUTCOME_GLYPH: Record<ResultOutcome, string> = {
  passed: '✓',
  failed: '✗',
  faulted: '⚠',
};

const OUTCOME_WORD: Record<ResultOutcome, string> = {
  passed: 'pass',
  failed: 'fail',
  faulted: 'fault',
};

/** `{p}/{n} passed · {f}/{n} failed · {x}/{n} faulted` — each fraction toned only when nonzero. */
function countLine(counts: ResultSummaryProps['counts'], total: number): ViewNode {
  const fraction = (value: number, word: string, tone: Tone): Span => ({
    text: `${value}/${total} ${word}`,
    tone: value > 0 ? tone : 'muted',
  });
  const dot: Span = { text: ' · ', dim: true };
  const spans: Span[] = [
    fraction(counts.passed, 'passed', 'success'),
    dot,
    fraction(counts.failed, 'failed', 'error'),
    dot,
    fraction(counts.faulted, 'faulted', 'warning'),
  ];
  // Name the fault class so `faulted` reads as "result unknown", not "gate fail".
  if (counts.faulted > 0) spans.push({ text: ' (runtime error)', dim: true });
  return line(spans);
}

/** `{glyph} {label}  {word}  {detail}` — one bullet, toned by outcome. */
function itemLine(item: ResultSummaryItem): ViewNode {
  const tone = OUTCOME_TONE[item.outcome];
  const spans: Span[] = [
    { text: OUTCOME_GLYPH[item.outcome], tone },
    { text: ` ${item.label}` },
    { text: `  ${OUTCOME_WORD[item.outcome]}`, tone },
  ];
  if (item.detail !== undefined && item.detail !== '') {
    spans.push({ text: `  ${item.detail}`, dim: true });
  }
  return line(spans);
}

/**
 * The canonical result block as a renderer-agnostic view-model node: a count
 * line followed by the (optionally filtered) per-item bullets. See the module
 * header for the format and the {@link ResultSummaryProps.showAll} filter.
 */
export function viewResultSummary(props: ResultSummaryProps): ViewNode {
  const { passed, failed, faulted } = props.counts;
  const total = passed + failed + faulted;
  const shown =
    props.showAll === true ? props.items : props.items.filter((item) => item.outcome !== 'passed');

  const children: ViewNode[] = [countLine(props.counts, total)];
  for (const item of shown) children.push(itemLine(item));
  // Attention-only view with nothing to flag: say so rather than render blank.
  if (shown.length === 0 && props.items.length > 0) {
    children.push(line([{ text: 'All passed — nothing to flag.', tone: 'success' }]));
  }
  return group(children);
}
