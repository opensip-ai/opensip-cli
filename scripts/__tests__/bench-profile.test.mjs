import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProfileChildEnv, parseProfileArgs, runBenchProfile } from '../bench-profile.mjs';
import {
  captureProfileArtifactSnapshot,
  hasProfileArtifactPair,
  indexNewProfileArtifacts,
  MAX_PROFILE_ARTIFACTS,
  MAX_PROFILE_LABEL_BYTES,
} from '../perf/profile-artifacts.mjs';
import {
  createProfileReport,
  finalizeProfileReport,
  renderProfileMarkdown,
  summarizeScenarioSamples,
} from '../perf/profile-report.mjs';
import { runMeasuredCommand } from '../perf/run-command.mjs';
import { extractStartupDiagnostics } from '../perf/startup-diagnostics.mjs';

test('measured commands optionally retain a bounded stdout prefix with truncation state', async () => {
  const result = await runMeasuredCommand({
    command: [process.execPath, '-e', "process.stdout.write('abcdefghij')"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    sampleIntervalMs: 10,
    stdoutTailBytes: 3,
    stderrTailBytes: 3,
    stdoutCaptureBytes: 5,
  });
  assert.equal(result.stdoutTail, 'hij');
  assert.equal(result.stdoutCapture, 'abcde');
  assert.equal(result.stdoutTruncated, true);
});

test('profile arguments default to quick retained repeats and reject remote experiment export', () => {
  const defaults = parseProfileArgs([]);
  assert.equal(defaults.quick, true);
  assert.equal(defaults.keepCorpus, true);
  assert.equal(defaults.runs, 3);
  assert.throws(() => parseProfileArgs(['--runs', '11']), /1 to 10/u);
  assert.throws(() => parseProfileArgs(['--runs', '3junk']), /integer/u);
  assert.throws(() => parseProfileArgs(['--timeout-ms', '999999999999']), /1 to 3600000/u);
  assert.throws(
    () => parseProfileArgs(['--cpu-profile', '--otlp-endpoint', 'https://collector.example']),
    /localhost/u,
  );
  assert.throws(
    () => parseProfileArgs(['--otlp-endpoint', 'http://127.0.0.1:4318']),
    /requires --cpu-profile/u,
  );
});

test('profile child environments are isolated and profiling is explicit', () => {
  const profileDirectory = join(tmpdir(), 'opensip-profile-test');
  const source = {
    PATH: '/bin',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://remote.invalid',
    OTEL_EXPORTER_OTLP_HEADERS: 'secret',
    OPENSIP_PROFILING: '1',
    NODE_OPTIONS: '--cpu-prof --max-old-space-size=4096',
  };
  const clean = createProfileChildEnv(source, {
    cpuProfile: false,
    artifactDirectory: profileDirectory,
    runId: 'clean',
  });
  assert.equal(clean.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(clean.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(clean.OPENSIP_PROFILING, undefined);
  assert.equal(clean.NODE_OPTIONS, '--max-old-space-size=8192');
  assert.equal(clean.OPENSIP_CLI_SKIP_INSTALLED, '1');
  const profiled = createProfileChildEnv(source, {
    cpuProfile: true,
    artifactDirectory: profileDirectory,
    runId: 'profiled',
  });
  assert.equal(profiled.OPENSIP_PROFILING, '1');
  assert.equal(profiled.OPENSIP_PROFILE_DIR, profileDirectory);
});

test('profile driver rejects colliding JSON and Markdown output paths', async () => {
  await assert.rejects(() => runBenchProfile(['--out', 'result.md']), /paths must differ/u);
});

test('profile driver uses the built CLI semantics and aggregates fake repeated runs', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'opensip-bench-profile-'));
  const writes = new Map();
  const invocations = [];
  const config = minimalProfileConfig(repoRoot);
  const result = await runBenchProfile(
    ['--runs', '2', '--scenario', 'cli-help', '--out', 'result.json', '--markdown', 'result.md'],
    {
      repoRoot,
      existsSync: () => true,
      loadSloConfig: async () => config,
      collectBenchmarkEnvironment: async () => ({
        node: 'v24.16.0',
        gitSha: 'abc',
      }),
      materializeCorpus: async ({ root }) => ({
        root,
        fileCount: 2,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
        contentSha256: 'b'.repeat(64),
      }),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      runMeasuredCommand: async (input) => {
        invocations.push(input);
        return {
          startedAt: '2026-07-13T00:00:00.000Z',
          completedAt: '2026-07-13T00:00:00.010Z',
          status: 0,
          timedOut: false,
          durationMs: invocations.length * 10,
          maxRssBytes: invocations.length * 100,
          stdoutTail: '',
          stderrTail: '',
          stdoutCapture: '{}',
          stdoutTruncated: false,
        };
      },
      writeFile: async (path, content) => writes.set(path, content),
      consoleLog: () => null,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].command.slice(-2), ['--no-cloud', '--help']);
  assert.equal(result.report.scenarioSummaries[0].durationMs.median, 15);
  assert.equal(result.report.corpora[0].contentSha256, 'b'.repeat(64));
  assert.equal(writes.size, 2);
});

test('startup diagnostics retain bounded startup and pre-action timing summaries', () => {
  const summary = extractStartupDiagnostics(
    JSON.stringify({
      diagnostics: {
        events: [
          {
            data: {
              source: 'startup',
              phase: 'first-party-tools',
              durationMs: 100,
              sinceStartMs: 120,
            },
          },
          {
            data: {
              source: 'pre-action',
              phase: 'tool-preflight',
              durationMs: 25,
              sinceStartMs: 30,
              skipped: false,
            },
          },
          { data: { source: 'unrelated', phase: 'ignored', durationMs: 999 } },
        ],
      },
    }),
  );
  assert.equal(summary.startup.elapsedMs, 120);
  assert.equal(summary.preAction.elapsedMs, 30);
  assert.deepEqual(summary.preAction.phases[0], {
    phase: 'tool-preflight',
    durationMs: 25,
    sinceStartMs: 30,
    skipped: false,
  });
});

test('startup extraction rejects truncated, malformed, and oversized documents', () => {
  assert.equal(extractStartupDiagnostics('{', {}), undefined);
  assert.equal(extractStartupDiagnostics('{}', { truncated: true }), undefined);
  assert.equal(
    extractStartupDiagnostics(
      JSON.stringify({
        diagnostics: { events: Array.from({ length: 257 }, () => ({})) },
      }),
    ),
    undefined,
  );
});

test('profile artifact indexing keeps bounded metadata and rejects unsafe entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opensip-profile-artifacts-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })),
  );
  const before = await captureProfileArtifactSnapshot(root);
  await writeFile(join(root, 'run-command.cpuprofile'), 'profile body');
  await writeFile(join(root, 'run-command.labels.json'), '{}');
  await writeFile(join(root, 'not-a-profile.txt'), 'ignored');
  await writeFile(join(root, 'oversized.labels.json'), Buffer.alloc(MAX_PROFILE_LABEL_BYTES + 1));
  await mkdir(join(root, 'nested'));
  await symlink(join(root, 'run-command.cpuprofile'), join(root, 'linked.cpuprofile'));

  const after = await captureProfileArtifactSnapshot(root);
  const index = indexNewProfileArtifacts(before, after);
  assert.deepEqual(
    index.files.map((entry) => ({ file: entry.file, kind: entry.kind })),
    [
      { file: 'run-command.cpuprofile', kind: 'cpu-profile' },
      { file: 'run-command.labels.json', kind: 'labels' },
    ],
  );
  assert.ok(index.omittedCount >= 4);
  assert.equal(JSON.stringify(index).includes('profile body'), false);
  assert.equal(hasProfileArtifactPair(index), true);
});

test('profile artifact snapshots cap indexed file count deterministically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opensip-profile-cap-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })),
  );
  await Promise.all(
    Array.from({ length: MAX_PROFILE_ARTIFACTS + 3 }, (_, index) =>
      writeFile(join(root, `profile-${String(index).padStart(3, '0')}.cpuprofile`), ''),
    ),
  );
  const snapshot = await captureProfileArtifactSnapshot(root);
  assert.equal(snapshot.entries.size, MAX_PROFILE_ARTIFACTS);
  assert.equal(snapshot.omittedCount, 3);
});

test('cpu-profile evidence fails closed when no artifact pair is produced', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'opensip-bench-profile-missing-artifacts-'));
  const config = minimalProfileConfig(repoRoot);
  config.profiles.pr.scenarios = ['graph-cold'];
  config.scenarios['graph-cold'] = { label: 'Graph cold', description: 'test' };
  const result = await runBenchProfile(
    [
      '--cpu-profile',
      '--runs',
      '1',
      '--scenario',
      'graph-cold',
      '--out',
      'result.json',
      '--markdown',
      'result.md',
    ],
    {
      repoRoot,
      existsSync: () => true,
      loadSloConfig: async () => config,
      collectBenchmarkEnvironment: async () => ({ node: 'v24.16.0' }),
      materializeCorpus: async ({ root }) => ({
        root,
        fileCount: 2,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
      }),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      runMeasuredCommand: async () => ({
        status: 0,
        timedOut: false,
        durationMs: 10,
        maxRssBytes: 100,
      }),
      captureProfileArtifactSnapshot: async (directory) => ({
        directory,
        entries: new Map(),
        omittedCount: 0,
      }),
      writeFile: () => Promise.resolve(),
      consoleLog: () => null,
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.report.verdict, 'fail');
  assert.equal(result.report.scenarios[0].profileArtifactFailure, true);
  await import('node:fs/promises').then(({ rm }) => rm(repoRoot, { recursive: true, force: true }));
});

test('a timed-out graph setup cannot prime a measured profile sample', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'opensip-bench-profile-timeout-'));
  const config = minimalProfileConfig(repoRoot);
  config.profiles.pr.scenarios = ['graph-impact-files'];
  config.scenarios['graph-impact-files'] = {
    label: 'Graph impact',
    description: 'test',
  };
  let invocations = 0;
  const result = await runBenchProfile(
    [
      '--runs',
      '1',
      '--scenario',
      'graph-impact-files',
      '--out',
      'result.json',
      '--markdown',
      'result.md',
    ],
    {
      repoRoot,
      existsSync: () => true,
      loadSloConfig: async () => config,
      collectBenchmarkEnvironment: async () => ({ node: 'v24.16.0' }),
      materializeCorpus: async ({ root }) => ({
        root,
        fileCount: 2,
        changedFiles: ['src/module-0.ts'],
        gitReady: true,
      }),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      runMeasuredCommand: async () => {
        invocations += 1;
        return { status: 0, timedOut: true, durationMs: 10, maxRssBytes: 100 };
      },
      writeFile: () => Promise.resolve(),
      consoleLog: () => null,
    },
  );

  assert.equal(invocations, 1);
  assert.equal(result.report.scenarios[0].setupFailure, true);
  assert.equal(result.report.verdict, 'fail');
  await import('node:fs/promises').then(({ rm }) => rm(repoRoot, { recursive: true, force: true }));
});

test('profile reports aggregate repeated duration, RSS, graph, and startup samples', () => {
  const samples = [10, 30, 20].map((durationMs, index) => ({
    tier: 'small',
    scenario: 'graph-cold',
    label: 'Graph cold',
    status: 0,
    timedOut: false,
    durationMs,
    maxRssBytes: (index + 1) * 100,
    graphProfile: { stages: [{ name: 'parse', durationMs: durationMs / 2 }] },
    startupDiagnostics: {
      startup: {
        elapsedMs: durationMs,
        phases: [{ phase: 'first-party-tools', durationMs: durationMs / 4 }],
      },
    },
  }));
  const summary = summarizeScenarioSamples(samples);
  assert.deepEqual(summary.durationMs, { min: 10, median: 20, p95: 30 });
  assert.deepEqual(summary.maxRssBytes, {
    min: 100,
    median: 200,
    p95: 300,
    max: 300,
  });
  assert.equal(summary.graphProfile.stages[0].durationMs.median, 10);
  assert.equal(summary.startupDiagnostics.startup.elapsedMs.median, 20);
});

test('profile finalization fails when any repeated sample fails and renders compact markdown', () => {
  const report = createProfileReport({
    measurementMode: 'clean-wall',
    profile: 'pr',
    quick: true,
    runs: 2,
    repoRoot: '/repo',
    environment: { node: 'v24.16.0', gitSha: 'abc' },
    config: {
      sourcePath: '/repo/.config/performance-slos.json',
      sampleIntervalMs: 25,
      tailBytes: { stdout: 128, stderr: 128 },
    },
  });
  report.scenarios.push(
    {
      tier: 'small',
      scenario: 'cli-help',
      label: 'CLI help',
      status: 0,
      durationMs: 10,
      maxRssBytes: 100,
      startupDiagnostics: {
        startup: {
          elapsedMs: 8,
          phases: [{ phase: 'first-party-tools', durationMs: 4 }],
        },
      },
    },
    {
      tier: 'small',
      scenario: 'cli-help',
      label: 'CLI help',
      status: 1,
      durationMs: 11,
      maxRssBytes: 110,
    },
  );
  finalizeProfileReport(report);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.scenarioSummaries[0].failedSamples, 1);
  assert.match(renderProfileMarkdown(report), /clean-wall/u);
  assert.match(renderProfileMarkdown(report), /small \/ cli-help/u);
  assert.match(renderProfileMarkdown(report), /Ranked hotspot evidence/u);
});

function minimalProfileConfig(repoRoot) {
  return {
    version: 1,
    sourcePath: join(repoRoot, '.config/performance-slos.json'),
    sampleIntervalMs: 25,
    tailBytes: { stdout: 128, stderr: 128 },
    profiles: {
      pr: { description: 'test', tiers: ['small'], scenarios: ['cli-help'] },
    },
    tiers: {
      small: { maxFiles: 10, maxLoc: 100, fileCount: 2, quickFileCount: 2 },
    },
    scenarios: {
      'cli-help': { label: 'CLI help', description: 'test' },
    },
    budgets: [],
    budgetByKey: new Map(),
  };
}
