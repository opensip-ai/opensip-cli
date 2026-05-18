/**
 * Tests for the --packages parallel runner.
 *
 * Strategy: rather than mock node:child_process, we feed
 * runPackagesInParallel a tiny Node script as the "CLI" that emits a
 * CliOutput-shaped JSON document on stdout. The runner spawns it
 * once per pseudo-package; we then verify aggregation, ordering,
 * exit-code propagation, and concurrency cap.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPackagesInParallel } from '../../cli/packages-runner.js';

/**
 * A faux CLI script that mimics what `graph --package <dir> --json`
 * would emit. It reads its own packageDir argv and produces a
 * CliOutput document with one finding per package, so the parent's
 * aggregation logic is observable.
 */
const FAKE_CLI = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
// args[0] = 'graph', args[1] = '--package', args[2] = packageDir, args[3] = '--json', maybe args[4] = '--no-cache'
const packageDir = args[2] || 'unknown';
const action = process.env.OPENSIP_TEST_FAKE_ACTION || 'ok';
if (action === 'fail') {
  process.stderr.write('synthetic failure for ' + packageDir + '\n');
  process.exit(1);
}
if (action === 'badjson') {
  process.stdout.write('not-actually-json\n');
  process.exit(0);
}
const output = {
  version: '1.0',
  tool: 'graph',
  timestamp: new Date().toISOString(),
  recipe: 'graph',
  score: 100,
  passed: true,
  summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
  checks: [
    {
      checkSlug: 'fake-rule',
      passed: false,
      violationCount: 1,
      durationMs: 0,
      findings: [
        {
          ruleId: 'fake-rule',
          message: 'finding from ' + packageDir,
          severity: 'warning',
          filePath: packageDir + '/synthetic.ts',
          line: 1,
          column: 0,
        },
      ],
    },
  ],
  durationMs: 0,
};
process.stdout.write(JSON.stringify(output));
process.exit(0);
`;

describe('runPackagesInParallel', () => {
  let dir: string;
  let fakeCliPath: string;
  let pkgDirs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-packages-'));
    fakeCliPath = join(dir, 'fake-cli.cjs');
    writeFileSync(fakeCliPath, FAKE_CLI, 'utf8');
    pkgDirs = ['packages/a', 'packages/b', 'packages/c'].map((rel) => {
      const p = join(dir, rel);
      mkdirSync(p, { recursive: true });
      return p;
    });
    delete process.env.OPENSIP_TEST_FAKE_ACTION;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENSIP_TEST_FAKE_ACTION;
  });

  it('aggregates findings from each child', async () => {
    const result = await runPackagesInParallel({
      cwd: dir,
      packageDirs: pkgDirs,
      cliScript: fakeCliPath,
      concurrency: 2,
    });
    expect(result.anyChildFailed).toBe(false);
    expect(result.perPackage).toHaveLength(3);
    const totalFindings = result.perPackage.reduce((n, r) => n + r.findings.length, 0);
    expect(totalFindings).toBe(3);
    // Each finding should reference its source packageDir.
    for (const r of result.perPackage) {
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.message).toContain(r.packageDir);
    }
  });

  it('returns results sorted by packageDir for deterministic display', async () => {
    const shuffled = [pkgDirs[2], pkgDirs[0], pkgDirs[1]];
    const result = await runPackagesInParallel({
      cwd: dir,
      packageDirs: shuffled,
      cliScript: fakeCliPath,
      concurrency: 3,
    });
    const order = result.perPackage.map((r) => r.packageDir);
    expect(order).toEqual([...pkgDirs].sort());
  });

  it('flags anyChildFailed when a child exits non-zero', async () => {
    process.env.OPENSIP_TEST_FAKE_ACTION = 'fail';
    const result = await runPackagesInParallel({
      cwd: dir,
      packageDirs: pkgDirs,
      cliScript: fakeCliPath,
      concurrency: 2,
    });
    expect(result.anyChildFailed).toBe(true);
    for (const r of result.perPackage) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('synthetic failure');
      expect(r.findings).toHaveLength(0);
    }
  });

  it('returns empty findings when a child emits non-JSON stdout', async () => {
    process.env.OPENSIP_TEST_FAKE_ACTION = 'badjson';
    const result = await runPackagesInParallel({
      cwd: dir,
      packageDirs: pkgDirs,
      cliScript: fakeCliPath,
      concurrency: 2,
    });
    expect(result.anyChildFailed).toBe(false);
    for (const r of result.perPackage) {
      expect(r.findings).toHaveLength(0);
    }
  });

  it('throws ConfigurationError when no packages are passed', async () => {
    await expect(
      runPackagesInParallel({
        cwd: dir,
        packageDirs: [],
        cliScript: fakeCliPath,
      }),
    ).rejects.toThrow(/no workspace packages found/);
  });

  it('respects an explicit concurrency override', async () => {
    // 6 packages, concurrency 1 — a sequential run still returns all
    // results. This is mostly a smoke test that the worker-pool
    // pattern doesn't deadlock with low concurrency.
    const more = ['packages/d', 'packages/e', 'packages/f'].map((rel) => {
      const p = join(dir, rel);
      mkdirSync(p, { recursive: true });
      return p;
    });
    const result = await runPackagesInParallel({
      cwd: dir,
      packageDirs: [...pkgDirs, ...more],
      cliScript: fakeCliPath,
      concurrency: 1,
    });
    expect(result.perPackage).toHaveLength(6);
    expect(result.anyChildFailed).toBe(false);
  });
});
