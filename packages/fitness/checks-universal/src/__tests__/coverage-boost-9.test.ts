// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/**
 * @fileoverview Branch-coverage tests for medium-coverage checks (round 9).
 *
 * Targets the ESLint directive parser's separator branches, the
 * TypeScript directive-hygiene separator branches, the image-optimization
 * checker, the JWT-validation matchers, and the remaining public-API
 * graph resolution branches (bare/source export targets, non-object
 * package.json).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { fileCache } from '@opensip-tools/fitness'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseESLintDirectives } from '../checks/documentation/_directives/eslint.js'
import { _resetPublicApiGraphCache, isInPublicApiSurface } from '../checks/documentation/_public-api-graph.js'
import { checks } from '../index.js'

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug)
  if (!check) throw new Error(`check not found: ${slug}`)
  return check
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov9-${prefix}-`))
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

afterEach(() => {
  fileCache.clear()
  _resetPublicApiGraphCache()
})

// =============================================================================
// parseESLintDirectives: separator / scope / file-level branches
// =============================================================================

describe('parseESLintDirectives', () => {
  it('returns no directives for lines without comments', () => {
    expect(parseESLintDirectives('const x = 1', 'a.ts', 'a.ts')).toEqual([])
  })

  it('parses a line-comment disable-next-line with a single rule and reason', () => {
    const [d] = parseESLintDirectives(
      'const x = 1 // eslint-disable-next-line no-console -- debugging only',
      'a.ts',
      'a.ts',
    )
    expect(d?.rule).toBe('eslint/no-console')
    expect(d?.scope).toBe('next-line')
    expect(d?.reason).toBe('debugging only')
  })

  it('parses a disable-line comment with multiple comma-separated rules', () => {
    const ds = parseESLintDirectives(
      'doThing() // eslint-disable-line no-console, no-alert',
      'a.ts',
      'a.ts',
    )
    expect(ds.map((d) => d.rule)).toEqual(['eslint/no-console', 'eslint/no-alert'])
    expect(ds.every((d) => d.scope === 'same-line')).toBe(true)
  })

  it('emits a wildcard rule when a disable-next-line has no concrete rules', () => {
    const [d] = parseESLintDirectives(
      'const x = 1 // eslint-disable-next-line * -- broad suppression',
      'a.ts',
      'a.ts',
    )
    expect(d?.rule).toBe('*')
    expect(d?.reason).toBe('broad suppression')
  })

  it('parses a block-comment eslint-disable directive', () => {
    const [d] = parseESLintDirectives(
      '/* eslint-disable no-bitwise -- low-level masks */ const x = 1',
      'a.ts',
      'a.ts',
    )
    expect(d?.rule).toBe('eslint/no-bitwise')
    expect(d?.scope).toBe('file')
  })

  it('handles two block comments on the same line', () => {
    const ds = parseESLintDirectives(
      '/* eslint-disable no-console */ x; /* eslint-disable-line no-alert */',
      'a.ts',
      'a.ts',
    )
    expect(ds.map((d) => d.rule)).toEqual(
      expect.arrayContaining(['eslint/no-console', 'eslint/no-alert']),
    )
  })

  it('records a file-level bare disable at the top of the file', () => {
    const [d] = parseESLintDirectives('/* eslint-disable */\nconst x = 1', 'a.ts', 'a.ts')
    expect(d?.rule).toBe('*')
    expect(d?.scope).toBe('file')
  })

  it('ignores an unterminated block comment', () => {
    expect(parseESLintDirectives('/* eslint-disable no-console', 'a.ts', 'a.ts')).toEqual([])
  })
})

// =============================================================================
// typescript-directive-hygiene: separator branches in extractJustification
// =============================================================================

describe('typescript-directive-hygiene separators', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('ts-directive')
    // `:` separator with a real reason -> accepted, no violation.
    writeFixture(cwd, 'src/colon.ts', [
      '// @ts-expect-error: legacy API has incorrect upstream types',
      'const x = legacy()',
    ].join('\n'))
    // `- ` separator with a real reason -> accepted, no violation.
    writeFixture(cwd, 'src/dash-space.ts', [
      '// @ts-expect-error - upstream typings lag the runtime contract here',
      'const y = legacy()',
    ].join('\n'))
    // `--` separator with EMPTY reason -> treated as missing justification.
    writeFixture(cwd, 'src/empty-reason.ts', [
      '// @ts-ignore --',
      'const z = legacy()',
    ].join('\n'))
    // `:` separator with empty reason -> missing justification.
    writeFixture(cwd, 'src/empty-colon.ts', [
      '// @ts-ignore:',
      'const w = legacy()',
    ].join('\n'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('accepts a colon-separated justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/colon.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('missing justification'))).toBe(false)
  })

  it('accepts a "- " dash-space-separated justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/dash-space.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.includes('missing justification'))).toBe(false)
  })

  it('flags an empty -- reason as missing justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/empty-reason.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('flags an empty colon reason as missing justification', async () => {
    const result = await findCheck('typescript-directive-hygiene').run(cwd, {
      targetFiles: [join(cwd, 'src/empty-colon.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// image-optimization: react-native Image vs expo-image branches
// =============================================================================

describe('image-optimization', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('img-opt')
    // react-native Image, no expo-image -> use-expo-image violation.
    writeFixture(cwd, 'src/rn.tsx', [
      "import { Image, View } from 'react-native'",
      'export const C = () => <Image source={src} />',
    ].join('\n'))
    // expo-image present + <Image source=> without placeholder -> no-placeholder.
    writeFixture(cwd, 'src/expo-missing.tsx', [
      "import { Image } from 'expo-image'",
      'export const C = () => <Image source={src} />',
    ].join('\n'))
    // expo-image present + placeholder nearby -> no violation.
    writeFixture(cwd, 'src/expo-ok.tsx', [
      "import { Image } from 'expo-image'",
      'export const C = () => (',
      '  <Image',
      '    source={src}',
      '    placeholder={blur}',
      '  />',
      ')',
    ].join('\n'))
    // Non-tsx file -> skipped even though it mentions Image.
    writeFixture(cwd, 'src/not-tsx.ts', "import { Image } from 'react-native'")
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags react-native Image when expo-image is absent', async () => {
    const result = await findCheck('image-optimization').run(cwd, {
      targetFiles: [join(cwd, 'src/rn.tsx')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('use-expo-image')
  })

  it('flags expo-image elements missing a placeholder prop', async () => {
    const result = await findCheck('image-optimization').run(cwd, {
      targetFiles: [join(cwd, 'src/expo-missing.tsx')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).toContain('no-placeholder')
  })

  it('does not flag expo-image elements that declare a placeholder', async () => {
    const result = await findCheck('image-optimization').run(cwd, {
      targetFiles: [join(cwd, 'src/expo-ok.tsx')],
    })
    const types = result.signals.map((s) => s.metadata.type)
    expect(types).not.toContain('no-placeholder')
  })

  it('skips non-tsx files', async () => {
    const result = await findCheck('image-optimization').run(cwd, {
      targetFiles: [join(cwd, 'src/not-tsx.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// jwt-validation: verify-without-algorithm and decode-for-auth matchers
// =============================================================================

describe('jwt-validation matchers', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('jwt')
    // jwt.verify with only 2 args (no algorithms option) -> flagged.
    writeFixture(cwd, 'src/verify.ts', [
      'import jwt from jsonwebtoken',
      'export function check(token, secret) {',
      '  return jwt.verify(token, secret)',
      '}',
    ].join('\n'))
    // jwt.decode used in an auth context -> flagged.
    writeFixture(cwd, 'src/decode.ts', [
      'import jwt from jsonwebtoken',
      'export function getUser(token) {',
      '  const user = jwt.decode(token)',
      '  return user',
      '}',
    ].join('\n'))
    // jwt.verify with comment line + an unbalanced reference that should not match.
    writeFixture(cwd, 'src/safe.ts', [
      '// jwt.verify(token, secret) shown in a comment only',
      'export function ok(token, secret) {',
      '  return jwt.verify(token, secret, { algorithms: [HS256] })',
      '}',
    ].join('\n'))
    // File without JWT keywords -> skipped.
    writeFixture(cwd, 'src/none.ts', 'export const x = 1')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags jwt.verify without an algorithms option', async () => {
    const result = await findCheck('jwt-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/verify.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('flags jwt.decode used in an auth context', async () => {
    const result = await findCheck('jwt-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/decode.ts')],
    })
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('does not flag verify-in-comment or verify-with-algorithms', async () => {
    const result = await findCheck('jwt-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/safe.ts')],
    })
    const messages = result.signals.map((s) => s.message)
    expect(messages.some((m) => m.toLowerCase().includes('algorithm'))).toBe(false)
  })

  it('skips files with no JWT keywords', async () => {
    const result = await findCheck('jwt-validation').run(cwd, {
      targetFiles: [join(cwd, 'src/none.ts')],
    })
    expect(result.signals.length).toBe(0)
  })
})

// =============================================================================
// public-API graph: bare/source export targets, non-object package.json
// =============================================================================

describe('isInPublicApiSurface resolution edge cases', () => {
  let cwd: string

  beforeAll(() => {
    cwd = makeFixtureDir('pubapi2')

    // Export target that is already a source path (no dist/ prefix, no
    // leading './') -> exercises the non-./ and non-dist branches plus the
    // re-export specifier with no .js extension.
    writeFixture(cwd, 'pkg-src/package.json', JSON.stringify({
      name: '@org/src',
      exports: 'src/index.ts',
    }))
    writeFixture(cwd, 'pkg-src/src/index.ts', [
      "export { foo } from './lib'",
    ].join('\n'))
    writeFixture(cwd, 'pkg-src/src/lib.ts', 'export const foo = 1')

    // package.json that parses to a non-object, non-null value (a bare
    // string) -> exercises the `typeof pkg !== 'object'` true branch.
    writeFixture(cwd, 'pkg-str/package.json', '"just-a-string"')
    writeFixture(cwd, 'pkg-str/src/anything.ts', 'export const x = 1')
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('resolves a bare source export target and an extensionless re-export', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-src/src/index.ts'))).toBe(true)
    expect(isInPublicApiSurface(join(cwd, 'pkg-src/src/lib.ts'))).toBe(true)
  })

  it('open-fails when package.json parses to a non-object value', () => {
    expect(isInPublicApiSurface(join(cwd, 'pkg-str/src/anything.ts'))).toBe(true)
  })
})
