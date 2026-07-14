import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareReports,
  normalizeBenchmarkReport,
  parseCompareArgs,
  renderReportComparison,
} from '../perf/compare-reports.mjs';

test('compareReports calculates deterministic duration, RSS, and graph-stage deltas', () => {
  const base = report('clean-wall', [scenario('medium', 200, 2000), scenario('small', 100, 1000)]);
  base.scenarios[1].graphProfile = {
    stages: [{ name: 'parse', durationMs: 40 }],
  };
  const head = report('clean-wall', [scenario('small', 80, 900), scenario('medium', 220, 2100)]);
  head.scenarios[0].graphProfile = {
    stages: [{ name: 'parse', durationMs: 30 }],
  };

  const comparison = compareReports(base, head);

  assert.deepEqual(
    comparison.rows.map((row) => `${row.tier}:${row.scenario}`),
    ['medium:graph-cold', 'small:graph-cold'],
  );
  assert.equal(comparison.rows[1].durationMs.delta, -20);
  assert.equal(comparison.rows[1].durationMs.percentChange, -20);
  assert.equal(comparison.rows[1].maxRssBytes.delta, -100);
  assert.deepEqual(comparison.rows[1].graphStages[0], {
    name: 'parse',
    base: 40,
    head: 30,
    delta: -10,
    percentChange: -25,
  });
});

test('normalization uses repeated-run medians and does not claim metrics for failed samples', () => {
  const normalized = normalizeBenchmarkReport({
    measurementMode: 'clean-wall',
    scenarios: [scenario('small', 30, 300), scenario('small', 10, 100), scenario('small', 20, 200)],
  });
  assert.equal(normalized.rows.get('small:graph-cold').durationMs, 20);
  assert.equal(normalized.rows.get('small:graph-cold').maxRssBytes, 200);

  const failed = report('clean-wall', [
    scenario('small', 10, 100),
    { ...scenario('small', 999, 999), status: 1 },
  ]);
  const comparison = compareReports(report('clean-wall', [scenario('small', 20, 200)]), failed);
  assert.equal(comparison.rows[0].durationMs.head, undefined);
  assert.equal(comparison.rows[0].maxRssBytes.head, undefined);
  assert.match(comparison.rows[0].warnings[0], /failed sample/u);
});

test('compareReports rejects mode mismatch unless explicitly allowed', () => {
  const clean = report('clean-wall', [scenario('small', 100, 1000)]);
  const profiled = report('cpu-profile', [scenario('small', 120, 1100)]);
  assert.throws(() => compareReports(clean, profiled), /Measurement mode mismatch/u);
  const diagnostic = compareReports(clean, profiled, {
    allowModeMismatch: true,
  });
  assert.match(diagnostic.warnings[0], /not comparable/u);
});

test('legacy reports and zero baselines remain readable without false percentages', () => {
  const base = { scenarios: [scenario('small', 0, 0)] };
  const head = report('clean-wall', [scenario('small', 1, 0)]);
  const comparison = compareReports(base, head);
  assert.match(comparison.warnings[0], /predates measurementMode/u);
  assert.equal(comparison.rows[0].durationMs.delta, undefined);
  assert.equal(comparison.rows[0].durationMs.percentChange, undefined);
  assert.equal(comparison.rows[0].maxRssBytes.percentChange, undefined);
});

test('scenario summary samples and median-shaped fields are accepted', () => {
  const normalized = normalizeBenchmarkReport({
    measurementMode: 'clean-wall',
    scenarioSummaries: [
      {
        tier: 'small',
        scenario: 'cli-help',
        label: 'CLI help',
        durationMs: { median: 12 },
        maxRssBytes: { median: 2048 },
        samples: [
          { status: 0, durationMs: 10, maxRssBytes: 1024 },
          { status: 0, durationMs: 14, maxRssBytes: 3072 },
        ],
      },
    ],
  });
  assert.equal(normalized.rows.get('small:cli-help').durationMs, 12);
  assert.equal(normalized.rows.get('small:cli-help').maxRssBytes, 2048);
});

test('declared failed aggregate samples suppress comparison metrics', () => {
  const base = report('clean-wall', [scenario('small', 10, 100)]);
  const head = {
    measurementMode: 'clean-wall',
    scenarioSummaries: [
      {
        tier: 'small',
        scenario: 'graph-cold',
        sampleCount: 3,
        failedSamples: 1,
        durationMs: { median: 8 },
      },
    ],
  };
  const comparison = compareReports(base, head);
  assert.equal(comparison.rows[0].durationMs.head, undefined);
  assert.match(comparison.rows[0].warnings[0], /failed sample/u);
});

test('comparison renderer includes metadata, scenario rows, and graph stages', () => {
  const base = report('clean-wall', [scenario('small', 100, 1024 * 1024)]);
  const head = report('clean-wall', [scenario('small', 90, 1024 * 1024)]);
  base.scenarios[0].graphProfile = {
    stages: [{ name: 'parse', durationMs: 50 }],
  };
  head.scenarios[0].graphProfile = {
    stages: [{ name: 'parse', durationMs: 40 }],
  };
  const markdown = renderReportComparison(compareReports(base, head));
  assert.match(markdown, /Base mode: clean-wall/u);
  assert.match(markdown, /small \/ graph-cold.*-10\.0%/u);
  assert.match(markdown, /## Graph stages/u);
});

test('comparison CLI args are strict and expose diagnostic mismatch mode', () => {
  assert.deepEqual(parseCompareArgs(['--base', 'a.json', '--head', 'b.json']), {
    format: 'markdown',
    allowModeMismatch: false,
    allowContextMismatch: false,
    allowRuntimeMismatch: false,
    allowToolchainMismatch: false,
    base: 'a.json',
    head: 'b.json',
  });
  assert.equal(
    parseCompareArgs([
      '--base',
      'a.json',
      '--head',
      'b.json',
      '--allow-mode-mismatch',
      '--format',
      'json',
    ]).allowModeMismatch,
    true,
  );
  assert.throws(() => parseCompareArgs(['--base', 'a.json']), /--base and --head/u);
  assert.equal(parseCompareArgs(['--help']).help, true);
});

test('comparison rejects changed benchmark context and diagnostic override suppresses deltas', () => {
  const base = report('clean-wall', [scenario('small', 100, 1000)]);
  const head = report('clean-wall', [scenario('small', 80, 900)]);
  head.quick = true;
  assert.throws(() => compareReports(base, head), /Quick\/full posture mismatch/u);
  const diagnostic = compareReports(base, head, { allowContextMismatch: true });
  assert.equal(diagnostic.comparable, false);
  assert.equal(diagnostic.rows[0].durationMs.percentChange, undefined);
});

test('toolchain comparisons reject cache and protocol changes', () => {
  const base = toolchainReport('force', ['pnpm', 'build']);
  assert.throws(
    () => compareReports(base, toolchainReport('reuse', ['pnpm', 'build'])),
    /Cache posture/u,
  );
  assert.throws(
    () => compareReports(base, toolchainReport('force', ['pnpm', 'test'])),
    /Toolchain protocol/u,
  );
});

test('runtime differences require an explicit comparison axis', () => {
  const base = report('clean-wall', [scenario('small', 100, 1000)]);
  const head = report('clean-wall', [scenario('small', 80, 900)]);
  head.environment.node = 'v26.5.0';
  assert.throws(() => compareReports(base, head), /Node runtime mismatch/u);
  const experiment = compareReports(base, head, { allowRuntimeMismatch: true });
  assert.equal(experiment.rows[0].durationMs.percentChange, -20);
  assert.match(experiment.warnings[0], /comparison-axis override/u);
});

function report(measurementMode, scenarios) {
  return {
    kind: 'opensip-performance-slo',
    measurementMode,
    profile: 'pr',
    quick: false,
    otlpExport: false,
    config: { fingerprint: 'a'.repeat(64) },
    corpora: [{ tier: 'small', fileCount: 10, changedFileCount: 1, gitReady: true }],
    createdAt: '2026-07-13T00:00:00.000Z',
    environment: {
      node: 'v24.16.0',
      pnpm: '11.10.0',
      arch: 'arm64',
      platform: 'darwin',
      release: '25.5.0',
      cpuModel: 'Test CPU',
      cpuCount: 8,
      ci: false,
    },
    scenarios,
  };
}

function toolchainReport(cacheMode, command) {
  const base = report('toolchain-throughput', []);
  return {
    ...base,
    kind: 'opensip-toolchain-benchmark',
    profile: 'toolchain',
    quick: undefined,
    otlpExport: undefined,
    config: undefined,
    corpora: undefined,
    cache: { mode: cacheMode },
    repetitions: 1,
    iterationOrder: ['build'],
    scenarios: [
      {
        tier: 'workspace',
        scenario: 'build',
        command,
        samples: [{ status: 0, durationMs: 10, maxRssBytes: 100 }],
      },
    ],
  };
}

function scenario(tier, durationMs, maxRssBytes) {
  return {
    tier,
    scenario: 'graph-cold',
    label: 'Graph cold',
    status: 0,
    timedOut: false,
    durationMs,
    maxRssBytes,
  };
}
