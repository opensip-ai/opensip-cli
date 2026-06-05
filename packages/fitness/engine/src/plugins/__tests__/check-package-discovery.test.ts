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

describe('discoverCheckPackages — explicit packages', () => {
  it('returns empty when no explicit list is configured', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({ projectDir: testDir })
    expect(result).toEqual([])
  })

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

  it('explicit empty list contributes no packages', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const result = discoverCheckPackages({ projectDir: testDir, explicitPackages: [] })
    expect(result).toEqual([])
  })

  it('honors every entry in the explicit list — no package is privileged', () => {
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

  it('walks ancestor node_modules for explicit packages', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python')
    const nestedDir = join(testDir, 'apps', 'web')
    mkdirSync(nestedDir, { recursive: true })
    const result = discoverCheckPackages({
      projectDir: nestedDir,
      explicitPackages: ['@opensip-tools/checks-python'],
    })
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/checks-python'])
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
  it('reads checkPackages from project config', () => {
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
fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
`,
    )
    const prefs = readCheckPackagePreferences(testDir)
    expect(prefs.checkPackages).toEqual(['@opensip-tools/checks-python'])
  })

  it('ignores removed prefix-discovery preferences', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: [typescript]
    concerns: []
    include: ["**/*.ts"]
plugins:
  autoDiscoverChecks: false
  packageScopes:
    - "@acme"
fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
`,
    )
    expect(readCheckPackagePreferences(testDir)).toEqual({})
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
