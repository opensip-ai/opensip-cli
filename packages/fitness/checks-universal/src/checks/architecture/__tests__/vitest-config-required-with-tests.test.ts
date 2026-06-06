/**
 * Unit tests for the `vitest-config-required-with-tests` check.
 *
 * Two layers:
 *  1. The pure `detectMissingVitestConfig` detector, exercised with an
 *     injected in-memory filesystem port — deterministic, no disk, no mocks.
 *  2. The default `nodeFsPort` exercised against the on-disk `__fixtures__`
 *     trees, validating the real recursive test-file scan and `existsSync`
 *     wiring end-to-end.
 *
 * The workspace root is DERIVED from the package paths (common ancestor +
 * its parent), so the workspace-root-config cases use >=2 packages — that is
 * the only shape in which a centralized config sits one level above the
 * shared `packages/` ancestor.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  detectMissingVitestConfig,
  nodeFsPort,
  vitestConfigRequiredWithTests,
  type VitestConfigFsPort,
} from '../vitest-config-required-with-tests.js'

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'vitest-config-required-with-tests',
)

/**
 * Build an in-memory port from a set of existing paths and a set of
 * package dirs that contain test files.
 */
function fakePort(existing: Set<string>, withTests: Set<string>): VitestConfigFsPort {
  return {
    exists: (p) => existing.has(p),
    hasTestFiles: (dir) => withTests.has(dir),
  }
}

const ROOT = '/repo'

describe('detectMissingVitestConfig (pure detector)', () => {
  it('flags exactly the package that has tests but no vitest config', () => {
    const goodPkg = `${ROOT}/packages/good/package.json`
    const badPkg = `${ROOT}/packages/bad/package.json`
    const port = fakePort(
      new Set([`${ROOT}/packages/good/vitest.config.ts`]),
      new Set([`${ROOT}/packages/good`, `${ROOT}/packages/bad`]),
    )

    const violations = detectMissingVitestConfig([goodPkg, badPkg], port)

    expect(violations).toHaveLength(1)
    expect(violations[0]?.filePath).toBe(badPkg)
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.line).toBe(1)
    expect(violations[0]?.match).toBe('bad')
    expect(violations[0]?.type).toBe('missing-vitest-config')
    expect(violations[0]?.message).toContain('bad')
    expect(violations[0]?.suggestion).toContain('vitest.config')
  })

  it('accepts a .mts package-root config', () => {
    const a = `${ROOT}/packages/a/package.json`
    const m = `${ROOT}/packages/m/package.json`
    const port = fakePort(
      new Set([`${ROOT}/packages/a/vitest.config.ts`, `${ROOT}/packages/m/vitest.config.mts`]),
      new Set([`${ROOT}/packages/a`, `${ROOT}/packages/m`]),
    )
    expect(detectMissingVitestConfig([a, m], port)).toHaveLength(0)
  })

  it('does NOT flag a package that has NO test files (even without a config)', () => {
    const a = `${ROOT}/packages/a/package.json`
    const lib = `${ROOT}/packages/lib/package.json`
    // `lib` has no config, but also no tests -> not a violation. `a` is a
    // second package so the derived workspace root is `packages/` (no config).
    const port = fakePort(
      new Set([`${ROOT}/packages/a/vitest.config.ts`]),
      new Set([`${ROOT}/packages/a`]),
    )
    expect(detectMissingVitestConfig([a, lib], port)).toHaveLength(0)
  })

  it('does NOT flag any package when a workspace-root vitest.config.ts exists', () => {
    const a = `${ROOT}/packages/a/package.json`
    const bad = `${ROOT}/packages/bad/package.json`
    const port = fakePort(
      new Set([`${ROOT}/vitest.config.ts`]), // centralized config at repo root
      new Set([`${ROOT}/packages/a`, `${ROOT}/packages/bad`]), // both have tests, no per-pkg config
    )
    expect(detectMissingVitestConfig([a, bad], port)).toHaveLength(0)
  })

  it('treats a workspace-root vitest.workspace.ts as satisfying every package', () => {
    const a = `${ROOT}/packages/a/package.json`
    const bad = `${ROOT}/packages/bad/package.json`
    const port = fakePort(
      new Set([`${ROOT}/vitest.workspace.ts`]),
      new Set([`${ROOT}/packages/a`, `${ROOT}/packages/bad`]),
    )
    expect(detectMissingVitestConfig([a, bad], port)).toHaveLength(0)
  })

  it('does NOT count tests as covered by a sibling package config', () => {
    // `a` has a config; `bad` does not. A config under `a` must not satisfy
    // `bad` — only a per-package or true workspace-root config counts.
    const a = `${ROOT}/packages/a/package.json`
    const bad = `${ROOT}/packages/bad/package.json`
    const port = fakePort(
      new Set([`${ROOT}/packages/a/vitest.config.ts`]),
      new Set([`${ROOT}/packages/bad`]),
    )
    const violations = detectMissingVitestConfig([a, bad], port)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.match).toBe('bad')
  })

  it('skips the workspace-root package.json itself (multi-package repo)', () => {
    // The repo-root package.json reports tests but no config; it is not a
    // leaf package and must not self-flag.
    const rootPkg = `${ROOT}/package.json`
    const a = `${ROOT}/packages/a/package.json`
    const port = fakePort(
      new Set([`${ROOT}/packages/a/vitest.config.ts`]),
      new Set([ROOT, `${ROOT}/packages/a`]),
    )
    expect(detectMissingVitestConfig([rootPkg, a], port)).toHaveLength(0)
  })

  it('returns no violations for an empty package list', () => {
    const port = fakePort(new Set(), new Set())
    expect(detectMissingVitestConfig([], port)).toEqual([])
  })
})

describe('nodeFsPort against on-disk fixtures', () => {
  it('clean fixture (tests + config) yields no violation', () => {
    const pkg = path.join(FIXTURES, 'clean', 'packages', 'x', 'package.json')
    // hasTestFiles must find the nested src/sum.test.ts.
    expect(nodeFsPort.hasTestFiles(path.dirname(pkg))).toBe(true)
    expect(detectMissingVitestConfig([pkg], nodeFsPort)).toHaveLength(0)
  })

  it('violation fixture (tests, no config) yields exactly one violation', () => {
    const pkg = path.join(FIXTURES, 'violation', 'packages', 'x', 'package.json')
    expect(nodeFsPort.hasTestFiles(path.dirname(pkg))).toBe(true)
    const violations = detectMissingVitestConfig([pkg], nodeFsPort)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.filePath).toBe(pkg)
    expect(violations[0]?.match).toBe('x')
  })

  it('hasTestFiles finds nested tests and exists() reflects real files', () => {
    expect(nodeFsPort.hasTestFiles(path.join(FIXTURES, 'clean', 'packages', 'x', 'src'))).toBe(true)
    expect(nodeFsPort.exists(path.join(FIXTURES, 'clean', 'packages', 'x', 'vitest.config.ts'))).toBe(true)
    expect(nodeFsPort.exists(path.join(FIXTURES, 'clean', 'packages', 'x', 'nope.ts'))).toBe(false)
  })

  it('hasTestFiles returns false for an unreadable / nonexistent directory', () => {
    expect(nodeFsPort.hasTestFiles(path.join(FIXTURES, 'does-not-exist'))).toBe(false)
  })
})

describe('vitestConfigRequiredWithTests check descriptor', () => {
  it('is registered as an analyzeAll check with the expected metadata', () => {
    expect(vitestConfigRequiredWithTests.config.slug).toBe('vitest-config-required-with-tests')
    expect(vitestConfigRequiredWithTests.config.id).toBe('b7363db9-c3f7-47bc-8c25-1ddeebf53904')
    expect(vitestConfigRequiredWithTests.config.analysisMode).toBe('analyzeAll')
    expect(vitestConfigRequiredWithTests.config.tags).toContain('testing')
  })
})
