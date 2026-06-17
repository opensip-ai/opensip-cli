// @fitness-ignore-file file-length-limit -- the one result→view dispatch switch grows a case per CommandResult variant; the view BODIES already live in ui/views/* (init, misc, plugin, tools) and cli-ui, so what remains is the irreducible switch + shared envelope-table helpers. Splitting the switch would fragment the single dispatch surface (cf. command-results.ts's identical waiver for the union itself).
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
 * cli may depend on both `@opensip-cli/contracts` (for `CommandResult`)
 * and `@opensip-cli/cli-ui` (for the view-model). The keystone boundary
 * only forbids the reverse — cli-ui must never import contracts.
 */

import {
  line,
  group,
  viewRunSummary,
  viewFooterHints,
  viewVerboseLines,
  viewFindingsGroups,
  VERBOSE_DETAIL_HINT,
  formatValidatedColumn,
  parseValidatedCount,
  sortFitRowPriority,
  type Span,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';
import {
  formatSignalTableRows,
  formatSignalTableSummary,
  type SignalTableRow,
} from '@opensip-cli/output';

import { viewInit } from './views/init-view.js';
import {
  viewListChecks,
  viewListRecipes,
  viewHistory,
  viewSimNotice,
  viewReport,
  viewClearDone,
  viewConfigureDone,
  viewUninstallDone,
  viewHelp,
} from './views/misc-views.js';
import { viewPlugin } from './views/plugin-view.js';
import {
  viewToolsDataPurge,
  viewToolsInstall,
  viewToolsList,
  viewToolsUninstall,
  viewToolsValidate,
} from './views/tools-views.js';

import type {
  CommandResult,
  ErrorResult,
  GraphDoneResult,
  SessionReplayResult,
  SignalEnvelope,
  VerboseDetail,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

/**
 * Resolve the top-level run duration for a summary line.
 *
 * host-owned-run-timing Phase 4: this is the EXPLICIT value the host caller
 * stamps onto the done result from the host run lifecycle (the same duration
 * the host writes to `StoredSession.durationMs`). The former `currentScope()`
 * scope-stash heuristic — which probed an imagined `runSession.timing` on the
 * RunScope — is gone (nothing ever stashed it; it always degraded to 0). The
 * `?? 0` is only a defensive default for an error path or a very early failure
 * before any lifecycle/duration exists.
 */
function resolveSummaryDuration(explicit?: number): number {
  return explicit ?? 0;
}

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

/**
 * The graph report: an optional verbose body, an optional fast-tier
 * caveat, the shared summary line, and the shared footer hints. The
 * summary/hints reuse the cli-ui producers, so graph's piped and TTY
 * output match each other and the live view — no hand-maintained
 * plain-text copies (which previously lived in graph-report.ts).
 */
function graphDoneView(result: GraphDoneResult): ViewNode {
  const children: ViewNode[] = [];
  if (result.verboseDetail !== undefined) {
    children.push(renderVerboseDetail(result.verboseDetail), SPACER);
  }
  if (result.resolutionBanner !== undefined) {
    children.push(line([{ text: result.resolutionBanner, tone: 'muted' }]));
  }
  // ADR-0035: the headline verdict is PASS/FAIL. graph-done carries count-based
  // summary (no envelope verdict on this report path), so derive the verdict from
  // graph's default policy — fail on any error-rung finding ({failOnErrors:1}).
  children.push(
    viewRunSummary({
      passed: result.summary.errors === 0,
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      durationMs: resolveSummaryDuration(result.durationMs),
    }),
  );
  // Non-verbose run: show the shared "Use --verbose…" hint plus graph's
  // report hint (ADR-0021 — one source for the verbose-hint string).
  if (result.verboseDetail === undefined) {
    children.push(
      viewFooterHints([
        VERBOSE_DETAIL_HINT,
        { text: 'opensip report for HTML report', bold: ['opensip report'] },
      ]),
    );
  }
  return group(children);
}

/**
 * A replayed session (`sessions show` / `--show`). Uniform across tools: a
 * compact session header + the SAME shared envelope→table view a live run uses
 * (so a replayed graph session shows its per-rule table too), and deliberately
 * NO live-run footer ("Use --verbose" / "report") — that is fresh-run guidance,
 * meaningless for a replay. ADR-0011: the projected envelope is the one currency.
 */
function sessionReplayView(result: SessionReplayResult): ViewNode {
  const s = result.session;
  const when = new Date(s.startedAt).toLocaleString();
  const verdictTone: Tone = s.passed ? 'success' : 'error';
  return group([
    line([
      { text: 'Session ', bold: true },
      { text: s.id },
      { text: `  ·  ${s.tool}`, tone: 'brand' },
      { text: `  ·  ${when}`, tone: 'muted' },
    ]),
    line([
      { text: `${s.score}%`, tone: verdictTone },
      { text: '  ' },
      { text: s.passed ? 'PASS' : 'FAIL', tone: verdictTone },
      ...(s.recipe === undefined
        ? []
        : [{ text: `  ·  recipe ${s.recipe}`, tone: 'muted' as Tone }]),
      { text: `  ·  replayed (${result.fidelity})`, tone: 'muted' },
    ]),
    SPACER,
    envelopeToTableView(result.envelope),
  ]);
}

/** Pre-composed lines rendered verbatim through both media (gate output, graph status). */
function linesView(lines: readonly string[]): ViewNode {
  return group(lines.map((l) => line([{ text: l }])));
}

function titledLinesView(title: string | undefined, lines: readonly string[]): ViewNode {
  const children: ViewNode[] = [];
  if (title !== undefined && title.length > 0) {
    children.push(line([{ text: title, bold: true }]));
    if (lines.length > 0) children.push(SPACER);
  }
  children.push(...lines.map((l) => line([{ text: l }])));
  return group(children);
}

/** @throws {Error} When the closed command-result union and renderer drift. */
function assertNever(result: never): never {
  throw new Error(`Unhandled command result '${JSON.stringify(result)}'`);
}

// --- Envelope-derived terminal table (ADR-0011) -----------------------------
//
// The single, tool-agnostic table derivation: every migrated tool's result
// carries a `SignalEnvelope`, and the terminal table is derived FROM its
// `units` + `signals` via the shared `formatSignalTableRows` / `Summary`
// formatters (`@opensip-cli/output`). One row per unit (check / rule /
// scenario). Replaces the three per-tool, pre-computed `rows`/`reportLines`
// shapes (the fit/sim/graph `*DoneResult` legacy branches, retired in Phase 7).

const ENV_COL = {
  status: 7,
  errors: 6,
  warnings: 8,
  validated: 12,
  ignored: 7,
  duration: 10,
} as const;

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

/** Ignored-ratio tone: red >10%, yellow >5%, else muted (parity with the live view). */
function envIgnoredTone(ignored: number, validatedCell: string): Tone {
  const total = parseValidatedCount(validatedCell);
  if (total === 0 || ignored === 0) return 'muted';
  const pct = (ignored / total) * 100;
  if (pct > 10) return 'error';
  if (pct > 5) return 'warning';
  return 'muted';
}

const ENV_SEP: Span = { text: ' | ' };

/**
 * Fixed-width per-unit table from the envelope's signal-table rows, or null
 * when empty. Renders fitness's `Validated`/`Ignores` columns when ANY row
 * carries `validated` (a per-unit fact on {@link UnitResult}); graph/sim rows
 * omit them, so those tools' tables stay the lean 5-column form.
 */
function envelopeTableNode(rows: readonly SignalTableRow[]): ViewNode | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => sortFitRowPriority(a) - sortFitRowPriority(b));
  const unitW = Math.max(40, ...sorted.map((r) => r.unit.length));
  const showValidated = sorted.some((r) => r.validated !== undefined);

  const headerCells = [
    'Unit'.padEnd(unitW),
    'Status'.padEnd(ENV_COL.status),
    'Errors'.padEnd(ENV_COL.errors),
    'Warnings'.padEnd(ENV_COL.warnings),
    ...(showValidated
      ? ['Validated'.padEnd(ENV_COL.validated), 'Ignores'.padEnd(ENV_COL.ignored)]
      : []),
    'Duration'.padEnd(ENV_COL.duration),
  ];
  const sepCells = [
    '-'.repeat(unitW),
    '-'.repeat(ENV_COL.status),
    '-'.repeat(ENV_COL.errors),
    '-'.repeat(ENV_COL.warnings),
    ...(showValidated ? ['-'.repeat(ENV_COL.validated), '-'.repeat(ENV_COL.ignored)] : []),
    '-'.repeat(ENV_COL.duration),
  ];
  const header = line([{ text: headerCells.join(' | ') }]);
  const separator = line([{ text: sepCells.join('-|-') }]);

  const rowNodes = sorted.map((r) => {
    const validatedCell = formatValidatedColumn(r.validated, r.itemType);
    const spans: Span[] = [
      { text: r.unit.padEnd(unitW) },
      ENV_SEP,
      { text: r.status.padEnd(ENV_COL.status), tone: envStatusTone(r.status) },
      ENV_SEP,
      { text: String(r.errors).padEnd(ENV_COL.errors), tone: r.errors > 0 ? 'error' : 'success' },
      ENV_SEP,
      {
        text: String(r.warnings).padEnd(ENV_COL.warnings),
        tone: r.warnings > 0 ? 'warning' : 'muted',
      },
    ];
    if (showValidated) {
      spans.push(ENV_SEP, { text: validatedCell.padEnd(ENV_COL.validated) }, ENV_SEP, {
        text: String(r.ignored ?? 0).padEnd(ENV_COL.ignored),
        tone: envIgnoredTone(r.ignored ?? 0, validatedCell),
      });
    }
    spans.push(ENV_SEP, {
      text: r.duration.padEnd(ENV_COL.duration),
      tone: envDurationTone(r.durationMs),
    });
    return line(spans);
  });

  return group([header, separator, ...rowNodes]);
}

/**
 * Render a tool's verbose detail body (ADR-0021) as a `ViewNode`, switching on
 * the union `kind`. `lines` → verbatim text (graph's catalog/findings dump);
 * `findings` → the shared coloured findings blocks (fit/sim). Rendered through
 * the same seam as everything else, so a tool's `--verbose` output is identical
 * in a TTY and a pipe.
 */
export function renderVerboseDetail(detail: VerboseDetail): ViewNode {
  return detail.kind === 'lines'
    ? viewVerboseLines(detail.lines)
    : viewFindingsGroups(detail.groups);
}

/**
 * Append the shared non-verbose footer (the "Use --verbose…" hint + the
 * report hint) to a view when `show` is true (ADR-0021). Used by the
 * envelope-backed tools (fit/sim) so a non-verbose run nudges toward the detail
 * body and the HTML report — parity with graph's footer.
 */
function withVerboseHint(node: ViewNode, show: boolean): ViewNode {
  if (!show) return node;
  return group([
    node,
    viewFooterHints([
      VERBOSE_DETAIL_HINT,
      { text: 'opensip report for HTML report', bold: ['opensip report'] },
    ]),
  ]);
}

/**
 * The shared envelope → terminal-table view. Used by every migrated tool's
 * result (fit/sim always; graph when it carries an envelope). The per-tool
 * `rows`/`reportLines` legacy derivations it once fell back to were retired in
 * Phase 7 (ADR-0011).
 *
 * When `verboseDetail` is present (a `--verbose` run), its rendered body is
 * prepended above the per-unit table (ADR-0021).
 */
export function envelopeToTableView(
  envelope: SignalEnvelope,
  verboseDetail?: VerboseDetail,
): ViewNode {
  const rows = formatSignalTableRows(envelope);
  const summary = formatSignalTableSummary(envelope);
  const children: ViewNode[] = [];
  if (verboseDetail !== undefined) {
    children.push(renderVerboseDetail(verboseDetail), SPACER);
  }
  const table = envelopeTableNode(rows);
  if (table !== null) children.push(table);
  children.push(
    viewRunSummary({
      // ADR-0035: the headline is the run's single verdict; the per-unit
      // passed/failed counts live in the table rows above.
      passed: envelope.verdict.passed,
      errors: summary.totalErrors,
      warnings: summary.totalWarnings,
      durationMs: resolveSummaryDuration(summary.durationMs),
    }),
  );
  return group(children);
}

/** Map any CommandResult to its view-model node (total — every variant covered). */
export function resultToView(result: CommandResult): ViewNode {
  switch (result.type) {
    // fit (Phase 6) and sim (Phase 4) are both envelope-backed: the terminal
    // table is derived from the envelope (one row per check/scenario unit) and
    // the optional verbose body + non-verbose "Use --verbose…" hint render
    // through the one shared seam (ADR-0011/ADR-0021), identically in TTY/pipe.
    case 'fit-done':
    case 'sim-done': {
      return withVerboseHint(
        envelopeToTableView(result.envelope, result.verboseDetail),
        result.verboseDetail === undefined,
      );
    }
    case 'error': {
      return errorView(result);
    }
    case 'graph-done': {
      // graph keeps its own rich report view (it delivers signals via an
      // explicit `cli.deliverSignals(...)` call, not via a result envelope).
      return graphDoneView(result);
    }
    case 'gate-done': {
      return linesView(result.lines);
    }
    case 'graph-status': {
      return linesView(result.lines);
    }
    case 'text-lines': {
      return titledLinesView(result.title, result.lines);
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
    case 'session-replay': {
      return sessionReplayView(result);
    }
    case 'report': {
      return viewReport(result);
    }
    case 'init': {
      return viewInit(result);
    }
    case 'sim-notice': {
      return viewSimNotice(result);
    }
    case 'tools-list': {
      return viewToolsList(result);
    }
    case 'tools-validate': {
      return viewToolsValidate(result);
    }
    case 'tools-install': {
      return viewToolsInstall(result);
    }
    case 'tools-uninstall': {
      return viewToolsUninstall(result);
    }
    case 'tools-data-purge': {
      return viewToolsDataPurge(result);
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
    default: {
      return assertNever(result);
    }
  }
}
