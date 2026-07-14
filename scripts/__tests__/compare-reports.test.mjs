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

test('raw scenario rows require an explicit successful status', () => {
  const base = report('clean-wall', [scenario('small', 20, 200)]);
  const missingStatus = scenario('small', 10, 100);
  delete missingStatus.status;
  missingStatus.sampleCount = 1;
  missingStatus.failedSamples = 0;

  const comparison = compareReports(base, report('clean-wall', [missingStatus]));

  assert.equal(comparison.comparable, false);
  assert.equal(comparison.rows[0].comparable, false);
  assert.equal(comparison.rows[0].failedSamples.head, 1);
  assert.equal(comparison.rows[0].durationMs.head, undefined);
  assert.equal(comparison.rows[0].durationMs.percentChange, undefined);
  assert.match(comparison.rows[0].warnings.join(' '), /failed sample/u);
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
        sampleCount: 2,
        failedSamples: 0,
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

test('aggregate summaries require explicit zero-failure metadata', () => {
  const normalized = normalizeBenchmarkReport({
    measurementMode: 'clean-wall',
    scenarioSummaries: [
      {
        tier: 'small',
        scenario: 'cli-help',
        sampleCount: 2,
        durationMs: { median: 12 },
        maxRssBytes: { median: 2048 },
      },
    ],
  });
  const row = normalized.rows.get('small:cli-help');

  assert.equal(row.durationMs, undefined);
  assert.equal(row.maxRssBytes, undefined);
  assert.match(row.statusIssue, /failedSamples metadata/u);
});

test('aggregate summary medians are accepted when zero failures are explicitly proven', () => {
  const normalized = normalizeBenchmarkReport({
    measurementMode: 'clean-wall',
    scenarioSummaries: [
      {
        tier: 'small',
        scenario: 'cli-help',
        sampleCount: 3,
        failedSamples: 0,
        durationMs: { median: 12 },
        maxRssBytes: { median: 2048 },
      },
    ],
  });
  const row = normalized.rows.get('small:cli-help');

  assert.equal(row.durationMs, 12);
  assert.equal(row.maxRssBytes, 2048);
  assert.equal(row.statusIssue, undefined);
});

test('aggregate summary metadata must agree with its explicit samples', () => {
  const normalized = normalizeBenchmarkReport({
    measurementMode: 'clean-wall',
    scenarioSummaries: [
      {
        tier: 'small',
        scenario: 'cli-help',
        sampleCount: 2,
        failedSamples: 0,
        durationMs: { median: 12 },
        samples: [{ status: 0, durationMs: 10 }, { durationMs: 14 }],
      },
    ],
  });
  const row = normalized.rows.get('small:cli-help');

  assert.equal(row.durationMs, undefined);
  assert.equal(row.failedSamples, 1);
  assert.match(row.statusIssue, /inconsistent/u);
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

test('comparison rejects a different selected scenario matrix', () => {
  const base = report('clean-wall', [scenario('small', 100, 1000)]);
  const head = report('clean-wall', [
    scenario('small', 80, 900),
    { ...scenario('small', 20, 200), scenario: 'cli-help' },
  ]);

  assert.throws(() => compareReports(base, head), /Selected scenario matrix mismatch/u);
  const diagnostic = compareReports(base, head, { allowContextMismatch: true });
  assert.equal(diagnostic.comparable, false);
  assert.equal(diagnostic.rows[0].durationMs.percentChange, undefined);
});

test('missing pnpm and TypeScript identity suppress performance deltas', () => {
  const base = report('clean-wall', [scenario('small', 100, 1000)]);
  const missingPnpm = report('clean-wall', [scenario('small', 80, 900)]);
  missingPnpm.environment.pnpm = 'unavailable';
  const runtimeComparison = compareReports(base, missingPnpm);
  assert.equal(runtimeComparison.comparable, false);
  assert.equal(runtimeComparison.rows[0].durationMs.percentChange, undefined);
  assert.match(runtimeComparison.warnings.join(' '), /pnpm runtime/u);

  const toolchainBase = toolchainReport('force', ['pnpm', 'build']);
  const missingTypescript = toolchainReport('force', ['pnpm', 'build']);
  missingTypescript.environment.typescript = 'unavailable';
  const toolchainComparison = compareReports(toolchainBase, missingTypescript);
  assert.equal(toolchainComparison.comparable, false);
  assert.equal(toolchainComparison.rows[0].durationMs.percentChange, undefined);
  assert.match(toolchainComparison.warnings.join(' '), /TypeScript toolchain/u);
});

test('corpus content SHA is required and content changes reject deltas', () => {
  const base = report('clean-wall', [scenario('small', 100, 1000)]);
  const changed = report('clean-wall', [scenario('small', 80, 900)]);
  changed.corpora[0].contentSha256 = 'c'.repeat(64);
  assert.throws(() => compareReports(base, changed), /Generated corpus mismatch/u);

  const missing = report('clean-wall', [scenario('small', 80, 900)]);
  delete missing.corpora[0].contentSha256;
  const legacy = compareReports(base, missing);
  assert.equal(legacy.comparable, false);
  assert.equal(legacy.rows[0].durationMs.percentChange, undefined);
  assert.match(legacy.warnings.join(' '), /generated corpus fingerprint/u);
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
    corpora: [
      {
        tier: 'small',
        fileCount: 10,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
        contentSha256: 'b'.repeat(64),
      },
    ],
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
    environment: { ...base.environment, typescript: '6.0.3' },
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
