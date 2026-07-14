#!/usr/bin/env node
//
// bench-fork-cost — manual evidence harness for the subprocess-all follow-up ADR.
//
// Measures built-CLI wall time with the bundled worker subprocess path versus
// the bundled-only in-process fallback (`OPENSIP_CLI_NO_WORKER=1`) for fit/graph.
// Every sample receives a fresh deterministic corpus so cache/order effects are
// not mislabeled as process overhead. This is intentionally non-gating.
//
// Usage:
//   pnpm bench:fork-cost -- --runs 3
//   pnpm bench:fork-cost -- --commands fit,graph --quick

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { BENCHMARK_NODE_OPTIONS, createCleanWallChildEnv } from './perf/benchmark-environment.mjs';
import { cleanupOwnedCorpus, materializeCorpus } from './perf/corpus.mjs';
import { loadSloConfig } from './perf/slo-config.mjs';
import { fingerprintStructuredResult } from './perf/result-fingerprint.mjs';
import { median } from './perf/statistics.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

const { values: args } = parseArgs({
  options: {
    commands: { type: 'string', default: 'fit,graph' },
    runs: { type: 'string' },
    quick: { type: 'boolean', default: false },
  },
});

const quick = args.quick === true;
const defaultRuns = quick ? 1 : 3;
const runs = args.runs === undefined ? defaultRuns : parseRuns(args.runs);
const commands = args.commands
  .split(',')
  .map((command) => command.trim())
  .filter((command) => command.length > 0);

if (!Number.isSafeInteger(runs)) {
  console.error('--runs must be an integer between 1 and 100.');
  process.exit(1);
}
const supportedCommands = new Set(['fit', 'graph']);
if (commands.length === 0 || commands.some((command) => !supportedCommands.has(command))) {
  console.error('--commands must contain only fit and/or graph.');
  process.exit(1);
}
if (!existsSync(cli)) {
  console.error(`CLI is not built at ${cli}. Run \`pnpm build\` first.`);
  process.exit(1);
}

console.error(
  'bench-fork-cost: driving packages/cli/dist — make sure `pnpm build` is FRESH ' +
    '(the npm alias does this automatically; a stale dist runs old behavior silently).',
);

const config = await loadSloConfig();
const tierId = 'small';
const tier = config.tiers[tierId];
if (tier === undefined) throw new Error(`performance SLO config has no '${tierId}' tier`);
const workRoot = await mkdtemp(join(tmpdir(), 'opensip-fork-cost-'));

function commandArgs(command) {
  if (command === 'fit') return ['fit', '--json'];
  if (command === 'graph') return ['graph', '--json'];
  throw new Error(`unsupported command '${command}' (supported: fit, graph)`);
}

function parseRuns(value) {
  if (!/^\d+$/u.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : Number.NaN;
}

function runOne(command, mode, cwd) {
  const env = {
    ...createCleanWallChildEnv(process.env),
    NODE_OPTIONS: BENCHMARK_NODE_OPTIONS,
    OPENSIP_CLI_SKIP_INSTALLED: '1',
    OPENSIP_DISABLE_UPDATE_CHECK: '1',
    ...(mode === 'in-process' ? { OPENSIP_CLI_NO_WORKER: '1' } : {}),
  };
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [cli, '--no-cloud', '--no-plugins', ...commandArgs(command)],
    {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      killSignal: 'SIGKILL',
    },
  );
  const durationMs = performance.now() - started;
  const outcome = validateStructuredOutcome(result, cwd);
  return {
    durationMs,
    status: result.status ?? 1,
    outcome: outcome.value,
    fingerprint: outcome.fingerprint,
    failure: result.error?.message ?? outcome.failure,
    stdoutTail: (result.stdout ?? '').split('\n').slice(-8).join('\n'),
    stderrTail: (result.stderr ?? '').split('\n').slice(-8).join('\n'),
  };
}

function validateStructuredOutcome(result, cwd) {
  let document;
  try {
    document = JSON.parse(result.stdout ?? '');
  } catch {
    return { failure: 'command did not emit one structured JSON result' };
  }
  const status = result.status ?? 1;
  if (
    (status !== 0 && status !== 1) ||
    document.status !== 'ok' ||
    document.exitCode !== status ||
    document.envelope?.verdict?.faulted !== false
  ) {
    return {
      failure: `unexpected command outcome (process=${String(status)}, document=${String(
        document.exitCode,
      )}, status=${String(document.status)})`,
    };
  }
  return {
    value: status === 0 ? 'pass' : 'findings',
    fingerprint: fingerprintStructuredResult(document, { corpusRoot: cwd }),
  };
}

async function measureSample(command, mode, sample) {
  const corpusRoot = join(workRoot, `${command}-${mode}-${String(sample)}`);
  await materializeCorpus({ root: corpusRoot, tierId, tier, quick });
  try {
    return runOne(command, mode, corpusRoot);
  } finally {
    await cleanupOwnedCorpus(corpusRoot);
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values) {
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function fmt(ms) {
  return ms.toFixed(0);
}

async function runBenchmarks() {
  const rows = [];
  try {
    for (const command of commands) {
      const byMode = new Map([
        ['worker', { durations: [], outcomes: [], fingerprints: [] }],
        ['in-process', { durations: [], outcomes: [], fingerprints: [] }],
      ]);
      for (let index = 0; index < runs; index += 1) {
        const modes = index % 2 === 0 ? ['worker', 'in-process'] : ['in-process', 'worker'];
        for (const mode of modes) {
          console.error(
            `bench-fork-cost: ${command} ${mode} run ${String(index + 1)}/${String(runs)}`,
          );
          const run = await measureSample(command, mode, index + 1);
          if (run.failure !== undefined) {
            throw new Error(
              `${command} ${mode} failed with exit ${String(run.status)}: ${run.failure}\n` +
                `${run.stdoutTail}\n${run.stderrTail}`,
            );
          }
          const measurements = byMode.get(mode);
          measurements.durations.push(run.durationMs);
          measurements.outcomes.push(run.outcome);
          measurements.fingerprints.push(run.fingerprint);
        }
      }
      const worker = byMode.get('worker');
      const inProcess = byMode.get('in-process');
      const outcomes = [...worker.outcomes, ...inProcess.outcomes];
      if (new Set(outcomes).size !== 1) {
        throw new Error(
          `${command} worker/in-process outcomes differed (${outcomes.join(', ')}); ` +
            'refusing to compare non-equivalent runs.',
        );
      }
      const fingerprints = [...worker.fingerprints, ...inProcess.fingerprints];
      if (new Set(fingerprints).size !== 1) {
        throw new Error(
          `${command} worker/in-process result fingerprints differed; ` +
            'refusing to compare non-equivalent evidence.',
        );
      }
      for (const [mode, measurements] of byMode) {
        rows.push({
          command,
          mode,
          outcome: measurements.outcomes[0],
          medianMs: median(measurements.durations),
          meanMs: mean(measurements.durations),
          stdevMs: stdev(measurements.durations),
        });
      }
    }
    return rows;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

try {
  const rows = await runBenchmarks();
  console.log('\n## Fork-cost benchmark\n');
  console.log(
    `Fresh deterministic ${tierId} corpus per sample (${String(
      quick ? tier.quickFileCount : tier.fileCount,
    )} files).`,
  );
  console.log('\n| Command | Mode | Outcome | Runs | Median ms | Mean ms | Stddev ms |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(
      `| ${row.command} | ${row.mode} | ${row.outcome} | ${String(runs)} | ${fmt(
        row.medianMs,
      )} | ${fmt(row.meanMs)} | ${fmt(row.stdevMs)} |`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
