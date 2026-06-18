/**
 * @fileoverview Graph live-view derivation from the run's `SignalEnvelope`
 * (envelope-first-presentation RP-2).
 *
 * Graph's STATIC render path routes through the cli host's `presentationToView`
 * → `envelopeToTableView`, which renders one per-unit (per-rule) row plus the
 * PASS/FAIL summary. To keep the LIVE final frame in parity with that static
 * frame (the plan's table-in-both default — Assumption 3), the live runner must
 * render the SAME per-unit table + summary.
 *
 * It cannot reuse the host's `envelopeTableNode`/`presentationToView` directly:
 * those live in `opensip-cli` (the cli package), which graph — a peer-layer tool
 * — must never import (it would create a cli↔tool cycle). Nor may graph's
 * PRODUCTION source import `@opensip-cli/output` (the `formatSignalTableRows`
 * home is forbidden to tool engines by dependency-cruiser
 * `tool-engines-no-output-formatters` / `-barrel`; ADR-0011). So — exactly like
 * fitness's `fit/envelope-view.ts` — this module derives graph's table straight
 * from the envelope using only `@opensip-cli/contracts` (envelope/units) +
 * `@opensip-cli/core` (signals, `formatDuration`/`isErrorSignal`) and builds the
 * `ViewNode` with `@opensip-cli/cli-ui` primitives.
 *
 * The row facts mirror `@opensip-cli/output`'s `formatSignalTableRows`
 * (group signals by `source`, split errors/warnings via `isErrorSignal`,
 * `formatDuration(unit.durationMs)`) and the node layout mirrors the host's
 * `envelopeTableNode` lean 5-column form (graph units carry no
 * `filesValidated`, so the Validated/Ignores columns are absent). The
 * `static === live` byte parity is pinned by a test that renders this node and
 * the host's `envelopeToTableView` side by side
 * (`packages/cli/src/ui/__tests__/graph-live-static-parity.test.tsx`).
 *
 * Pure: no IO, no clock.
 */

import {
  line,
  group,
  sortFitRowPriority,
  type Span,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';
import { formatDuration, isErrorSignal } from '@opensip-cli/core';

import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

/** A graph live-view table row — one per rule that fired. */
interface GraphTableRow {
  readonly unit: string;
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  readonly errors: number;
  readonly warnings: number;
  readonly duration: string;
  readonly durationMs: number;
}

// Fixed column widths — byte-identical to the host's `envelopeTableNode`
// lean (no-Validated) form (`result-to-view.ts` `ENV_COL`).
const COL = { status: 7, errors: 6, warnings: 8, duration: 10 } as const;
const SEP: Span = { text: ' | ' };

/** Group a run's signals by `signal.source` (the emitting rule's slug). */
function groupBySource(signals: readonly Signal[]): Map<string, Signal[]> {
  const bySource = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }
  return bySource;
}

function rowStatus(unit: UnitResult): GraphTableRow['status'] {
  if (unit.error !== undefined) return 'ERROR';
  return unit.passed ? 'PASS' : 'FAIL';
}

/** Build one row per unit — mirrors `formatSignalTableRows` (output) for graph. */
function envelopeToGraphRows(envelope: SignalEnvelope): GraphTableRow[] {
  const bySource = groupBySource(envelope.signals);
  return envelope.units.map((unit) => {
    const unitSignals = bySource.get(unit.slug) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const s of unitSignals) {
      if (isErrorSignal(s)) errors += 1;
      else warnings += 1;
    }
    return {
      unit: unit.slug,
      status: rowStatus(unit),
      errors,
      warnings,
      duration: formatDuration(unit.durationMs),
      durationMs: unit.durationMs,
    };
  });
}

// Tone helpers — byte-identical to the host's `envelopeTableNode` tones.
function statusTone(status: GraphTableRow['status']): Tone {
  if (status === 'FAIL') return 'error';
  if (status === 'ERROR') return 'warning';
  return 'success';
}

function durationTone(ms: number): Tone {
  if (ms >= 60_000) return 'error';
  if (ms >= 30_000) return 'warning';
  return 'success';
}

/**
 * Fixed-width per-unit table from the envelope, or null when empty — mirrors the
 * host `envelopeTableNode` lean 5-column form so the live frame matches static.
 * Sort order is the SAME shared `sortFitRowPriority` the host applies (ERROR/
 * TIMEOUT first, then FAIL, then warning-carrying, then clean; stable for ties)
 * — graph rows structurally satisfy `FitRowSortKey`, so reusing it removes any
 * drift between the live table order and the static one.
 */
function graphTableNode(rows: readonly GraphTableRow[]): ViewNode | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
  const unitW = Math.max(40, ...sorted.map((r) => r.unit.length));

  const headerCells = [
    'Unit'.padEnd(unitW),
    'Status'.padEnd(COL.status),
    'Errors'.padEnd(COL.errors),
    'Warnings'.padEnd(COL.warnings),
    'Duration'.padEnd(COL.duration),
  ];
  const sepCells = [
    '-'.repeat(unitW),
    '-'.repeat(COL.status),
    '-'.repeat(COL.errors),
    '-'.repeat(COL.warnings),
    '-'.repeat(COL.duration),
  ];
  const header = line([{ text: headerCells.join(' | ') }]);
  const separator = line([{ text: sepCells.join('-|-') }]);

  const rowNodes = sorted.map((r) =>
    line([
      { text: r.unit.padEnd(unitW) },
      SEP,
      { text: r.status.padEnd(COL.status), tone: statusTone(r.status) },
      SEP,
      { text: String(r.errors).padEnd(COL.errors), tone: r.errors > 0 ? 'error' : 'success' },
      SEP,
      { text: String(r.warnings).padEnd(COL.warnings), tone: r.warnings > 0 ? 'warning' : 'muted' },
      SEP,
      { text: r.duration.padEnd(COL.duration), tone: durationTone(r.durationMs) },
    ]),
  );

  return group([header, separator, ...rowNodes]);
}

/**
 * The graph per-unit (per-rule) table as a `ViewNode`, or null when no rule
 * fired — the same table the static path produces via `envelopeToTableView`
 * (`envelopeTableNode`). The live runner renders this above the shared
 * `<RunSummary>` (which already matches the static summary via the shared
 * `viewRunSummary` producer + host `RunTimingProvider`), bringing the live final
 * frame into parity with the static frame (envelope-first-presentation RP-2,
 * table-in-both default).
 */
export function graphDoneTableNode(envelope: SignalEnvelope): ViewNode | null {
  return graphTableNode(envelopeToGraphRows(envelope));
}
