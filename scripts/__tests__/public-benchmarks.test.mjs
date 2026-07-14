import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeMarkdownTableCell, renderBenchmarkDoc } from '../build-public-benchmarks-doc.mjs';
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

test('public snapshots accept only explicit clean-wall reports', () => {
  assert.throws(
    () =>
      snapshotFromSloReport({
        ...minimalSnapshot(),
        measurementMode: 'cpu-profile',
      }),
    /require measurementMode "clean-wall"/u,
  );
  assert.throws(
    () =>
      normalizeBenchmarkSnapshot({
        ...minimalSnapshot(),
        measurementMode: undefined,
      }),
    /measurementMode/u,
  );
});

test('public snapshots reject non-reference runtime evidence', () => {
  const valid = minimalSnapshot();
  const invalidReports = [
    [{ ...valid, kind: 'opensip-performance-profile' }, /performance-slo report/u],
    [{ ...valid, quick: true }, /non-quick/u],
    [{ ...valid, profile: 'optimization' }, /pr profile/u],
    [{ ...valid, verdict: 'fail' }, /passing report/u],
    [{ ...valid, environment: { ...valid.environment, node: 'v26.5.0' } }, /Node 24/u],
    [
      { ...valid, environment: { ...valid.environment, pnpm: 'unavailable' } },
      /environment\.pnpm/u,
    ],
    [
      { ...valid, environment: { ...valid.environment, gitBranch: undefined } },
      /environment\.gitBranch/u,
    ],
    [
      { ...valid, environment: { ...valid.environment, gitSha: 'abc123' } },
      /40- or 64-hex environment\.gitSha/u,
    ],
    [{ ...valid, environment: { ...valid.environment, gitDirty: true } }, /clean Git worktree/u],
    [
      { ...valid, environment: { ...valid.environment, gitDirty: undefined } },
      /clean Git worktree/u,
    ],
    [{ ...valid, environment: { ...valid.environment, ci: undefined } }, /non-CI/u],
    [
      {
        ...valid,
        corpora: [{ ...valid.corpora[0], contentSha256: undefined }],
      },
      /corpus contentSha256/u,
    ],
    [
      { ...valid, corpora: [{ ...valid.corpora[0], changedFiles: undefined }] },
      /corpus changedFiles/u,
    ],
    [{ ...valid, otlpExport: true }, /OTLP-export/u],
    [
      { ...valid, scenarios: [{ ...valid.scenarios[0], skipped: true }] },
      /skipped, timed-out, or failed/u,
    ],
    [{ ...valid, budgets: valid.budgets.slice(0, 2) }, /budget coverage/u],
  ];
  for (const [report, expected] of invalidReports) {
    assert.throws(() => snapshotFromSloReport(report), expected);
  }
});

test('modern committed snapshots enforce the same publication contract', () => {
  const valid = minimalSnapshot();
  assert.throws(() => normalizeBenchmarkSnapshot({ ...valid, quick: true }), /non-quick/u);
  assert.throws(
    () =>
      normalizeBenchmarkSnapshot({
        ...valid,
        config: { ...valid.config, fingerprint: undefined },
      }),
    /config\.fingerprint/u,
  );
});

test('rowsFromSnapshot joins scenario measurements to configured budgets', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const [row] = rowsFromSnapshot(minimalSnapshot(), config);
  assert.equal(row.label, 'Fit full run');
  assert.equal(row.status, 'pass');
  assert.equal(row.durationBudgetMs, 1000);
  assert.equal(row.durationMarginMs, 900);
});

test('publication rejects a subset of the configured pr profile matrix', () => {
  const rawConfig = minimalRawConfig();
  rawConfig.profiles.pr.scenarios.push('graph-cold');
  rawConfig.scenarios['graph-cold'] = {
    label: 'Graph cold build',
    description: 'test',
  };
  rawConfig.budgets.push({
    tier: 'small',
    scenario: 'graph-cold',
    maxDurationMs: 1000,
    maxRssBytes: 1024,
  });
  const config = normalizeSloConfig(rawConfig, MEMORY_CONFIG_PATH);
  const subset = {
    ...minimalSnapshot(),
    config: { ...minimalSnapshot().config, fingerprint: config.fingerprint },
  };

  assert.throws(
    () => snapshotFromSloReport(subset, { sloConfig: config }),
    /scenario coverage is incomplete/u,
  );
  assert.throws(() => rowsFromSnapshot(subset, config), /scenario coverage is incomplete/u);
});

test('publication recomputes budget facts from scenarios and the loaded config', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const cases = [
    {
      expected: /durationMs actual does not match/u,
      mutate: (snapshot) => {
        snapshot.budgets[1].actual = 101;
      },
    },
    {
      expected: /durationMs budget does not match/u,
      mutate: (snapshot) => {
        snapshot.budgets[1].budget = 999;
      },
    },
    {
      expected: /durationMs ratio does not match/u,
      mutate: (snapshot) => {
        snapshot.budgets[1].ratio = 0.2;
      },
    },
    {
      expected: /durationMs status does not match/u,
      mutate: (snapshot) => {
        snapshot.scenarios[0].durationMs = 2000;
        Object.assign(snapshot.budgets[1], {
          actual: 2000,
          budget: 1000,
          ratio: 2,
          status: 'pass',
        });
      },
    },
  ];

  for (const { expected, mutate } of cases) {
    const snapshot = structuredClone(minimalSnapshot());
    mutate(snapshot);
    assert.throws(() => snapshotFromSloReport(snapshot, { sloConfig: config }), expected);
  }

  const committedSnapshot = structuredClone(minimalSnapshot());
  committedSnapshot.budgets[2].actual = 513;
  assert.throws(
    () => rowsFromSnapshot(committedSnapshot, config),
    /maxRssBytes actual does not match/u,
  );
});

test('renderBenchmarkDoc replaces all generated benchmark sections', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const rendered = renderBenchmarkDoc(templateDoc(), minimalSnapshot(), config);
  assert.match(rendered, /Fit full run/u);
  assert.match(rendered, /Generated files/u);
  assert.match(rendered, /Node\.js/u);
  assert.match(rendered, /Git worktree dirty \| no/u);
  assert.match(rendered, new RegExp(minimalSnapshot().config.fingerprint, 'u'));
  assert.doesNotMatch(rendered, /STALE/u);
});

test('public benchmark tables escape Markdown, HTML, pipes, and newlines in string values', () => {
  const hostile = 'value|next\n`<script>alert(1)</script>[link](javascript:bad)*em*_u_~s~\\';
  const rawConfig = minimalRawConfig();
  rawConfig.scenarios['fit-full'].label = hostile;
  const config = normalizeSloConfig(rawConfig, MEMORY_CONFIG_PATH);
  const snapshot = structuredClone(minimalSnapshot());
  snapshot.config.fingerprint = config.fingerprint;
  snapshot.source = hostile;
  snapshot.createdAt = hostile;
  snapshot.environment = {
    ...snapshot.environment,
    node: `v24.16.0 ${hostile}`,
    pnpm: hostile,
    arch: hostile,
    platform: hostile,
    release: hostile,
    cpuModel: hostile,
    gitBranch: hostile,
  };
  snapshot.scenarios[0].graphProfile = { cache: hostile };

  const rendered = renderBenchmarkDoc(templateDoc(), snapshot, config);
  const sourceRow = rendered.split('\n').find((line) => line.startsWith('| Source |'));

  assert.equal(sourceRow?.split('|').length, 4, 'snapshot pipes must not create table columns');
  assert.match(sourceRow ?? '', /<code>value&#124;next ⏎ &#96;&lt;script&gt;/u);
  assert.doesNotMatch(rendered, /<script>|<\/script>|\[link\]|\*em\*|_u_|~s~/u);
  assert.equal(rendered.split('\n').filter((line) => line.includes('alert(1)')).length, 10);
});

test('escapeMarkdownTableCell handles every structural Markdown table character', () => {
  assert.equal(
    escapeMarkdownTableCell('&\\|`<>*_[]~\r\nnext'),
    '&amp;&#92;&#124;&#96;&lt;&gt;&#42;&#95;&#91;&#93;&#126; ⏎ next',
  );
});

function minimalSnapshot() {
  return {
    version: 1,
    kind: 'opensip-performance-slo',
    reportKind: 'opensip-performance-slo',
    source: 'pnpm bench:slo -- --profile pr --out slo-report.json',
    createdAt: '2026-07-02T00:00:00.000Z',
    measurementMode: 'clean-wall',
    profile: 'pr',
    quick: false,
    verdict: 'pass',
    config: {
      sourcePath: '.config/performance-slos.json',
      fingerprint: normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH).fingerprint,
      sampleIntervalMs: 25,
    },
    environment: {
      node: 'v24.16.0',
      pnpm: '11.10.0',
      arch: 'arm64',
      platform: 'darwin',
      release: '25.5.0',
      cpuModel: 'Apple M5 Max',
      cpuCount: 18,
      ci: false,
      gitSha: '0123456789abcdef0123456789abcdef01234567',
      gitBranch: 'main',
      gitDirty: false,
    },
    corpora: [
      {
        tier: 'small',
        fileCount: 10,
        changedFiles: ['src/module-0.ts'],
        changedFileCount: 1,
        gitReady: true,
        contentSha256: 'c'.repeat(64),
      },
    ],
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
