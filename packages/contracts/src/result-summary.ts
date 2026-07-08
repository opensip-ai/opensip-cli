/**
 * Project a run {@link SignalEnvelope} onto the attention-only result summary —
 * the 3-way unit counts + one item per unit that both the static render
 * (`result-to-view`) and the live done-body (`cli-live`) turn into the shared
 * `viewResultSummary` block. It lives in `contracts` (beside {@link deriveOutcome}
 * and {@link buildSignalEnvelope}) because the derivation is envelope SEMANTICS,
 * not styling: it yields DATA (label, outcome, a compact detail string), and the
 * UI layer owns the glyphs/tones. Keeping it here lets the engine live runners
 * (layer 4) and the cli composition root (layer 6) share one derivation without a
 * same-layer import.
 *
 * Granularity is UNIT-centric (one item per check/rule/scenario), so the count
 * line and bullets both count units and line up. A failing unit's detail is its
 * finding LOCATIONS (`file:line`); a faulted unit's detail is its runtime error
 * message (the check that threw, named). A run that faults at the RUN level (the
 * tool itself failing to load/parse) never reaches here — ADR-0060 makes that a
 * command-error before the envelope.
 */

import { deriveOutcome, type RunOutcome } from './run-outcome.js';

import type { SignalEnvelope, UnitResult } from './signal-envelope.js';

/** How many finding locations to list inline on a failing unit before eliding. */
const MAX_INLINE_LOCATIONS = 2;

/** A unit's 3-way outcome: a per-unit `error` is a fault; otherwise pass/fail from `passed`. */
export function unitOutcome(unit: UnitResult): RunOutcome {
  return deriveOutcome({ passed: unit.passed, faulted: unit.error !== undefined });
}

/**
 * The distinct finding locations a unit produced (`filePath[:line]`), compacted
 * to one line: the first {@link MAX_INLINE_LOCATIONS}, then `(+N more)`. A signal
 * belongs to a unit when `signal.source === unit.slug` (the same grouping the
 * per-unit table uses). `undefined` when the unit produced no locatable findings.
 */
function unitLocations(envelope: SignalEnvelope, slug: string): string | undefined {
  const locations: string[] = [];
  const seen = new Set<string>();
  for (const signal of envelope.signals) {
    if (signal.source !== slug) continue;
    const loc = signal.line === undefined ? signal.filePath : `${signal.filePath}:${signal.line}`;
    if (loc === '' || seen.has(loc)) continue;
    seen.add(loc);
    locations.push(loc);
  }
  if (locations.length === 0) return undefined;
  const head = locations.slice(0, MAX_INLINE_LOCATIONS).join(', ');
  const extra = locations.length - MAX_INLINE_LOCATIONS;
  return extra > 0 ? `${head} (+${extra} more)` : head;
}

function unitDetail(
  envelope: SignalEnvelope,
  unit: UnitResult,
  outcome: RunOutcome,
): string | undefined {
  if (outcome === 'faulted') return unit.error;
  if (outcome === 'failed') return unitLocations(envelope, unit.slug);
  return undefined;
}

/** One row of the attention list — the data a `viewResultSummary` bullet renders. */
export interface ResultSummaryItem {
  readonly label: string;
  readonly outcome: RunOutcome;
  readonly detail?: string;
}

/**
 * The attention-only projection of a run envelope: the 3-way unit counts
 * (passed/failed/faulted) plus one {@link ResultSummaryItem} per unit. Both the
 * static render and the live done-body turn this into the shared
 * `viewResultSummary` block.
 */
export interface EnvelopeResultSummary {
  readonly counts: { readonly passed: number; readonly failed: number; readonly faulted: number };
  readonly items: readonly ResultSummaryItem[];
}

/**
 * Project the envelope onto {@link EnvelopeResultSummary}: 3-way unit counts and
 * one item per unit. Returns `undefined` when nothing needs attention (no failed
 * and no faulted units) — the caller keeps the compact headline-only surface.
 */
export function envelopeToResultSummary(
  envelope: SignalEnvelope,
): EnvelopeResultSummary | undefined {
  let passed = 0;
  let failed = 0;
  let faulted = 0;
  const items: ResultSummaryItem[] = [];
  for (const unit of envelope.units) {
    const outcome = unitOutcome(unit);
    if (outcome === 'faulted') faulted += 1;
    else if (outcome === 'failed') failed += 1;
    else passed += 1;
    const detail = unitDetail(envelope, unit, outcome);
    items.push({ label: unit.slug, outcome, ...(detail === undefined ? {} : { detail }) });
  }
  if (failed + faulted === 0) return undefined;
  return { counts: { passed, failed, faulted }, items };
}
