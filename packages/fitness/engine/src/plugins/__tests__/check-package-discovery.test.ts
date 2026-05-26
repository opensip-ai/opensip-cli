import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from '../check-package-discovery.js'

let testDir: string

function makeNodeModulesPackage(testDir: string, scopedName: string, fields: Record<string, unknown> = {}): string {
  const [scope, name] = scopedName.startsWith('@')
    ? [scopedName.split('/')[0], scopedName.split('/').slice(1).join('/')]
    : ['', scopedName]
  const dir = scope ? join(testDir, 'node_modules', scope, name) : join(testDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: scopedName, version: '0.0.0', main: './index.js', ...fields }),
  )
  writeFileSync(join(dir, 'index.js'), 'export const checks = []')
  return dir
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-check-pkg-disc-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('discoverCheckPackages — auto-discovery (default)', () => {
  it('finds @opensip-tools/checks-* packages in node_modules', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-go')
    const result = discoverCheckPackages({ projectDir: testDir })
    const names = result.map((p) => p.name).sort()
    expect(names).toEqual([
      '@opensip-tools/checks-go',
      '@opensip-tools/checks-python',
    ])
  })

  it('returns every @opensip-tools/checks-* package without privileging any one', () => {
    // No package is hardcoded into the CLI any more; the discovery layer
    // treats them all the same. The only reason a check package would be
    // excluded is if the package.json is missing or unreadable.
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-typescript')
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({ projectDir: testDir })
    expect(result.map((p) => p.name).sort()).toEqual([
      '@opensip-tools/checks-python',
      '@opensip-tools/checks-typescript',
    ])
  })

  it('ignores @opensip-tools packages that are not check packs', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/lang-python')
    makeNodeModulesPackage(testDir, '@opensip-tools/core')
    const result = discoverCheckPackages({ projectDir: testDir })
    expect(result).toHaveLength(0)
  })

  it('walks ancestor node_modules to handle pnpm hoisted layouts', () => {
    // Place check package in workspace-root node_modules, run discovery
    // from a nested project dir.
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const nestedDir = join(testDir, 'apps', 'web')
    mkdirSync(nestedDir, { recursive: true })
    const result = discoverCheckPackages({ projectDir: nestedDir })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/checks-python'])
  })

  it('returns empty array when there is no @opensip-tools scope dir', () => {
    const result = discoverCheckPackages({ projectDir: testDir })
    expect(result).toEqual([])
  })
})

describe('discoverCheckPackages — custom packageScopes', () => {
  it('discovers checks under a customer-configured scope alongside the default', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    makeNodeModulesPackage(testDir, '@acme/checks-internal')
    const result = discoverCheckPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name).sort()).toEqual([
      '@acme/checks-internal',
      '@opensip-tools/checks-python',
    ])
  })

  it('always includes the default scope even when packageScopes is non-empty', () => {
    // Customer adds their own scope; they don't lose @opensip-tools coverage.
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-go')
    makeNodeModulesPackage(testDir, '@acme/checks-internal')
    const result = discoverCheckPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toContain('@opensip-tools/checks-go')
  })

  it('dedupes when the customer redundantly lists the default scope', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({
      projectDir: testDir,
      packageScopes: ['@opensip-tools', '@opensip-tools'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/checks-python'])
  })

  it('only picks up `checks-*` packages under the custom scope, not unrelated packages', () => {
    makeNodeModulesPackage(testDir, '@acme/checks-internal')
    makeNodeModulesPackage(testDir, '@acme/utils')
    const result = discoverCheckPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toEqual(['@acme/checks-internal'])
  })

  it('skips invalid scope strings without throwing', () => {
    // Path-traversal-shaped values would scan the wrong directory if joined
    // naively; the validator rejects them. Discovery still returns the
    // default-scope results so a typo doesn't take down the whole run.
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({
      projectDir: testDir,
      packageScopes: ['..', 'no-at-sign', '@', '@Bad-Caps'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/checks-python'])
  })

  it('walks ancestor node_modules for custom scopes the same as the default', () => {
    makeNodeModulesPackage(testDir, '@acme/checks-internal')
    const nestedDir = join(testDir, 'apps', 'web')
    mkdirSync(nestedDir, { recursive: true })
    const result = discoverCheckPackages({
      projectDir: nestedDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toEqual(['@acme/checks-internal'])
  })
})

describe('discoverCheckPackages — opt-out', () => {
  it('returns empty array when autoDiscover is false', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({ projectDir: testDir, autoDiscover: false })
    expect(result).toEqual([])
  })
})

describe('discoverCheckPackages — explicit packages', () => {
  it('loads only the configured list', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-go')
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-java')
    const result = discoverCheckPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/checks-python'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/checks-python'])
  })

  it('warns and skips packages that are configured but not installed', () => {
    const result = discoverCheckPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/checks-missing'],
    })
    expect(result).toEqual([])
  })

  it('explicit empty list disables loading entirely', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({ projectDir: testDir, explicitPackages: [] })
    expect(result).toEqual([])
  })

  it('honors every entry in the explicit list — no package is privileged', () => {
    // After the decoupling there is no hardcoded "builtin" package; the
    // explicit list passes through verbatim. This guards against
    // re-introducing a magic name skip.
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-typescript')
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/checks-typescript', '@opensip-tools/checks-python'],
    })
    expect(result.map((p) => p.name).sort()).toEqual([
      '@opensip-tools/checks-python',
      '@opensip-tools/checks-typescript',
    ])
  })
})

describe('readCheckPackageMetadata', () => {
  it('reads name and main from package.json', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/checks-python', {
      main: './dist/index.js',
    })
    const meta = readCheckPackageMetadata(dir)
    expect(meta?.name).toBe('@opensip-tools/checks-python')
    expect(meta?.mainEntry.endsWith('/dist/index.js')).toBe(true)
  })

  it('honors exports["."] over main', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/checks-go', {
      main: './main-fallback.js',
      exports: { '.': './dist/preferred.js' },
    })
    const meta = readCheckPackageMetadata(dir)
    expect(meta?.mainEntry.endsWith('/dist/preferred.js')).toBe(true)
  })

  it('returns undefined when no package.json exists', () => {
    expect(readCheckPackageMetadata('/nonexistent/path')).toBeUndefined()
  })
})

describe('readCheckPackagePreferences', () => {
  it('reads checkPackages and autoDiscoverChecks from project config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: [typescript]
    concerns: []
    include: ["**/*.ts"]
plugins:
  checkPackages:
    - "@opensip-tools/checks-python"
  autoDiscoverChecks: false
fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
`,
    )
    const prefs = readCheckPackagePreferences(testDir)
    expect(prefs.checkPackages).toEqual(['@opensip-tools/checks-python'])
    expect(prefs.autoDiscoverChecks).toBe(false)
  })

  it('reads packageScopes from project config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: [typescript]
    concerns: []
    include: ["**/*.ts"]
plugins:
  packageScopes:
    - "@acme"
    - "@my-org"
fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
`,
    )
    const prefs = readCheckPackagePreferences(testDir)
    expect(prefs.packageScopes).toEqual(['@acme', '@my-org'])
  })

  it('returns empty object when config has no plugins section', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: []
    concerns: []
    include: ["**/*.ts"]
fitness: { failOnErrors: 0, failOnWarnings: 0, disabledChecks: [] }
`,
    )
    const prefs = readCheckPackagePreferences(testDir)
    expect(prefs).toEqual({})
  })

  it('returns empty object when no config file exists', () => {
    expect(readCheckPackagePreferences(testDir)).toEqual({})
  })
})
