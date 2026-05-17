/**
 * Tests for the SARIF renderer (a thin wrapper around fitness's
 * buildSarifLog).
 */

import { describe, expect, it } from 'vitest';

import { buildCliOutput } from '../../render/json.js';
import { renderSarif } from '../../render/sarif.js';

import type { CliOutput } from '@opensip-tools/contracts';

describe('renderSarif', () => {
  it('produces a SARIF 2.1.0 log with one run per CliOutput', () => {
    const cliOutput = buildCliOutput([], 'graph');
    const sarifText = renderSarif(cliOutput);
    const parsed = JSON.parse(sarifText) as { version: string; runs: unknown[] };
    expect(parsed.version).toBe('2.1.0');
    expect(Array.isArray(parsed.runs)).toBe(true);
  });

  it('includes findings as SARIF results', () => {
    const cliOutput: CliOutput = {
      version: '1.0',
      tool: 'graph',
      timestamp: '2026-05-17T00:00:00.000Z',
      recipe: 'graph',
      score: 99,
      passed: true,
      summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
      checks: [
        {
          checkSlug: 'graph:orphan-subtree',
          passed: false,
          violationCount: 1,
          findings: [
            {
              ruleId: 'graph:orphan-subtree',
              message: 'orphan',
              severity: 'warning',
              filePath: 'src/a.ts',
              line: 1,
              column: 0,
            },
          ],
          durationMs: 0,
        },
      ],
      durationMs: 0,
    };
    const sarifText = renderSarif(cliOutput);
    const parsed = JSON.parse(sarifText) as { runs: { results: unknown[] }[] };
    expect(parsed.runs.length).toBeGreaterThan(0);
    const totalResults = parsed.runs.reduce((n, r) => n + r.results.length, 0);
    expect(totalResults).toBeGreaterThanOrEqual(1);
  });
});
