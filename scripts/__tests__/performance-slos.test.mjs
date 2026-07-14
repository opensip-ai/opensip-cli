import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBenchSlo } from '../bench-slo.mjs';
import {
  collectBenchmarkEnvironment,
  createCleanWallChildEnv,
} from '../perf/benchmark-environment.mjs';
import { createChildProcessTerminator } from '../perf/child-process-lifecycle.mjs';
import { compareBudgets } from '../perf/compare-budgets.mjs';
import {
  cleanupOwnedCorpus,
  corpusMarkerPath,
  initializeGitCorpus,
  materializeCorpus,
} from '../perf/corpus.mjs';
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
import { summarizeGraphProfile } from '../perf/report-schema.mjs';
import { runMeasuredCommand } from '../perf/run-command.mjs';
import { normalizeSloConfig } from '../perf/slo-config.mjs';
import { median, nearestRankPercentile } from '../perf/statistics.mjs';

const MEMORY_CONFIG_PATH = '<memory>/slo.json';

test('clean-wall child environments remove profiling and every OpenTelemetry input', () => {
  const source = {
    PATH: '/usr/bin',
    OPENSIP_PROFILE_DIR: '/private/profiles',
    OPENSIP_PROFILING: '1',
    OPENSIP_CLI_SKIP_BUNDLED: 'fit,graph',
    NODE_OPTIONS: '--cpu-prof --max-old-space-size=4096',
    NODE_PATH: '/private/node_modules',
    otel_exporter_otlp_endpoint: 'https://collector.example',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=secret',
    OTEL_TRACES_SAMPLER: 'always_on',
    TRACEPARENT: '00-abc-def-01',
    TRACESTATE: 'vendor=value',
    BAGGAGE: 'tenant=private',
    KEEP_ME: 'yes',
    UNDEFINED_VALUE: undefined,
  };

  const sanitized = createCleanWallChildEnv(source);

  assert.deepEqual(sanitized, { PATH: '/usr/bin', KEEP_ME: 'yes' });
  assert.equal(source.OPENSIP_PROFILING, '1', 'the caller environment must not be mutated');
});

test('benchmark environment metadata uses bounded commands and records reproducibility facts', async () => {
  const invocations = [];
  const environment = await collectBenchmarkEnvironment({
    repoRoot: '/repo',
    env: { CI: 'true' },
    nodeVersion: 'v24.16.0',
    arch: () => 'arm64',
    platform: () => 'darwin',
    release: () => '25.5.0',
    cpus: () => [{ model: 'Test CPU' }, { model: 'Test CPU' }],
    execFileAsync: async (command, args, options) => {
      invocations.push({ command, args, options });
      if (command === 'pnpm') return { stdout: '11.10.0\n' };
      if (args[0] === 'rev-parse') return { stdout: 'abc123\n' };
      if (args[0] === 'status') return { stdout: '' };
      return { stdout: 'codex/perf\n' };
    },
  });

  assert.deepEqual(environment, {
    node: 'v24.16.0',
    pnpm: '11.10.0',
    arch: 'arm64',
    platform: 'darwin',
    release: '25.5.0',
    cpuModel: 'Test CPU',
    cpuCount: 2,
    ci: true,
    gitSha: 'abc123',
    gitBranch: 'codex/perf',
    gitDirty: false,
  });
  assert.equal(invocations.length, 4);
  for (const invocation of invocations) {
    assert.equal(invocation.options.cwd, '/repo');
    assert.equal(invocation.options.killSignal, 'SIGKILL');
    assert.equal(invocation.options.timeout, 2000);
    assert.equal(invocation.options.maxBuffer, 64 * 1024);
  }
});

test('benchmark environment recognizes common CI values and records Git dirtiness', async () => {
  const collect = (env, status = '') =>
    collectBenchmarkEnvironment({
      repoRoot: '/repo',
      env: { npm_config_user_agent: 'pnpm/11.10.0', ...env },
      cpus: () => [{ model: 'Test CPU' }],
      execFileAsync: async (_command, args) => {
        if (args[0] === 'rev-parse') {
          return { stdout: '0123456789abcdef0123456789abcdef01234567\n' };
        }
        if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
        if (args[0] === 'status') return { stdout: status };
        throw new Error(`unexpected metadata command: ${args.join(' ')}`);
      },
    });

  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'buildkite']) {
    const result = await collect({ CI: value });
    assert.equal(result.ci, true, `CI=${value} must be detected`);
  }
  for (const value of [undefined, '', '0', 'false', 'FALSE', 'no', 'off']) {
    const result = await collect({ CI: value });
    assert.equal(result.ci, false, `CI=${String(value)} must stay local`);
  }
  const providerCi = await collect({ CI: 'false', GITHUB_ACTIONS: '1' });
  const dirty = await collect({}, ' M scripts/example.mjs\n');
  const clean = await collect({}, '');
  assert.equal(providerCi.ci, true);
  assert.equal(dirty.gitDirty, true);
  assert.equal(clean.gitDirty, false);
});

test('graph profile summaries normalize runs, stages, and cache facts without raw paths', () => {
  const summary = summarizeGraphProfile({
    mode: 'graph',
    resolutionMode: 'exact',
    durationMs: 42,
    cwd: '/private/repository',
    runs: [
      {
        label: 'root',
        cwd: '/private/repository',
        mode: 'exact',
        durationMs: 40,
        stages: [
          {
            name: 'discover',
            status: 'done',
            durationMs: 5,
            detail: '/private/repository/src',
          },
        ],
        summary: {
          cacheHit: false,
          files: 12,
          functions: 34,
          unresolved: 7,
        },
      },
      {
        label: 'nested',
        mode: 'exact',
        durationMs: 10,
        stages: [{ name: 'discover', status: 'done', durationMs: 7 }],
        summary: { cacheHit: false, files: 1, functions: 2 },
      },
    ],
  });

  assert.equal(summary.cache, 'miss');
  assert.equal(summary.files, 13);
  assert.equal(summary.functions, 36);
  assert.deepEqual(summary.stages, [{ name: 'discover', status: 'done', durationMs: 12 }]);
  assert.equal(summary.runs.length, 2);
  assert.doesNotMatch(JSON.stringify(summary), /private|detail|unresolved/u);
});

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
  const secondRoot = mkdtempSync(join(tmpdir(), 'opensip-slo-corpus-'));
  await rm(root, { recursive: true, force: true });
  await rm(secondRoot, { recursive: true, force: true });
  const input = {
    tierId: 'small',
    tier: { fileCount: 4, quickFileCount: 2, maxFiles: 10, maxLoc: 1000 },
    quick: true,
  };
  const corpus = await materializeCorpus({
    root,
    ...input,
  });
  const sameCorpus = await materializeCorpus({ root: secondRoot, ...input });
  assert.equal(corpus.fileCount, 2);
  assert.match(corpus.contentSha256, /^[a-f\d]{64}$/u);
  assert.equal(corpus.contentSha256, sameCorpus.contentSha256);
  assert.equal(existsSync(corpusMarkerPath(root)), true);
  assert.match(
    readFileSync(join(root, 'opensip-cli.config.yml'), 'utf8'),
    /description: Synthetic/,
  );
  assert.match(readFileSync(join(root, 'src', 'module-0.ts'), 'utf8'), /changedProbe/);
  await cleanupOwnedCorpus(root);
  await cleanupOwnedCorpus(secondRoot);
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(secondRoot), false);
});

test('initializeGitCorpus uses bounded hermetic Git commands and fails closed', () => {
  const root = join(tmpdir(), 'opensip-slo-hermetic-git');
  const invocations = [];
  const ready = initializeGitCorpus(root, {
    env: {
      Path: '/test/bin',
      PATHEXT: '.EXE;.CMD',
      SystemRoot: 'C:\\Windows',
      TEMP: '/safe/tmp',
      HOME: '/private/home',
      GIT_CONFIG_GLOBAL: '/private/home/.gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_TERMINAL_PROMPT: '1',
      GIT_ASKPASS: '/private/askpass',
      GPG_TTY: '/dev/tty',
      UNRELATED_SECRET: 'private',
    },
    spawnSync: (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0 };
    },
  });

  const repositoryOptions = [
    '-c',
    `core.hooksPath=${join(root, '.git', 'opensip-disabled-hooks')}`,
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
  ];
  assert.equal(ready, true);
  assert.deepEqual(
    invocations.map(({ command, args }) => [command, args]),
    [
      ['git', ['--version']],
      ['git', ['init', '--quiet', '--initial-branch=main', '--template=']],
      ['git', [...repositoryOptions, 'add', '--all', '--', '.']],
      [
        'git',
        [
          ...repositoryOptions,
          '-c',
          'commit.gpgSign=false',
          'commit',
          '--quiet',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'baseline',
        ],
      ],
    ],
  );

  const childEnv = invocations[0].options.env;
  for (const { options } of invocations) {
    assert.equal(options.cwd, root);
    assert.equal(options.env, childEnv);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.timeout, 10_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.windowsHide, true);
  }
  assert.equal(childEnv.Path, '/test/bin');
  assert.equal(childEnv.PATHEXT, '.EXE;.CMD');
  assert.equal(childEnv.SystemRoot, 'C:\\Windows');
  assert.equal(childEnv.TEMP, '/safe/tmp');
  assert.equal(childEnv.HOME, root);
  assert.equal(childEnv.USERPROFILE, root);
  assert.equal(childEnv.GIT_CONFIG_GLOBAL, join(root, '.git', 'opensip-disabled-global-config'));
  assert.equal(childEnv.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(childEnv.GIT_ATTR_NOSYSTEM, '1');
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0');
  assert.equal(childEnv.GCM_INTERACTIVE, 'Never');
  assert.equal(childEnv.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(childEnv.GIT_AUTHOR_DATE, '2000-01-01T00:00:00Z');
  assert.equal(childEnv.GIT_COMMITTER_DATE, '2000-01-01T00:00:00Z');
  assert.equal(childEnv.GIT_CONFIG_COUNT, undefined);
  assert.equal(childEnv.GIT_ASKPASS, undefined);
  assert.equal(childEnv.GPG_TTY, undefined);
  assert.equal(childEnv.UNRELATED_SECRET, undefined);

  let failedCalls = 0;
  assert.equal(
    initializeGitCorpus(root, {
      env: { PATH: '/test/bin' },
      spawnSync: () => {
        failedCalls += 1;
        return { status: 127 };
      },
    }),
    false,
  );
  assert.equal(failedCalls, 1);
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

test('compareBudgets rejects explicit profiled reports but accepts legacy reports without a mode', () => {
  const config = normalizeSloConfig(minimalRawConfig(), MEMORY_CONFIG_PATH);
  const report = {
    scenarios: [
      {
        tier: 'small',
        scenario: 'fit-full',
        status: 0,
        timedOut: false,
        durationMs: 100,
        maxRssBytes: 512,
      },
    ],
  };

  assert.doesNotThrow(() => compareBudgets(report, config));
  assert.throws(
    () => compareBudgets({ ...report, measurementMode: 'cpu-profile' }, config),
    /require measurementMode 'clean-wall'/u,
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
      collectBenchmarkEnvironment: async () => ({
        node: 'v24.16.0',
        pnpm: '11.10.0',
        arch: 'arm64',
        platform: 'darwin',
        release: '25.5.0',
        cpuModel: 'Test CPU',
        cpuCount: 2,
        ci: false,
        gitSha: '0123456789abcdef0123456789abcdef01234567',
        gitBranch: 'codex/perf',
        gitDirty: false,
      }),
      existsSync: () => true,
      mkdir,
      rm,
      materializeCorpus: async ({ root }) => ({
        root,
        tier: 'small',
        fileCount: 2,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
        contentSha256: 'b'.repeat(64),
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
  assert.equal(report.measurementMode, 'clean-wall');
  assert.equal(report.environment.pnpm, '11.10.0');
  assert.equal(report.environment.gitSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(report.environment.gitDirty, false);
  assert.equal(report.corpora[0].contentSha256, 'b'.repeat(64));
  assert.equal(report.scenarios[0].scenario, 'fit-full');
  await rm(repoRoot, { recursive: true, force: true });
});

test('runBenchSlo executes unbudgeted scenarios and fails on their exit status', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-slo-unbudgeted-'));
  const config = normalizeSloConfig(
    { ...minimalRawConfig(), budgets: [] },
    join(repoRoot, '.config/performance-slos.json'),
  );
  const result = await runBenchSlo(
    ['--', '--profile', 'pr', '--out', 'report.json', '--work-root', 'work'],
    {
      repoRoot,
      loadSloConfig: () => Promise.resolve(config),
      collectBenchmarkEnvironment: async () => ({ node: 'v24.16.0' }),
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
      runMeasuredCommand: async ({ command, cwd, env }) => {
        assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
        assert.equal(env.OPENSIP_PROFILING, undefined);
        return {
          command,
          cwd,
          startedAt: '2026-07-02T00:00:00.000Z',
          completedAt: '2026-07-02T00:00:00.100Z',
          status: 9,
          timedOut: false,
          durationMs: 100,
          maxRssBytes: 512,
          stdoutTail: '',
          stderrTail: 'failed',
        };
      },
      writeFile: () => Promise.resolve(),
      consoleLog: () => null,
    },
  );

  assert.equal(result.report.scenarios.length, 1);
  assert.equal(result.comparisons.length, 1);
  assert.equal(result.comparisons[0].metric, 'exitCode');
  assert.equal(result.report.verdict, 'fail');
  assert.equal(result.exitCode, 1);
  await rm(repoRoot, { recursive: true, force: true });
});

test('runBenchSlo primes report generation with a deterministic fit session', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-slo-report-prime-'));
  const raw = minimalRawConfig();
  raw.profiles.pr.scenarios = ['report-generate'];
  raw.scenarios['report-generate'] = {
    label: 'HTML report generation',
    description: 'test',
  };
  raw.budgets = [];
  const config = normalizeSloConfig(raw, join(repoRoot, '.config/performance-slos.json'));
  const commands = [];
  const result = await runBenchSlo(
    ['--', '--profile', 'pr', '--out', 'report.json', '--work-root', 'work'],
    {
      repoRoot,
      loadSloConfig: () => Promise.resolve(config),
      collectBenchmarkEnvironment: async () => ({ node: 'v24.16.0' }),
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
      runMeasuredCommand: async ({ command, cwd }) => {
        commands.push(command);
        return {
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
        };
      },
      writeFile: () => Promise.resolve(),
      consoleLog: () => null,
    },
  );

  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].slice(-2), ['fit', '--json']);
  assert.deepEqual(commands[1].slice(-3), ['report', '--no-open', '--json']);
  assert.equal(result.report.scenarios.length, 1);
  assert.equal(result.report.scenarios[0].scenario, 'report-generate');
  assert.equal(result.exitCode, 0);
  await rm(repoRoot, { recursive: true, force: true });
});

test('runBenchSlo fails closed when a graph setup command times out', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-slo-graph-prime-timeout-'));
  const raw = minimalRawConfig();
  raw.profiles.pr.scenarios = ['graph-impact-files'];
  raw.scenarios['graph-impact-files'] = {
    label: 'Graph impact',
    description: 'test',
  };
  raw.budgets = [];
  const config = normalizeSloConfig(raw, join(repoRoot, '.config/performance-slos.json'));
  let invocations = 0;
  const result = await runBenchSlo(
    ['--', '--profile', 'pr', '--out', 'report.json', '--work-root', 'work'],
    {
      repoRoot,
      loadSloConfig: () => Promise.resolve(config),
      collectBenchmarkEnvironment: async () => ({ node: 'v24.16.0' }),
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
      runMeasuredCommand: async () => {
        invocations += 1;
        return {
          status: 0,
          timedOut: true,
          durationMs: 100,
          maxRssBytes: 512,
          stdoutTail: '',
          stderrTail: 'timed out',
        };
      },
      writeFile: () => Promise.resolve(),
      consoleLog: () => null,
    },
  );

  assert.equal(invocations, 1);
  assert.equal(result.report.scenarios.length, 1);
  assert.equal(result.report.scenarios[0].setupFailure, true);
  assert.equal(result.report.scenarios[0].timedOut, true);
  assert.equal(result.report.verdict, 'fail');
  assert.equal(result.exitCode, 1);
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
