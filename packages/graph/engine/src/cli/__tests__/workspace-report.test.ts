/**
 * `graph --workspace` report renderers — the human terminal report and
 * the JSON shape. Both are pure functions over a `WorkspaceUnitRunResult[]`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWorkspaceJson, writeWorkspaceReport } from '../workspace-report.js';

import type { WorkspaceUnitRunResult } from '../workspace-runner.js';
import type { FindingOutput } from '@opensip-tools/contracts';

function finding(over: Partial<FindingOutput> = {}): FindingOutput {
  return {
    ruleId: 'graph.cycle',
    message: 'cyclic dependency',
    severity: 'warning',
    filePath: 'src/a.ts',
    line: 12,
    ...over,
  };
}

function unit(over: Partial<WorkspaceUnitRunResult> = {}): WorkspaceUnitRunResult {
  return {
    unitId: 'core',
    rootDir: '/abs/packages/core',
    displayPath: 'packages/core',
    findings: [],
    exitCode: 0,
    stderr: '',
    ...over,
  };
}

function captureStdout(fn: () => void): string {
  let buf = '';
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return buf;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeWorkspaceReport', () => {
  it('renders an ok unit with its finding count and project-relative display path', () => {
    const out = captureStdout(() =>
      writeWorkspaceReport([unit({ findings: [finding()] })], 1234),
    );
    expect(out).toContain('opensip-tools graph --workspace');
    expect(out).toContain('== Units (1) ==');
    expect(out).toContain('packages/core: 1 finding(s) — ok');
    expect(out).toContain('1 total finding(s) across 1 unit(s) in 1234 ms.');
    // The single finding is previewed with its file:line and message.
    expect(out).toContain('src/a.ts:12 — cyclic dependency');
  });

  it('marks a failed unit and includes a truncated stderr preview', () => {
    const out = captureStdout(() =>
      writeWorkspaceReport(
        [unit({ exitCode: 2, stderr: 'line1\nline2\nline3\nline4\nline5' })],
        5,
      ),
    );
    expect(out).toContain('FAILED (exit 2)');
    expect(out).toContain('stderr: line1');
    expect(out).toContain('line3');
    // Only the first three stderr lines are kept.
    expect(out).not.toContain('line4');
  });

  it('falls back to rootDir when displayPath is empty', () => {
    const out = captureStdout(() =>
      writeWorkspaceReport([unit({ displayPath: '', findings: [finding()] })], 1),
    );
    expect(out).toContain('/abs/packages/core: 1 finding(s)');
  });

  it('omits the line suffix when a finding has no line number', () => {
    const out = captureStdout(() =>
      writeWorkspaceReport([unit({ findings: [finding({ line: undefined })] })], 1),
    );
    expect(out).toContain('src/a.ts — cyclic dependency');
    expect(out).not.toContain('src/a.ts: ');
  });

  it('truncates a finding preview past the cap and reports the remainder', () => {
    const many = Array.from({ length: 13 }, (_v, i) =>
      finding({ message: `m${String(i)}`, line: i + 1 }),
    );
    const out = captureStdout(() => writeWorkspaceReport([unit({ findings: many })], 1));
    expect(out).toContain('... 3 more (use --json for full list)');
    expect(out).toContain('13 total finding(s)');
  });
});

describe('renderWorkspaceJson', () => {
  it('produces a stable JSON document mirroring every unit', () => {
    const json = renderWorkspaceJson(
      [unit({ findings: [finding()] }), unit({ unitId: 'cli', findings: [] })],
      99,
    );
    const parsed = JSON.parse(json) as {
      version: string;
      tool: string;
      mode: string;
      durationMs: number;
      totalFindings: number;
      units: { unitId: string; findings: unknown[] }[];
    };
    expect(parsed.version).toBe('1.0');
    expect(parsed.tool).toBe('graph');
    expect(parsed.mode).toBe('workspace');
    expect(parsed.durationMs).toBe(99);
    expect(parsed.totalFindings).toBe(1);
    expect(parsed.units.map((u) => u.unitId)).toEqual(['core', 'cli']);
    expect(parsed.units[0]?.findings).toHaveLength(1);
  });
});
