import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readScenarioPackagePreferences } from '../scenario-package-discovery.js'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-scenario-pkg-disc-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
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

  it('reads packageScopes from project config', () => {
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
