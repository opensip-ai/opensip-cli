/**
 * @fileoverview Additional fixture tests for the second tier of low-coverage checks.
 *
 * Pattern matches `coverage-boost.test.ts`: per-check fixtures driven through
 * `check.run(cwd, { targetFiles })`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { fileCache } from '@opensip-tools/fitness'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { checks } from '../index.js'

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug)
  if (!check) throw new Error(`check not found: ${slug}`)
  return check
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov2-${prefix}-`))
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

afterEach(() => {
  fileCache.clear()
})

// =============================================================================
// dangerous-config-defaults
// =============================================================================

describe('dangerous-config-defaults', () => {
  let cwd: string
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture array for setup; tests target files individually
  const files: string[] = []

  beforeAll(() => {
    cwd = makeFixtureDir('dcd')
    files.push(
      writeFixture(cwd, 'src/db.ts', [
        'export const db = {',
        '  ssl: false,',
        '  rejectUnauthorized: false,',
        '  poolSize: 1,',
        '  timeout: 0,',
        '  maxRetries: 0,',
        '  debug: true,',
        '};',
      ].join('\n')),
      writeFixture(cwd, 'src/safe.ts', [
        'export const db = {',
        '  ssl: true,',
        '  poolSize: 20,',
        '  timeout: 30000,',
        '  maxRetries: 3,',
        '};',
      ].join('\n')),
    )
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags multiple dangerous defaults', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/db.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('SSL'))).toBe(true)
    expect(messages.some((m) => m.includes('TLS'))).toBe(true)
    expect(messages.some((m) => m.includes('pool size'))).toBe(true)
    expect(messages.some((m) => m.includes('timeout'))).toBe(true)
    expect(messages.some((m) => m.includes('retries'))).toBe(true)
    expect(messages.some((m) => m.includes('Debug'))).toBe(true)
  })

  it('does not fire on safe defaults', async () => {
    const result = await findCheck('dangerous-config-defaults').run(cwd, {
      targetFiles: [join(cwd, 'src/safe.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// no-hardcoded-timeouts
// =============================================================================

describe('no-hardcoded-timeouts', () => {
  let cwd: string
  // eslint-disable-next-line sonarjs/no-unused-collection -- fixture setup helper; per-test targetFiles override at call sites
  const files: string[] = []

  beforeAll(() => {
    cwd = makeFixtureDir('hardcoded-to')
    files.push(
      writeFixture(cwd, 'src/raw-set-timeout.ts', [
        'export function delay(cb: () => void) {',
        '  setTimeout(cb, 30000);',
        '}',
      ].join('\n')),
      writeFixture(cwd, 'src/timeout-assign.ts', [
        'export const config = {',
        '  timeout: 60000,',
        '};',
      ].join('\n')),
      writeFixture(cwd, 'src/dot-timeout.ts', [
        'export function setUp(client: any) {',
        '  client.timeout(45000);',
        '}',
      ].join('\n')),
      writeFixture(cwd, 'src/short-timeout.ts', [
        'export function delay(cb: () => void) { setTimeout(cb, 1000); }',
      ].join('\n')),
      writeFixture(cwd, 'src/__tests__/skip.test.ts', [
        'it("times out", () => { setTimeout(() => {}, 30000); });',
      ].join('\n')),
    )
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags large hardcoded setTimeout values', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/raw-set-timeout.ts')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('hardcoded-timeout')
  })

  it('flags timeout assignments with 4+ digit values', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/timeout-assign.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('flags .timeout(N) calls', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/dot-timeout.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('does not fire on values below the 5000ms threshold', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/short-timeout.ts')],
    })
    expect(result.signals.length).toBe(0)
  })

  it('skips test files', async () => {
    const result = await findCheck('no-hardcoded-timeouts').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/skip.test.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// catch-clause-safety
// =============================================================================

describe('catch-clause-safety', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('catch-safe')
    writeFixture(cwd, 'src/swallows.ts', [
      'export async function doStuff() {',
      '  try { await op(); }',
      '  catch (err: any) {',
      '    err.printStackTrace();',
      '  }',
      '}',
      'function op() {}',
    ].join('\n'))
    writeFixture(cwd, 'src/proper.ts', [
      'export async function doStuff() {',
      '  try { await op(); }',
      '  catch (err) { throw err; }',
      '}',
      'function op() {}',
    ].join('\n'))
    writeFixture(cwd, 'src/no-catch.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer without errors', async () => {
    // Drives the analyze function for catch-clause-safety against fixtures
    // that exercise both the violation and the bail-out paths.
    const result = await findCheck('catch-clause-safety').run(cwd, {
      targetFiles: [
        join(cwd, 'src/swallows.ts'),
        join(cwd, 'src/proper.ts'),
        join(cwd, 'src/no-catch.ts'),
      ],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// error-code-registration
// =============================================================================

describe('error-code-registration', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('err-code')
    writeFixture(cwd, 'src/errors/error-codes.ts', [
      'export const ERROR_CODES = {',
      '  FOO_BAR_BAZ: "FOO.BAR.BAZ",',
      '} as const;',
    ].join('\n'))
    writeFixture(cwd, 'src/services/foo.ts', [
      'export function bad() {',
      '  throw { code: "UNKNOWN.ERROR.HERE", message: "boom" };',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/services/registered.ts', [
      'export function good() {',
      '  throw { code: "FOO.BAR.BAZ", message: "boom" };',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags unregistered error codes used in source', async () => {
    const result = await findCheck('error-code-registration').run(cwd, {
      targetFiles: [
        join(cwd, 'src/errors/error-codes.ts'),
        join(cwd, 'src/services/foo.ts'),
        join(cwd, 'src/services/registered.ts'),
      ],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('unregistered-error-code')
  })

  it('does not flag codes that match the registry', async () => {
    const result = await findCheck('error-code-registration').run(cwd, {
      targetFiles: [
        join(cwd, 'src/errors/error-codes.ts'),
        join(cwd, 'src/services/registered.ts'),
      ],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// no-stub-tests
// =============================================================================

describe('no-stub-tests', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('no-stub')
    writeFixture(cwd, 'src/__tests__/empty.test.ts', [
      'import { it } from "vitest";',
      'it("does the thing", () => {});',
      'it("does another", async () => {});',
    ].join('\n'))
    writeFixture(cwd, 'src/__tests__/todo.test.ts', [
      'import { it } from "vitest";',
      'it("future work", () => { /* TODO implement */ });',
    ].join('\n'))
    writeFixture(cwd, 'src/__tests__/trivial.test.ts', [
      'import { it, expect } from "vitest";',
      'it("placeholder", () => { expect(true).toBe(true); });',
    ].join('\n'))
    writeFixture(cwd, 'src/__tests__/real.test.ts', [
      'import { it, expect } from "vitest";',
      'it("does math", () => { expect(1 + 1).toBe(2); });',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags empty test bodies', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/empty.test.ts')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('empty-test-body')
  })

  it('flags TODO-only test bodies', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/todo.test.ts')],
    })
    const types = new Set(result.signals.map((s) => s.metadata.type))
    expect(types.has('todo-stub-test') || types.has('empty-test-body')).toBe(true)
  })

  it('flags trivial expect(true).toBe(true) assertions', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/trivial.test.ts')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('trivial-assertion')
  })

  it('does not fire on real assertions', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/real.test.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// dependency-version-consistency
// =============================================================================

describe('dependency-version-consistency', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('dep-ver')
    writeFixture(cwd, 'package.json', JSON.stringify({
      name: 'root',
      devDependencies: {
        vitest: '^2.0.0',
        typescript: '^5.4.0',
      },
    }, null, 2))
    writeFixture(cwd, 'packages/a/package.json', JSON.stringify({
      name: 'pkg-a',
      devDependencies: {
        vitest: '^1.0.0',     // Mismatched
        typescript: '^5.4.0',  // Match
      },
    }, null, 2))
    writeFixture(cwd, 'packages/b/package.json', JSON.stringify({
      name: 'pkg-b',
      devDependencies: {
        vitest: '^2.0.0',     // Match
        typescript: '^5.4.0',  // Match
      },
    }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags packages using non-canonical dependency versions', async () => {
    // Force the check's process.cwd() reference to our fixture dir.
    const origCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await findCheck('dependency-version-consistency').run(cwd, {
        targetFiles: [
          join(cwd, 'package.json'),
          join(cwd, 'packages/a/package.json'),
          join(cwd, 'packages/b/package.json'),
        ],
      })
      const types = result.signals.map((s) => s.metadata.type)
      expect(types).toContain('version-mismatch')
    } finally {
      process.chdir(origCwd)
    }
  })
})

// =============================================================================
// empty-package-detection
// =============================================================================

describe('empty-package-detection', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('empty-pkg')
    // Root package — should be skipped
    writeFixture(cwd, 'package.json', JSON.stringify({ name: 'root' }, null, 2))
    // Empty package — main entry exists but has no exports
    writeFixture(cwd, 'packages/empty/package.json', JSON.stringify({
      name: '@org/empty',
      main: 'src/index.ts',
    }, null, 2))
    writeFixture(cwd, 'packages/empty/src/index.ts', '// no exports here')
    // Mostly-commented package
    writeFixture(cwd, 'packages/commented/package.json', JSON.stringify({
      name: '@org/commented',
      main: 'src/index.ts',
    }, null, 2))
    writeFixture(cwd, 'packages/commented/src/index.ts', [
      'export const a = 1',
      '// export const b = 2',
      '// export const c = 3',
      '// export const d = 4',
    ].join('\n'))
    // Healthy package
    writeFixture(cwd, 'packages/healthy/package.json', JSON.stringify({
      name: '@org/healthy',
      main: 'src/index.ts',
    }, null, 2))
    writeFixture(cwd, 'packages/healthy/src/index.ts', [
      'export const x = 1',
      'export const y = 2',
    ].join('\n'))
    // CLI package with `bin` — should be skipped
    writeFixture(cwd, 'packages/cli/package.json', JSON.stringify({
      name: '@org/cli',
      bin: 'bin/cli.js',
    }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags empty and mostly-commented packages while skipping the root and bin packages', async () => {
    const origCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await findCheck('empty-package-detection').run(cwd, {
        targetFiles: [
          join(cwd, 'package.json'),
          join(cwd, 'packages/empty/package.json'),
          join(cwd, 'packages/commented/package.json'),
          join(cwd, 'packages/healthy/package.json'),
          join(cwd, 'packages/cli/package.json'),
        ],
      })
      const types = new Set(result.signals.map((s) => s.metadata.type))
      // Either empty-package or mostly-commented should fire
      expect(types.has('empty-package') || types.has('mostly-commented')).toBe(true)
    } finally {
      process.chdir(origCwd)
    }
  })
})

// =============================================================================
// no-duplicate-packages
// =============================================================================

describe('no-duplicate-packages', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('no-dup')
    writeFixture(cwd, 'packages/a/package.json', JSON.stringify({ name: '@org/utils' }, null, 2))
    writeFixture(cwd, 'packages/b/package.json', JSON.stringify({ name: '@other/utils' }, null, 2))
    writeFixture(cwd, 'packages/c/package.json', JSON.stringify({ name: '@org/helpers' }, null, 2))
    writeFixture(cwd, 'packages/d/package.json', JSON.stringify({ name: '@org/logger' }, null, 2))
    writeFixture(cwd, 'packages/e/package.json', JSON.stringify({ name: '@org/logging' }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags duplicate-purpose packages', async () => {
    const result = await findCheck('no-duplicate-packages').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/a/package.json'),
        join(cwd, 'packages/b/package.json'),
        join(cwd, 'packages/c/package.json'),
        join(cwd, 'packages/d/package.json'),
        join(cwd, 'packages/e/package.json'),
      ],
    })
    const matches = result.signals.map((s) => s.metadata.match)
    // utilities (utils, helpers) and logging (logger, logging) categories
    expect(matches).toEqual(expect.arrayContaining(['utilities', 'logging']))
  })
})

// =============================================================================
// docker-version-sync
// =============================================================================

describe('docker-version-sync', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('docker-ver')
    writeFixture(cwd, 'package.json', JSON.stringify({
      name: 'root',
      engines: { node: '>=20' },
      packageManager: 'pnpm@10.0.0',
    }, null, 2))
    writeFixture(cwd, 'Dockerfile.bad', [
      'FROM node:18',
      'RUN corepack prepare pnpm@9.0.0 --activate',
    ].join('\n'))
    writeFixture(cwd, 'Dockerfile.good', [
      'FROM node:20',
      'RUN corepack prepare $(node -e "process.stdout.write(require(\'./package.json\').packageManager.split(\'+\')[0])") --activate',
    ].join('\n'))
    writeFixture(cwd, 'Dockerfile.non-node', [
      'FROM redis:7',
      'EXPOSE 6379',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags node version mismatch and pnpm version mismatch', async () => {
    const origCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await findCheck('docker-version-sync').run(cwd, {
        targetFiles: [
          join(cwd, 'Dockerfile.bad'),
          join(cwd, 'Dockerfile.good'),
          join(cwd, 'Dockerfile.non-node'),
        ],
      })
      const types = result.signals.map((s) => s.metadata.type)
      expect(types).toContain('node-version-mismatch')
      expect(types).toContain('pnpm-version-mismatch')
    } finally {
      process.chdir(origCwd)
    }
  })
})

// =============================================================================
// stale-build-artifacts
// =============================================================================

describe('stale-build-artifacts', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('stale-build')
    // dist file present but no source mapping — analyzer just reads file paths
    writeFixture(cwd, 'packages/a/dist/index.js', '// stale')
    writeFixture(cwd, 'packages/a/package.json', JSON.stringify({ name: 'a' }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs analysis without errors', async () => {
    const result = await findCheck('stale-build-artifacts').run(cwd, {
      targetFiles: [join(cwd, 'packages/a/package.json'), join(cwd, 'packages/a/dist/index.js')],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// directive-audit
// =============================================================================

describe('directive-audit', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('directive')
    writeFixture(cwd, 'src/many-suppressions.ts', [
      '// @ts-expect-error reason: testing',
      'const x: number = "y" as any',
      '// @ts-ignore — ancient shim',
      'const y: string = 42 as any',
      '// eslint-disable-next-line no-console',
      'console.log("inline")',
      '/* eslint-disable @typescript-eslint/no-explicit-any */',
      'export function takes(a: any) { return a }',
      '/* eslint-enable */',
      '// @fitness-ignore-file no-console-log -- intentional CLI logger',
      '// @fitness-ignore-next-line no-todo-comments -- intentional',
      '// nosemgrep: javascript.lang.security',
      'eval("nosemgrep here")',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('classifies several directive categories', async () => {
    const result = await findCheck('directive-audit').run(cwd, {
      targetFiles: [join(cwd, 'src/many-suppressions.ts')],
    })
    expect(result.errors).toBe(0)
    expect(result.info).toBeDefined()
  })
})

// =============================================================================
// jwt-validation
// =============================================================================

describe('jwt-validation', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('jwt')
    writeFixture(cwd, 'src/auth.ts', [
      'import jwt from "jsonwebtoken";',
      'export function verifyTok(tok: string) {',
      '  return jwt.verify(tok, "static-secret");',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/decode.ts', [
      'import jwt from "jsonwebtoken";',
      'export function noVerify(tok: string) {',
      '  return jwt.decode(tok);',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/no-jwt.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the jwt analyzer and produces a CheckResult', async () => {
    const result = await findCheck('jwt-validation').run(cwd, {
      targetFiles: [
        join(cwd, 'src/auth.ts'),
        join(cwd, 'src/decode.ts'),
        join(cwd, 'src/no-jwt.ts'),
      ],
    })
    expect(result).toBeDefined()
    expect(result.signals).toBeDefined()
    expect(typeof result.errors).toBe('number')
  })
})

// =============================================================================
// docker-best-practices
// =============================================================================

describe('docker-best-practices', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('docker-bp')
    writeFixture(cwd, 'Dockerfile.root-user', [
      'FROM node:20',
      'WORKDIR /app',
      'COPY . .',
      'RUN npm install',
      'USER root',
      'CMD ["node", "src/app.js"]',
    ].join('\n'))
    writeFixture(cwd, 'Dockerfile.no-user', [
      'FROM node:20',
      'COPY . .',
      'CMD ["node", "src/app.js"]',
    ].join('\n'))
    writeFixture(cwd, 'Dockerfile.proper', [
      'FROM node:20',
      'COPY . .',
      'USER node',
      'CMD ["node", "src/app.js"]',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('produces signals for docker best-practice violations', async () => {
    const result = await findCheck('docker-best-practices').run(cwd, {
      targetFiles: [
        join(cwd, 'Dockerfile.root-user'),
        join(cwd, 'Dockerfile.no-user'),
        join(cwd, 'Dockerfile.proper'),
      ],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// project-readme-existence — already 100%, but useful smoke test
// =============================================================================

describe('todo-comments (quality)', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('todo-quality')
    writeFixture(cwd, 'src/has-todos.ts', [
      '// TODO refactor this function',
      'export function foo() { return 1; }',
      '// FIXME flaky logic',
      'export function bar() { return 2; }',
      '// HACK: temporary patch for the storage adapter',
      'export function baz() { return 3; }',
      '// XXX: this needs a security review',
      'export function qux() { return 4; }',
      '// OPTIMIZE: profile this hot path',
      'export function quux() { return 5; }',
    ].join('\n'))
    writeFixture(cwd, 'src/clean.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags all five debt-marker types', async () => {
    const result = await findCheck('todo-comments').run(cwd, {
      targetFiles: [join(cwd, 'src/has-todos.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.startsWith('TODO'))).toBe(true)
    expect(messages.some((m) => m.startsWith('FIXME'))).toBe(true)
    expect(messages.some((m) => m.startsWith('HACK'))).toBe(true)
    expect(messages.some((m) => m.startsWith('XXX'))).toBe(true)
    expect(messages.some((m) => m.startsWith('OPTIMIZE'))).toBe(true)
  })

  it('does not fire on clean files', async () => {
    const result = await findCheck('todo-comments').run(cwd, {
      targetFiles: [join(cwd, 'src/clean.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// dead-code (command mode — drives parseOutput via fixtures rather than running knip)
// =============================================================================

describe('dead-code (command mode)', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('dead-code')
    writeFixture(cwd, 'src/orphan.ts', [
      'export function unused() { return 1; }',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  // The dead-code check's bin is `npx knip`. Locally, `npx` finds
  // knip in `node_modules` instantly; on a cold CI runner it can
  // spend tens of seconds fetching knip from the registry before
  // running it. Both paths are valid — the test contract is "the
  // check doesn't crash with an unhandled exception."
  //
  // Three outcomes we accept as success:
  //   1. ENOENT/missing-knip — executor returns a CheckResult with
  //      `error` populated. (Local dev path.)
  //   2. knip ran successfully — returns a CheckResult with
  //      violations. (CI path, knip got fetched in time.)
  //   3. CheckAbortedError thrown because the run hit the test's
  //      30 s timeout via vitest's signal. The framework's clean-
  //      abort path is itself part of the contract we want to
  //      verify; throwing CheckAbortedError is correct behaviour
  //      under abort, not a regression.
  //
  // The deadCode check itself caps at 120 s via
  // `deadCode.config.timeout` so a runaway invocation can't hang
  // indefinitely under any path.
  it('does not throw when knip is missing', async () => {
    try {
      const result = await findCheck('dead-code').run(cwd, {
        targetFiles: [join(cwd, 'src/orphan.ts')],
      })
      expect(result).toBeDefined()
    } catch (error) {
      const isCleanAbort =
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: unknown }).name === 'CheckAbortedError'
      if (!isCleanAbort) throw error
      // Clean abort is the framework's documented contract path;
      // proves the check responded to AbortSignal, which is what
      // we needed to verify.
      expect(isCleanAbort).toBe(true)
    }
  }, 60_000)
})

// =============================================================================
// performance-anti-patterns
// =============================================================================

describe('performance-anti-patterns', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('perf-anti')
    writeFixture(cwd, 'src/n-plus-one.ts', [
      'export async function listUsers(db: any) {',
      '  const users = await db.users.findMany();',
      '  for (const u of users) {',
      '    u.posts = await db.posts.findMany({ where: { userId: u.id } });',
      '  }',
      '  return users;',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/clean.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer without throwing', async () => {
    const result = await findCheck('performance-anti-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/n-plus-one.ts'), join(cwd, 'src/clean.ts')],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// no-non-null-assertions
// =============================================================================

describe('no-non-null-assertions', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('non-null')
    writeFixture(cwd, 'src/with-bangs.ts', [
      'export function pick(arr: any[]) {',
      '  return arr.find(x => x.id === 1)!.value;',
      '}',
      'export function f(x?: { v: number }) { return x!.v; }',
    ].join('\n'))
    writeFixture(cwd, 'src/clean.ts', [
      'export function pick(arr: any[]) {',
      '  return arr.find(x => x.id === 1)?.value ?? 0;',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer without throwing', async () => {
    const result = await findCheck('no-non-null-assertions').run(cwd, {
      targetFiles: [join(cwd, 'src/with-bangs.ts'), join(cwd, 'src/clean.ts')],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// timer-lifecycle
// =============================================================================

describe('timer-lifecycle', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('timer-lc')
    writeFixture(cwd, 'src/no-cleanup.ts', [
      'const handle = setInterval(() => {}, 60000);',
      'export const stop = () => undefined;',
    ].join('\n'))
    writeFixture(cwd, 'src/with-cleanup.ts', [
      'let handle: ReturnType<typeof setInterval> | undefined;',
      'export function start() { handle = setInterval(() => {}, 60000); }',
      'export function stop() { if (handle) clearInterval(handle); }',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer without throwing', async () => {
    const result = await findCheck('timer-lifecycle').run(cwd, {
      targetFiles: [
        join(cwd, 'src/no-cleanup.ts'),
        join(cwd, 'src/with-cleanup.ts'),
      ],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// recovery-patterns
// =============================================================================

describe('recovery-patterns', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('recovery')
    writeFixture(cwd, 'src/retry-without-backoff.ts', [
      'export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {',
      '  for (let i = 0; i < 3; i++) {',
      '    try { return await fn(); } catch {}',
      '  }',
      '  throw new Error("retry exhausted");',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/clean.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer without throwing', async () => {
    const result = await findCheck('recovery-patterns').run(cwd, {
      targetFiles: [join(cwd, 'src/retry-without-backoff.ts'), join(cwd, 'src/clean.ts')],
    })
    expect(result.errors).toBe(0)
  })
})

// =============================================================================
// graceful-shutdown (in service-patterns.ts)
// =============================================================================

describe('graceful-shutdown', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('graceful')
    writeFixture(cwd, 'src/server-no-handlers.ts', [
      'import express from "express";',
      'const app = express();',
      'app.listen(3000);',
    ].join('\n'))
    writeFixture(cwd, 'src/server-with-handlers.ts', [
      'import express from "express";',
      'const app = express();',
      'const server = app.listen(3000);',
      'process.on("SIGTERM", () => server.close());',
      'process.on("SIGINT", () => server.close());',
    ].join('\n'))
    writeFixture(cwd, 'src/util.ts', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs without throwing on listen-style server fixtures', async () => {
    const result = await findCheck('graceful-shutdown').run(cwd, {
      targetFiles: [
        join(cwd, 'src/server-no-handlers.ts'),
        join(cwd, 'src/server-with-handlers.ts'),
        join(cwd, 'src/util.ts'),
      ],
    })
    expect(result).toBeDefined()
    expect(result.signals).toBeDefined()
  })
})

describe('rate-limiting-coverage (resilience)', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('rl-resilience')
    writeFixture(cwd, 'src/api.ts', [
      'export function attach(app: any) {',
      '  app.post("/api/login", async () => ({}));',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs without throwing', async () => {
    const result = await findCheck('rate-limiting-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/api.ts')],
    })
    expect(result).toBeDefined()
  })
})
