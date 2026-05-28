/**
 * Render helpers for `graph --workspace` output — both the human
 * terminal report and the JSON shape. Extracted from `cli/graph.ts`
 * to keep the dispatcher file under the file-length-limit fitness
 * check.
 */

import type { WorkspaceUnitRunResult } from './workspace-runner.js'

const FINDINGS_PREVIEW = 10

/**
 * Write the human-readable workspace report to stdout.
 */
export function writeWorkspaceReport(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): void {
  const totalFindings = perUnit.reduce((n, r) => n + r.findings.length, 0)
  const lines: string[] = [
    'opensip-tools graph --workspace',
    '',
    `== Units (${String(perUnit.length)}) ==`,
    ...renderWorkspaceStatusLines(perUnit),
    '',
    '== Findings ==',
    ...renderWorkspaceFindingsLines(perUnit),
    '== Summary ==',
    `${String(totalFindings)} total finding(s) across ${String(perUnit.length)} unit(s) in ${String(durationMs)} ms.`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Render the JSON document for `graph --workspace --json`.
 */
export function renderWorkspaceJson(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): string {
  return JSON.stringify(
    {
      version: '1.0',
      tool: 'graph',
      command: 'graph',
      mode: 'workspace',
      timestamp: new Date().toISOString(),
      durationMs,
      units: perUnit.map((r) => ({
        unitId: r.unitId,
        rootDir: r.rootDir,
        displayPath: r.displayPath,
        exitCode: r.exitCode,
        findings: r.findings,
      })),
      totalFindings: perUnit.reduce((n, r) => n + r.findings.length, 0),
    },
    null,
    2,
  )
}

function renderWorkspaceStatusLines(
  perUnit: readonly WorkspaceUnitRunResult[],
): readonly string[] {
  const out: string[] = []
  for (const r of perUnit) {
    const status = r.exitCode === 0 ? 'ok' : `FAILED (exit ${String(r.exitCode)})`
    const display = unitDisplay(r)
    out.push(`  ${display}: ${String(r.findings.length)} finding(s) — ${status}`)
    if (r.exitCode !== 0 && r.stderr.length > 0) {
      const stderrPreview = r.stderr.split('\n').slice(0, 3).join('\n    ')
      out.push(`    stderr: ${stderrPreview}`)
    }
  }
  return out
}

function renderWorkspaceFindingsLines(
  perUnit: readonly WorkspaceUnitRunResult[],
): readonly string[] {
  const out: string[] = []
  for (const r of perUnit) {
    if (r.findings.length === 0) continue
    out.push(`[${unitDisplay(r)}]`, ...renderUnitFindingPreview(r), '')
  }
  return out
}

function renderUnitFindingPreview(r: WorkspaceUnitRunResult): readonly string[] {
  const preview = r.findings.slice(0, FINDINGS_PREVIEW)
  const lines = preview.map((f) => {
    const loc = typeof f.line === 'number' ? `:${String(f.line)}` : ''
    return `  ${f.filePath}${loc} — ${f.message}`
  })
  if (r.findings.length > preview.length) {
    lines.push(
      `  ... ${String(r.findings.length - preview.length)} more (use --json for full list)`,
    )
  }
  return lines
}

function unitDisplay(r: WorkspaceUnitRunResult): string {
  return r.displayPath.length > 0 ? r.displayPath : r.rootDir
}
