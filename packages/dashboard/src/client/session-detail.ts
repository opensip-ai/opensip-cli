/**
 * Session-detail rendering — the expandable per-session detail panel under the
 * session table (sessions.ts).
 *
 * `renderSessionDetail(detailContainer, session, idx, tool)` distinguishes three
 * payload states: a fitness payload (per-check detail, "Check" column), a graph
 * payload (per-rule detail, "Rule" column — same structural shape, tool-specific
 * label), and no payload at all (explicit "No detail recorded" rather than a
 * silent empty table). Split out of sessions.ts to keep each module focused (L4).
 */

import { el } from './el.js';
import { paginateGroupedRows } from './pagination.js';
import { makeSortable } from './sortable.js';

/** A finding inside a check/rule (read structurally from the tool payload). */
interface Finding {
  severity?: string;
  message?: string;
  filePath?: string;
  line?: number;
  suggestion?: string;
  metadata?: Record<string, unknown>;
}

/** One check (fitness) / rule (graph) row inside a session's detail payload. */
interface Check {
  checkSlug: string;
  passed?: boolean;
  durationMs?: number;
  findings?: Finding[];
}

/** Per-rule metric column descriptor for the expanded findings table. */
interface MetricColumn {
  label: string;
  key: string;
}

// Per-rule metric column map for the expanded findings table. For these graph
// rules the finding message just repeats the file + the metric, so we DROP the
// Message column and render a dedicated metric column read from finding.metadata
// (persisted on the signal metadata payload).
const RULE_METRIC_COLUMNS: Record<string, MetricColumn> = {
  'graph:large-function': { label: 'Lines', key: 'bodyLines' },
  'graph:high-blast-untested': { label: 'Score', key: 'blast' },
  'graph:wide-function': { label: 'Parameters', key: 'paramCount' },
  'graph:cycle': { label: 'Call Cycle', key: 'sccSize' },
};

// Shared inline-style fragments reused across the detail tables.
const DIM = 'color:var(--text-dim)';
const FINDING_CELL_PAD = 'padding:6px 12px';

/** Em-dash placeholder for a missing/empty cell value. */
const EM_DASH = '—';

/** Stringify a metric value (number / string / boolean) for a metric cell, em-dash otherwise. */
function formatMetricValue(mv: unknown): string {
  if (typeof mv === 'number' || typeof mv === 'string' || typeof mv === 'boolean') {
    return String(mv);
  }
  return EM_DASH;
}

/** Render a finding's `file[:line]`, or em-dash when no file is recorded. */
function formatFindingFile(f: Finding): string {
  if (!f.filePath) return EM_DASH;
  return f.line ? f.filePath + ':' + f.line : f.filePath;
}

/** Count findings of a given severity on a check (0 when there are none). */
function countSeverity(check: Check, severity: string): number {
  return check.findings ? check.findings.filter((f) => f.severity === severity).length : 0;
}

/** Sort checks/rules by severity weight: most errors first, warnings as tiebreak. */
function sortChecksBySeverity(checks: readonly Check[]): Check[] {
  return [...checks].sort((a, b) => {
    const aErrors = countSeverity(a, 'error');
    const bErrors = countSeverity(b, 'error');
    if (bErrors !== aErrors) return bErrors - aErrors;
    return countSeverity(b, 'warning') - countSeverity(a, 'warning');
  });
}

/** Build the findings sub-table for one expanded check/rule. */
function buildFindingsTable(check: Check, metricColumn: MetricColumn | undefined): HTMLElement {
  const fTable = el('table', { class: 'data-table', style: 'margin:0;border:none' });
  const fHead = el('thead');
  const fHeaderRow = el('tr');
  // Per-rule column shape. Most rules render the default
  // [Severity, Message, File, Suggestion]. The graph metric rules repeat the
  // file + metric in their message, so they DROP Message and ADD a metric
  // column read from finding.metadata.
  const fHeaders = metricColumn
    ? ['Severity', 'File', metricColumn.label, 'Suggestion']
    : ['Severity', 'Message', 'File', 'Suggestion'];
  fHeaders.forEach((h) => {
    fHeaderRow.append(el('th', { text: h, style: 'font-size:11px;padding:6px 12px' }));
  });
  fHead.append(fHeaderRow);
  fTable.append(fHead);

  const fBody = el('tbody');
  // Sort findings within the rule: errors first, then warnings (stable).
  const sevWeight: Record<string, number> = { error: 0, warning: 1 };
  const sortedFindings = [...(check.findings ?? [])].sort(
    (a, b) => (sevWeight[a.severity ?? ''] ?? 2) - (sevWeight[b.severity ?? ''] ?? 2),
  );
  const fileCellStyle = FINDING_CELL_PAD + ';' + DIM + ';font-size:12px';
  sortedFindings.forEach((f) => {
    const fRow = el('tr');
    const sevCell = el('td', { style: FINDING_CELL_PAD });
    sevCell.append(el('span', { class: 'finding-sev ' + f.severity, text: f.severity }));
    fRow.append(sevCell);
    const fileText = formatFindingFile(f);
    if (metricColumn) {
      fRow.append(el('td', { text: fileText, style: fileCellStyle }));
      const mv = f.metadata ? f.metadata[metricColumn.key] : undefined;
      fRow.append(
        el('td', { text: formatMetricValue(mv), style: FINDING_CELL_PAD + ';font-size:13px' }),
      );
    } else {
      fRow.append(el('td', { text: f.message, style: FINDING_CELL_PAD + ';font-size:13px' }));
      fRow.append(el('td', { text: fileText, style: fileCellStyle }));
    }
    fRow.append(
      el('td', {
        text: f.suggestion ?? EM_DASH,
        style: FINDING_CELL_PAD + ';color:var(--accent);font-size:12px',
      }),
    );
    fBody.append(fRow);
  });
  fTable.append(fBody);
  return fTable;
}

/** Build the detail sub-line shown under the "Session Detail" heading. */
function detailSubline(
  session: DashboardSession,
  totalErrors: number,
  totalWarnings: number,
): HTMLElement {
  const sub = el('div', { style: 'color:var(--text-dim);font-size:12px' });
  const countParts: string[] = [];
  if (totalErrors > 0) countParts.push(totalErrors + ' error' + (totalErrors === 1 ? '' : 's'));
  if (totalWarnings > 0)
    countParts.push(totalWarnings + ' warning' + (totalWarnings === 1 ? '' : 's'));
  const countsStr = countParts.length > 0 ? ' — ' + countParts.join(', ') : '';
  sub.textContent =
    session.cwd + (session.recipe ? ' — recipe: ' + session.recipe : '') + countsStr;
  return sub;
}

/** Build the "Session Detail" header (heading + sub-line) for a session. */
function buildDetailHeader(
  session: DashboardSession,
  totalErrors: number,
  totalWarnings: number,
): HTMLElement {
  const headerRow = el('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px',
  });
  const headerLeft = el('div');
  headerLeft.append(
    el('h3', {
      text: 'Session Detail — ' + new Date(session.startedAt).toLocaleString(),
      style: 'margin-bottom:4px',
    }),
  );
  headerLeft.append(detailSubline(session, totalErrors, totalWarnings));
  headerRow.append(headerLeft);
  return headerRow;
}

/** A count cell: `value` colored with `activeColor` when positive, dimmed at 0. */
function buildCountCell(value: number, activeColor: string): HTMLElement {
  return el('td', { text: '' + value, style: value > 0 ? activeColor : DIM });
}

/** Build the expander row holding one check's findings table. */
function buildCheckExpanderRow(
  check: Check,
  expanderId: string,
  checkStatusVal: string,
  itemHeadersLength: number,
): HTMLElement {
  const expRow = el('tr', {
    id: expanderId,
    class: 'expander-row',
    'data-check-status': checkStatusVal,
  });
  const expCell = el('td', { colspan: '' + itemHeadersLength, style: 'padding:0' });
  const expContent = el('div', { class: 'expander-content' });
  const fTable = buildFindingsTable(check, RULE_METRIC_COLUMNS[check.checkSlug]);
  // Wrap the wide findings table in a horizontal-scroll container so long file
  // paths / messages scroll inside the card instead of overrunning the section
  // (mirrors the .coupling-scroll fix).
  const fScroll = el('div', { style: 'overflow-x:auto;max-width:100%' }, [fTable]);
  expContent.append(fScroll);
  expCell.append(expContent);
  expRow.append(expCell);
  return expRow;
}

/** Build the detail table's `<thead>` for a tool (graph drops the Duration column). */
function buildDetailHead(itemHeaders: readonly string[]): HTMLElement {
  const thead = el('thead');
  const thRow = el('tr');
  itemHeaders.forEach((h) => {
    thRow.append(el('th', { text: h }));
  });
  thead.append(thRow);
  return thead;
}

/** Build one check/rule row (+ its expander row when it has findings). */
function appendCheckRow(
  detailBody: HTMLElement,
  check: Check,
  i: number,
  ctx: { filterUid: string; itemHeadersLength: number; showDuration: boolean },
): void {
  const checkErrors = countSeverity(check, 'error');
  const checkWarnings = countSeverity(check, 'warning');
  const findingsTotal = checkErrors + checkWarnings;
  const hasFindings = findingsTotal > 0;
  const expanderId = ctx.filterUid + '-exp-' + i;
  const checkStatusVal = check.passed ? 'pass' : 'fail';

  const arrowCell = el('td', {
    style: 'width:24px;text-align:center;' + DIM + ';font-size:12px',
  });
  if (hasFindings) arrowCell.textContent = '▶';

  const row = el('tr', {
    class: hasFindings ? 'clickable' : '',
    'data-check-status': checkStatusVal,
    onclick: hasFindings
      ? () => {
          const exp = document.querySelector<HTMLElement>('#' + expanderId);
          if (exp) {
            const isOpen = exp.classList.toggle('open');
            exp.style.display = isOpen ? 'table-row' : 'none';
            arrowCell.textContent = isOpen ? '▼' : '▶';
          }
          row.classList.toggle('expanded');
        }
      : undefined,
  });
  row.append(arrowCell);
  row.append(el('td', { text: check.checkSlug, style: 'font-weight:500' }));

  const statusCell = el('td');
  statusCell.append(
    el('span', {
      class: 'badge ' + (check.passed ? 'badge-pass' : 'badge-fail'),
      text: check.passed ? 'PASS' : 'FAIL',
    }),
  );
  row.append(statusCell);
  row.append(buildCountCell(checkErrors, 'color:var(--error)'));
  row.append(buildCountCell(checkWarnings, 'color:var(--warning)'));
  row.append(buildCountCell(findingsTotal, 'color:var(--text)'));
  if (ctx.showDuration)
    row.append(
      el('td', {
        text: (check.durationMs ?? 0) > 0 ? check.durationMs + 'ms' : '0ms',
        style: DIM,
      }),
    );
  detailBody.append(row);

  if (hasFindings) {
    detailBody.append(
      buildCheckExpanderRow(check, expanderId, checkStatusVal, ctx.itemHeadersLength),
    );
  }
}

/** Render the empty-state for a session with no recorded detail. */
function renderNoDetail(detailContainer: HTMLElement, session: DashboardSession): void {
  detailContainer.append(
    el('h3', {
      text: 'Session Detail — ' + new Date(session.startedAt).toLocaleString(),
      style: 'margin-bottom:4px',
    }),
  );
  detailContainer.append(
    el('div', { class: 'empty', text: 'No detail recorded for this session.' }),
  );
}

/** Render the empty-state for a payload that recorded no per-item rows. */
function renderEmptyChecks(detailContainer: HTMLElement, session: DashboardSession): void {
  detailContainer.append(
    el('h3', {
      text: 'Session Detail — ' + new Date(session.startedAt).toLocaleString(),
      style: 'margin-bottom:4px',
    }),
  );
  const sm = session.payload?.summary ?? {};
  const clean = (sm.errors ?? 0) === 0 && (sm.warnings ?? 0) === 0;
  const subline = el('div', { style: DIM + ';font-size:12px;margin-bottom:12px' });
  subline.textContent = session.cwd + (session.recipe ? ' — recipe: ' + session.recipe : '');
  detailContainer.append(subline);
  detailContainer.append(
    el('div', {
      class: 'empty',
      text: clean
        ? 'No findings — this run was clean. Every rule passed with zero violations.'
        : 'No per-rule detail was recorded for this run.',
    }),
  );
}

/** Build the populated detail table (header + rows) for a non-empty checks payload. */
function buildDetailTable(checks: readonly Check[], tool: string, filterUid: string): HTMLElement {
  // Tools share the structural payload.checks shape but name their items
  // differently — relabel the column so the header reads in the tool's own
  // vocabulary (graph "rules", yagni "detectors", fitness/sim "checks").
  // Graph rules are dataset queries, not timed units — their per-rule duration is
  // always 0ms, so drop the Duration column for graph sessions; fitness/sim/yagni
  // items ARE timed, so keep it for them.
  const itemColumnByTool: Record<string, string> = { graph: 'Rule', yagni: 'Detector' };
  const itemColumn = itemColumnByTool[tool] ?? 'Check';
  const showDuration = tool !== 'graph';
  const itemHeaders = ['', itemColumn, 'Status', 'Errors', 'Warnings', 'Findings'];
  if (showDuration) itemHeaders.push('Duration');

  const table = el('table', { class: 'data-table sortable' });
  table.append(buildDetailHead(itemHeaders));

  const detailBody = el('tbody');
  sortChecksBySeverity(checks).forEach((check, i) => {
    appendCheckRow(detailBody, check, i, {
      filterUid,
      itemHeadersLength: itemHeaders.length,
      showDuration,
    });
  });
  table.append(detailBody);

  const detailPag = el('div', { class: 'pagination' });
  const card = el('div', { class: 'card' }, [table, detailPag]);

  // Enable sorting on the detail table, then paginate.
  makeSortable(table);
  paginateGroupedRows(detailBody, detailPag, 10);
  return card;
}

/**
 * Render the detail panel for `session` into `detailContainer` (clears it first).
 * `idx` and `tool` namespace the per-session DOM ids; `tool` also drives the
 * graph-specific column relabel / duration drop.
 */
export function renderSessionDetail(
  detailContainer: HTMLElement,
  session: DashboardSession,
  idx: number,
  tool: string,
): void {
  detailContainer.style.display = 'block';
  while (detailContainer.firstChild) detailContainer.firstChild.remove();

  // Sessions written before the tool-owned payload split (or by a tool that
  // records no per-item detail) have no payload at all. Distinguish that from
  // "payload present but empty" so the panel says so explicitly rather than
  // rendering a silent empty table.
  if (!session.payload) {
    renderNoDetail(detailContainer, session);
    return;
  }

  // Per-item detail lives in the tool-owned opaque payload. Fitness calls these
  // "checks"; graph groups signals by rule (relabeled in buildDetailTable).
  const checks = (session.payload.checks as Check[] | undefined) ?? [];

  // A payload that records no per-item rows (e.g. a clean graph run — graph only
  // persists rules that emitted a finding) would otherwise render a header-only
  // table that reads as "nothing shows up". Render an explicit empty state.
  if (checks.length === 0) {
    renderEmptyChecks(detailContainer, session);
    return;
  }

  // Compute session-level totals from check findings.
  let totalErrors = 0;
  let totalWarnings = 0;
  checks.forEach((c) => {
    totalErrors += countSeverity(c, 'error');
    totalWarnings += countSeverity(c, 'warning');
  });
  detailContainer.append(buildDetailHeader(session, totalErrors, totalWarnings));

  const filterUid = 'df-' + tool + '-' + idx + '-' + Math.random().toString(36).slice(2, 6);
  detailContainer.append(buildDetailTable(checks, tool, filterUid));
}
