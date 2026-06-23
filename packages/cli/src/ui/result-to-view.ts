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
  liveRunTable,
  viewRunSummary,
  viewFooterHints,
  viewVerboseLines,
  viewFindingsGroups,
  DEFAULT_RUN_FOOTER_HINTS,
  shouldRenderRunFooterHints,
  shouldRenderRunUnitTable,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';
import { formatSignalTableRows, formatSignalTableSummary } from '@opensip-cli/output';

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
  viewToolsCreate,
  viewToolsDataPurge,
  viewToolsDoctor,
  viewToolsInstall,
  viewToolsList,
  viewToolsUninstall,
  viewToolsValidate,
} from './views/tools-views.js';

import type {
  CommandResult,
  ErrorResult,
  RunPresentation,
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
// scenario). Replaced the three per-tool, pre-computed `rows`/`reportLines`
// shapes (the fit/sim/graph per-tool render branches, retired in Phase 7).

// The per-unit table itself is rendered by cli-ui's shared `liveRunTable`
// (ADR-0058) — the SAME producer the live (TTY) views use — so the static
// non-TTY table and the live table cannot diverge. `SignalTableRow` is
// structurally a `LiveRunTableRow` (it carries `durationMs`, which the renderer
// formats), so the rows pass straight through. The tone/width/column policy
// lives once, in `liveRunTable`.

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
 * Append the platform-owned compact-run footer to a view when `show` is true
 * (ADR-0021). The decision to show it lives in `cli-ui`'s run render policy so
 * static rendering and live runners cannot drift.
 */
function withDefaultRunFooter(node: ViewNode, show: boolean): ViewNode {
  if (!show) return node;
  return group([node, viewFooterHints(DEFAULT_RUN_FOOTER_HINTS)]);
}

/**
 * The shared envelope → terminal view. Used by every migrated tool's
 * RunPresentation. The per-tool `rows`/`reportLines` legacy derivations it once
 * fell back to were retired in Phase 7 (ADR-0011).
 *
 * When `verboseDetail` is present (a `--verbose` run), its rendered body is
 * prepended above the per-unit table (ADR-0021). Without verbose detail, callers
 * can suppress the table for the compact default run surface.
 *
 * `durationOverride` is the host-owned display duration (ADR-0051), threaded by
 * `presentationToView` from `RunPresentation.durationMs`. It WINS over the
 * envelope unit-sum: tools whose units carry no per-unit duration (graph stamps
 * `durationMs: 0`) would otherwise render a `0ms` summary. fit/sim units carry
 * real durations, so they are unaffected when no override is supplied (the
 * unit-sum fallback stays exact).
 */
export function envelopeToTableView(
  envelope: SignalEnvelope,
  verboseDetail?: VerboseDetail,
  durationOverride?: number,
  showTable = true,
): ViewNode {
  const rows = formatSignalTableRows(envelope);
  const summary = formatSignalTableSummary(envelope);
  const children: ViewNode[] = [];
  if (verboseDetail !== undefined) {
    children.push(renderVerboseDetail(verboseDetail), SPACER);
  }
  if (showTable) {
    const table = liveRunTable(rows);
    if (table !== null) children.push(table);
  }
  children.push(
    viewRunSummary({
      // ADR-0035: the headline is the run's single verdict; the per-unit
      // passed/failed counts live in the table rows above.
      passed: envelope.verdict.passed,
      errors: summary.totalErrors,
      warnings: summary.totalWarnings,
      durationMs: resolveSummaryDuration(durationOverride ?? summary.durationMs),
    }),
  );
  return group(children);
}

/**
 * The single render path for a {@link RunPresentation} (envelope-first-presentation
 * plan). Renders `p.banners` as muted lines above the run body (graph's
 * resolution caveat), delegates the verbose table+summary or default summary to
 * `envelopeToTableView` (threading `p.durationMs` as the host-owned duration
 * override), and applies the shared default footer when platform policy says the
 * run is compact — preserving the live default surface: summary only, no
 * per-unit table.
 *
 * This is the sole `resultToView` `case 'run-presentation'` target; it superseded
 * the three per-tool `*DoneResult` render cases (hard-removed in RP-3).
 */
export function presentationToView(p: RunPresentation): ViewNode {
  const children: ViewNode[] = [];
  if (p.banners !== undefined) {
    for (const banner of p.banners) {
      children.push(line([{ text: banner, tone: 'muted' }]));
    }
  }
  const verbose = p.verboseDetail !== undefined;
  const body = withDefaultRunFooter(
    envelopeToTableView(
      p.envelope,
      p.verboseDetail,
      p.durationMs,
      shouldRenderRunUnitTable({ verbose }),
    ),
    shouldRenderRunFooterHints({ verbose }),
  );
  children.push(body);
  return group(children);
}

/** Map any CommandResult to its view-model node (total — every variant covered). */
export function resultToView(result: CommandResult): ViewNode {
  switch (result.type) {
    // The render-only run-presentation adjunct (envelope-first-presentation plan):
    // the SINGLE run variant. fit/sim/graph all construct this; summary and
    // optional verbose/detail table are derived from the envelope, banners
    // (graph's resolution caveat) render above, and the shared non-verbose footer
    // below — identically in TTY/pipe.
    // It replaced the three per-tool `*DoneResult` cases (hard-removed in RP-3).
    case 'run-presentation': {
      return presentationToView(result);
    }
    case 'error': {
      return errorView(result);
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
    case 'tools-doctor': {
      return viewToolsDoctor(result);
    }
    case 'tools-create': {
      return viewToolsCreate(result);
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
