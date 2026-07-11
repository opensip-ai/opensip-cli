#!/usr/bin/env node
/**
 * typecheck-tests — run `tsc --noEmit` over every generated `<pkg>/tsconfig.test.json`
 * (ADR-0150). This is the semantic-checking lane for test sources, which the
 * production package builds intentionally exclude. Each package is checked in
 * isolation (see scripts/build-test-tsconfigs.mjs) and in parallel.
 *
 * Root `pnpm typecheck` runs this after `turbo run typecheck`. Exit non-zero if
 * any package's tests fail to type-check.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
const log = (msg) => console.error(`[typecheck-tests] ${msg}`);

function runOne(configPath, relativeDir) {
  return new Promise((resolve) => {
    const child = spawn(TSC, ['-p', configPath, '--noEmit', '--pretty', 'false'], {
      cwd: REPO_ROOT,
      shell: false,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const errorCount = (out.match(/error TS\d+/g) ?? []).length;
      resolve({ relativeDir, code: code ?? 1, errorCount, output: out.trimEnd() });
    });
    child.on('error', (err) => {
      resolve({ relativeDir, code: 1, errorCount: 1, output: `spawn failed: ${err.message}` });
    });
  });
}

async function main() {
  const records = readWorkspacePackageManifests(REPO_ROOT);
  const jobs = [];
  for (const rec of records) {
    const configPath = join(rec.dir, 'tsconfig.test.json');
    if (existsSync(configPath)) jobs.push({ configPath, relativeDir: rec.relativeDir });
  }
  if (jobs.length === 0) {
    log('no test tsconfigs found — did you run `pnpm typecheck:tests:sync`?');
    process.exit(1);
  }

  const concurrency = Math.max(1, Math.min(jobs.length, availableParallelism() - 1));
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      results.push(await runOne(job.configPath, job.relativeDir));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const failures = results.filter((r) => r.code !== 0).sort((a, b) => b.errorCount - a.errorCount);
  if (failures.length > 0) {
    for (const f of failures) {
      log(`FAIL ${f.relativeDir} (${f.errorCount} error(s))`);
      if (f.output) console.error(f.output);
    }
    log(`FAIL — ${failures.length}/${jobs.length} package test suites did not type-check`);
    process.exit(1);
  }
  log(`ok — ${jobs.length} package test suites type-checked`);
}

main();
