import { describe, it, expect } from 'vitest';

import { buildSarifLog, chunkSarifRuns } from '../sarif.js';

import type { CliOutput } from '@opensip-tools/cli-shared';

function makeSampleOutput(): CliOutput {
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: '2026-03-31T00:00:00.000Z',
    score: 85,
    passed: true,
    summary: { total: 2, passed: 1, failed: 1, errors: 2, warnings: 1 },
    durationMs: 1500,
    checks: [
      {
        checkSlug: 'no-console-log',
        passed: false,
        durationMs: 100,
        findings: [
          {
            ruleId: 'no-console-log',
            message: 'console.log found',
            severity: 'error',
            filePath: 'src/index.ts',
            line: 42,
            column: 5,
          },
          {
            ruleId: 'no-console-log',
            message: 'console.warn found',
            severity: 'warning',
            filePath: 'src/utils.ts',
            line: 10,
            suggestion: 'Use a logger',
          },
        ],
      },
      {
        checkSlug: 'require-error-handling',
        passed: true,
        durationMs: 80,
        findings: [],
      },
    ],
  };
}

describe('buildSarifLog', () => {
  it('returns SARIF 2.1.0 structure', () => {
    const sarif = buildSarifLog(makeSampleOutput());

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
    expect(Array.isArray(sarif.runs)).toBe(true);
  });

  it('creates one run per check with findings', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as Record<string, unknown>[];

    // Only 1 check has findings (no-console-log); require-error-handling has 0
    expect(runs).toHaveLength(1);
  });

  it('uses check slug as tool driver name', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as { tool: { driver: { name: string } } }[];

    expect(runs[0].tool.driver.name).toBe('no-console-log');
  });

  it('includes file locations in results', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as { results: Record<string, unknown>[] }[];
    const results = runs[0].results;

    expect(results).toHaveLength(2);

    // First result has full location
    const first = results[0] as { locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine?: number; startColumn?: number } } }[] };
    expect(first.locations[0].physicalLocation.artifactLocation.uri).toBe('src/index.ts');
    expect(first.locations[0].physicalLocation.region.startLine).toBe(42);
    expect(first.locations[0].physicalLocation.region.startColumn).toBe(5);
  });

  it('maps severity to SARIF levels', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as { results: { level: string }[] }[];
    const results = runs[0].results;

    expect(results[0].level).toBe('error');
    expect(results[1].level).toBe('warning');
  });

  it('includes suggestions as fixes', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as { results: Record<string, unknown>[] }[];
    const second = runs[0].results[1] as { fixes: { description: { text: string } }[] };

    expect(second.fixes[0].description.text).toBe('Use a logger');
  });

  it('includes rule IDs in driver rules', () => {
    const sarif = buildSarifLog(makeSampleOutput());
    const runs = sarif.runs as { tool: { driver: { rules: { id: string }[] } } }[];

    const ruleIds = runs[0].tool.driver.rules.map((r) => r.id);
    expect(ruleIds).toContain('no-console-log');
  });

  it('returns empty runs for output with no findings', () => {
    const output = makeSampleOutput();
    // Clear all findings
    const cleanOutput: CliOutput = {
      ...output,
      checks: output.checks.map((ch) => ({ ...ch, findings: [] })),
    };

    const sarif = buildSarifLog(cleanOutput);
    const runs = sarif.runs as unknown[];
    expect(runs).toHaveLength(0);
  });
});

// ─── chunkSarifRuns ───────────────────────────────────────────────

function makeRun(name: string, findingCount: number) {
  return {
    tool: {
      driver: {
        name,
        version: '1.0.0',
        rules: [{ id: name }],
      },
    },
    results: Array.from({ length: findingCount }, (_, i) => ({
      ruleId: name,
      message: { text: `finding ${i}` },
      level: 'warning',
    })),
  };
}

describe('chunkSarifRuns', () => {
  it('returns empty array for empty runs', () => {
    expect(chunkSarifRuns([])).toEqual([]);
  });

  it('keeps small runs in a single chunk', () => {
    const runs = [makeRun('a', 100), makeRun('b', 200)];
    const chunks = chunkSarifRuns(runs, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it('splits into multiple chunks when findings exceed limit', () => {
    const runs = [makeRun('a', 300), makeRun('b', 300)];
    const chunks = chunkSarifRuns(runs, 500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0][0].results).toHaveLength(300);
    expect(chunks[1][0].results).toHaveLength(300);
  });

  it('splits a single large run across multiple chunks', () => {
    const runs = [makeRun('big', 1200)];
    const chunks = chunkSarifRuns(runs, 500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0][0].results).toHaveLength(500);
    expect(chunks[1][0].results).toHaveLength(500);
    expect(chunks[2][0].results).toHaveLength(200);
    // Each split chunk preserves the tool driver name
    for (const chunk of chunks) {
      expect(chunk[0].tool.driver.name).toBe('big');
    }
  });

  it('preserves total finding count across all chunks', () => {
    const runs = [makeRun('a', 450), makeRun('b', 300), makeRun('c', 750)];
    const chunks = chunkSarifRuns(runs, 500);
    const total = chunks.reduce(
      (sum, chunk) => sum + chunk.reduce((s, r) => s + r.results.length, 0),
      0,
    );
    expect(total).toBe(1500);
  });

  it('packs multiple small runs into one chunk up to the limit', () => {
    const runs = [makeRun('a', 100), makeRun('b', 100), makeRun('c', 100), makeRun('d', 100), makeRun('e', 100)];
    const chunks = chunkSarifRuns(runs, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it('starts a new chunk when next run would exceed limit', () => {
    const runs = [makeRun('a', 400), makeRun('b', 400)];
    const chunks = chunkSarifRuns(runs, 500);
    expect(chunks).toHaveLength(2);
  });
});
