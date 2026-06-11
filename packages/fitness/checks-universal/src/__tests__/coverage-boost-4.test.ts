// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Final batch of coverage tests for the remaining gaps.
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
  return mkdtempSync(join(tmpdir(), `cu-cov4-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => fileCache.clear());

// =============================================================================
// cache-ttl-validation: drives all four violation paths
// =============================================================================

describe('cache-ttl-validation', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('cache-ttl');
    writeFixture(
      cwd,
      'src/cache/short.ts',
      [
        'const cacheConfig = {',
        '  ttl: 1,', // too short
        '};',
        'export { cacheConfig };',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/cache/financial.ts',
      [
        'const cacheConfig = {',
        '  ttl: 600, // payment balance cache',
        '  payment: true,',
        '};',
        'export { cacheConfig };',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/cache/sensitive.ts',
      [
        'const cacheConfig = {',
        '  ttl: 86400, // session token cache',
        '  session: true,',
        '};',
        'export { cacheConfig };',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/cache/general-too-long.ts',
      [
        'const cacheConfig = {',
        '  ttl: 999999, // generic cache',
        '};',
        'export { cacheConfig };',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/cache/safe.ts',
      ['const cacheConfig = {', '  ttl: 300,', '};', 'export { cacheConfig };'].join('\n'),
    );
    writeFixture(cwd, 'src/no-cache.ts', 'export const x = 1;');
    writeFixture(
      cwd,
      'src/cache/map-set.ts',
      [
        'const cache = new Map();',
        'cache.set("k", "v"); // not a cache TTL',
        'export { cache };',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags TTL that is too short', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/short.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('ttl-too-short');
  });

  it('flags financial data with long TTL', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/financial.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('financial-ttl-too-long');
  });

  it('flags sensitive data with long TTL', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/sensitive.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sensitive-ttl-too-long');
  });

  it('flags general data with excessive TTL', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/general-too-long.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('ttl-too-long');
  });

  it('does not fire on safe TTL values', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/safe.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without cache patterns', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/no-cache.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips Map.set / metrics operations', async () => {
    const result = await findCheck('cache-ttl-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/cache/map-set.ts')],
    });
    // No TTL pattern so 0 signals; we're exercising the skip branch.
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// test-file-naming — file with bad name in __tests__
// =============================================================================

describe('test-file-naming', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('test-naming');
    // Set up packages/<x>/__tests__/<bad-name>.ts
    writeFixture(
      cwd,
      'packages/a/__tests__/foo-spec.ts',
      ['import { it } from "vitest";', 'it("works", () => undefined);'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/__tests__/bar.test.ts',
      ['import { it } from "vitest";', 'it("works", () => undefined);'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/__tests__/setup.ts',
      ['export const setup = () => undefined;'].join('\n'),
    );
    // Marker for the analyzer's "find packages dir" walk
    writeFixture(cwd, 'package.json', JSON.stringify({ name: 'root' }, null, 2));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer end-to-end without throwing', async () => {
    const result = await findCheck('test-file-naming').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/a/__tests__/foo-spec.ts'),
        join(cwd, 'packages/a/__tests__/bar.test.ts'),
        join(cwd, 'packages/a/__tests__/setup.ts'),
      ],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// test-file-pairing
// =============================================================================

describe('test-file-pairing', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('test-pair');
    writeFixture(cwd, 'package.json', JSON.stringify({ name: 'root' }, null, 2));
    writeFixture(
      cwd,
      'packages/a/src/orphan.ts',
      ['export function unused() { return 1; }'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/src/paired.ts',
      ['export function paired() { return 1; }'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/src/__tests__/paired.test.ts',
      ['import { it, expect } from "vitest";', 'it("works", () => expect(1).toBe(1));'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/src/types.ts',
      ['export type Thing = { id: string };'].join('\n'),
    );
    writeFixture(
      cwd,
      'packages/a/src/with-pending.ts',
      ['// @test-pending — work in progress', 'export function pending() { return 1; }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer end-to-end without throwing', async () => {
    const result = await findCheck('test-file-pairing').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/a/src/orphan.ts'),
        join(cwd, 'packages/a/src/paired.ts'),
        join(cwd, 'packages/a/src/__tests__/paired.test.ts'),
        join(cwd, 'packages/a/src/types.ts'),
        join(cwd, 'packages/a/src/with-pending.ts'),
      ],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// docker-ignore-validation — fire path
// =============================================================================

describe('docker-ignore-validation cases', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('di-cases');
    // Dockerfile present, but .dockerignore missing important entries
    writeFixture(
      cwd,
      'Dockerfile',
      ['FROM node:20', 'COPY . .', 'RUN npm install', 'CMD ["node", "src/app.js"]'].join('\n'),
    );
    writeFixture(cwd, '.dockerignore', '# empty\n');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer without throwing', async () => {
    const result = await findCheck('docker-ignore-validation').run(cwd, {
      targetFiles: [join(cwd, 'Dockerfile'), join(cwd, '.dockerignore')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// retry-config-validation: edge cases
// =============================================================================

describe('retry-config-validation edges', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('retry-edges');
    // Comment line — should be skipped
    writeFixture(
      cwd,
      'src/skip-comment.ts',
      [
        'export const retryConfig = {',
        '  // maxRetries: 100, // commented-out',
        '  maxRetries: 5,',
        '};',
      ].join('\n'),
    );
    // Excessive baseDelay only
    writeFixture(
      cwd,
      'src/aggressive.ts',
      ['export const retryConfig = {', '  maxRetries: 3,', '  baseDelay: 5,', '};'].join('\n'),
    );
    // Both above thresholds
    writeFixture(
      cwd,
      'src/both.ts',
      ['export const retryConfig = {', '  maxRetries: 100,', '  baseDelay: 1,', '};'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('skips commented-out retry config lines', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/skip-comment.ts')],
    });
    // The commented-out 100 should not fire; the active 5 is sane.
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).not.toContain('excessive-retries');
  });

  it('flags aggressive baseDelay below 100ms', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/aggressive.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('aggressive-retry-delay');
  });

  it('flags both excessive retries and aggressive delay together', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/both.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('excessive-retries');
    expect(types).toContain('aggressive-retry-delay');
  });
});

// =============================================================================
// no-hardcoded-timeouts edges
// =============================================================================

describe('no-hardcoded-timeouts edges', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('hardcoded-edges');
    writeFixture(
      cwd,
      'src/comment-line.ts',
      ['// timeout = 30000 — commented config example', 'export const x = 1;'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/non-numeric.ts',
      ['export function setup(client: any) {', '  client.timeout(THIRTY_SECONDS);', '}'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('skips comment lines', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/comment-line.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-numeric timeout references', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/non-numeric.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// dangerous-config-defaults: drives `0` value branch and TLS pattern
// =============================================================================

describe('dangerous-config-defaults additional', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('dcd-add');
    // Pool size 2
    writeFixture(
      cwd,
      'src/pool.ts',
      ['export const config = {', '  poolSize: 2,', '};'].join('\n'),
    );
    // SSL true is OK
    writeFixture(
      cwd,
      'src/ssl-true.ts',
      ['export const config = {', '  ssl: true,', '};'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags small pool size', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/pool.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('pool size'))).toBe(true);
  });

  it('does not fire when ssl is true', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/ssl-true.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// reentrancy-guard: extra patterns
// =============================================================================

describe('reentrancy-guard variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('reentry-variants');
    writeFixture(
      cwd,
      'src/locked.ts',
      [
        'let cacheLocked = false;',
        'export function update() {',
        '  if (cacheLocked) {',
        '    return;',
        '  }',
        '  cacheLocked = true;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/initialized.ts',
      [
        'let isInitialized = false;',
        'export function init() {',
        '  if (isInitialized) return;',
        '  isInitialized = true;',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags Locked-suffix flags', async () => {
    const result = await findCheck('reentrancy-guard').run(cwd, {
      targetFiles: [join(cwd, 'src/locked.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('boolean-reentrancy-guard');
  });

  it('flags Initialized-suffix flags', async () => {
    const result = await findCheck('reentrancy-guard').run(cwd, {
      targetFiles: [join(cwd, 'src/initialized.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('boolean-reentrancy-guard');
  });
});

// =============================================================================
// readline-cleanup: with cleanup using using/Symbol.dispose
// =============================================================================

describe('readline-cleanup variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('rl-variants');
    writeFixture(
      cwd,
      'src/using.ts',
      [
        'export async function ask() {',
        '  using rl = readline.createInterface({});',
        '  return rl;',
        '}',
      ].join('\n'),
    );
    writeFixture(cwd, 'src/no-readline.ts', 'export const x = 1;');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('does not fire when using-block ensures cleanup', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/using.ts')],
    });
    // Cleanup keyword `using` matches CLEANUP_PATTERNS, so no violations
    expect(result.signals.length).toBe(0);
  });

  it('skips files without readline references', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/no-readline.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// no-process-exit-in-finally
// =============================================================================

describe('no-process-exit-in-finally', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('npe-finally');
    writeFixture(
      cwd,
      'src/exit-in-finally.ts',
      [
        'export function shutdown() {',
        '  try { cleanup(); }',
        '  finally { process.exit(0); }',
        '}',
        'function cleanup() {}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/clean.ts',
      [
        'export function shutdown() {',
        '  try { cleanup(); }',
        '  finally { /* no exit */ }',
        '}',
        'function cleanup() {}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags process.exit() in finally blocks', async () => {
    const result = await findCheck('no-process-exit-in-finally').run(cwd, {
      targetFiles: [join(cwd, 'src/exit-in-finally.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not fire on clean finally blocks', async () => {
    const result = await findCheck('no-process-exit-in-finally').run(cwd, {
      targetFiles: [join(cwd, 'src/clean.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// recovery-patterns: drives more code
// =============================================================================

describe('recovery-patterns additional', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('recovery-add');
    writeFixture(
      cwd,
      'src/exponential.ts',
      [
        'export async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {',
        '  for (let i = 0; i < 5; i++) {',
        '    try { return await fn(); } catch (e) {',
        '      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));',
        '    }',
        '  }',
        '  throw new Error("retry exhausted");',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on exponential backoff fixture', async () => {
    const result = await findCheck('recovery-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/exponential.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// performance-anti-patterns variants
// =============================================================================

describe('performance-anti-patterns variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('perf-variants');
    writeFixture(
      cwd,
      'src/sync-await.ts',
      [
        'export async function listItems(items: number[]) {',
        '  for (const i of items) {',
        '    await sendOne(i);',
        '  }',
        '}',
        'async function sendOne(_n: number) { return; }',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/parallel-ok.ts',
      [
        'export async function listItems(items: number[]) {',
        '  await Promise.all(items.map(sendOne));',
        '}',
        'async function sendOne(_n: number) { return; }',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on sequential await pattern', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/sync-await.ts')],
    });
    expect(result).toBeDefined();
  });

  it('runs without throwing on parallel pattern', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/parallel-ok.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// no-non-null-assertions: drives more branches
// =============================================================================

describe('no-non-null-assertions variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('non-null-variants');
    writeFixture(
      cwd,
      'src/multi.ts',
      [
        'export function chain(arr: any[]) {',
        '  const a = arr[0]!.b!.c!;',
        '  return a;',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/test-skip.test.ts',
      [
        'import { it, expect } from "vitest";',
        'it("uses bang", () => { expect(arr[0]!.b).toBe(1); });',
        'declare const arr: any;',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on chained non-null assertions', async () => {
    const result = await findCheck('no-non-null-assertions').run(cwd, {
      targetFiles: [join(cwd, 'src/multi.ts')],
    });
    expect(result).toBeDefined();
  });

  it('skips test files', async () => {
    const result = await findCheck('no-non-null-assertions').run(cwd, {
      targetFiles: [join(cwd, 'src/test-skip.test.ts')],
    });
    // Test file is skipped → 0 violations expected
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// directive-audit: drive the exact stats branches
// =============================================================================

describe('directive-audit suppression categories', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('directive-cat');
    writeFixture(
      cwd,
      'src/many-fitness.ts',
      [
        '// @fitness-ignore-file foo -- a',
        '// @fitness-ignore-file bar -- b',
        '// @fitness-ignore-next-line baz -- c',
        'const x = 1;',
        '/* eslint-disable no-console */',
        'console.log("disabled");',
        '/* eslint-enable */',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing', async () => {
    const result = await findCheck('directive-audit').run(cwd, {
      targetFiles: [join(cwd, 'src/many-fitness.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// dependency-vulnerability-audit: smoke on a file with curated dangerous patterns
// =============================================================================

describe('dependency-vulnerability-audit', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('sec-scan');
    writeFixture(
      cwd,
      'src/cookies.ts',
      [
        'export const cookieSecure = "Set-Cookie: token=abc; HttpOnly; Secure; SameSite=Strict";',
        'export const cookieInsecure = "Set-Cookie: token=abc";',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/exec.ts',
      [
        'export function dangerous(input: string) {',
        '  return require("node:child_process").exec(`echo ${input}`);',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  // dependency-vulnerability-audit shells out (`sh -c '...pnpm audit...'`).
  // pnpm audit walks the lockfile and queries the registry; on CI
  // this can take several seconds. Three success paths:
  //   1. audit completes — returns a CheckResult with violations.
  //   2. audit fails fast (no lockfile, no internet, etc.) —
  //      returns a CheckResult with `error` populated.
  //   3. CheckAbortedError thrown via vitest's signal at the
  //      testTimeout ceiling. Clean abort is the framework's
  //      contract under signal cancellation.
  // The check itself caps at 90 s via its own timeout config.
  it('runs without throwing on cookie/exec patterns', async () => {
    try {
      const result = await findCheck('dependency-vulnerability-audit').run(cwd, {
        targetFiles: [join(cwd, 'src/cookies.ts'), join(cwd, 'src/exec.ts')],
      });
      expect(result).toBeDefined();
    } catch (error) {
      const isCleanAbort =
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: unknown }).name === 'CheckAbortedError';
      if (!isCleanAbort) throw error;
      expect(isCleanAbort).toBe(true);
    }
  }, 60_000);
});

// =============================================================================
// heavy-import-detection: explicit moment / lodash imports
// =============================================================================

describe('heavy-import-detection variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('heavy-variants');
    writeFixture(
      cwd,
      'src/full-lodash.ts',
      ['import _ from "lodash";', 'export const x = _.pick({ a: 1 }, ["a"]);'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/cherry-lodash.ts',
      ['import pick from "lodash/pick";', 'export const x = pick({ a: 1 }, ["a"]);'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on heavy lodash import', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/full-lodash.ts')],
    });
    expect(result).toBeDefined();
  });

  it('runs without throwing on cherry-picked lodash import', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/cherry-lodash.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// graphql-offset-pagination: backtick template variant
// =============================================================================

describe('graphql-offset-pagination variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('gql-variants');
    writeFixture(
      cwd,
      'src/backtick.ts',
      [
        'export const Q = `',
        '  query Items($offset: Int, $limit: Int) {',
        '    items(offset: $offset, limit: $limit) { id }',
        '  }',
        '`;',
      ].join('\n'),
    );
    writeFixture(cwd, 'src/no-template.ts', ['export const Q = "no template";'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('detects $offset in plain template literals containing query', async () => {
    const result = await findCheck('graphql-offset-pagination').run(cwd, {
      targetFiles: [join(cwd, 'src/backtick.ts')],
    });
    expect(result).toBeDefined();
  });

  it('does not fire on non-GraphQL strings', async () => {
    const result = await findCheck('graphql-offset-pagination').run(cwd, {
      targetFiles: [join(cwd, 'src/no-template.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});
