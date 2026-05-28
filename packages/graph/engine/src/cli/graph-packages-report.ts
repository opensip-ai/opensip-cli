/**
 * @fileoverview Reporting helpers for the `graph --packages` fan-out
 * mode. Extracted from `cli/graph.ts` so the orchestrator there stays
 * focused on dispatch.
 *
 * Owns the per-package status / findings preview lines, the
 * `writePackagesReport` stdout writer, and the `--json` envelope for
 * fan-out output.
 */

import type { PackageRunResult } from './packages-runner.js';

const FINDINGS_PREVIEW = 10;

export function writePackagesReport(
  perPackage: readonly PackageRunResult[],
  durationMs: number,
): void {
  const totalFindings = perPackage.reduce((n, r) => n + r.findings.length, 0);
  const lines: string[] = [
    'opensip-tools graph --packages',
    '',
    `== Packages (${String(perPackage.length)}) ==`,
    ...renderPackagesStatusLines(perPackage),
    '',
    '== Findings ==',
    ...renderPackagesFindingsLines(perPackage),
    '== Summary ==',
    `${String(totalFindings)} total finding(s) across ${String(perPackage.length)} package(s) in ${String(durationMs)} ms.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderPackagesStatusLines(perPackage: readonly PackageRunResult[]): readonly string[] {
  const out: string[] = [];
  for (const r of perPackage) {
    const status = r.exitCode === 0 ? 'ok' : `FAILED (exit ${String(r.exitCode)})`;
    const display = packageDisplay(r);
    out.push(`  ${display}: ${String(r.findings.length)} finding(s) — ${status}`);
    if (r.exitCode !== 0 && r.stderr.length > 0) {
      const stderrPreview = r.stderr.split('\n').slice(0, 3).join('\n    ');
      out.push(`    stderr: ${stderrPreview}`);
    }
  }
  return out;
}

function renderPackagesFindingsLines(perPackage: readonly PackageRunResult[]): readonly string[] {
  const out: string[] = [];
  for (const r of perPackage) {
    if (r.findings.length === 0) continue;
    out.push(`[${packageDisplay(r)}]`, ...renderPackageFindingPreview(r), '');
  }
  return out;
}

function renderPackageFindingPreview(r: PackageRunResult): readonly string[] {
  const preview = r.findings.slice(0, FINDINGS_PREVIEW);
  const lines = preview.map((f) => {
    const loc = typeof f.line === 'number' ? `:${String(f.line)}` : '';
    return `  ${f.filePath}${loc} — ${f.message}`;
  });
  if (r.findings.length > preview.length) {
    lines.push(`  ... ${String(r.findings.length - preview.length)} more (use --json for full list)`);
  }
  return lines;
}

function packageDisplay(r: PackageRunResult): string {
  return r.displayPath.length > 0 ? r.displayPath : r.packageDir;
}

export function renderPackagesJson(
  perPackage: readonly PackageRunResult[],
  durationMs: number,
): string {
  return JSON.stringify(
    {
      version: '1.0',
      tool: 'graph',
      command: 'graph',
      mode: 'packages',
      timestamp: new Date().toISOString(),
      durationMs,
      packages: perPackage.map((r) => ({
        packageDir: r.packageDir,
        displayPath: r.displayPath,
        exitCode: r.exitCode,
        findings: r.findings,
      })),
      totalFindings: perPackage.reduce((n, r) => n + r.findings.length, 0),
    },
    null,
    2,
  );
}
