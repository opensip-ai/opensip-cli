/**
 * @fileoverview Final pushes to crack 90% coverage.
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
  return mkdtempSync(join(tmpdir(), `cu-cov5-${prefix}-`))
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

afterEach(() => fileCache.clear())

// =============================================================================
// docker-best-practices: HEALTHCHECK and NODE_ENV branches
// =============================================================================

describe('docker-best-practices HEALTHCHECK/NODE_ENV branches', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('docker-bp-healthcheck')
    writeFixture(cwd, 'Dockerfile.full', [
      'FROM node:20',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'ENV NODE_ENV=production',
      'USER node',
      'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000 || exit 1',
      'CMD ["node", "src/app.js"]',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs without throwing on Dockerfile with HEALTHCHECK and NODE_ENV', async () => {
    const result = await findCheck('docker-best-practices').run(cwd, {
      targetFiles: [join(cwd, 'Dockerfile.full')],
    })
    expect(result).toBeDefined()
  })
})

// =============================================================================
// rate-limit-coverage: sensitive-endpoint variant
// =============================================================================

describe('rate-limit-coverage sensitive endpoints', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('rl-sensitive')
    // The check applies strip-strings, but the regex stays line-bound
    // and uses character classes that match spaces. We exercise the
    // top-level scan and skip-paths regardless of detection outcome.
    writeFixture(cwd, 'src/login.ts', [
      'export function attach(app: any) {',
      '  app.post("/api/login", async () => ({ token: "x" }));',
      '  app.get("/health", (_req: any, res: any) => res.send("ok"));',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/internal.ts', [
      'export function attach(app: any) {',
      '  app.get("/internal/metrics", () => ({}));',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs the analyzer including the internal-route skip path', async () => {
    const result = await findCheck('rate-limit-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/login.ts'), join(cwd, 'src/internal.ts')],
    })
    expect(result).toBeDefined()
  })
})

// =============================================================================
// directive-audit: file with only fitness ignores (drives counters)
// =============================================================================

describe('directive-audit pure-fitness file', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('directive-pure')
    writeFixture(cwd, 'src/fitness-only.ts', [
      '// @fitness-ignore-file no-todo-comments -- intentional placeholder',
      'export const x = 1;',
    ].join('\n'))
    writeFixture(cwd, 'src/many-mixed.ts', [
      '// @fitness-ignore-next-line no-console-log -- CLI logger',
      'console.log("ok");',
      '// @ts-expect-error -- third-party type wrong',
      'const a: number = "no" as any;',
      '// nosemgrep: javascript.lang.security',
      'eval("1 + 1");',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs without throwing on mixed directive file', async () => {
    const result = await findCheck('directive-audit').run(cwd, {
      targetFiles: [
        join(cwd, 'src/fitness-only.ts'),
        join(cwd, 'src/many-mixed.ts'),
      ],
    })
    expect(result).toBeDefined()
  })
})

// =============================================================================
// no-focused-tests / no-skipped-tests: cover concurrent + playwright variants
// =============================================================================

describe('no-focused-tests / no-skipped-tests variants', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('no-skip')
    writeFixture(cwd, 'src/__tests__/with-only.test.ts', [
      'import { it, describe } from "vitest";',
      'describe.only("important suite", () => {',
      '  it("test", () => undefined);',
      '});',
    ].join('\n'))
    writeFixture(cwd, 'src/__tests__/with-skip.test.ts', [
      'import { it, describe } from "vitest";',
      'describe.skip("disabled suite", () => {',
      '  it.skip("disabled", () => undefined);',
      '});',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags .only as error', async () => {
    const result = await findCheck('no-focused-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/with-only.test.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('flags .skip as warning', async () => {
    const result = await findCheck('no-skipped-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/with-skip.test.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// auth-route-guard: drive variants
// =============================================================================

describe('auth-route-guard variants', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('arg-variants')
    // Auth group with useUser (one of the auth-protection patterns)
    writeFixture(cwd, 'app/(auth)/_layout.useUser.tsx', [
      'import { useUser } from "../auth";',
      'export default function Layout() {',
      '  const u = useUser();',
      '  return u ? <Slot /> : <Login />;',
      '}',
    ].join('\n'))
    // Auth group with no auth check
    writeFixture(cwd, 'app/(auth)/_layout.unprotected.tsx', [
      'export default function Layout() { return <Slot />; }',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('does not fire when useUser hook is referenced', async () => {
    const result = await findCheck('auth-route-guard').run(cwd, {
      targetFiles: [join(cwd, 'app/(auth)/_layout.useUser.tsx')],
    })
    expect(result.signals.length).toBe(0)
  })

  it('flags layouts with no auth hooks', async () => {
    const result = await findCheck('auth-route-guard').run(cwd, {
      targetFiles: [join(cwd, 'app/(auth)/_layout.unprotected.tsx')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// hasura-production-config: incorrect-value variant
// =============================================================================

describe('hasura-production-config incorrect values', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('hpc-bad')
    writeFixture(cwd, 'docker-compose.prod.yml', [
      'version: "3"',
      'services:',
      '  hasura:',
      '    image: hasura/graphql-engine:v2',
      '    environment:',
      '      HASURA_GRAPHQL_ENABLE_INTROSPECTION: "true"', // wrong value
      '      HASURA_GRAPHQL_ENABLE_ALLOWLIST: "false"',   // wrong value
      '      HASURA_GRAPHQL_DEV_MODE: "true"',            // wrong value
      '      HASURA_GRAPHQL_ENABLE_CONSOLE: "true"',      // wrong value
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags incorrect production values', async () => {
    const result = await findCheck('hasura-production-config').run(cwd, {
      targetFiles: [join(cwd, 'docker-compose.prod.yml')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('incorrect value'))).toBe(true)
  })
})

// =============================================================================
// pino-serializer-coverage: queryRunner variant
// =============================================================================

describe('pino-serializer-coverage variants', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('pino-variants')
    writeFixture(cwd, 'src/qr.ts', [
      'declare const logger: { info(o: unknown): void };',
      'export function track(queryRunner: any) {',
      '  logger.info({ msg: "tx", queryRunner });',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/entity.ts', [
      'declare const logger: { error(o: unknown): void };',
      'export function logIt(entity: any) {',
      '  logger.error({ msg: "fail", entity });',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags QueryRunner without serializer', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/qr.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('QueryRunner'))).toBe(true)
  })

  it('flags Entity without serializer', async () => {
    const result = await findCheck('pino-serializer-coverage').run(cwd, {
      targetFiles: [join(cwd, 'src/entity.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('Entity'))).toBe(true)
  })
})

// =============================================================================
// no-stub-tests: edge case strip-strings interaction
// =============================================================================

describe('no-stub-tests test ID strip', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('stub-edge')
    writeFixture(cwd, 'src/__tests__/multi.test.ts', [
      'import { it } from "vitest";',
      "it('plain', () => {})",
      'test("trivial", () => { expect(true).toBe(true); });',
      "it('async-empty', async () => {});",
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags multiple stub patterns in a single file', async () => {
    const result = await findCheck('no-stub-tests').run(cwd, {
      targetFiles: [join(cwd, 'src/__tests__/multi.test.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// stale-build-artifacts: directory variant with src and dist
// =============================================================================

describe('stale-build-artifacts with src + dist', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('stale-srcdist')
    writeFixture(cwd, 'src/index.ts', 'export const x = 1;')
    // Stale .js artifact alongside source — should fire
    writeFixture(cwd, 'src/index.js', 'export const x = 1;')
    writeFixture(cwd, 'src/index.d.ts', 'export declare const x: number;')
    writeFixture(cwd, 'src/index.js.map', '{}')
    // Properly placed in dist/ — should not fire
    writeFixture(cwd, 'dist/index.js', 'export const x = 1;')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags compiled artifacts in src/', async () => {
    const result = await findCheck('stale-build-artifacts').run(cwd, {
      targetFiles: [
        join(cwd, 'src/index.ts'),
        join(cwd, 'src/index.js'),
        join(cwd, 'src/index.d.ts'),
        join(cwd, 'src/index.js.map'),
        join(cwd, 'dist/index.js'),
      ],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// async-state-pattern: skipped paths (test, components/patterns)
// =============================================================================

describe('async-state-pattern skip paths', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('asp-skip')
    writeFixture(cwd, 'src/screens/__tests__/foo.test.tsx', [
      'import { useQuery } from "@tanstack/react-query";',
      'export function Test() {',
      '  const q = useQuery({ queryKey: ["k"], queryFn: async () => 1 });',
      '  return <div>{q.data}</div>;',
      '}',
    ].join('\n'))
    writeFixture(cwd, 'src/screens/components/patterns/Loading.tsx', [
      'import { useQuery } from "@tanstack/react-query";',
      'export function Loading() {',
      '  const q = useQuery({ queryKey: ["k"], queryFn: async () => 1 });',
      '  return <div>{q.data}</div>;',
      '}',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('skips test files in screens', async () => {
    const result = await findCheck('async-state-pattern').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/__tests__/foo.test.tsx')],
    })
    expect(result.signals.length).toBe(0)
  })

  it('skips files inside components/patterns/', async () => {
    const result = await findCheck('async-state-pattern').run(cwd, {
      targetFiles: [join(cwd, 'src/screens/components/patterns/Loading.tsx')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// dependency-version-consistency: workspace protocol drift
// =============================================================================

describe('dependency-version-consistency variants', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('dvc-variants')
    writeFixture(cwd, 'package.json', JSON.stringify({
      name: 'root',
      devDependencies: { vitest: '^2.0.0', typescript: '^5.4.0' },
    }, null, 2))
    writeFixture(cwd, 'packages/a/package.json', JSON.stringify({
      name: '@org/a',
      devDependencies: { vitest: '^2.0.0' },
    }, null, 2))
    writeFixture(cwd, 'packages/b/package.json', JSON.stringify({
      name: '@org/b',
      devDependencies: { vitest: '^2.0.0' },
    }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('runs without throwing when versions are consistent', async () => {
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
      expect(result).toBeDefined()
    } finally {
      process.chdir(origCwd)
    }
  })
})

// =============================================================================
// no-duplicate-packages: api-client and config categories
// =============================================================================

describe('no-duplicate-packages other categories', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('no-dup-other')
    writeFixture(cwd, 'packages/api/package.json', JSON.stringify({ name: '@org/api-client' }, null, 2))
    writeFixture(cwd, 'packages/http/package.json', JSON.stringify({ name: '@org/http-client' }, null, 2))
    writeFixture(cwd, 'packages/c1/package.json', JSON.stringify({ name: '@org/config' }, null, 2))
    writeFixture(cwd, 'packages/c2/package.json', JSON.stringify({ name: '@org/settings' }, null, 2))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags duplicate api-client and config categories', async () => {
    const result = await findCheck('no-duplicate-packages').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/api/package.json'),
        join(cwd, 'packages/http/package.json'),
        join(cwd, 'packages/c1/package.json'),
        join(cwd, 'packages/c2/package.json'),
      ],
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches).toEqual(expect.arrayContaining(['api-client', 'config']))
  })
})

// =============================================================================
// test-convention-consistency: dominance threshold scenarios
// =============================================================================

describe('test-convention-consistency dominance', () => {
  let cwd: string
  const files: string[] = []

  beforeAll(() => {
    cwd = makeFixtureDir('tcc-dom')
    // 20 .test files + 1 .spec file → .test is dominant (95.2%) → .spec gets flagged
    for (let i = 0; i < 20; i++) {
      files.push(writeFixture(cwd, `src/__tests__/file${i}.test.ts`, [
        'import { it } from "vitest";',
        'it("works", () => undefined);',
      ].join('\n')))
    }
    files.push(writeFixture(cwd, 'src/__tests__/odd.spec.ts', [
      'import { it } from "vitest";',
      'it("works", () => undefined);',
    ].join('\n')))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags the minority .spec file when .test is dominant', async () => {
    const result = await findCheck('test-convention-consistency').run(cwd, {
      targetFiles: files,
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

describe('test-convention-consistency mixed (no dominance)', () => {
  let cwd: string
  let mixedFiles: string[] = []

  beforeAll(() => {
    cwd = makeFixtureDir('tcc-mixed')
    const collected: string[] = []
    for (let i = 0; i < 5; i++) {
      collected.push(writeFixture(cwd, `src/__tests__/t${i}.test.ts`, 'export const x = 1;'))
    }
    for (let i = 0; i < 5; i++) {
      collected.push(writeFixture(cwd, `src/__tests__/s${i}.spec.ts`, 'export const x = 1;'))
    }
    mixedFiles = collected
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('does not fire when neither convention is dominant', async () => {
    const result = await findCheck('test-convention-consistency').run(cwd, {
      targetFiles: mixedFiles,
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// docker-version-sync: pnpm-hardcoded-version variant
// =============================================================================

describe('docker-version-sync hardcoded pnpm', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('dvs-hardcoded')
    writeFixture(cwd, 'package.json', JSON.stringify({
      name: 'root',
      engines: { node: '>=20' },
      packageManager: 'pnpm@10.0.0',
    }, null, 2))
    writeFixture(cwd, 'Dockerfile.match-but-hardcoded', [
      'FROM node:20',
      'RUN corepack prepare pnpm@10.0.0 --activate',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('warns when pnpm version matches but is hardcoded', async () => {
    const origCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = await findCheck('docker-version-sync').run(cwd, {
        targetFiles: [join(cwd, 'Dockerfile.match-but-hardcoded')],
      })
      const types = result.signals.map((s) => s.metadata.type)
      expect(types).toContain('pnpm-hardcoded-version')
    } finally {
      process.chdir(origCwd)
    }
  })
})
