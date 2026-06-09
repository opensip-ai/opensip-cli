import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readCheckPackagePreferences } from '../check-package-discovery.js'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-check-pkg-disc-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
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
      `plugins:
  autoDiscoverChecks: false
  packageScopes:
    - "@acme"
`,
    )
    expect(readCheckPackagePreferences(testDir)).toEqual({})
  })

  it('returns empty object when config has no plugins section', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `fitness: { failOnErrors: 0, failOnWarnings: 0, disabledChecks: [] }\n`,
    )
    expect(readCheckPackagePreferences(testDir)).toEqual({})
  })

  it('returns empty object when no config file exists', () => {
    expect(readCheckPackagePreferences(testDir)).toEqual({})
  })
})
