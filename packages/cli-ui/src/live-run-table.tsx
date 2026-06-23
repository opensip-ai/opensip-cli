/**
 * Shared per-unit table renderer for live-run done frames.
 *
 * Tools pass plain {@link LiveRunTableRow} DATA (numbers + enums, never
 * pre-formatted strings); this module turns it into the canonical `table`
 * view-model node (ADR-0058) — the same node the host lists (sessions/tools)
 * and the static non-TTY path use, so every terminal table renders identically.
 * Duration is formatted HERE from `durationMs`, not by each tool, so the format
 * cannot drift per tool. cli-ui stays free of @opensip-cli/contracts and
 * @opensip-cli/output.
 */

import {
  formatValidatedColumn,
  parseValidatedCount,
  sortFitRowPriority,
} from './fit-table-format.js';
import { formatDuration } from './format-duration.js';
import {
  viewTable,
  type Span,
  type TableColumnSpec,
  type Tone,
  type ViewNode,
} from './view-model.js';

/** Plain row data for the live-run per-unit table. */
export interface LiveRunTableRow {
  readonly unit: string;
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  readonly errors: number;
  readonly warnings: number;
  /** Raw duration in milliseconds — the renderer formats it (see module docstring). */
  readonly durationMs: number;
  readonly validated?: number;
  readonly ignored?: number;
  readonly itemType?: string;
}

/**
 * Per-column minimum widths — the fixed columns the results table has always
 * shown. The shared renderer grows a column past its floor to fit content; the
 * Unit column floors at 40 so short runs still read as a table.
 */
const COL = {
  unit: 40,
  status: 7,
  errors: 6,
  warnings: 8,
  validated: 12,
  ignored: 7,
  duration: 10,
} as const;

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
  const showValidated = sorted.some((r) => r.validated !== undefined);

  const columns: TableColumnSpec[] = [
    { header: 'Unit', minWidth: COL.unit },
    { header: 'Status', minWidth: COL.status },
    { header: 'Errors', minWidth: COL.errors },
    { header: 'Warnings', minWidth: COL.warnings },
    ...(showValidated
      ? [
          { header: 'Validated', minWidth: COL.validated },
          { header: 'Ignores', minWidth: COL.ignored },
        ]
      : []),
    { header: 'Duration', minWidth: COL.duration },
  ];

  const rowSpans: Span[][] = sorted.map((r) => {
    const validatedCell = formatValidatedColumn(r.validated, r.itemType);
    const cells: Span[] = [
      { text: r.unit },
      { text: r.status, tone: statusTone(r.status) },
      { text: String(r.errors), tone: r.errors > 0 ? 'error' : 'success' },
      { text: String(r.warnings), tone: r.warnings > 0 ? 'warning' : 'muted' },
    ];
    if (showValidated) {
      cells.push(
        { text: validatedCell },
        { text: String(r.ignored ?? 0), tone: ignoredTone(r.ignored ?? 0, validatedCell) },
      );
    }
    cells.push({ text: formatDuration(r.durationMs), tone: durationTone(r.durationMs) });
    return cells;
  });

  return viewTable(columns, rowSpans);
}
