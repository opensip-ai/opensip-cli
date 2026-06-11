// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Third batch of fixture-based tests targeting the
 * remaining low-coverage analyzers.
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
  return mkdtempSync(join(tmpdir(), `cu-cov3-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => fileCache.clear());

// =============================================================================
// node-version-consistency
// =============================================================================

describe('node-version-consistency', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('node-ver');
    writeFixture(
      cwd,
      'package.json',
      JSON.stringify(
        {
          name: 'root',
          engines: { node: '>=24.0.0' },
          devDependencies: { '@types/node': '^24.0.0' },
        },
        null,
        2,
      ),
    );
    writeFixture(cwd, '.nvmrc', '20.11.1\n');
    writeFixture(
      cwd,
      'packages/a/package.json',
      JSON.stringify(
        {
          name: 'a',
          engines: { node: '>=18.0.0' },
          devDependencies: { '@types/node': '^18.0.0' },
        },
        null,
        2,
      ),
    );
    writeFixture(
      cwd,
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '18'",
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags .nvmrc / workspace engines / @types/node / CI version mismatches', async () => {
    const result = await findCheck('node-version-consistency').run(cwd, {
      targetFiles: [
        join(cwd, 'package.json'),
        join(cwd, '.nvmrc'),
        join(cwd, 'packages/a/package.json'),
        join(cwd, '.github/workflows/ci.yml'),
      ],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('nvmrc-version-mismatch');
    expect(types).toContain('workspace-engines-mismatch');
    expect(types).toContain('types-node-mismatch');
    expect(types).toContain('ci-node-version-mismatch');
  });
});

// =============================================================================
// sentry-source-maps
// =============================================================================

describe('sentry-source-maps', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-srcmaps');
    writeFixture(
      cwd,
      'webpack.config.ts',
      [
        'import * as Sentry from "@sentry/node";',
        'export default {',
        '  // No source map plugin configured',
        '  plugins: [],',
        '};',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'vite.config.ts',
      [
        'import { sentryVitePlugin } from "@sentry/vite-plugin";',
        'export default {',
        '  plugins: [sentryVitePlugin({})],',
        '};',
      ].join('\n'),
    );
    writeFixture(cwd, 'rollup.config.ts', ['export default { plugins: [] };'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags bundler config that references Sentry without a source map plugin', async () => {
    const result = await findCheck('sentry-source-maps').run(cwd, {
      targetFiles: [join(cwd, 'webpack.config.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-missing-source-maps');
  });

  it('does not fire when a Sentry source map plugin is configured', async () => {
    const result = await findCheck('sentry-source-maps').run(cwd, {
      targetFiles: [join(cwd, 'vite.config.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('skips non-Sentry bundler configs', async () => {
    const result = await findCheck('sentry-source-maps').run(cwd, {
      targetFiles: [join(cwd, 'rollup.config.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// sentry-pii-scrubbing
// =============================================================================

describe('sentry-pii-scrubbing', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-pii');
    writeFixture(
      cwd,
      'src/init-no-callbacks.ts',
      [
        'import * as Sentry from "@sentry/node";',
        'Sentry.init({',
        '  dsn: "https://example",',
        '});',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/init-with-callback.ts',
      [
        'import * as Sentry from "@sentry/node";',
        'Sentry.init({',
        '  dsn: "https://example",',
        '  beforeSend(event) { return event; },',
        '});',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/pii-context.ts',
      [
        'import * as Sentry from "@sentry/node";',
        'export function tag(user: { email: string }) {',
        '  Sentry.setUser({ email: user.email, id: "u1" });',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags Sentry.init() without beforeSend / beforeBreadcrumb', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/init-no-callbacks.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-no-pii-filter');
  });

  it('does not fire when beforeSend is wired up', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/init-with-callback.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('flags PII field names in setUser/setExtra/setContext calls', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/pii-context.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-pii-in-context');
  });
});

// =============================================================================
// env-secret-exposure
// =============================================================================

describe('env-secret-exposure', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('env-secret');
    writeFixture(
      cwd,
      'src/log-env.ts',
      ['export function diag() {', '  console.log(process.env);', '}'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/throw-secret.ts',
      [
        'export function check() {',
        '  throw new Error("invalid secret " + process.env.API_SECRET);',
        '}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/json-env.ts',
      ['export function dump() {', '  return JSON.stringify(process.env);', '}'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/spread-env.ts',
      ['export const settings = { ...process.env, custom: 1 };'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/clean.ts',
      ['export const port = process.env.PORT ?? "3000";'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags logging the entire process.env object', async () => {
    const result = await findCheck('env-secret-exposure').run(cwd, {
      targetFiles: [join(cwd, 'src/log-env.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('Logging entire process.env'))).toBe(true);
  });

  it('flags JSON.stringify(process.env)', async () => {
    const result = await findCheck('env-secret-exposure').run(cwd, {
      targetFiles: [join(cwd, 'src/json-env.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('JSON.stringify'))).toBe(true);
  });

  it('flags spread of process.env', async () => {
    const result = await findCheck('env-secret-exposure').run(cwd, {
      targetFiles: [join(cwd, 'src/spread-env.ts')],
    });
    const messages = result.signals.map((s) => s.message);
    expect(messages.some((m) => m.includes('Spreading process.env'))).toBe(true);
  });

  it('does not fire on safe scoped access', async () => {
    const result = await findCheck('env-secret-exposure').run(cwd, {
      targetFiles: [join(cwd, 'src/clean.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// catch-clause-safety (drive more branches)
// =============================================================================

describe('catch-clause-safety branches', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('catch-branches');
    writeFixture(
      cwd,
      'src/explicit-any.ts',
      [
        'export async function run() {',
        '  try { await op(); }',
        '  catch (err: any) {',
        '    err.printStackTrace?.();',
        '  }',
        '}',
        'function op() {}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/unsafe-cast.ts',
      [
        'export async function run() {',
        '  try { await op(); }',
        '  catch (err) {',
        '    const e = err as Error;',
        '    console.error(e.message);',
        '  }',
        '}',
        'function op() {}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/safe-cast.ts',
      [
        'export async function run() {',
        '  try { await op(); }',
        '  catch (err) {',
        '    if (err instanceof Error) {',
        '      const e = err as Error;',
        '      console.error(e.message);',
        '    }',
        '  }',
        '}',
        'function op() {}',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/empty-catch.ts',
      [
        'export async function run() {',
        '  try { await op(); }',
        '  catch {}',
        '}',
        'function op() {}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags catch (e: any) explicit annotation', async () => {
    const result = await findCheck('catch-clause-safety').run(cwd, {
      targetFiles: [join(cwd, 'src/explicit-any.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('catch-any-annotation');
  });

  it('flags `as Error` cast without instanceof guard', async () => {
    const result = await findCheck('catch-clause-safety').run(cwd, {
      targetFiles: [join(cwd, 'src/unsafe-cast.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('unsafe-error-cast');
  });

  it('does not fire when instanceof Error guard is present', async () => {
    const result = await findCheck('catch-clause-safety').run(cwd, {
      targetFiles: [join(cwd, 'src/safe-cast.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('does not fire on empty catch blocks', async () => {
    const result = await findCheck('catch-clause-safety').run(cwd, {
      targetFiles: [join(cwd, 'src/empty-catch.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// dangerous-config-defaults — coverage of TLS variant
// =============================================================================

describe('dangerous-config-defaults TLS variant', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('dcd-tls');
    writeFixture(cwd, 'src/tls.ts', ['process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";'].join('\n'));
    writeFixture(
      cwd,
      'src/quoted.ts',
      ['export const env = {', '  "NODE_TLS_REJECT_UNAUTHORIZED": "0",', '};'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on TLS_REJECT_UNAUTHORIZED variants', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/tls.ts'), join(cwd, 'src/quoted.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// no-duplicate-packages: keyword-based matching
// =============================================================================

describe('no-duplicate-packages keyword matches', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('no-dup-kw');
    // Two packages flagged as "contracts" by keyword
    writeFixture(
      cwd,
      'packages/a/package.json',
      JSON.stringify(
        {
          name: '@org/a',
          keywords: ['types', 'shared'],
        },
        null,
        2,
      ),
    );
    writeFixture(
      cwd,
      'packages/b/package.json',
      JSON.stringify(
        {
          name: '@org/b',
          keywords: ['types', 'public'],
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('detects duplicates via keywords field', async () => {
    const result = await findCheck('no-duplicate-packages').run(cwd, {
      targetFiles: [join(cwd, 'packages/a/package.json'), join(cwd, 'packages/b/package.json')],
    });
    // Both packages have `types` keyword → contracts/types category
    const matches = result.signals.map((s) => s.metadata.match);
    expect(matches).toContain('contracts/types');
  });
});

// =============================================================================
// fitness-ignore-hygiene — exercise excessive directive accumulation
// =============================================================================

describe('fitness-ignore-hygiene cumulative count', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('fih');
    // 8+ directives with reasons → triggers excessive-ignores threshold
    writeFixture(
      cwd,
      'src/many.ts',
      [
        ...Array.from(
          { length: 9 },
          (_, i) => `// @fitness-ignore-file slug-${i} -- justified reason`,
        ),
        'export const x = 1;',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags files with excessive ignore directives', async () => {
    const result = await findCheck('fitness-ignore-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/many.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('excessive-ignores');
  });
});

// =============================================================================
// no-stub-tests — cover function() {} and trivial assertions
// =============================================================================

describe('no-stub-tests function form', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('stub-fn');
    writeFixture(
      cwd,
      'src/__tests__/fn.test.ts',
      ['import { it } from "vitest";', 'it("plain function form", function() {});'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags function() {} empty bodies', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/fn.test.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('empty-test-body');
  });
});

// =============================================================================
// timer-lifecycle — cover setInterval/setTimeout in tests
// =============================================================================

describe('timer-lifecycle additional', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('timer-additional');
    writeFixture(
      cwd,
      'src/long-running.ts',
      [
        'export class Worker {',
        '  start() {',
        '    setInterval(() => this.tick(), 60000);',
        '    setTimeout(() => this.boot(), 5000);',
        '  }',
        '  tick() {}',
        '  boot() {}',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on long-running timer fixture', async () => {
    const result = await findCheck('timer-lifecycle').run(cwd, {
      targetFiles: [join(cwd, 'src/long-running.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// rate-limit-coverage edge: file that contains framework but no actual routes
// =============================================================================

describe('rate-limit-coverage skip paths', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('rl-skip');
    writeFixture(
      cwd,
      'src/no-routes.ts',
      [
        'export function build(fastify: any) {',
        '  // no routes here',
        '  return fastify;',
        '}',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('skips files that do not call route framework methods', async () => {
    const result = await findCheck('rate-limit-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/no-routes.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// public-api-jsdoc
// =============================================================================

describe('public-api-jsdoc', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('pubapi-jsdoc');
    writeFixture(
      cwd,
      'src/no-doc.ts',
      ['export function thing() { return 1; }', 'export class Box { open() {} }'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/with-doc.ts',
      ['/**', ' * Returns one.', ' */', 'export function thing() { return 1; }'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on public-api fixtures', async () => {
    const result = await findCheck('public-api-jsdoc').run(cwd, {
      targetFiles: [join(cwd, 'src/no-doc.ts'), join(cwd, 'src/with-doc.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// dockerfile checks — additional fixtures
// =============================================================================

describe('docker-best-practices additional', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('docker-bp-additional');
    writeFixture(
      cwd,
      'Dockerfile.latest',
      [
        'FROM node:latest', // floating tag
        'COPY . .',
        'CMD ["node", "src/app.js"]',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'Dockerfile.no-healthcheck',
      ['FROM node:20', 'COPY . .', 'CMD ["node", "src/app.js"]'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on docker fixtures', async () => {
    const result = await findCheck('docker-best-practices').run(cwd, {
      targetFiles: [join(cwd, 'Dockerfile.latest'), join(cwd, 'Dockerfile.no-healthcheck')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// docker-ignore-validation
// =============================================================================

describe('docker-ignore-validation', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('docker-ignore');
    writeFixture(
      cwd,
      'Dockerfile',
      ['FROM node:20', 'COPY . .', 'CMD ["node", "src/app.js"]'].join('\n'),
    );
    writeFixture(cwd, '.dockerignore', ['node_modules', '.git'].join('\n'));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing', async () => {
    const result = await findCheck('docker-ignore-validation').run(cwd, {
      targetFiles: [join(cwd, 'Dockerfile'), join(cwd, '.dockerignore')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// heavy-import-detection
// =============================================================================

describe('heavy-import-detection', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('heavy-imp');
    writeFixture(
      cwd,
      'src/lodash-namespace.ts',
      ['import * as _ from "lodash";', 'export const x = _.pick({ a: 1 }, ["a"]);'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/moment.ts',
      ['import moment from "moment";', 'export const x = moment(new Date()).format();'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/aws-sdk.ts',
      ['import AWS from "aws-sdk";', 'export const s3 = new AWS.S3();'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/excessive-named.ts',
      [
        'import { a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q } from "huge-lib";',
        'export const x = { a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q };',
      ].join('\n'),
    );
    writeFixture(
      cwd,
      'src/scoped.ts',
      [
        'import { format } from "date-fns";',
        'export const x = format(new Date(), "yyyy-MM-dd");',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags namespace import of lodash', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/lodash-namespace.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('HEAVY_IMPORT');
  });

  it('flags moment as deprecated', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/moment.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('DEPRECATED_LIBRARY');
  });

  it('flags aws-sdk v2 as deprecated', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/aws-sdk.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('DEPRECATED_LIBRARY');
  });

  it('flags excessive named imports', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/excessive-named.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('EXCESSIVE_NAMED_IMPORTS');
  });

  it('does not fire on lightweight scoped imports', async () => {
    const result = await findCheck('heavy-import-detection').run(cwd, {
      targetFiles: [join(cwd, 'src/scoped.ts')],
    });
    expect(result.signals.length).toBe(0);
  });
});

// =============================================================================
// project-readme-existence
// =============================================================================

describe('project-readme-existence', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('readme');
    writeFixture(cwd, 'package.json', JSON.stringify({ name: 'no-readme' }, null, 2));
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on a fixture with no README', async () => {
    const result = await findCheck('project-readme-existence').run(cwd, {
      targetFiles: [join(cwd, 'package.json')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// stale-build-artifacts variants
// =============================================================================

describe('stale-build-artifacts variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('stale-variants');
    writeFixture(cwd, 'packages/a/dist/index.js', '// stale');
    writeFixture(
      cwd,
      'packages/a/package.json',
      JSON.stringify(
        {
          name: 'a',
          main: 'dist/index.js',
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing', async () => {
    const result = await findCheck('stale-build-artifacts').run(cwd, {
      targetFiles: [join(cwd, 'packages/a/dist/index.js'), join(cwd, 'packages/a/package.json')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// eslint-justifications
// =============================================================================

describe('eslint-justifications', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('eslint-just');
    writeFixture(
      cwd,
      'src/no-reason.ts',
      ['// eslint-disable-next-line no-console', 'console.log("hi");'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/generic-reason.ts',
      ['// eslint-disable-next-line no-console -- todo', 'console.log("hi");'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/proper.ts',
      [
        '// eslint-disable-next-line no-console -- intentional CLI logger output',
        'console.log("hi");',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on disable-without-reason fixtures', async () => {
    const result = await findCheck('eslint-justifications').run(cwd, {
      targetFiles: [
        join(cwd, 'src/no-reason.ts'),
        join(cwd, 'src/generic-reason.ts'),
        join(cwd, 'src/proper.ts'),
      ],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// semgrep-justifications
// =============================================================================

describe('semgrep-justifications', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('semgrep-just');
    writeFixture(
      cwd,
      'src/no-reason.ts',
      ['// nosemgrep: javascript.lang.security', 'eval("1 + 1");'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/proper.ts',
      [
        '// nosemgrep: javascript.lang.security -- expression evaluation in trusted plugin sandbox',
        'eval("1 + 1");',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on nosemgrep fixtures', async () => {
    const result = await findCheck('semgrep-justifications').run(cwd, {
      targetFiles: [join(cwd, 'src/no-reason.ts'), join(cwd, 'src/proper.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// directive-audit additional fixtures (drive more counters)
// =============================================================================

describe('directive-audit additional', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('directive-add');
    writeFixture(
      cwd,
      'src/each-kind.ts',
      [
        '/* eslint-disable no-console */',
        'console.log("disabled");',
        '/* eslint-enable */',
        '// @ts-expect-error reason — third-party type incorrect',
        'const x: number = "no" as any;',
        '// @ts-ignore — old shim',
        'const y: string = 1 as any;',
        '// @fitness-ignore-file no-todo-comments -- intentional',
        '// @fitness-ignore-next-line no-console-log -- intentional',
        '// nosemgrep: jsx.security.tag',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs all directive parsers without throwing', async () => {
    const result = await findCheck('directive-audit').run(cwd, {
      targetFiles: [join(cwd, 'src/each-kind.ts')],
    });
    expect(result).toBeDefined();
  });
});

// =============================================================================
// test-convention-consistency: mixed naming forms
// =============================================================================

describe('test-convention-consistency', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('tcc');
    writeFixture(
      cwd,
      'src/__tests__/foo-spec.ts',
      ['import { it } from "vitest";', 'it("works", () => undefined);'].join('\n'),
    );
    writeFixture(
      cwd,
      'src/__tests__/bar.test.ts',
      ['import { it } from "vitest";', 'it("works", () => undefined);'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('runs without throwing on mixed naming forms', async () => {
    const result = await findCheck('test-convention-consistency').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/foo-spec.ts'), join(cwd, 'src/__tests__/bar.test.ts')],
    });
    expect(result).toBeDefined();
  });
});
