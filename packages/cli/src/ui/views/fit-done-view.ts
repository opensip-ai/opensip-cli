/**
 * fit-done view-model builder.
 *
 * Expresses the fitness `fit-done` result — results table, one-line
 * summary, findings detail, and optional cloud-report status — as a single
 * `ViewNode`. Both interpreters render it: Ink (TTY) colors the toned
 * spans; renderToText (pipe/CI) emits the same text without ANSI. The
 * 7-column table keeps its `|`-separated, fixed-width layout by baking the
 * padding into span text (rather than via the generic `table` node), so
 * the format is preserved exactly while colors stay per-cell.
 */

import { line, group, viewRunSummary, type Span, type Tone, type ViewNode } from '@opensip-tools/cli-ui';

import type { CheckOutput, FitDoneResult, TableRow } from '@opensip-tools/contracts';

const VIOLATIONS_PER_CHECK = 25;
const COL = { status: 7, errors: 6, warnings: 8, validated: 12, ignored: 7, duration: 10 } as const;

function sortPriority(r: TableRow): number {
  if (r.status === 'TIMEOUT') return 0;
  if (r.status === 'FAIL') return 1;
  if (r.warnings > 0) return 2;
  return 3;
}

function statusTone(status: TableRow['status']): Tone {
  if (status === 'FAIL') return 'error';
  if (status === 'TIMEOUT') return 'warning';
  return 'success';
}

function parseValidatedCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function ignoredTone(ignored: number, validated: string): Tone {
  const total = parseValidatedCount(validated);
  if (total === 0 || ignored === 0) return 'muted';
  const pct = (ignored / total) * 100;
  if (pct > 10) return 'error';
  if (pct > 5) return 'warning';
  return 'muted';
}

function durationTone(ms: number): Tone {
  if (ms >= 60_000) return 'error';
  if (ms >= 30_000) return 'warning';
  return 'success';
}

const SEP: Span = { text: ' | ' };

function tableNode(rows: readonly TableRow[]): ViewNode | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => sortPriority(a) - sortPriority(b));
  const checkW = Math.max(40, ...sorted.map((r) => r.check.length));

  const header = line([
    { text: `${'Check'.padEnd(checkW)} | ${'Status'.padEnd(COL.status)} | ${'Errors'.padEnd(COL.errors)} | ${'Warnings'.padEnd(COL.warnings)} | ${'Validated'.padEnd(COL.validated)} | ${'Ignores'.padEnd(COL.ignored)} | ${'Duration'.padEnd(COL.duration)}` },
  ]);
  const separator = line([
    {
      text: [
        '-'.repeat(checkW), '-'.repeat(COL.status), '-'.repeat(COL.errors), '-'.repeat(COL.warnings),
        '-'.repeat(COL.validated), '-'.repeat(COL.ignored), '-'.repeat(COL.duration),
      ].join('-|-'),
    },
  ]);

  const rowNodes = sorted.map((r) =>
    line([
      { text: r.check.padEnd(checkW) },
      SEP,
      { text: r.status.padEnd(COL.status), tone: statusTone(r.status) },
      SEP,
      { text: String(r.errors).padEnd(COL.errors), tone: r.errors > 0 ? 'error' : 'success' },
      SEP,
      { text: String(r.warnings).padEnd(COL.warnings), tone: r.warnings > 0 ? 'warning' : 'muted' },
      SEP,
      { text: r.validated.padEnd(COL.validated) },
      SEP,
      { text: String(r.ignored).padEnd(COL.ignored), tone: ignoredTone(r.ignored, r.validated) },
      SEP,
      { text: r.duration.padEnd(COL.duration), tone: durationTone(r.durationMs) },
    ]),
  );

  return group([header, separator, ...rowNodes]);
}

function countBySeverity(check: CheckOutput): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const f of check.findings) {
    if (f.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

function isRelevant(c: CheckOutput): boolean {
  const { errors, warnings } = countBySeverity(c);
  return errors > 0 || warnings > 0 || c.error !== undefined;
}

function locationOf(filePath: string | undefined, lineNo: number | undefined): string {
  if (filePath === undefined) return '';
  return lineNo === undefined ? filePath : `${filePath}:${String(lineNo)}`;
}

/** One finding row, plus an optional indented suggestion line. */
function findingLines(v: CheckOutput['findings'][number]): ViewNode[] {
  const loc = locationOf(v.filePath, v.line);
  const spans: Span[] = [
    { text: '      ' },
    { text: v.severity === 'error' ? 'error' : 'warn', tone: v.severity === 'error' ? 'error' : 'warning' },
    { text: `  ${v.message}` },
  ];
  if (loc.length > 0) spans.push({ text: ` ${loc}`, dim: true });
  const lines: ViewNode[] = [line(spans)];
  if (v.suggestion !== undefined) lines.push(line([{ text: `            ${v.suggestion}`, dim: true }]));
  return lines;
}

/** The findings block for a single check: header, error/finding lines, hidden-count footer. */
function checkBlock(check: CheckOutput): ViewNode {
  const { errors, warnings } = countBySeverity(check);
  const count = errors + warnings + (check.error ? 1 : 0);
  const visible = check.findings.slice(0, VIOLATIONS_PER_CHECK);
  const hidden = Math.max(0, check.findings.length - visible.length);

  const block: ViewNode[] = [
    line([{ text: check.checkSlug, tone: 'brand' }, { text: ` (${count})`, dim: true }]),
  ];
  if (check.error !== undefined) {
    block.push(line([{ text: '      ' }, { text: 'error', tone: 'error' }, { text: `  ${check.error}` }]));
  }
  for (const v of visible) block.push(...findingLines(v));
  if (hidden > 0) {
    block.push(line([{ text: `      … ${hidden} more hidden (use --json or opensip-tools dashboard for all)`, dim: true }]));
  }
  block.push({ kind: 'spacer' });
  return group(block, 2);
}

function findingsNode(checks: readonly CheckOutput[]): ViewNode {
  const total = checks.reduce((sum, c) => {
    const { errors, warnings } = countBySeverity(c);
    return sum + errors + warnings + (c.error ? 1 : 0);
  }, 0);
  const relevant = checks.filter(isRelevant);
  const anyTruncated = relevant.some((c) => c.findings.length > VIOLATIONS_PER_CHECK);

  const children: ViewNode[] = [
    line([{ text: 'Findings', bold: true }, { text: ` (${total})`, dim: true }, { text: ':' }]),
    { kind: 'spacer' },
    ...relevant.map(checkBlock),
  ];
  if (anyTruncated) {
    children.push(
      line(
        [{ text: `Showing first ${VIOLATIONS_PER_CHECK} violations per check. For the full set, run with --json or open opensip-tools dashboard.` }],
        true,
      ),
    );
  }
  return group(children, 2);
}

function cloudReportNode(status: NonNullable<FitDoneResult['reportStatus']>): ViewNode {
  const chunkDetail =
    status.chunksTotal !== undefined && status.chunksTotal > 1
      ? ` (${status.chunksSucceeded}/${status.chunksTotal} chunks)`
      : '';
  if (!status.success) {
    const partial = status.chunksSucceeded !== undefined && status.chunksSucceeded > 0;
    const children: ViewNode[] = [
      line([
        { text: partial ? '⚠' : '✗', tone: partial ? 'warning' : 'error' },
        { text: ` ${partial ? 'Partially reported' : 'Failed to report'} to ` },
        { text: status.url, dim: true },
        { text: chunkDetail },
      ]),
    ];
    if (status.error !== undefined) children.push(line([{ text: `    ${status.error}`, dim: true }]));
    return group(children, 2);
  }
  return group(
    [
      line([{ text: '✔', tone: 'success' }, { text: ' Reported to ' }, { text: status.url, dim: true }, { text: chunkDetail }]),
      line([{ text: `    ${status.findingCount} findings from ${status.runCount} checks`, dim: true }]),
    ],
    2,
  );
}

/** Build the fit-done view: table, summary, findings, and cloud-report status. */
export function viewFitDone(result: FitDoneResult): ViewNode {
  const children: ViewNode[] = [];
  const table = tableNode(result.rows);
  if (table !== null) children.push(table);
  children.push(
    viewRunSummary({
      passed: result.summary.passed,
      failed: result.summary.failed,
      errors: result.summary.totalErrors,
      warnings: result.summary.totalWarnings,
      durationMs: result.summary.durationMs,
    }),
  );
  if (result.findings) children.push(findingsNode(result.findings.checks));
  if (result.reportStatus) children.push(cloudReportNode(result.reportStatus));
  return group(children);
}
