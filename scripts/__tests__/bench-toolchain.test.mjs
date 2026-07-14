import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseToolchainArgs, runToolchainBenchmark } from '../bench-toolchain.mjs';
import {
  createToolchainReport,
  renderToolchainMarkdown,
  summarizeDurations,
} from '../perf/toolchain-report.mjs';

test('toolchain arguments require output and bound repeat, cache, and timeout controls', () => {
  assert.deepEqual(parseToolchainArgs(['--out', 'result.json']), {
    repetitions: 5,
    cacheMode: 'force',
    timeoutMs: 900_000,
    out: 'result.json',
  });
  assert.deepEqual(
    parseToolchainArgs([
      '--out',
      'result.json',
      '--markdown-out',
      'summary.md',
      '--repetitions',
      '2',
      '--cache-mode',
      'reuse',
      '--timeout-ms',
      '1234',
    ]),
    {
      repetitions: 2,
      cacheMode: 'reuse',
      timeoutMs: 1234,
      out: 'result.json',
      markdownOut: 'summary.md',
    },
  );
  assert.equal(parseToolchainArgs(['--help']).help, true);

  assert.throws(() => parseToolchainArgs([]), /--out is required/u);
  assert.throws(
    () => parseToolchainArgs(['--out', 'result.json', '--runs', '0']),
    /between 1 and 30/u,
  );
  assert.throws(
    () => parseToolchainArgs(['--out', 'result.json', '--cache-mode', 'cold']),
    /force.*reuse/u,
  );
  assert.throws(
    () => parseToolchainArgs(['--out', 'result.json', '--timeout-ms', '999']),
    /between 1000/u,
  );
  assert.throws(() => parseToolchainArgs(['--out', 'result.json', '--wat']), /Unknown option/u);
});

test('toolchain report computes stable min, median, and nearest-rank p95 math', () => {
  const values = [40, 10, 30, 20];
  assert.deepEqual(summarizeDurations(values), {
    min: 10,
    median: 25,
    p95: 40,
  });
  assert.deepEqual(values, [40, 10, 30, 20], 'report math must not mutate samples');

  const report = createToolchainReport({
    createdAt: '2026-07-13T12:00:00.000Z',
    repetitions: 4,
    cacheMode: 'force',
    environment: benchmarkEnvironment(),
    typescript: { declared: '~6.0.3', resolved: '6.0.3' },
    scenarios: [
      {
        scenario: 'build',
        label: 'Workspace build',
        command: ['pnpm', 'build'],
        samples: values.map((durationMs, index) => ({
          run: index + 1,
          status: 0,
          durationMs,
        })),
      },
    ],
  });

  assert.equal(report.measurementMode, 'toolchain-throughput');
  assert.equal(report.runtimeClaim, false);
  assert.equal(report.cache.turboForce, true);
  assert.equal(report.cache.eslintCache, false);
  assert.equal(report.environment.typescript, '6.0.3');
  assert.deepEqual(report.scenarios[0].summary.durationMs, {
    min: 10,
    median: 25,
    p95: 40,
  });
  const markdown = renderToolchainMarkdown(report);
  assert.match(markdown, /do not measure built CLI runtime/u);
  assert.match(markdown, /TypeScript 6\.0\.3 \(declared ~6\.0\.3\)/u);
  assert.match(markdown, /<code>pnpm build<\/code>/u);
});

test('toolchain benchmark uses a fake runner for fixed commands and writes both reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opensip-toolchain-'));
  const invocations = [];
  const progress = [];
  try {
    const result = await runToolchainBenchmark(
      ['--out', 'artifacts/toolchain.json', '--runs', '2', '--timeout-ms', '1234'],
      {
        repoRoot: root,
        env: {
          PATH: '/test/bin',
          TURBO_FORCE: 'unexpected',
          DROP_ME: undefined,
        },
        collectBenchmarkEnvironment: async () => benchmarkEnvironment(),
        readFile: fakePackageReader,
        runMeasuredCommand: async (input) => {
          invocations.push(input);
          return {
            status: 0,
            timedOut: false,
            durationMs: invocations.length * 10,
            maxRssBytes: invocations.length * 100,
            startedAt: '2026-07-13T11:00:00.000Z',
            completedAt: '2026-07-13T11:00:01.000Z',
          };
        },
        now: () => new Date('2026-07-13T12:00:00.000Z'),
        stderr: { write: (value) => progress.push(value) },
        stdout: { write: () => null },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(invocations.length, 6);
    assert.deepEqual(
      invocations.map((input) => input.command),
      [
        ['pnpm', 'build'],
        ['pnpm', 'typecheck'],
        [
          'pnpm',
          'exec',
          'eslint',
          '--config',
          '.config/eslint.config.mjs',
          'packages/**/src/**/*.{ts,tsx}',
        ],
        ['pnpm', 'build'],
        ['pnpm', 'typecheck'],
        [
          'pnpm',
          'exec',
          'eslint',
          '--config',
          '.config/eslint.config.mjs',
          'packages/**/src/**/*.{ts,tsx}',
        ],
      ],
    );
    for (const invocation of invocations) {
      assert.equal(invocation.cwd, root);
      assert.equal(invocation.timeoutMs, 1234);
      assert.equal(invocation.env.TURBO_FORCE, 'true');
      assert.equal(invocation.env.DROP_ME, undefined);
      assert.equal(invocation.stdoutTailBytes, 16 * 1024);
      assert.equal(invocation.stderrTailBytes, 16 * 1024);
    }
    assert.equal(progress.length, 6);

    const json = JSON.parse(await readFile(join(root, 'artifacts/toolchain.json'), 'utf8'));
    const markdown = await readFile(join(root, 'artifacts/toolchain.md'), 'utf8');
    assert.equal(json.environment.typescript, '6.0.3');
    assert.equal(json.environment.typescriptDeclared, '~6.0.3');
    assert.deepEqual(
      json.scenarios.map((scenario) => scenario.summary.durationMs.median),
      [25, 35, 45],
    );
    assert.match(markdown, /Type-aware ESLint/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuse cache mode is explicit and command failures do not write reports', async () => {
  const common = {
    repoRoot: '/repo',
    env: { TURBO_FORCE: 'true' },
    collectBenchmarkEnvironment: async () => benchmarkEnvironment(),
    readFile: fakePackageReader,
    stderr: { write: () => null },
    stdout: { write: () => null },
  };
  const cacheValues = [];
  await runToolchainBenchmark(['--out', 'unused.json', '--runs', '1', '--cache-mode', 'reuse'], {
    ...common,
    runMeasuredCommand: async (input) => {
      cacheValues.push(input.env.TURBO_FORCE);
      return { status: 0, timedOut: false, durationMs: 1 };
    },
    writeReports: async () => null,
  });
  assert.deepEqual(cacheValues, ['false', 'false', 'false']);

  let wrote = false;
  await assert.rejects(
    () =>
      runToolchainBenchmark(['--out', 'failure.json', '--runs', '1'], {
        ...common,
        runMeasuredCommand: async () => ({
          status: 1,
          timedOut: false,
          durationMs: 5,
          stderrTail: 'compiler failed',
        }),
        writeReports: async () => {
          wrote = true;
        },
      }),
    /build.*status 1.*compiler failed/u,
  );
  assert.equal(wrote, false);
});

function benchmarkEnvironment() {
  return {
    node: 'v24.16.0',
    pnpm: '10.12.4',
    arch: 'arm64',
    platform: 'darwin',
    release: '25.5.0',
    cpuModel: 'Test CPU',
    cpuCount: 8,
    ci: false,
    gitSha: 'abc123',
    gitBranch: 'codex/perf',
  };
}

async function fakePackageReader(path) {
  if (path.endsWith('/node_modules/typescript/package.json')) {
    return JSON.stringify({ version: '6.0.3' });
  }
  if (path.endsWith('/package.json')) {
    return JSON.stringify({ devDependencies: { typescript: '~6.0.3' } });
  }
  throw new Error(`Unexpected read: ${path}`);
}
