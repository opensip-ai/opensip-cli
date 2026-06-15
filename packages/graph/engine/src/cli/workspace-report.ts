/**
 * Render helpers for `graph --workspace` output — both the human
 * terminal report and the JSON shape. Extracted from `cli/graph.ts`
 * to keep the dispatcher file under the file-length-limit fitness
 * check.
 */

import type { WorkspaceUnitRunResult } from './workspace-runner.js';
import type { ToolCliContext } from '@opensip-cli/core';

const FINDINGS_PREVIEW = 10;

/**
 * Compose the human-readable workspace report as plain lines (no Ink twin),
 * for the render seam.
 */
export function workspaceReportLines(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): readonly string[] {
  const totalFindings = perUnit.reduce((n, r) => n + r.signals.length, 0);
  return [
    'opensip graph --workspace',
    '',
    `== Units (${String(perUnit.length)}) ==`,
    ...renderWorkspaceStatusLines(perUnit),
    '',
    '== Findings ==',
    ...renderWorkspaceFindingsLines(perUnit),
    '== Summary ==',
    `${String(totalFindings)} total finding(s) across ${String(perUnit.length)} unit(s) in ${String(durationMs)} ms.`,
  ];
}

/**
 * Render the human-readable workspace report through the seam (Ink on TTY,
 * plain text in pipes/CI) rather than writing to stdout directly.
 */
export async function writeWorkspaceReport(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
  cli: ToolCliContext,
): Promise<void> {
  await cli.render({ type: 'graph-status', lines: workspaceReportLines(perUnit, durationMs) });
}

/**
 * Build the JSON document object for `graph --workspace --json`. Returns the
 * plain object so the dispatcher can route it through the CLI's `emitJson`
 * seam (ADR-0011: tools emit, the composition root owns the stdout IO),
 * instead of writing to `process.stdout` directly.
 */
export function buildWorkspaceJsonDocument(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): Record<string, unknown> {
  return {
    version: '1.0',
    tool: 'graph',
    command: 'graph',
    mode: 'workspace',
    // Workspace-specific artifact timestamp (for the --workspace JSON/report document).
    // This is *not* the StoredSession row: the parent handler RETURNS the single
    // aggregate session contribution for the whole --workspace invocation and the
    // host run plane persists it (children are carrier --json and do not write
    // sessions). This keeps user-facing workspace docs with their own clocks while
    // the durable history row is host-stamped from the RunTimer.
    timestamp: new Date().toISOString(),
    durationMs,
    units: perUnit.map((r) => ({
      unitId: r.unitId,
      rootDir: r.rootDir,
      displayPath: r.displayPath,
      exitCode: r.exitCode,
      signals: r.signals,
    })),
    totalFindings: perUnit.reduce((n, r) => n + r.signals.length, 0),
  };
}

/**
 * Render the JSON document for `graph --workspace --json` as a string.
 * Retained for unit-test ergonomics; the dispatcher emits the object via
 * `cli.emitJson` (which applies the same `JSON.stringify(_, null, 2)`).
 */
export function renderWorkspaceJson(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): string {
  return JSON.stringify(buildWorkspaceJsonDocument(perUnit, durationMs), null, 2);
}

function renderWorkspaceStatusLines(perUnit: readonly WorkspaceUnitRunResult[]): readonly string[] {
  const out: string[] = [];
  for (const r of perUnit) {
    const status = r.exitCode === 0 ? 'ok' : `FAILED (exit ${String(r.exitCode)})`;
    const display = unitDisplay(r);
    out.push(`  ${display}: ${String(r.signals.length)} finding(s) — ${status}`);
    if (r.exitCode !== 0 && r.stderr.length > 0) {
      const stderrPreview = r.stderr.split('\n').slice(0, 3).join('\n    ');
      out.push(`    stderr: ${stderrPreview}`);
    }
  }
  return out;
}

function renderWorkspaceFindingsLines(
  perUnit: readonly WorkspaceUnitRunResult[],
): readonly string[] {
  const out: string[] = [];
  for (const r of perUnit) {
    if (r.signals.length === 0) continue;
    out.push(`[${unitDisplay(r)}]`, ...renderUnitFindingPreview(r), '');
  }
  return out;
}

function renderUnitFindingPreview(r: WorkspaceUnitRunResult): readonly string[] {
  const preview = r.signals.slice(0, FINDINGS_PREVIEW);
  const lines = preview.map((s) => {
    const loc = typeof s.line === 'number' ? `:${String(s.line)}` : '';
    return `  ${s.filePath}${loc} — ${s.message}`;
  });
  if (r.signals.length > preview.length) {
    lines.push(
      `  ... ${String(r.signals.length - preview.length)} more (use --json for full list)`,
    );
  }
  return lines;
}

function unitDisplay(r: WorkspaceUnitRunResult): string {
  return r.displayPath.length > 0 ? r.displayPath : r.rootDir;
}
