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

import { line, group, viewRunSummary, viewFooterHints, type Span, type ViewNode } from '@opensip-tools/cli-ui';

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

import type { CommandResult, SimDoneResult, ErrorResult, GraphDoneResult, GateDoneResult } from '@opensip-tools/contracts';

const SEPARATOR: ViewNode = { kind: 'separator' };
const SPACER: ViewNode = { kind: 'spacer' };

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
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

/** The gate output: pre-composed lines rendered verbatim through both media. */
function gateDoneView(result: GateDoneResult): ViewNode {
  return group(result.lines.map((l) => line([{ text: l }])));
}

/** Map any CommandResult to its view-model node (total — every variant covered). */
export function resultToView(result: CommandResult): ViewNode {
  switch (result.type) {
    case 'fit-done': {
      return viewFitDone(result);
    }
    case 'error': {
      return errorView(result);
    }
    case 'sim-done': {
      return simDoneView(result);
    }
    case 'graph-done': {
      return graphDoneView(result);
    }
    case 'gate-done': {
      return gateDoneView(result);
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
