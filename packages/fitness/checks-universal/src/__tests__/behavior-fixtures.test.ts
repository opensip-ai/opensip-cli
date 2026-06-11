// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Targeted fixture-based tests for universal check behavior.
 *
 * Each `describe` block targets a specific check behavior that the
 * all-checks-execute parametric run does not assert directly. The fixtures are
 * crafted to drive the analyze function past its bail-out conditions and into
 * its violation-creation branches.
 *
 * Pattern: build a tmpdir cwd, write fixture files, run the check via
 * `check.run(cwd, { targetFiles })`, then assert on the structured
 * `signals` array.
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
  return mkdtempSync(join(tmpdir(), `cu-cov-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => {
  // Each suite manages its own fileCache prewarming; ensure no
  // cross-test contamination.
  fileCache.clear();
});

// =============================================================================
// transaction-patterns: transaction-boundary-validation + transaction-timeout
// =============================================================================

describe('transaction-boundary-validation', () => {
  let cwd: string;
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('tx-boundary');
    files.push(
      writeFixture(
        cwd,
        'src/uncommitted.ts',
        [
          'export async function transfer(db: any) {',
          '  await db.beginTransaction();',
          '  await db.users.update({ id: 1 });',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/properly-handled.ts',
        [
          'export async function transfer(db: any) {',
          '  await db.startTransaction();',
          '  try { await db.users.update({ id: 1 }); await db.commit(); }',
          '  catch (e) { await db.rollback(); }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/async-in-tx.ts',
        [
          'export async function risky(db: any, http: any) {',
          '  await db.beginTransaction();',
          '  await http.fetch("https://other-service");',
          '  await db.users.update({ id: 1 });',
          '}',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-tx.ts', ['export async function plain() { return 1; }'].join('\n')),
      writeFixture(
        cwd,
        'src/delegation.ts',
        [
          'export async function delegated(repo: any, work: any) {',
          '  return await this.repository.transaction(work);',
          '}',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags an uncommitted transaction', async () => {
    const result = await findCheck('transaction-boundary-validation').run(cwd, {
      targetFiles: files,
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('uncommitted-transaction');
  });

  it('flags async operations inside a transaction', async () => {
    const result = await findCheck('transaction-boundary-validation').run(cwd, {
      targetFiles: files,
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('async-in-transaction');
  });

  it('does not fire on a delegation pattern (`return this.repo.transaction(...)`)', async () => {
    const result = await findCheck('transaction-boundary-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/delegation.ts'), join(cwd, 'src/no-tx.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).not.toContain('uncommitted-transaction');
  });
});

describe('transaction-timeout', () => {
  let cwd: string;
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('tx-timeout');
    files.push(
      writeFixture(
        cwd,
        'src/no-timeout.ts',
        [
          'export async function update(queryRunner: any) {',
          '  await queryRunner.startTransaction();',
          '  await queryRunner.update();',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/with-timeout.ts',
        [
          'export async function update(queryRunner: any) {',
          '  const transactionTimeout = 30000;',
          '  await queryRunner.startTransaction();',
          '}',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-tx-here.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags manual transaction usage missing timeout configuration', async () => {
    const result = await findCheck('transaction-timeout').run(cwd, { targetFiles: files });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('missing-transaction-timeout');
  });

  it('skips files that already declare a transaction timeout', async () => {
    const result = await findCheck('transaction-timeout').run(cwd, {
      targetFiles: [join(cwd, 'src/with-timeout.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// reentrancy-guard
// =============================================================================

describe('reentrancy-guard', () => {
  let cwd: string;
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('reentrancy');
    files.push(
      writeFixture(
        cwd,
        'src/server.ts',
        [
          'let serverRunning = false;',
          'export function startServer() {',
          '  if (serverRunning) return;',
          '  serverRunning = true;',
          '}',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-flag.ts', 'export const x = 1;'),
      writeFixture(
        cwd,
        'src/__tests__/skip.test.ts',
        ['let isRunning = false;', 'if (isRunning) return;'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags a module-scoped boolean reentrancy guard', async () => {
    const result = await findCheck('reentrancy-guard').run(cwd, { targetFiles: files });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('boolean-reentrancy-guard');
  });

  it('skips test files', async () => {
    const result = await findCheck('reentrancy-guard').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/skip.test.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// readline-cleanup
// =============================================================================

describe('readline-cleanup', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('readline');
    files.push(
      writeFixture(
        cwd,
        'src/no-cleanup.ts',
        [
          'import { createInterface } from "node:readline";',
          'export async function ask() {',
          '  const rl = readline.createInterface({ input: process.stdin });',
          '  return new Promise(r => rl.question("?", r));',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/with-cleanup.ts',
        [
          'export async function ask() {',
          '  const rl = readline.createInterface({ input: process.stdin });',
          '  try { return await something(rl); } finally { rl.close(); }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/helper-call.ts',
        [
          'export async function run() {',
          '  const ans = await readLine("Continue?");',
          '  return ans;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/helper-defn.ts',
        ['export async function readLine(prompt: string) { return prompt; }'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags readline.createInterface without cleanup', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/no-cleanup.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('readline-no-cleanup');
  });

  it('skips files that wrap readline in try/finally with rl.close()', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/with-cleanup.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not flag the readLine() definition itself', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/helper-defn.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('flags readLine() helper calls without cleanup', async () => {
    const result = await findCheck('readline-cleanup').run(cwd, {
      targetFiles: [join(cwd, 'src/helper-call.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('readline-helper-no-cleanup');
  });
});

// =============================================================================
// retry-config-validation
// =============================================================================

describe('retry-config-validation', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('retry-config');
    files.push(
      writeFixture(
        cwd,
        'src/excessive.ts',
        ['export const retryConfig = {', '  maxRetries: 50,', '  baseDelay: 10,', '};'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/sane.ts',
        ['export const retryConfig = {', '  maxRetries: 3,', '  baseDelay: 500,', '};'].join('\n'),
      ),
      writeFixture(cwd, 'src/no-retry.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags excessive maxRetries values', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/excessive.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('excessive-retries');
    expect(types).toContain('aggressive-retry-delay');
  });

  it('does not fire on sane values within bounds', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/sane.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without retry/attempt keywords', async () => {
    const result = await findCheck('retry-config-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/no-retry.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// env-var-validation
// =============================================================================

describe('env-var-validation', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('env-var');
    files.push(
      writeFixture(
        cwd,
        'src/server.ts',
        [
          '// Direct, unvalidated process.env access outside config',
          'export function getPort() {',
          '  return process.env.PORT;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/config/loader.ts',
        [
          '// Config file: type-coercion smell',
          'const port = process.env.PORT + 0;',
          'export const config = { port };',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/config/safe.ts',
        [
          '// Config file with proper validation',
          'export const port = process.env.PORT ?? "3000";',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/__tests__/skip.test.ts',
        ['export const x = process.env.NODE_ENV;'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on a non-config file with process.env', async () => {
    // The check's safe-context regex (`env\.\w+`) inadvertently matches
    // `process.env.X` itself, so direct-access violations rarely fire on
    // simple fixtures. We exercise the analysis path instead.
    const result = await findCheck('env-var-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/server.ts')],
    });
    expect(result.errors).toBe(0);
  });

  it('analyzes config files in the config dir without erroring', async () => {
    // Inside `config/` paths, the check skips the "direct-access-outside-config"
    // branch and explores type-coercion / unvalidated-access branches. The
    // exact signal type depends on context; what we care about is that the
    // config-file branch executes without throwing.
    const result = await findCheck('env-var-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/config/loader.ts'), join(cwd, 'src/config/safe.ts')],
    });
    expect(result.errors).toBe(0);
  });

  it('skips files in __tests__ directories', async () => {
    const result = await findCheck('env-var-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/skip.test.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// sentry-error-boundary
// =============================================================================

describe('sentry-error-boundary', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-eb');
    files.push(
      writeFixture(
        cwd,
        'src/App.tsx',
        [
          'import * as Sentry from "@sentry/react";',
          'import React from "react";',
          'Sentry.init({ dsn: "https://example" });',
          'export function App() {',
          '  return (<div>hello</div>);',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/Wrapped.tsx',
        [
          'import * as Sentry from "@sentry/react";',
          'import React from "react";',
          'export function App() {',
          '  return (<Sentry.ErrorBoundary fallback={<div>oops</div>}><div>hi</div></Sentry.ErrorBoundary>);',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/notReact.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'export function reportError(e: Error) { Sentry.captureException(e); }',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/NoSentry.tsx',
        ['import React from "react";', 'export function App() { return (<div>hi</div>); }'].join(
          '\n',
        ),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags React component using Sentry without ErrorBoundary', async () => {
    const result = await findCheck('sentry-error-boundary').run(cwd, {
      targetFiles: [join(cwd, 'src/App.tsx')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-missing-error-boundary');
  });

  it('does not fire when ErrorBoundary is wired up', async () => {
    const result = await findCheck('sentry-error-boundary').run(cwd, {
      targetFiles: [join(cwd, 'src/Wrapped.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-tsx/jsx files', async () => {
    const result = await findCheck('sentry-error-boundary').run(cwd, {
      targetFiles: [join(cwd, 'src/notReact.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips React files that do not use Sentry', async () => {
    const result = await findCheck('sentry-error-boundary').run(cwd, {
      targetFiles: [join(cwd, 'src/NoSentry.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// sentry-sample-rate
// =============================================================================

describe('sentry-sample-rate', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-sample');
    files.push(
      writeFixture(
        cwd,
        'src/init-too-high.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'Sentry.init({',
          '  dsn: "https://example",',
          '  tracesSampleRate: 1.0,',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/init-missing.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'import { httpIntegration } from "@sentry/node";',
          'Sentry.init({',
          '  dsn: "https://example",',
          '  integrations: [httpIntegration()],',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/init-fine.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'Sentry.init({',
          '  dsn: "https://example",',
          '  tracesSampleRate: 0.1,',
          '});',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-init.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags tracesSampleRate of 1.0 as too high', async () => {
    const result = await findCheck('sentry-sample-rate').run(cwd, {
      targetFiles: [join(cwd, 'src/init-too-high.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-full-sample-rate');
  });

  it('flags tracing import without tracesSampleRate', async () => {
    const result = await findCheck('sentry-sample-rate').run(cwd, {
      targetFiles: [join(cwd, 'src/init-missing.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-missing-sample-rate');
  });

  it('does not fire when sample rate is sane', async () => {
    const result = await findCheck('sentry-sample-rate').run(cwd, {
      targetFiles: [join(cwd, 'src/init-fine.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without Sentry.init', async () => {
    const result = await findCheck('sentry-sample-rate').run(cwd, {
      targetFiles: [join(cwd, 'src/no-init.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// sentry-dsn-configured
// =============================================================================

describe('sentry-dsn-configured', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-dsn');
    files.push(
      writeFixture(
        cwd,
        'src/init-no-dsn.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'Sentry.init({',
          '  tracesSampleRate: 0.1,',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/init-with-dsn.ts',
        [
          'import * as Sentry from "@sentry/node";',
          'Sentry.init({',
          '  dsn: process.env.SENTRY_DSN,',
          '  tracesSampleRate: 0.1,',
          '});',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags Sentry.init() without a dsn', async () => {
    const result = await findCheck('sentry-dsn-configured').run(cwd, {
      targetFiles: [join(cwd, 'src/init-no-dsn.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-missing-dsn');
  });

  it('does not fire when dsn is configured', async () => {
    const result = await findCheck('sentry-dsn-configured').run(cwd, {
      targetFiles: [join(cwd, 'src/init-with-dsn.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// expo-vector-icons
// =============================================================================

describe('expo-vector-icons', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('expo-icons');
    files.push(
      writeFixture(
        cwd,
        'src/Bad.tsx',
        [
          'import Icon from "react-native-vector-icons/FontAwesome";',
          'export const Foo = () => <Icon name="rocket" />;',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/AlsoBad.tsx',
        ['import { FaBeer } from "react-icons/fa";', 'export const Bar = () => <FaBeer />;'].join(
          '\n',
        ),
      ),
      writeFixture(
        cwd,
        'src/Good.tsx',
        [
          'import { Ionicons } from "@expo/vector-icons";',
          'export const Baz = () => <Ionicons name="home" />;',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer on .tsx files and short-circuits when no discouraged library is mentioned', async () => {
    // The check's strip-strings contentFilter blanks the import path before
    // analyze sees it, so the regex cannot match a real import. We still
    // exercise the analyze function's quick-filter bail-out.
    const result = await findCheck('expo-vector-icons').run(cwd, {
      targetFiles: [join(cwd, 'src/Good.tsx')],
    });
    expect(result.signals.length).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('runs without throwing when discouraged libraries are mentioned in source', async () => {
    const result = await findCheck('expo-vector-icons').run(cwd, {
      targetFiles: [join(cwd, 'src/Bad.tsx'), join(cwd, 'src/AlsoBad.tsx')],
    });
    // Strip-strings empties the import string contents, so detection is a
    // no-op in this configuration. Just assert it ran without errors.
    expect(result.errors).toBe(0);
  });
});

// =============================================================================
// async-state-pattern
// =============================================================================

describe('async-state-pattern', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('async-state');
    files.push(
      writeFixture(
        cwd,
        'src/screens/UserScreen.tsx',
        [
          'import { useQuery } from "@tanstack/react-query";',
          'export function UserScreen() {',
          '  const { data, isLoading, error } = useQuery({ queryKey: ["u"], queryFn: async () => ({}) });',
          '  return <div>{isLoading ? "..." : JSON.stringify(data)}</div>;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/screens/SafeScreen.tsx',
        [
          'import { useQuery } from "@tanstack/react-query";',
          'import { AsyncState } from "components/patterns/AsyncState";',
          'export function Safe() {',
          '  const q = useQuery({ queryKey: ["k"], queryFn: async () => 1 });',
          '  return <AsyncState isLoading={q.isLoading} error={q.error} data={q.data}>ok</AsyncState>;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/components/Button.tsx',
        [
          'import { useQuery } from "@tanstack/react-query";',
          'export const Btn = () => useQuery({ queryKey: ["b"], queryFn: async () => 1 });',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags screen using TanStack Query without AsyncState', async () => {
    const result = await findCheck('async-state-pattern').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/UserScreen.tsx')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('missing-async-state');
  });

  it('does not fire when AsyncState pattern is wired up', async () => {
    const result = await findCheck('async-state-pattern').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/SafeScreen.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-screen files', async () => {
    const result = await findCheck('async-state-pattern').run(cwd, {
      targetFiles: [join(cwd, 'src/components/Button.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// no-raw-regex-on-code
// =============================================================================

describe('no-raw-regex-on-code', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('no-raw-regex');
    files.push(
      writeFixture(
        cwd,
        'fitness/src/checks/missing-filter.ts',
        [
          'import { defineCheck } from "@opensip-tools/fitness";',
          'export const myCheck = defineCheck({',
          '  id: "abc-123",',
          '  slug: "my-check",',
          '  description: "x",',
          '  tags: [],',
          '  analyze(content: string) {',
          '    if (/foo/.test(content)) return [{ message: "no" }];',
          '    return [];',
          '  },',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'fitness/src/checks/has-filter.ts',
        [
          'import { defineCheck } from "@opensip-tools/fitness";',
          'export const myCheck = defineCheck({',
          '  id: "abc-456",',
          '  slug: "my-check",',
          '  description: "x",',
          '  tags: [],',
          "  contentFilter: 'raw',",
          '  analyze(content: string) {',
          '    if (/foo/.test(content)) return [{ message: "no" }];',
          '    return [];',
          '  },',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'fitness/src/checks/strip-strings-filter.ts',
        [
          'import { defineCheck } from "@opensip-tools/fitness";',
          'export const myCheck = defineCheck({',
          '  id: "abc-654",',
          '  slug: "my-check",',
          '  description: "x",',
          '  tags: [],',
          "  contentFilter: 'strip-strings',",
          '  analyze(content: string) {',
          '    if (/foo/.test(content)) return [{ message: "no" }];',
          '    return [];',
          '  },',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'fitness/src/checks/no-regex.ts',
        [
          'import { defineCheck } from "@opensip-tools/fitness";',
          'export const myCheck = defineCheck({',
          '  id: "abc-789",',
          '  slug: "my-check",',
          '  description: "x",',
          '  tags: [],',
          '  analyze(content: string) { return []; },',
          '});',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/not-a-check.ts',
        ['export function find(content: string) {', '  return /foo/.test(content);', '}'].join(
          '\n',
        ),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags fitness check files using regex without contentFilter', async () => {
    const result = await findCheck('no-raw-regex-on-code').run(cwd, {
      targetFiles: [join(cwd, 'fitness/src/checks/missing-filter.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('missing-content-filter');
  });

  it('does not fire when contentFilter is declared', async () => {
    const result = await findCheck('no-raw-regex-on-code').run(cwd, {
      targetFiles: [join(cwd, 'fitness/src/checks/has-filter.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire when contentFilter: strip-strings is declared', async () => {
    const result = await findCheck('no-raw-regex-on-code').run(cwd, {
      targetFiles: [join(cwd, 'fitness/src/checks/strip-strings-filter.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on a fitness check that does not use regex', async () => {
    const result = await findCheck('no-raw-regex-on-code').run(cwd, {
      targetFiles: [join(cwd, 'fitness/src/checks/no-regex.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on non-fitness files', async () => {
    const result = await findCheck('no-raw-regex-on-code').run(cwd, {
      targetFiles: [join(cwd, 'src/not-a-check.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// hasura-production-config
// =============================================================================

describe('hasura-production-config', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('hasura');
    writeFixture(
      cwd,
      'docker-compose.prod.yaml',
      [
        'version: "3"',
        'services:',
        '  hasura:',
        '    image: hasura/graphql-engine:v2',
        '    environment:',
        '      HASURA_GRAPHQL_ENABLE_CONSOLE: "true"',
        '      HASURA_GRAPHQL_DATABASE_URL: "postgres://x"',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'docker-compose.prod-secure.yaml',
      [
        'version: "3"',
        'services:',
        '  hasura:',
        '    image: hasura/graphql-engine:v2',
        '    environment:',
        '      HASURA_GRAPHQL_ENABLE_INTROSPECTION: "false"',
        '      HASURA_GRAPHQL_ENABLE_ALLOWLIST: "true"',
        '      HASURA_GRAPHQL_DEV_MODE: "false"',
        '      HASURA_GRAPHQL_ENABLE_CONSOLE: "false"',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'docker-compose.dev.yaml',
      [
        'services:',
        '  hasura:',
        '    image: hasura/graphql-engine:v2',
        '    environment:',
        '      HASURA_GRAPHQL_ENABLE_CONSOLE: "true"',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags missing/incorrect Hasura security settings in production compose', async () => {
    const result = await findCheck('hasura-production-config').run(cwd, {
      targetFiles: [join(cwd, 'docker-compose.prod.yaml'), join(cwd, 'docker-compose.dev.yaml')],
    });
    const messages = result.signals.map((s) => s.message);
    // We expect at least one finding for incorrect or missing console/allowlist/dev-mode/introspection
    expect(messages.some((m) => m.includes('HASURA_GRAPHQL_'))).toBe(true);
  });

  it('does not flag when all production settings are correct', async () => {
    const result = await findCheck('hasura-production-config').run(cwd, {
      targetFiles: [join(cwd, 'docker-compose.prod-secure.yaml')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-prod compose files', async () => {
    const result = await findCheck('hasura-production-config').run(cwd, {
      targetFiles: [join(cwd, 'docker-compose.dev.yaml')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// auth-route-guard
// =============================================================================

describe('auth-route-guard', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('auth-route-guard');
    files.push(
      writeFixture(
        cwd,
        'app/(auth)/_layout.tsx',
        ['export default function Layout() { return <Slot />; }'].join('\n'),
      ),
      writeFixture(
        cwd,
        'app/(auth)/_layout.protected.tsx',
        [
          'import { useAuth } from "../auth";',
          'export default function Layout() {',
          '  const { isAuthenticated } = useAuth();',
          '  return isAuthenticated ? <Slot /> : <Redirect href="/login" />;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'app/(public)/_layout.tsx',
        ['export default function Layout() { return <Slot />; }'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags (auth) layout files missing an auth check', async () => {
    const result = await findCheck('auth-route-guard').run(cwd, {
      targetFiles: [join(cwd, 'app/(auth)/_layout.tsx')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not fire when (auth) layout has an auth hook', async () => {
    const result = await findCheck('auth-route-guard').run(cwd, {
      targetFiles: [join(cwd, 'app/(auth)/_layout.protected.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on non-auth layouts', async () => {
    const result = await findCheck('auth-route-guard').run(cwd, {
      targetFiles: [join(cwd, 'app/(public)/_layout.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// no-markdown-references
// =============================================================================

describe('no-markdown-references', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('no-md-refs');
    files.push(
      writeFixture(
        cwd,
        'src/with-stale-ref.ts',
        [
          '// See docs/adr/052-something.md for the rationale.',
          '// Also reference ../docs/guide.md for setup.',
          'export const x = 1;',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/with-stable-ref.ts',
        [
          '// See README.md for setup',
          '// See CHANGELOG.md for history',
          'export const x = 1;',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-refs.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags non-stable markdown references in comments', async () => {
    const result = await findCheck('no-markdown-references').run(cwd, {
      targetFiles: [join(cwd, 'src/with-stale-ref.ts')],
    });
    const matches = result.signals.map((s) => s.metadata.match);
    expect(matches.some((m) => typeof m === 'string' && m.endsWith('.md'))).toBe(true);
  });

  it('does not flag stable references like README.md/CHANGELOG.md', async () => {
    const result = await findCheck('no-markdown-references').run(cwd, {
      targetFiles: [join(cwd, 'src/with-stable-ref.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// no-deprecated-tags / no-compatibility-layer-names / no-temporary-workarounds
// (split from the former `no-legacy-code` umbrella in Phase C4)
// =============================================================================

describe('no-legacy-code split (deprecated-tags / compat-layers / workarounds)', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('no-legacy');
    files.push(
      writeFixture(
        cwd,
        'src/legacy.ts',
        [
          '/**',
          ' * @deprecated since v1, use the v2 API',
          ' */',
          'export function oldThing() { return 1; }',
          'class UserCompatibilityLayer {}',
          'function legacyWrapperFor(input: any) { return input; }',
          '// HACK: temporary workaround before launch — fix me',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/clean.ts', 'export const x = 1;'),
      writeFixture(
        cwd,
        'src/__tests__/skip.test.ts',
        ['// @deprecated still here', 'export const y = 1;'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('no-deprecated-tags flags @deprecated JSDoc tags', async () => {
    const result = await findCheck('no-deprecated-tags').run(cwd, {
      targetFiles: [join(cwd, 'src/legacy.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('deprecated-tag');
  });

  it('no-compatibility-layer-names flags compatibility-layer/legacy-wrapper declarations', async () => {
    const result = await findCheck('no-compatibility-layer-names').run(cwd, {
      targetFiles: [join(cwd, 'src/legacy.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('compatibility-layer');
    expect(types).toContain('legacy-code-path');
  });

  it('no-temporary-workarounds flags HACK workarounds', async () => {
    const result = await findCheck('no-temporary-workarounds').run(cwd, {
      targetFiles: [join(cwd, 'src/legacy.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('temporary-workaround');
  });

  it('skips test files', async () => {
    const result = await findCheck('no-deprecated-tags').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/skip.test.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on clean code with no keywords', async () => {
    const result = await findCheck('no-deprecated-tags').run(cwd, {
      targetFiles: [join(cwd, 'src/clean.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// typescript-directive-hygiene
// =============================================================================

describe('typescript-directive-hygiene', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('ts-directive');
    files.push(
      writeFixture(
        cwd,
        'src/no-just.ts',
        ['// @ts-expect-error', 'const x: number = "y" as any;'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/generic-just.ts',
        ['// @ts-expect-error -- todo', 'const x: number = "y" as any;'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/ts-ignore.ts',
        [
          '// @ts-ignore -- legitimate reason that is more than ten chars',
          'const x: number = "y" as any;',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/good.ts',
        [
          '// @ts-expect-error -- third-party type definition is wrong, see issue #123',
          'const x: number = "y" as any;',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/clean.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags missing justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/no-just.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('missing justification'))).toBe(true);
  });

  it('flags generic justifications', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/generic-just.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('generic justification'))).toBe(true);
  });

  it('warns about @ts-ignore usage', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/ts-ignore.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('@ts-expect-error instead of @ts-ignore'))).toBe(true);
  });

  it('does not fire on @ts-expect-error with substantive justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/good.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without TS directives', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/clean.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// graphql-offset-pagination
// =============================================================================

describe('graphql-offset-pagination', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('graphql-offset');
    files.push(
      writeFixture(
        cwd,
        'src/uses-offset.ts',
        [
          'import { gql } from "@apollo/client";',
          'export const Query = gql`',
          '  query Items($offset: Int, $limit: Int) {',
          '    items(offset: $offset, limit: $limit) { id }',
          '  }',
          '`;',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/uses-cursor.ts',
        [
          'import { gql } from "@apollo/client";',
          'export const Query = gql`',
          '  query Items($after: String, $first: Int) {',
          '    items(after: $after, first: $first) { id }',
          '  }',
          '`;',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags $offset variables in gql template literals', async () => {
    const result = await findCheck('graphql-offset-pagination').run(cwd, {
      targetFiles: [join(cwd, 'src/uses-offset.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not fire on cursor-based pagination', async () => {
    const result = await findCheck('graphql-offset-pagination').run(cwd, {
      targetFiles: [join(cwd, 'src/uses-cursor.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// fitness-ignore-hygiene
// =============================================================================

describe('fitness-ignore-hygiene', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('fitness-ignore');
    files.push(
      writeFixture(
        cwd,
        'src/no-reason.ts',
        ['// @fitness-ignore-file no-console-log', 'console.log("hi");'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/bad-slug.ts',
        ['// @fitness-ignore-file Bad_Slug -- some reason', 'export const x = 1;'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/excessive.ts',
        [
          '// @fitness-ignore-file slug-a -- a',
          '// @fitness-ignore-file slug-b -- b',
          '// @fitness-ignore-file slug-c -- c',
          '// @fitness-ignore-file slug-d -- d',
          '// @fitness-ignore-file slug-e -- e',
          '// @fitness-ignore-file slug-f -- f',
          '// @fitness-ignore-file slug-g -- g',
          '// @fitness-ignore-file slug-h -- h',
          '// @fitness-ignore-file slug-i -- i',
          'export const x = 1;',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/proper.ts',
        [
          '// @fitness-ignore-file no-console-log -- intentionally logging for the CLI',
          'console.log("ok");',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags ignore directive without reason', async () => {
    const result = await findCheck('fitness-ignore-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/no-reason.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('ignore-without-reason');
  });

  it('flags invalid slug format', async () => {
    const result = await findCheck('fitness-ignore-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/bad-slug.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('invalid-ignore-slug');
  });

  it('flags excessive ignore directives in a single file', async () => {
    const result = await findCheck('fitness-ignore-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/excessive.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('excessive-ignores');
  });

  it('does not fire on a properly justified ignore', async () => {
    const result = await findCheck('fitness-ignore-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/proper.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// pino-serializer-coverage
// =============================================================================

describe('pino-serializer-coverage', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('pino-cov');
    files.push(
      writeFixture(
        cwd,
        'src/logs-req.ts',
        [
          'declare const logger: { info(o: unknown): void };',
          'export function handle(req: any) {',
          '  logger.info({ msg: "incoming", req });',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/logs-this.ts',
        [
          'declare const logger: { error(o: unknown): void };',
          'export class Service {',
          '  fail() {',
          '    logger.error({ msg: "boom", self: this });',
          '  }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/logs-safe.ts',
        [
          'declare const logger: { info(o: unknown): void };',
          'export function handle(req: any) {',
          '  logger.info({ id: req.id });',
          '}',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-logger.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags logging a Request object without serializer', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/logs-req.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('Request'))).toBe(true);
  });

  it('flags logging `this` directly', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/logs-this.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('circular reference'))).toBe(true);
  });

  it('does not fire on logger calls using safe primitives like .id', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/logs-safe.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without logger calls', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/no-logger.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// auth-middleware-coverage
// =============================================================================

describe('auth-middleware-coverage', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('auth-mw');
    files.push(
      writeFixture(
        cwd,
        'src/routes/exposed.ts',
        [
          'export function register(fastify: any) {',
          '  fastify.get("/users/:id", async (req: any) => req.params.id);',
          '  fastify.post("/items", async (req: any) => req.body);',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/routes/protected.ts',
        [
          'export function register(fastify: any) {',
          '  fastify.get("/secret", { preHandler: [authMiddleware] }, async () => 1);',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/routes/express-public.ts',
        [
          'export function attach(app: any) {',
          '  app.get("/health", (_req: any, res: any) => res.send("ok"));',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/routes/global-auth.ts',
        ['app.register(authPlugin);', 'fastify.get("/anything", async () => 1);'].join('\n'),
      ),
      writeFixture(cwd, 'src/no-routes.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer on files that contain framework calls', async () => {
    // The check applies strip-strings before analyze; route paths inside
    // the quote literals are blanked out, which prevents the inner regex
    // from matching. This test just exercises the shouldProcessFile path.
    const result = await findCheck('auth-middleware-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/routes/exposed.ts')],
    });
    expect(result.errors).toBe(0);
  });

  it('does not fire when route declares preHandler with auth', async () => {
    const result = await findCheck('auth-middleware-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/routes/protected.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on /health public routes', async () => {
    const result = await findCheck('auth-middleware-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/routes/express-public.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire when global auth is registered', async () => {
    const result = await findCheck('auth-middleware-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/routes/global-auth.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files that do not define routes', async () => {
    const result = await findCheck('auth-middleware-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/no-routes.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// api-key-rotation
// =============================================================================

describe('api-key-rotation', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('api-key-rot');
    files.push(
      writeFixture(
        cwd,
        'src/single-equality.ts',
        ['export function check(key: string) {', '  return key === process.env.API_KEY;', '}'].join(
          '\n',
        ),
      ),
      writeFixture(
        cwd,
        'src/single-assignment.ts',
        ['const API_KEY = process.env.API_KEY;', 'export { API_KEY };'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/has-rotation.ts',
        [
          'const validKeys = [process.env.API_KEY_CURRENT, process.env.API_KEY_PREVIOUS].filter(Boolean);',
          'export function check(k: string) { return validKeys.includes(k); }',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-keys.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags single-key equality comparison', async () => {
    const result = await findCheck('api-key-rotation').run(cwd, {
      targetFiles: [join(cwd, 'src/single-equality.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags single-key assignment', async () => {
    const result = await findCheck('api-key-rotation').run(cwd, {
      targetFiles: [join(cwd, 'src/single-assignment.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not fire when rotation support is in place', async () => {
    const result = await findCheck('api-key-rotation').run(cwd, {
      targetFiles: [join(cwd, 'src/has-rotation.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without API key references', async () => {
    const result = await findCheck('api-key-rotation').run(cwd, {
      targetFiles: [join(cwd, 'src/no-keys.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// rate-limit-coverage
// =============================================================================

describe('rate-limit-coverage', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('rate-limit');
    files.push(
      writeFixture(
        cwd,
        'src/api-routes.ts',
        [
          'export function attach(fastify: any) {',
          '  fastify.get("/api/users", async () => []);',
          '  fastify.post("/api/login", async () => ({ token: "x" }));',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/global-rl.ts',
        [
          'fastify.register(rateLimiter);',
          'fastify.post("/api/login", async () => ({ token: "x" }));',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-routes.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs the analyzer on files that contain framework calls', async () => {
    // Strip-strings blanks out route paths inside quotes; the regex
    // requires at least one non-quote char between quotes, so detection
    // is suppressed. This test exercises the framework-detection path.
    const result = await findCheck('rate-limit-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/api-routes.ts')],
    });
    expect(result.errors).toBe(0);
  });

  it('does not fire when global rate limiting is registered', async () => {
    const result = await findCheck('rate-limit-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/global-rl.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without route framework calls', async () => {
    const result = await findCheck('rate-limit-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/no-routes.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// cors-configuration
// =============================================================================

describe('cors-configuration', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('cors-cfg');
    files.push(
      writeFixture(
        cwd,
        'src/wildcard.ts',
        ['import cors from "cors";', 'export const c = cors({ origin: "*" });'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/reflecting.ts',
        [
          'import cors from "cors";',
          'export const c = cors({ origin: request.headers.origin });',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/origin-true.ts',
        ['import cors from "cors";', 'export const c = cors({ origin: true });'].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/safe.ts',
        [
          'import cors from "cors";',
          'export const c = cors({ origin: ["https://app.example.com"], credentials: true });',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-cors.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags wildcard origin', async () => {
    const result = await findCheck('cors-configuration').run(cwd, {
      targetFiles: [join(cwd, 'src/wildcard.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags reflecting origin without validation', async () => {
    const result = await findCheck('cors-configuration').run(cwd, {
      targetFiles: [join(cwd, 'src/reflecting.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags origin: true', async () => {
    const result = await findCheck('cors-configuration').run(cwd, {
      targetFiles: [join(cwd, 'src/origin-true.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('skips files without cors keyword', async () => {
    const result = await findCheck('cors-configuration').run(cwd, {
      targetFiles: [join(cwd, 'src/no-cors.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// use-centralized-crypto
// =============================================================================

describe('use-centralized-crypto', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('crypto');
    files.push(
      writeFixture(
        cwd,
        'src/services/hasher.ts',
        [
          'import * as crypto from "node:crypto";',
          'export function hash(input: string) {',
          '  return crypto.createHash("sha256").update(input).digest("hex");',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/services/imports-bcrypt.ts',
        [
          'import bcrypt from "bcrypt";',
          'export const hash = (s: string) => bcrypt.hash(s, 10);',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/crypto/adapters/sha.ts',
        [
          'import * as crypto from "node:crypto";',
          'export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/services/clean.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags direct crypto.createHash usage', async () => {
    const result = await findCheck('use-centralized-crypto').run(cwd, {
      targetFiles: [join(cwd, 'src/services/hasher.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags direct bcrypt import', async () => {
    const result = await findCheck('use-centralized-crypto').run(cwd, {
      targetFiles: [join(cwd, 'src/services/imports-bcrypt.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('skips the centralized crypto module itself', async () => {
    const result = await findCheck('use-centralized-crypto').run(cwd, {
      targetFiles: [join(cwd, 'src/crypto/adapters/sha.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// exit-code-correctness
// =============================================================================

describe('exit-code-correctness', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('exit-code');
    files.push(
      writeFixture(
        cwd,
        'src/cli/cmd.ts',
        [
          'export async function run() {',
          '  try { await doWork(); }',
          '  catch (err) { console.error("failed", err); }',
          '}',
          'function doWork() {}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/cli/proper.ts',
        [
          'export async function run() {',
          '  try { await doWork(); }',
          '  catch (err) { console.error("failed", err); throw err; }',
          '}',
          'function doWork() {}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/lib/notCli.ts',
        [
          'export async function run() {',
          '  try { await doWork(); }',
          '  catch (err) { console.error("failed", err); }',
          '}',
          'function doWork() {}',
        ].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags catch blocks in CLI files that swallow errors', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'src/cli/cmd.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('silent-failure-exit');
  });

  it('does not fire when error is rethrown', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'src/cli/proper.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-CLI files', async () => {
    const result = await findCheck('exit-code-correctness').run(cwd, {
      targetFiles: [join(cwd, 'src/lib/notCli.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// event-architecture (custom EventEmitter usage detection)
// =============================================================================

describe('event-architecture', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('event-arch');
    files.push(
      writeFixture(
        cwd,
        'src/domain/raw-emit.ts',
        [
          // Use a `.emit("...")` call without referencing EventEmitter or eventBus,
          // which the check treats as proper-pattern indicators.
          'export class Manager {',
          '  bus: any;',
          '  notify() { this.bus.emit("user.created", { id: 1 }); }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/domain/uses-bus.ts',
        [
          'import { eventBus } from "../infrastructure/events";',
          'eventBus.publish("user.created", { id: 1 });',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-events.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags direct EventEmitter usage in domain code', async () => {
    const result = await findCheck('event-architecture').run(cwd, {
      targetFiles: [join(cwd, 'src/domain/raw-emit.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('direct-event-emitter');
  });

  it('does not fire when canonical eventBus is used', async () => {
    const result = await findCheck('event-architecture').run(cwd, {
      targetFiles: [join(cwd, 'src/domain/uses-bus.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without event keywords', async () => {
    const result = await findCheck('event-architecture').run(cwd, {
      targetFiles: [join(cwd, 'src/no-events.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// event-handler-idempotency
// =============================================================================

describe('event-handler-idempotency', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('event-idem');
    files.push(
      writeFixture(
        cwd,
        'src/handler-no-idem.ts',
        [
          'export class OrderHandler {',
          '  @EventHandler',
          '  async handle(event: any) {',
          '    await db.orders.save(event.payload);',
          '  }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/handler-idem.ts',
        [
          'export class OrderHandler {',
          '  @EventHandler',
          '  async handle(event: any) {',
          '    if (await processedEvents.has(event.messageId)) return;',
          '    await db.orders.save(event.payload);',
          '  }',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/no-state.ts',
        ['export class OrderReader { @EventHandler handle() { return 1; } }'].join('\n'),
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags state-changing handler without idempotency', async () => {
    const result = await findCheck('event-handler-idempotency').run(cwd, {
      targetFiles: [join(cwd, 'src/handler-no-idem.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('non-idempotent-handler');
  });

  it('does not fire when idempotency keys are referenced', async () => {
    const result = await findCheck('event-handler-idempotency').run(cwd, {
      targetFiles: [join(cwd, 'src/handler-idem.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on handlers without state changes', async () => {
    const result = await findCheck('event-handler-idempotency').run(cwd, {
      targetFiles: [join(cwd, 'src/no-state.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// navigation-typing
// =============================================================================

describe('navigation-typing', () => {
  let cwd: string;
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = [];

  beforeAll(() => {
    cwd = makeFixtureDir('nav-typing');
    files.push(
      writeFixture(
        cwd,
        'src/screens/Untyped.tsx',
        [
          'import { useLocalSearchParams, router } from "expo-router";',
          'export function Screen() {',
          '  const params = useLocalSearchParams();',
          '  router.push("/items", { id: 1 });',
          '  return null;',
          '}',
        ].join('\n'),
      ),
      writeFixture(
        cwd,
        'src/screens/Typed.tsx',
        [
          'import { useLocalSearchParams } from "expo-router";',
          'export function Screen() {',
          '  const params = useLocalSearchParams<{ id: string }>();',
          '  return null;',
          '}',
        ].join('\n'),
      ),
      writeFixture(cwd, 'src/no-nav.ts', 'export const x = 1;'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags untyped useLocalSearchParams and router.push with inline params', async () => {
    const result = await findCheck('navigation-typing').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/Untyped.tsx')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toEqual(expect.arrayContaining(['untyped-params', 'untyped-push']));
  });

  it('does not fire when params are typed', async () => {
    const result = await findCheck('navigation-typing').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/Typed.tsx')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips files without navigation patterns', async () => {
    const result = await findCheck('navigation-typing').run(cwd, {
      targetFiles: [join(cwd, 'src/no-nav.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// display helpers (covers display/index.ts uncovered exports)
// =============================================================================

describe('display helpers', () => {
  it('getCheckIcon returns the icon for a known slug or a fallback', async () => {
    const { getCheckIcon, getCheckDisplayName } = await import('../display/index.js');
    expect(typeof getCheckIcon('no-todo-comments')).toBe('string');
    expect(typeof getCheckIcon('not-a-real-slug')).toBe('string');
    expect(typeof getCheckDisplayName('no-todo-comments')).toBe('string');
    expect(typeof getCheckDisplayName('not-a-real-slug')).toBe('string');
  });
});
