// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Branch-coverage tests for medium-coverage checks (round 12).
 *
 * Targets the dangerous-config-defaults value extractors (config, TLS,
 * pool-size) and the exit-code-correctness catch-block analyzer.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov12-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => fileCache.clear());

// =============================================================================
// dangerous-config-defaults: config / TLS-with-quotes / pool-size extractors
// =============================================================================

describe('dangerous-config-defaults extractors', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('dcd');
    // ssl: false and rejectUnauthorized: false and debug: true.
    writeFixture(
      cwd,
      'src/config.ts',
      [
        'export const db = {',
        '  ssl: false,',
        '  rejectUnauthorized: false,',
        '  debug: true,',
        '}',
      ].join('\n'),
    );
    // Global TLS reject env var set to 0 with quotes -> TLS extractor branches.
    writeFixture(cwd, 'src/tls.ts', ["process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'"].join('\n'));
    // Very small connection pool -> pool-size extractor branch.
    writeFixture(cwd, 'src/pool.ts', ['export const opts = { poolSize: 1 }'].join('\n'));
    // A safe config (ssl: true) -> the expected-value mismatch path, no flag.
    writeFixture(cwd, 'src/safe.ts', ['export const db = { ssl: true }'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags ssl/rejectUnauthorized=false and debug=true', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/config.ts')],
    });
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('flags NODE_TLS_REJECT_UNAUTHORIZED set to a quoted 0', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/tls.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags a dangerously small connection pool size', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/pool.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not flag a safe ssl: true config', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/safe.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// exit-code-correctness: catch-block propagation analysis
// =============================================================================

describe('exit-code-correctness catch blocks', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('exit-code');
    // A CLI file whose catch logs but does not propagate -> flagged.
    writeFixture(
      cwd,
      'cli/run.ts',
      [
        'export async function main() {',
        '  try {',
        '    await doWork()',
        '  } catch (err) {',
        '    logger.error(err)',
        '  }',
        '}',
      ].join('\n'),
    );
    // A catch that logs AND re-throws -> propagation path, not flagged.
    writeFixture(
      cwd,
      'cli/ok.ts',
      [
        'export async function main() {',
        '  try {',
        '    await doWork()',
        '  } catch (err) {',
        '    logger.error(err)',
        '    throw err',
        '  }',
        '}',
      ].join('\n'),
    );
    // A catch that does NOT log an error -> logsError-false continue branch.
    writeFixture(
      cwd,
      'cli/silent.ts',
      [
        'export async function main() {',
        '  try {',
        '    await doWork()',
        '  } catch (err) {',
        '    return undefined',
        '  }',
        '}',
      ].join('\n'),
    );
    // A CLI test file -> skipped by the test-file guard.
    writeFixture(
      cwd,
      'cli/run.test.ts',
      [
        'export async function main() {',
        '  try { await doWork() } catch (err) { logger.error(err) }',
        '}',
      ].join('\n'),
    );
    // A non-CLI file -> skipped by the path guard.
    writeFixture(
      cwd,
      'src/util.ts',
      ['export function f() { try { g() } catch (e) { logger.error(e) } }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags a CLI catch block that logs but does not propagate', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'cli/run.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not flag a catch that re-throws', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'cli/ok.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not flag a catch that does not log an error', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'cli/silent.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips CLI test files', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'cli/run.test.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-CLI files', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'src/util.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});
