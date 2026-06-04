/**
 * resultToView — the single `CommandResult → ViewNode` mapping.
 *
 * This is the cli-side counterpart to the cli-ui interpreters: each
 * command result is expressed once as a renderer-agnostic view-model node,
 * which the seam (`bootstrap/render.ts`) then renders through `renderToInk`
 * (TTY) or `renderToText` (pipe/CI). Because both media consume the same
 * node, interactive and non-interactive output cannot drift.
 *
 * This mapping is total — every `CommandResult` variant has a view. The
 * Ink `App` shell adds only the banner/project chrome around the body this
 * produces; there is no separate per-type rendering anymore.
 *
 * cli may depend on both `@opensip-tools/contracts` (for `CommandResult`)
 * and `@opensip-tools/cli-ui` (for the view-model). The keystone boundary
 * only forbids the reverse — cli-ui must never import contracts.
 */

import { line, group, viewRunSummary, viewFooterHints, type Span, type Tone, type ViewNode } from '@opensip-tools/cli-ui';
import { formatDuration } from '@opensip-tools/core';
import { formatSignalTableRows, formatSignalTableSummary, type SignalTableRow } from '@opensip-tools/output';

import { viewFitDone } from './views/fit-done-view.js';
import { viewInit } from './views/init-view.js';
import {
  viewListChecks,
  viewListRecipes,
  viewHistory,
  viewExperimental,
  viewDashboard,
  viewClearDone,
  viewConfigureDone,
  viewUninstallDone,
  viewHelp,
} from './views/misc-views.js';
import { viewPlugin } from './views/plugin-view.js';

import type { CommandResult, SimDoneResult, ErrorResult, GraphDoneResult, SignalEnvelope } from '@opensip-tools/contracts';

const SEPARATOR: ViewNode = { kind: 'separator' };
const SPACER: ViewNode = { kind: 'spacer' };

/** `✗ <message>` plus an optional dim suggestion — mirrors ErrorMessage. */
function errorView(result: ErrorResult): ViewNode {
  const children: ViewNode[] = [
    line([{ text: '✗', tone: 'error' }, { text: ` ${result.message}` }]),
  ];
  if (result.suggestion !== undefined) {
    children.push(line([{ text: `    ${result.suggestion}` }], true));
  }
  return group(children, 2);
}

/** One scenario row: `✓/✗ name (kind, Nms)`, with an indented error line. */
function scenarioView(s: SimDoneResult['scenarios'][number]): ViewNode {
  const row = line([
    { text: s.passed ? '✓' : '✗', tone: s.passed ? 'success' : 'error' },
    { text: ` ${s.scenarioName} `, bold: true },
    { text: `(${s.kind}, ${s.durationMs}ms)`, dim: true },
  ]);
  if (s.error === undefined) return row;
  return group([row, group([line([{ text: s.error, tone: 'error' }])], 2)]);
}

function simDoneView(result: SimDoneResult): ViewNode {
  const summary: Span[] = [
    { text: String(result.passedScenarios), bold: true },
    { text: ' passed, ' },
    { text: String(result.failedScenarios), bold: true, ...(result.failedScenarios > 0 ? { tone: 'error' as const } : {}) },
    { text: ' failed ' },
    { text: `| Duration ${formatDuration(result.durationMs)}`, dim: true },
  ];

  const body: ViewNode =
    result.scenarios.length === 0
      ? line(
          [{ text: `No scenarios matched recipe '${result.recipeName}'. Add one to opensip-tools/sim/scenarios/.` }],
          true,
        )
      : group(result.scenarios.map(scenarioView));

  return group(
    [
      line([{ text: 'Simulation', tone: 'brand', bold: true }]),
      line([{ text: `Recipe: ${result.recipeName}` }], true),
      SEPARATOR,
      SPACER,
      body,
      SPACER,
      line(summary),
    ],
    2,
  );
}

/**
 * The graph report: an optional verbose body, an optional fast-tier
 * caveat, the shared summary line, and the shared footer hints. The
 * summary/hints reuse the cli-ui producers, so graph's piped and TTY
 * output match each other and the live view — no hand-maintained
 * plain-text copies (which previously lived in graph-report.ts).
 */
function graphDoneView(result: GraphDoneResult): ViewNode {
  const children: ViewNode[] = [];
  if (result.reportLines.length > 0) {
    for (const l of result.reportLines) children.push(line([{ text: l }]));
    children.push(SPACER);
  }
  if (result.resolutionBanner !== undefined) {
    children.push(line([{ text: result.resolutionBanner, tone: 'muted' }]));
  }
  children.push(viewRunSummary({ ...result.summary, durationMs: result.durationMs }));
  if (result.footerHints.length > 0) {
    children.push(viewFooterHints(result.footerHints));
  }
  return group(children);
}

/** Pre-composed lines rendered verbatim through both media (gate output, graph status). */
function linesView(lines: readonly string[]): ViewNode {
  return group(lines.map((l) => line([{ text: l }])));
}

// --- Envelope-derived terminal table (ADR-0011) -----------------------------
//
// The single, tool-agnostic table derivation: every migrated tool's result
// carries a `SignalEnvelope`, and the terminal table is derived FROM its
// `units` + `signals` via the shared `formatSignalTableRows` / `Summary`
// formatters (`@opensip-tools/output`). One row per unit (check / rule /
// scenario). Replaces the three per-tool, pre-computed `rows`/`reportLines`
// shapes (the fit/sim/graph `*DoneResult` legacy branches, retired in Phase 7).

const ENV_COL = { status: 7, errors: 6, warnings: 8, duration: 10 } as const;

function envStatusTone(status: SignalTableRow['status']): Tone {
  if (status === 'FAIL') return 'error';
  if (status === 'ERROR') return 'warning';
  return 'success';
}

function envDurationTone(ms: number): Tone {
  if (ms >= 60_000) return 'error';
  if (ms >= 30_000) return 'warning';
  return 'success';
}

const ENV_SEP: Span = { text: ' | ' };

/** Fixed-width per-unit table from the envelope's signal-table rows, or null when empty. */
function envelopeTableNode(rows: readonly SignalTableRow[]): ViewNode | null {
  if (rows.length === 0) return null;
  const unitW = Math.max(40, ...rows.map((r) => r.unit.length));

  const header = line([
    {
      text:
        `${'Unit'.padEnd(unitW)} | ${'Status'.padEnd(ENV_COL.status)} | ` +
        `${'Errors'.padEnd(ENV_COL.errors)} | ${'Warnings'.padEnd(ENV_COL.warnings)} | ${'Duration'.padEnd(ENV_COL.duration)}`,
    },
  ]);
  const separator = line([
    {
      text: [
        '-'.repeat(unitW), '-'.repeat(ENV_COL.status), '-'.repeat(ENV_COL.errors),
        '-'.repeat(ENV_COL.warnings), '-'.repeat(ENV_COL.duration),
      ].join('-|-'),
    },
  ]);

  const rowNodes = rows.map((r) =>
    line([
      { text: r.unit.padEnd(unitW) },
      ENV_SEP,
      { text: r.status.padEnd(ENV_COL.status), tone: envStatusTone(r.status) },
      ENV_SEP,
      { text: String(r.errors).padEnd(ENV_COL.errors), tone: r.errors > 0 ? 'error' : 'success' },
      ENV_SEP,
      { text: String(r.warnings).padEnd(ENV_COL.warnings), tone: r.warnings > 0 ? 'warning' : 'muted' },
      ENV_SEP,
      { text: r.duration.padEnd(ENV_COL.duration), tone: envDurationTone(r.durationMs) },
    ]),
  );

  return group([header, separator, ...rowNodes]);
}

/**
 * The shared envelope → terminal-table view. Used by the fit/sim/graph cases
 * once their result carries an envelope; falls back to the legacy
 * `rows`/`reportLines` derivations until each tool migrates (Phases 4–6).
 */
export function envelopeToTableView(envelope: SignalEnvelope): ViewNode {
  const rows = formatSignalTableRows(envelope);
  const summary = formatSignalTableSummary(envelope);
  const children: ViewNode[] = [];
  const table = envelopeTableNode(rows);
  if (table !== null) children.push(table);
  children.push(
    viewRunSummary({
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.totalErrors,
      warnings: summary.totalWarnings,
      durationMs: summary.durationMs,
    }),
  );
  return group(children);
}

/** Map any CommandResult to its view-model node (total — every variant covered). */
export function resultToView(result: CommandResult): ViewNode {
  switch (result.type) {
    case 'fit-done': {
      // ADR-0011: a migrated result carries the envelope; derive the table
      // from it. Un-migrated results (Phase 6 pending) fall through to the
      // legacy `rows`/`findings` view.
      return result.envelope ? envelopeToTableView(result.envelope) : viewFitDone(result);
    }
    case 'error': {
      return errorView(result);
    }
    case 'sim-done': {
      return result.envelope ? envelopeToTableView(result.envelope) : simDoneView(result);
    }
    case 'graph-done': {
      return result.envelope ? envelopeToTableView(result.envelope) : graphDoneView(result);
    }
    case 'gate-done': {
      return linesView(result.lines);
    }
    case 'graph-status': {
      return linesView(result.lines);
    }
    case 'list-checks': {
      return viewListChecks(result);
    }
    case 'list-recipes': {
      return viewListRecipes(result);
    }
    case 'history': {
      return viewHistory(result);
    }
    case 'dashboard': {
      return viewDashboard(result);
    }
    case 'init': {
      return viewInit(result);
    }
    case 'experimental': {
      return viewExperimental(result);
    }
    case 'plugin-list':
    case 'plugin-add':
    case 'plugin-remove':
    case 'plugin-sync': {
      return viewPlugin(result);
    }
    case 'clear-done': {
      return viewClearDone(result);
    }
    case 'configure-done': {
      return viewConfigureDone(result);
    }
    case 'uninstall-done': {
      return viewUninstallDone(result);
    }
    case 'help': {
      return viewHelp();
    }
  }
}
