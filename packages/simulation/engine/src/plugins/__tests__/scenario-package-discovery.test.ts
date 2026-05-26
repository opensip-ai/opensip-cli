import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  discoverScenarioPackages,
  readScenarioPackageMetadata,
  readScenarioPackagePreferences,
} from '../scenario-package-discovery.js'

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
  // Scenario packs self-register at import time; a minimal index is enough
  // for discovery (which only reads package.json).
  writeFileSync(join(dir, 'index.js'), '// scenario pack — scenarios self-register')
  return dir
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-scenario-pkg-disc-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('discoverScenarioPackages — auto-discovery (default)', () => {
  it('finds @opensip-tools/scenarios-* packages in node_modules', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-chaos-default')
    const result = discoverScenarioPackages({ projectDir: testDir })
    const names = result.map((p) => p.name).sort()
    expect(names).toEqual([
      '@opensip-tools/scenarios-chaos-default',
      '@opensip-tools/scenarios-load-default',
    ])
  })

  it('returns every @opensip-tools/scenarios-* package without privileging any one', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-invariant-default')
    const result = discoverScenarioPackages({ projectDir: testDir })
    expect(result.map((p) => p.name).sort()).toEqual([
      '@opensip-tools/scenarios-invariant-default',
      '@opensip-tools/scenarios-load-default',
    ])
  })

  it('ignores @opensip-tools packages that are not scenario packs', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    makeNodeModulesPackage(testDir, '@opensip-tools/core')
    const result = discoverScenarioPackages({ projectDir: testDir })
    expect(result).toHaveLength(0)
  })

  it('walks ancestor node_modules to handle pnpm hoisted layouts', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    const nestedDir = join(testDir, 'apps', 'web')
    mkdirSync(nestedDir, { recursive: true })
    const result = discoverScenarioPackages({ projectDir: nestedDir })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/scenarios-load-default'])
  })

  it('returns empty array when there is no @opensip-tools scope dir', () => {
    const result = discoverScenarioPackages({ projectDir: testDir })
    expect(result).toEqual([])
  })
})

describe('discoverScenarioPackages — custom packageScopes', () => {
  it('discovers scenarios under a customer-configured scope alongside the default', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    makeNodeModulesPackage(testDir, '@acme/scenarios-internal')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name).sort()).toEqual([
      '@acme/scenarios-internal',
      '@opensip-tools/scenarios-load-default',
    ])
  })

  it('always includes the default scope even when packageScopes is non-empty', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-chaos-default')
    makeNodeModulesPackage(testDir, '@acme/scenarios-internal')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toContain('@opensip-tools/scenarios-chaos-default')
  })

  it('dedupes when the customer redundantly lists the default scope', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      packageScopes: ['@opensip-tools', '@opensip-tools'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/scenarios-load-default'])
  })

  it('only picks up `scenarios-*` packages under the custom scope, not unrelated packages', () => {
    makeNodeModulesPackage(testDir, '@acme/scenarios-internal')
    makeNodeModulesPackage(testDir, '@acme/utils')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toEqual(['@acme/scenarios-internal'])
  })

  it('skips invalid scope strings without throwing', () => {
    // Path-traversal-shaped values would scan the wrong directory if joined
    // naively; the validator rejects them. Discovery still returns the
    // default-scope results so a typo doesn't take down the whole run.
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      packageScopes: ['..', 'no-at-sign', '@', '@Bad-Caps'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/scenarios-load-default'])
  })

  it('walks ancestor node_modules for custom scopes the same as the default', () => {
    makeNodeModulesPackage(testDir, '@acme/scenarios-internal')
    const nestedDir = join(testDir, 'apps', 'web')
    mkdirSync(nestedDir, { recursive: true })
    const result = discoverScenarioPackages({
      projectDir: nestedDir,
      packageScopes: ['@acme'],
    })
    expect(result.map((p) => p.name)).toEqual(['@acme/scenarios-internal'])
  })
})

describe('discoverScenarioPackages — opt-out', () => {
  it('returns empty array when autoDiscover is false', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    const result = discoverScenarioPackages({ projectDir: testDir, autoDiscover: false })
    expect(result).toEqual([])
  })
})

describe('discoverScenarioPackages — explicit packages', () => {
  it('loads only the configured list', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-chaos-default')
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-invariant-default')
    const result = discoverScenarioPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/scenarios-load-default'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/scenarios-load-default'])
  })

  it('warns and skips packages that are configured but not installed', () => {
    const result = discoverScenarioPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/scenarios-missing'],
    })
    expect(result).toEqual([])
  })

  it('explicit empty list disables loading entirely', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default')
    const result = discoverScenarioPackages({ projectDir: testDir, explicitPackages: [] })
    expect(result).toEqual([])
  })
})

describe('readScenarioPackageMetadata', () => {
  it('reads name and main from package.json', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-load-default', {
      main: './dist/index.js',
    })
    const meta = readScenarioPackageMetadata(dir)
    expect(meta?.name).toBe('@opensip-tools/scenarios-load-default')
    expect(meta?.mainEntry.endsWith('/dist/index.js')).toBe(true)
  })

  it('honors exports["."] over main', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/scenarios-chaos-default', {
      main: './main-fallback.js',
      exports: { '.': './dist/preferred.js' },
    })
    const meta = readScenarioPackageMetadata(dir)
    expect(meta?.mainEntry.endsWith('/dist/preferred.js')).toBe(true)
  })

  it('returns undefined when no package.json exists', () => {
    expect(readScenarioPackageMetadata('/nonexistent/path')).toBeUndefined()
  })
})

describe('readScenarioPackagePreferences', () => {
  it('reads scenarioPackages and autoDiscoverScenarios from project config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `plugins:
  scenarioPackages:
    - "@opensip-tools/scenarios-load-default"
  autoDiscoverScenarios: false
`,
    )
    const prefs = readScenarioPackagePreferences(testDir)
    expect(prefs.scenarioPackages).toEqual(['@opensip-tools/scenarios-load-default'])
    expect(prefs.autoDiscoverScenarios).toBe(false)
  })

  it('reads packageScopes from project config (shared with fitness)', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `plugins:
  packageScopes:
    - "@acme"
    - "@my-org"
`,
    )
    const prefs = readScenarioPackagePreferences(testDir)
    expect(prefs.packageScopes).toEqual(['@acme', '@my-org'])
  })

  it('returns empty object when config has no plugins section', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `simulation: { enabled: true }
`,
    )
    const prefs = readScenarioPackagePreferences(testDir)
    expect(prefs).toEqual({})
  })

  it('returns empty object when no config file exists', () => {
    expect(readScenarioPackagePreferences(testDir)).toEqual({})
  })
})
