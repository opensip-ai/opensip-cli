/**
 * resultToView — the single `CommandResult → ViewNode` mapping.
 *
 * This is the cli-side counterpart to the cli-ui interpreters: each
 * command result is expressed once as a renderer-agnostic view-model node,
 * which the seam (`bootstrap/render.ts`) then renders through `renderToInk`
 * (TTY) or `renderToText` (pipe/CI). Because both media consume the same
 * node, interactive and non-interactive output cannot drift.
 *
 * Migration is phased: types not yet expressed here return `null`, and the
 * seam falls back to the legacy Ink `App` for them (TTY only). As types
 * migrate, the fallback shrinks; when the last type is migrated the
 * fallback is removed (plan Phase 5).
 *
 * cli may depend on both `@opensip-tools/contracts` (for `CommandResult`)
 * and `@opensip-tools/cli-ui` (for the view-model). The keystone boundary
 * only forbids the reverse — cli-ui must never import contracts.
 */

import { line, group, type Span, type ViewNode } from '@opensip-tools/cli-ui';

import type { CommandResult, SimDoneResult, ErrorResult } from '@opensip-tools/contracts';

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
 * Map a result to its view-model node, or `null` if this result type is
 * not yet migrated (the seam then renders it via the legacy Ink App).
 */
export function resultToView(result: CommandResult): ViewNode | null {
  switch (result.type) {
    case 'error':
      return errorView(result);
    case 'sim-done':
      return simDoneView(result);
    default:
      return null;
  }
}
