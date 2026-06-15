/**
 * `graph --workspace` report renderers — the human terminal report and
 * the JSON shape. Both are pure functions over a `WorkspaceUnitRunResult[]`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWorkspaceJson, workspaceReportLines } from '../workspace-report.js';

import type { WorkspaceUnitRunResult } from '../workspace-runner.js';
import type { Signal } from '@opensip-cli/core';

function signal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_cycle',
    source: 'graph.architecture.cycle',
    provider: 'opensip-cli',
    severity: 'medium',
    category: 'quality',
    ruleId: 'graph.architecture.cycle',
    message: 'cyclic dependency',
    filePath: 'src/a.ts',
    line: 12,
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
    ...over,
  };
}

function unit(over: Partial<WorkspaceUnitRunResult> = {}): WorkspaceUnitRunResult {
  return {
    unitId: 'core',
    rootDir: '/abs/packages/core',
    displayPath: 'packages/core',
    signals: [],
    exitCode: 0,
    stderr: '',
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The human report is composed as plain lines (workspaceReportLines) and then
// emitted through the render seam by writeWorkspaceReport; cross-renderer
// equivalence is covered in the cli's renderer tests. Here we assert the
// content composition directly.
const text = (perUnit: readonly WorkspaceUnitRunResult[], durationMs: number): string =>
  workspaceReportLines(perUnit, durationMs).join('\n');

describe('workspaceReportLines', () => {
  it('renders an ok unit with its finding count and project-relative display path', () => {
    const out = text([unit({ signals: [signal()] })], 1234);
    expect(out).toContain('opensip graph --workspace');
    expect(out).toContain('== Units (1) ==');
    expect(out).toContain('packages/core: 1 finding(s) — ok');
    expect(out).toContain('1 total finding(s) across 1 unit(s) in 1234 ms.');
    // The single finding is previewed with its file:line and message.
    expect(out).toContain('src/a.ts:12 — cyclic dependency');
  });

  it('marks a failed unit and includes a truncated stderr preview', () => {
    const out = text([unit({ exitCode: 2, stderr: 'line1\nline2\nline3\nline4\nline5' })], 5);
    expect(out).toContain('FAILED (exit 2)');
    expect(out).toContain('stderr: line1');
    expect(out).toContain('line3');
    // Only the first three stderr lines are kept.
    expect(out).not.toContain('line4');
  });

  it('falls back to rootDir when displayPath is empty', () => {
    const out = text([unit({ displayPath: '', signals: [signal()] })], 1);
    expect(out).toContain('/abs/packages/core: 1 finding(s)');
  });

  it('omits the line suffix when a finding has no line number', () => {
    const out = text([unit({ signals: [signal({ line: undefined })] })], 1);
    expect(out).toContain('src/a.ts — cyclic dependency');
    expect(out).not.toContain('src/a.ts: ');
  });

  it('truncates a finding preview past the cap and reports the remainder', () => {
    const many = Array.from({ length: 13 }, (_v, i) =>
      signal({ message: `m${String(i)}`, line: i + 1 }),
    );
    const out = text([unit({ signals: many })], 1);
    expect(out).toContain('... 3 more (use --json for full list)');
    expect(out).toContain('13 total finding(s)');
  });
});

describe('renderWorkspaceJson', () => {
  it('produces a stable JSON document mirroring every unit', () => {
    const json = renderWorkspaceJson(
      [unit({ signals: [signal()] }), unit({ unitId: 'cli', signals: [] })],
      99,
    );
    const parsed = JSON.parse(json) as {
      version: string;
      tool: string;
      mode: string;
      durationMs: number;
      totalFindings: number;
      units: { unitId: string; signals: unknown[] }[];
    };
    expect(parsed.version).toBe('1.0');
    expect(parsed.tool).toBe('graph');
    expect(parsed.mode).toBe('workspace');
    expect(parsed.durationMs).toBe(99);
    expect(parsed.totalFindings).toBe(1);
    expect(parsed.units.map((u) => u.unitId)).toEqual(['core', 'cli']);
    expect(parsed.units[0]?.signals).toHaveLength(1);
  });
});
