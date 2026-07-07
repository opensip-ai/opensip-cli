/**
 * Project a single-run {@link SignalEnvelope} onto the {@link viewResultSummary}
 * model — the attention-only bullet block for the compact default run surface
 * (`opensip fit` without `--verbose`).
 *
 * Granularity is UNIT-centric (one item per check/rule/scenario), so the count
 * line and bullets both count units and line up. A failing unit's detail is its
 * finding LOCATIONS (`file:line`); a faulted unit's detail is its runtime error
 * message (the check that threw, named). A run that faults at the RUN level (fit
 * itself failing to load/parse) never reaches here — ADR-0060 makes that a
 * command-error before the envelope, so there is no faulted-envelope with
 * spurious counts to render.
 *
 * Returns `undefined` when every unit passed, so a clean run keeps the
 * headline-only compact surface (no redundant "all passed" block).
 */

import type { ResultOutcome, ResultSummaryItem } from '@opensip-cli/cli-ui';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';

/** How many finding locations to list inline on a failing unit's bullet before eliding. */
const MAX_INLINE_LOCATIONS = 2;

/** A unit's 3-way outcome: a per-unit `error` is a fault; otherwise pass/fail from `passed`. */
export function unitOutcome(unit: UnitResult): ResultOutcome {
  if (unit.error !== undefined) return 'faulted';
  return unit.passed ? 'passed' : 'failed';
}

/**
 * The distinct finding locations a unit produced (`filePath[:line]`), compacted
 * to one line: the first {@link MAX_INLINE_LOCATIONS}, then `(+N more)`. A
 * signal belongs to a unit when `signal.source === unit.slug` (fit stamps each
 * finding's source with the check slug — the same grouping the per-unit table
 * uses). `undefined` when the unit produced no locatable findings.
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
  outcome: ResultOutcome,
): string | undefined {
  if (outcome === 'faulted') return unit.error;
  if (outcome === 'failed') return unitLocations(envelope, unit.slug);
  return undefined;
}

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
