import assert from 'node:assert/strict';
import test from 'node:test';

import { renderBenchmarkDoc } from '../build-public-benchmarks-doc.mjs';
import {
  normalizeBenchmarkSnapshot,
  rowsFromSnapshot,
  snapshotFromSloReport,
} from '../benchmarks/public-benchmark-schema.mjs';
import { normalizeSloConfig } from '../perf/slo-config.mjs';

const MEMORY_CONFIG_PATH = '<memory>/performance-slos.json';

test('normalizeBenchmarkSnapshot validates version and required fields', () => {
  const snapshot = normalizeBenchmarkSnapshot(minimalSnapshot());
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.scenarios[0].scenario, 'fit-full');
  assert.throws(
    () => normalizeBenchmarkSnapshot({ ...minimalSnapshot(), version: 2 }),
    /version must be 1/u,
  );
  assert.throws(
    () => normalizeBenchmarkSnapshot({ ...minimalSnapshot(), environment: {} }),
    /environment.node/u,
  );
});

test('snapshotFromSloReport strips private paths and output tails', () => {
  const report = {
    ...minimalSnapshot(),
    repoRoot: '/Users/example/private/repo',
    scenarios: [
      {
        ...minimalSnapshot().scenarios[0],
        command: [
          '/Users/example/.nvm/node',
          '/Users/example/private/repo/packages/cli/dist/index.js',
        ],
        cwd: '/Users/example/private/repo/.opensip-slo/pr-small',
        stdoutTail: 'private stdout',
        stderrTail: 'private stderr',
      },
    ],
  };
  const snapshot = snapshotFromSloReport(report, { source: 'pnpm bench:slo' });
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /\/Users\/example/u);
  assert.doesNotMatch(text, /stdoutTail|stderrTail/u);
});

test('rowsFromSnapshot joins scenario measurements to configured budgets', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const [row] = rowsFromSnapshot(minimalSnapshot(), config);
  assert.equal(row.label, 'Fit full run');
  assert.equal(row.status, 'pass');
  assert.equal(row.durationBudgetMs, 1000);
  assert.equal(row.durationMarginMs, 900);
});

test('renderBenchmarkDoc replaces all generated benchmark sections', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const rendered = renderBenchmarkDoc(templateDoc(), minimalSnapshot(), config);
  assert.match(rendered, /Fit full run/u);
  assert.match(rendered, /Generated files/u);
  assert.match(rendered, /Node\.js/u);
  assert.doesNotMatch(rendered, /STALE/u);
});

function minimalSnapshot() {
  return {
    version: 1,
    source: 'pnpm bench:slo -- --profile pr --out slo-report.json',
    createdAt: '2026-07-02T00:00:00.000Z',
    profile: 'pr',
    quick: false,
    verdict: 'pass',
    environment: {
      node: 'v24.16.0',
      platform: 'darwin',
      release: '25.5.0',
      cpuCount: 18,
      ci: false,
    },
    corpora: [{ tier: 'small', fileCount: 10, changedFileCount: 1, gitReady: true }],
    scenarios: [
      {
        tier: 'small',
        scenario: 'fit-full',
        label: 'Fit full run',
        status: 0,
        timedOut: false,
        durationMs: 100,
        maxRssBytes: 512,
      },
    ],
    budgets: [
      {
        tier: 'small',
        scenario: 'fit-full',
        metric: 'exitCode',
        actual: 0,
        budget: 0,
        ratio: 0,
        status: 'pass',
        message: 'command exited successfully',
      },
      {
        tier: 'small',
        scenario: 'fit-full',
        metric: 'durationMs',
        actual: 100,
        budget: 1000,
        ratio: 0.1,
        status: 'pass',
        message: 'durationMs 100 / 1000',
      },
      {
        tier: 'small',
        scenario: 'fit-full',
        metric: 'maxRssBytes',
        actual: 512,
        budget: 1024,
        ratio: 0.5,
        status: 'pass',
        message: 'maxRssBytes 512 / 1024',
      },
    ],
  };
}

function minimalRawConfig() {
  return {
    version: 1,
    sampleIntervalMs: 25,
    tailBytes: { stdout: 128, stderr: 128 },
    profiles: {
      pr: {
        description: 'test',
        tiers: ['small'],
        scenarios: ['fit-full'],
      },
    },
    tiers: {
      small: {
        maxFiles: 10,
        maxLoc: 1000,
        fileCount: 4,
        quickFileCount: 2,
      },
    },
    scenarios: {
      'fit-full': {
        label: 'Fit full run',
        description: 'test',
      },
    },
    budgets: [
      {
        tier: 'small',
        scenario: 'fit-full',
        maxDurationMs: 1000,
        maxRssBytes: 1024,
      },
    ],
  };
}

function templateDoc() {
  return [
    '<!-- opensip:public-benchmark-summary start -->',
    'STALE',
    '<!-- opensip:public-benchmark-summary end -->',
    '<!-- opensip:public-benchmark-corpora start -->',
    'STALE',
    '<!-- opensip:public-benchmark-corpora end -->',
    '<!-- opensip:public-benchmark-results start -->',
    'STALE',
    '<!-- opensip:public-benchmark-results end -->',
    '<!-- opensip:public-benchmark-environment start -->',
    'STALE',
    '<!-- opensip:public-benchmark-environment end -->',
  ].join('\n');
}
