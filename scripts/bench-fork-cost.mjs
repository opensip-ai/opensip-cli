#!/usr/bin/env node
//
// bench-fork-cost — manual evidence harness for the subprocess-all follow-up ADR.
//
// Measures real CLI wall time with the default live-worker subprocess path versus
// the bundled-only in-process fallback (`OPENSIP_CLI_NO_WORKER=1`) for fit/graph.
// This is intentionally non-gating: it produces a numbers table, not a perf ratchet.
//
// Usage:
//   pnpm bench:fork-cost -- --runs 3
//   pnpm bench:fork-cost -- --commands fit,graph --quick

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
const runs = args.runs === undefined ? defaultRuns : Number.parseInt(args.runs, 10);
const commands = args.commands
  .split(',')
  .map((command) => command.trim())
  .filter((command) => command.length > 0);

if (!Number.isFinite(runs) || runs <= 0) {
  console.error('--runs must be a positive integer.');
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

function commandArgs(command) {
  if (command === 'fit') return ['fit'];
  if (command === 'graph') return ['graph'];
  throw new Error(`unsupported command '${command}' (supported: fit, graph)`);
}

function runOne(command, mode) {
  const env = {
    ...process.env,
    ...(mode === 'in-process' ? { OPENSIP_CLI_NO_WORKER: '1' } : {}),
  };
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...commandArgs(command)], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = performance.now() - started;
  return {
    durationMs,
    status: result.status ?? 1,
    stderrTail: (result.stderr ?? '').split('\n').slice(-8).join('\n'),
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stdev(values) {
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function fmt(ms) {
  return ms.toFixed(0);
}

const rows = [];
for (const command of commands) {
  for (const mode of ['worker', 'in-process']) {
    const durations = [];
    for (let i = 0; i < runs; i += 1) {
      console.error(`bench-fork-cost: ${command} ${mode} run ${String(i + 1)}/${String(runs)}`);
      const run = runOne(command, mode);
      if (run.status !== 0) {
        console.error(`${command} ${mode} failed with exit ${String(run.status)}.`);
        if (run.stderrTail.length > 0) console.error(run.stderrTail);
        process.exit(run.status);
      }
      durations.push(run.durationMs);
    }
    rows.push({
      command,
      mode,
      medianMs: median(durations),
      meanMs: mean(durations),
      stdevMs: stdev(durations),
    });
  }
}

console.log('\n## Fork-cost benchmark\n');
console.log('| Command | Mode | Runs | Median ms | Mean ms | Stddev ms |');
console.log('| --- | --- | ---: | ---: | ---: | ---: |');
for (const row of rows) {
  console.log(
    `| ${row.command} | ${row.mode} | ${String(runs)} | ${fmt(row.medianMs)} | ${fmt(
      row.meanMs,
    )} | ${fmt(row.stdevMs)} |`,
  );
}
