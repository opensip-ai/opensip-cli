/**
 * Shared verbose-detail view producers (ADR-0021).
 *
 * `--verbose` is an output-currency concern: a tool's verbose detail body is
 * carried as data on its `*DoneResult` and rendered ONCE through these
 * producers, so the detail is identical in a TTY (`renderToInk`) and a pipe
 * (`renderToText`). They replace the three hand-copied "Use --verbose…" hints
 * and the fitness-local `FindingsBlock` Ink component.
 *
 * cli-ui must never import `@opensip-tools/contracts` (keystone boundary), so
 * these take plain structural inputs ({@link FindingGroupView}) — the cli
 * `resultToView` seam passes the contracts `FindingGroup` *values* straight in
 * (the shapes are structurally identical; a type-compat test pins that).
 *
 * Pure data + types: no `ink`/`react` imports (same rule as view-model.ts).
 */

import { viewFooterHints } from './run-footer-hints.js';
import { group, line, type Span, type ViewNode } from './view-model.js';

/** Per-check cap on rendered findings — mirrors the prior FindingsBlock limit. */
const DEFAULT_VIOLATIONS_PER_GROUP = 25;

/** One displayed finding (structural twin of contracts' `FindingLine`). */
export interface FindingLineView {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly location?: string;
  readonly suggestion?: string;
}

/** A verbose findings block (structural twin of contracts' `FindingGroup`). */
export interface FindingGroupView {
  readonly title: string;
  readonly error?: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly findings: readonly FindingLineView[];
}

/** The canonical next-step hint shown when a run was NOT verbose. */
export function viewVerboseHint(): ViewNode {
  return viewFooterHints([{ text: 'Use --verbose for detailed results', bold: ['--verbose'] }]);
}

/** Render a line-oriented verbose body verbatim (graph's catalog/findings dump). */
export function viewVerboseLines(lines: readonly string[]): ViewNode {
  return group(lines.map((l) => line([{ text: l }])));
}

/** Render one finding row: `      error  <message> <location>` + optional suggestion. */
function findingNode(f: FindingLineView): ViewNode {
  const spans: Span[] = [
    { text: '      ' },
    { text: f.severity === 'error' ? 'error' : 'warn', tone: f.severity === 'error' ? 'error' : 'warning' },
    { text: '  ' },
    { text: f.message },
  ];
  if (f.location !== undefined && f.location !== '') {
    spans.push({ text: ' ' }, { text: f.location, dim: true });
  }
  const rows: ViewNode[] = [line(spans)];
  if (f.suggestion !== undefined && f.suggestion !== '') {
    rows.push(line([{ text: '            ' }, { text: f.suggestion, dim: true }]));
  }
  return group(rows);
}

/** Render one findings group: a check title + count, an optional error line, the
 *  capped findings, and a "+N more" line when truncated. */
function groupNode(g: FindingGroupView): ViewNode {
  const count = g.errorCount + g.warningCount + (g.error === undefined ? 0 : 1);
  const visible = g.findings.slice(0, DEFAULT_VIOLATIONS_PER_GROUP);
  const hidden = Math.max(0, g.findings.length - visible.length);

  const children: ViewNode[] = [
    line([{ text: g.title, tone: 'brand' }, { text: ` (${String(count)})`, dim: true }]),
  ];
  if (g.error !== undefined) {
    children.push(line([{ text: '      ' }, { text: 'error', tone: 'error' }, { text: '  ' }, { text: g.error }]));
  }
  for (const f of visible) children.push(findingNode(f));
  if (hidden > 0) {
    children.push(
      line(
        [
          { text: '      … ' },
          { text: `${String(hidden)} more hidden (use ` },
          { text: '--json', bold: true },
          { text: ' or ' },
          { text: 'opensip-tools dashboard', bold: true },
          { text: ' for all)' },
        ],
        true,
      ),
    );
  }
  children.push({ kind: 'spacer' });
  return group(children, 2);
}

/** Render a verbose findings body — header + one block per group. */
export function viewFindingsGroups(groups: readonly FindingGroupView[]): ViewNode {
  const total = groups.reduce(
    (sum, g) => sum + g.errorCount + g.warningCount + (g.error === undefined ? 0 : 1),
    0,
  );
  const children: ViewNode[] = [
    line([{ text: 'Findings', bold: true }, { text: ` (${String(total)}):`, dim: true }]),
    { kind: 'spacer' },
    ...groups.map((g) => groupNode(g)),
  ];
  return group(children, 2);
}
