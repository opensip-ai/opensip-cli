import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBenchSlo } from '../bench-slo.mjs';
import { createChildProcessTerminator } from '../perf/child-process-lifecycle.mjs';
import { compareBudgets } from '../perf/compare-budgets.mjs';
import { cleanupOwnedCorpus, corpusMarkerPath, materializeCorpus } from '../perf/corpus.mjs';
import { signalsFromComparisons } from '../perf/performance-signals.mjs';
import {
  killProcessTree,
  parseProcessTable,
  readProcessTable,
  sumProcessTreeRss,
} from '../perf/process-tree-rss.mjs';
import {
  renderBudgetTable,
  renderTierTable,
  replaceMarkedSection,
} from '../perf/render-slo-markdown.mjs';
import { runMeasuredCommand } from '../perf/run-command.mjs';
import { normalizeSloConfig } from '../perf/slo-config.mjs';
import { median, nearestRankPercentile } from '../perf/statistics.mjs';

const MEMORY_CONFIG_PATH = '<memory>/slo.json';

test('shared performance statistics use median and nearest-rank percentile semantics', () => {
  const even = [8, 2, 4, 6];
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median(even), 5);
  assert.equal(median([Number.MAX_VALUE, Number.MAX_VALUE]), Number.MAX_VALUE);
  assert.deepEqual(even, [8, 2, 4, 6], 'statistics must not mutate caller samples');
  assert.equal(nearestRankPercentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(nearestRankPercentile([1, 2, 3, 4, 5], 20), 1);

  for (const invalid of [[], [Number.NaN], [Number.POSITIVE_INFINITY], [-1]]) {
    assert.throws(() => median(invalid), /non-empty|finite non-negative/u);
  }
  for (const percentile of [0, -1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => nearestRankPercentile([1], percentile), /percentile must/u);
  }
});

test('normalizeSloConfig indexes budgets and rejects duplicate tier/scenario rows', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  assert.equal(config.budgetByKey.get('small:fit-full')?.maxDurationMs, 1000);
  assert.throws(
    () =>
      normalizeSloConfig({
        ...minimalRawConfig(),
        budgets: [
          ...minimalRawConfig().budgets,
          {
            tier: 'small',
            scenario: 'fit-full',
            maxDurationMs: 1000,
            maxRssBytes: 1024,
          },
        ],
      }),
    /duplicate budget small:fit-full/,
  );
});

test('render helpers replace generated sections from normalized config', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  assert.match(renderTierTable(config), /Default corpus files/);
  assert.match(renderBudgetTable(config), /Fit full run/);
  const replaced = replaceMarkedSection(
    [
      'before',
      '<!-- opensip:performance-slo-tiers start -->',
      'stale',
      '<!-- opensip:performance-slo-tiers end -->',
      'after',
    ].join('\n'),
    'performance-slo-tiers',
    'fresh',
  );
  assert.equal(
    replaced,
    [
      'before',
      '<!-- opensip:performance-slo-tiers start -->',
      'fresh',
      '<!-- opensip:performance-slo-tiers end -->',
      'after',
    ].join('\n'),
  );
});

test('materializeCorpus writes a marker, deterministic files, and a changed probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-slo-corpus-'));
  await rm(root, { recursive: true, force: true });
  const corpus = await materializeCorpus({
    root,
    tierId: 'small',
    tier: { fileCount: 4, quickFileCount: 2, maxFiles: 10, maxLoc: 1000 },
    quick: true,
  });
  assert.equal(corpus.fileCount, 2);
  assert.equal(existsSync(corpusMarkerPath(root)), true);
  assert.match(
    readFileSync(join(root, 'opensip-cli.config.yml'), 'utf8'),
    /description: Synthetic/,
  );
  assert.match(readFileSync(join(root, 'src', 'module-0.ts'), 'utf8'), /changedProbe/);
  await cleanupOwnedCorpus(root);
  assert.equal(existsSync(root), false);
});

test('cleanupOwnedCorpus refuses unmarked directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-slo-unmarked-'));
  await assert.rejects(() => cleanupOwnedCorpus(root), /missing \.opensip-slo-corpus\.json/);
  await rm(root, { recursive: true, force: true });
});

test('process-table helpers sum root and descendant RSS', () => {
  const rows = parseProcessTable('10 1 100\n11 10 25\n12 11 5\n13 2 200\n');
  assert.equal(sumProcessTreeRss(rows, 10), 130 * 1024);
});

test('readProcessTable bounds and force-kills the ps subprocess', async () => {
  let invocation;
  const rows = await readProcessTable({
    platform: 'linux',
    timeoutMs: 37,
    execFileAsync: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: '10 1 100\n' };
    },
  });

  assert.deepEqual(rows, [{ pid: 10, ppid: 1, rssBytes: 100 * 1024 }]);
  assert.equal(invocation.command, 'ps');
  assert.deepEqual(invocation.args, ['-eo', 'pid=,ppid=,rss=']);
  assert.equal(invocation.options.timeout, 37);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
});

test('killProcessTree uses bounded taskkill tree termination on Windows', async () => {
  let invocation;
  await killProcessTree(4312, 'SIGTERM', {
    platform: 'win32',
    timeoutMs: 73,
    execFileAsync: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: '' };
    },
  });

  assert.equal(invocation.command, 'taskkill');
  assert.deepEqual(invocation.args, ['/pid', '4312', '/t', '/f']);
  assert.equal(invocation.options.timeout, 73);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.equal(invocation.options.windowsHide, true);
});

test('killProcessTree falls back to direct root termination when taskkill fails', async () => {
  const killed = [];
  const result = await killProcessTree(4312, 'SIGTERM', {
    platform: 'win32',
    execFileAsync: async () => {
      throw new Error('taskkill failed');
    },
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });
    },
  });

  assert.equal(result, false);
  assert.deepEqual(killed, [{ pid: 4312, signal: 'SIGTERM' }]);
});

for (const [outcome, terminateTree] of [
  ['returns false', async () => false],
  [
    'rejects',
    async () => {
      throw new Error('taskkill failed');
    },
  ],
]) {
  test(`child terminator falls back to the root handle when Windows tree termination ${outcome}`, async () => {
    const childSignals = [];
    const terminator = createChildProcessTerminator({
      child: {
        pid: 9471,
        kill: (signal) => {
          childSignals.push(signal);
        },
      },
      killProcessTree: terminateTree,
      platform: 'win32',
    });

    await terminator.signal('SIGKILL');

    assert.deepEqual(childSignals, ['SIGKILL']);
  });
}

test('child terminator avoids PID-based Windows cleanup after confirmed root close', async () => {
  let treeKillCalls = 0;
  const childSignals = [];
  const terminator = createChildProcessTerminator({
    child: {
      pid: 9471,
      kill: (signal) => {
        childSignals.push(signal);
      },
    },
    killProcessTree: async () => {
      treeKillCalls += 1;
      return true;
    },
    platform: 'win32',
  });

  await terminator.signalAfterRootClose('SIGKILL');

  assert.equal(treeKillCalls, 0);
  assert.deepEqual(childSignals, []);
});

test('runMeasuredCommand captures bounded output and exit status', async () => {
  const result = await runMeasuredCommand({
    command: [process.execPath, '-e', "process.stdout.write('abcdef');"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    sampleIntervalMs: 10,
    stdoutTailBytes: 3,
    stderrTailBytes: 3,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdoutTail, 'def');
  assert.equal(result.timedOut, false);
});

test('runMeasuredCommand stays bounded when the RSS sampler never settles', async () => {
  const started = Date.now();
  const neverSettles = new Promise(Function.prototype);
  const result = await runMeasuredCommand({
    command: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    sampleIntervalMs: 1,
    rssSampleTimeoutMs: 25,
    readProcessTable: () => neverSettles,
    stdoutTailBytes: 0,
    stderrTailBytes: 0,
  });

  assert.equal(result.status, 0);
  assert.equal(result.maxRssBytes, undefined);
  assert.ok(Date.now() - started < 1000, 'never-settling sampler must not hold command open');
});

test('compareBudgets reports command, duration, and required-memory failures', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const comparisons = compareBudgets(
    {
      scenarios: [
        {
          tier: 'small',
          scenario: 'fit-full',
          status: 1,
          durationMs: 1500,
          maxRssBytes: undefined,
        },
      ],
    },
    config,
    { requireMemory: true },
  );
  assert.deepEqual(
    comparisons.map((comparison) => comparison.status),
    ['fail', 'fail', 'fail'],
  );
});

test('runMeasuredCommand excludes final RSS sampling latency from command duration', async () => {
  const started = Date.now();
  const result = await runMeasuredCommand({
    command: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    sampleIntervalMs: 1,
    rssSampleTimeoutMs: 1000,
    readProcessTable: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    },
    stdoutTailBytes: 0,
    stderrTailBytes: 0,
  });
  const observedWallMs = Date.now() - started;

  assert.ok(observedWallMs >= 175, 'test must observe the delayed final sampler');
  assert.ok(
    result.durationMs < observedWallMs - 100,
    'reported command duration must end before the delayed final sampler',
  );
});

test('signalsFromComparisons emits performance-slo signals for failed budget rows', () => {
  const [signal] = signalsFromComparisons(
    [
      {
        tier: 'small',
        scenario: 'fit-full',
        metric: 'durationMs',
        actual: 1500,
        budget: 1000,
        ratio: 1.5,
        status: 'fail',
        message: 'durationMs 1500 / 1000',
      },
    ],
    'pr',
  );
  assert.equal(signal.ruleId, 'performance-slo:fit-full:durationMs');
  assert.equal(signal.metadata.profile, 'pr');
});

test('runBenchSlo supports fake dependencies and writes a report', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-slo-runner-'));
  let reportText = '';
  const config = normalizeSloConfig(
    minimalRawConfig(),
    join(repoRoot, '.config/performance-slos.json'),
  );
  const result = await runBenchSlo(
    ['--', '--profile', 'pr', '--out', 'report.json', '--work-root', 'work'],
    {
      repoRoot,
      loadSloConfig: () => Promise.resolve(config),
      existsSync: () => true,
      mkdir,
      rm,
      materializeCorpus: async ({ root }) => ({
        root,
        tier: 'small',
        fileCount: 2,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
      }),
      runMeasuredCommand: async ({ command, cwd }) => ({
        command,
        cwd,
        startedAt: '2026-07-02T00:00:00.000Z',
        completedAt: '2026-07-02T00:00:00.100Z',
        status: 0,
        timedOut: false,
        durationMs: 100,
        maxRssBytes: 512,
        stdoutTail: '',
        stderrTail: '',
      }),
      writeFile: async (_path, content) => {
        reportText = content;
      },
      consoleLog: () => null,
    },
  );
  assert.equal(result.exitCode, 0);
  const report = JSON.parse(reportText);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.scenarios[0].scenario, 'fit-full');
  await rm(repoRoot, { recursive: true, force: true });
});

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
