import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { buildSarifLog, chunkSarifRuns, reportToCloud } from '../sarif.js';

import type { CliOutput } from '@opensip-tools/contracts';

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

  it('omits the region key when neither line nor column is set', () => {
    const out: CliOutput = {
      ...makeSampleOutput(),
      checks: [
        {
          checkSlug: 'no-position',
          passed: false,
          durationMs: 1,
          findings: [
            {
              ruleId: 'no-position',
              message: 'file-level finding',
              severity: 'warning',
              filePath: 'src/x.ts',
              // No line, no column → region object stays empty.
            },
          ],
        },
      ],
    };
    const sarif = buildSarifLog(out);
    const result = sarif.runs[0]?.results[0] as { locations?: { physicalLocation: { region?: unknown } }[] };
    expect(result.locations?.[0]?.physicalLocation.region).toBeUndefined();
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

// ─── reportToCloud ────────────────────────────────────────────────

function makeOutputWithFindings(count: number, severity: 'error' | 'warning' = 'error'): CliOutput {
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: '2026-03-31T00:00:00.000Z',
    score: 0,
    passed: false,
    summary: { total: 1, passed: 0, failed: 1, errors: count, warnings: 0 },
    durationMs: 100,
    checks: [
      {
        checkSlug: 'demo-check',
        passed: false,
        durationMs: 100,
        findings: Array.from({ length: count }, (_, i) => ({
          ruleId: 'demo-check',
          message: `finding ${i}`,
          severity,
          filePath: 'src/x.ts',
          line: i + 1,
        })),
      },
    ],
  };
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function urlString(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request — has a .url string property
  return input.url;
}

describe('reportToCloud', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns success with findingCount=0 when there are no runs', async () => {
    const output: CliOutput = {
      version: '1.0',
      tool: 'fit',
      timestamp: '2026-03-31T00:00:00.000Z',
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      durationMs: 0,
      checks: [],
    };
    const result = await reportToCloud(output, 'https://example.test/api');
    expect(result.success).toBe(true);
    expect(result.findingCount).toBe(0);
    expect(result.runCount).toBe(0);
  });

  it('appends /sarif suffix when not present', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn((url: FetchInput) => {
      seenUrls.push(urlString(url));
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const result = await reportToCloud(makeOutputWithFindings(2), 'https://example.test/api');
    expect(seenUrls[0]).toContain('/sarif');
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.test/api/sarif');
  });

  it('does not double-append /sarif when already present', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn((url: FetchInput) => {
      seenUrls.push(urlString(url));
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const result = await reportToCloud(makeOutputWithFindings(1), 'https://example.test/api/sarif');
    const matches = seenUrls[0]?.match(/\/sarif/g);
    expect(matches).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it('forwards X-API-Key header when an apiKey is provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn((_url: FetchInput, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    await reportToCloud(makeOutputWithFindings(1), 'https://example.test', 'secret-key');
    expect(capturedHeaders['X-API-Key']).toBe('secret-key');
  });

  it('returns success=false with the response error on a non-transient (4xx) status', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('bad request body', { status: 400, statusText: 'Bad Request' })),
    );

    const result = await reportToCloud(makeOutputWithFindings(1), 'https://example.test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
    expect(result.chunksSucceeded).toBe(0);
  });

  it('aborts remaining chunks when a chunk returns 4xx', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls++;
      return Promise.resolve(new Response('forbidden', { status: 403 }));
    });

    const result = await reportToCloud(makeOutputWithFindings(1200), 'https://example.test');
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
  });

  it('treats 5xx as transient and continues to remaining chunks', async () => {
    // withRetry only retries when the awaited fn THROWS. A resolved
    // 500 response is not an exception, so each chunk gets one fetch
    // call. The 5xx classifier prevents the early break used for 4xx,
    // so all chunks are still attempted.
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls++;
      return Promise.resolve(new Response('server down', { status: 500 }));
    });

    // Two chunks (700 findings, cap = 500) -> two fetch attempts.
    const result = await reportToCloud(makeOutputWithFindings(700), 'https://example.test');
    expect(result.success).toBe(false);
    expect(calls).toBe(2);
    expect(result.chunksSucceeded).toBe(0);
  }, 30_000);

  it('captures fetch rejections (network errors) without breaking the run', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ECONNRESET')));

    const result = await reportToCloud(makeOutputWithFindings(1), 'https://example.test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNRESET');
  }, 30_000);

  it('aggregates per-chunk results (chunksTotal / chunksSucceeded)', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })));

    const result = await reportToCloud(makeOutputWithFindings(1200), 'https://example.test');
    expect(result.success).toBe(true);
    expect(result.chunksTotal).toBe(3);
    expect(result.chunksSucceeded).toBe(3);
    expect(result.findingCount).toBe(1200);
  });
});

