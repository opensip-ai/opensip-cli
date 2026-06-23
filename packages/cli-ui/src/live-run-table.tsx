/**
 * Shared per-unit table renderer for live-run done frames.
 *
 * Tools pass plain {@link LiveRunTableRow} data; this module builds the
 * ViewNode (byte-aligned with the host `envelopeTableNode` in result-to-view).
 * cli-ui stays free of @opensip-cli/contracts and @opensip-cli/output.
 */

import {
  formatValidatedColumn,
  parseValidatedCount,
  sortFitRowPriority,
} from './fit-table-format.js';
import { group, line, type Span, type Tone, type ViewNode } from './view-model.js';

/** Plain row data for the live-run per-unit table. */
export interface LiveRunTableRow {
  readonly unit: string;
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  readonly errors: number;
  readonly warnings: number;
  readonly duration: string;
  readonly durationMs: number;
  readonly validated?: number;
  readonly ignored?: number;
  readonly itemType?: string;
}

const COL = { status: 7, errors: 6, warnings: 8, validated: 12, ignored: 7, duration: 10 } as const;
const SEP: Span = { text: ' | ' };

function statusTone(status: LiveRunTableRow['status']): Tone {
  if (status === 'FAIL') return 'error';
  if (status === 'ERROR') return 'warning';
  return 'success';
}

function durationTone(ms: number): Tone {
  if (ms >= 60_000) return 'error';
  if (ms >= 30_000) return 'warning';
  return 'success';
}

function ignoredTone(ignored: number, validatedCell: string): Tone {
  const total = parseValidatedCount(validatedCell);
  if (total === 0 || ignored === 0) return 'muted';
  const pct = (ignored / total) * 100;
  if (pct > 10) return 'error';
  if (pct > 5) return 'warning';
  return 'muted';
}

/** Fixed-width per-unit table from plain row data, or null when empty. */
export function liveRunTable(rows: readonly LiveRunTableRow[]): ViewNode | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
  const unitW = Math.max(40, ...sorted.map((r) => r.unit.length));
  const showValidated = sorted.some((r) => r.validated !== undefined);

  const headerCells = [
    'Unit'.padEnd(unitW),
    'Status'.padEnd(COL.status),
    'Errors'.padEnd(COL.errors),
    'Warnings'.padEnd(COL.warnings),
    ...(showValidated ? ['Validated'.padEnd(COL.validated), 'Ignores'.padEnd(COL.ignored)] : []),
    'Duration'.padEnd(COL.duration),
  ];
  const sepCells = [
    '-'.repeat(unitW),
    '-'.repeat(COL.status),
    '-'.repeat(COL.errors),
    '-'.repeat(COL.warnings),
    ...(showValidated ? ['-'.repeat(COL.validated), '-'.repeat(COL.ignored)] : []),
    '-'.repeat(COL.duration),
  ];
  const header = line([{ text: headerCells.join(' | ') }]);
  const separator = line([{ text: sepCells.join('-|-') }]);

  const rowNodes = sorted.map((r) => {
    const validatedCell = formatValidatedColumn(r.validated, r.itemType);
    const spans: Span[] = [
      { text: r.unit.padEnd(unitW) },
      SEP,
      { text: r.status.padEnd(COL.status), tone: statusTone(r.status) },
      SEP,
      { text: String(r.errors).padEnd(COL.errors), tone: r.errors > 0 ? 'error' : 'success' },
      SEP,
      {
        text: String(r.warnings).padEnd(COL.warnings),
        tone: r.warnings > 0 ? 'warning' : 'muted',
      },
    ];
    if (showValidated) {
      spans.push(SEP, { text: validatedCell.padEnd(COL.validated) }, SEP, {
        text: String(r.ignored ?? 0).padEnd(COL.ignored),
        tone: ignoredTone(r.ignored ?? 0, validatedCell),
      });
    }
    spans.push(SEP, {
      text: r.duration.padEnd(COL.duration),
      tone: durationTone(r.durationMs),
    });
    return line(spans);
  });

  return group([header, separator, ...rowNodes]);
}
