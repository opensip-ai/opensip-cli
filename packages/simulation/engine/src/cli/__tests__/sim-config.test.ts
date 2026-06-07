import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveSimRecipeSelection } from '../sim-config.js'

/**
 * `resolveSimRecipeSelection` reads `simulation.recipe` from the project config
 * (permissively — sim must not depend on fitness's strict schema) plus the
 * deprecated `cli.recipe` fallback, and applies ADR-0022 precedence.
 */
describe('resolveSimRecipeSelection (ADR-0022)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opensip-sim-cfg-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (yaml: string): void => {
    writeFileSync(join(dir, 'opensip-tools.config.yml'), yaml)
  }

  it('explicit --recipe wins and is strict', () => {
    write('simulation:\n  recipe: from-config\n')
    expect(resolveSimRecipeSelection(dir, 'explicit')).toMatchObject({
      name: 'explicit',
      source: 'flag',
      tolerant: false,
    })
  })

  it('reads simulation.recipe when no flag', () => {
    write('simulation:\n  recipe: smoke\n')
    expect(resolveSimRecipeSelection(dir, undefined)).toMatchObject({
      name: 'smoke',
      source: 'tool-config',
      tolerant: true,
      usedDeprecatedCliRecipe: false,
    })
  })

  it('falls back to the deprecated cli.recipe when simulation.recipe is absent', () => {
    write('cli:\n  recipe: opensip\n')
    expect(resolveSimRecipeSelection(dir, undefined)).toMatchObject({
      name: 'opensip',
      source: 'cli-config',
      tolerant: true,
      usedDeprecatedCliRecipe: true,
    })
  })

  it('returns the builtin default when no config file exists', () => {
    expect(resolveSimRecipeSelection(dir, undefined)).toMatchObject({
      name: 'default',
      source: 'builtin',
      tolerant: true,
    })
  })

  it('ignores a non-string simulation.recipe (malformed) and falls through', () => {
    write('simulation:\n  recipe:\n    - not-a-string\ncli:\n  recipe: from-cli\n')
    expect(resolveSimRecipeSelection(dir, undefined)).toMatchObject({
      name: 'from-cli',
      source: 'cli-config',
    })
  })

  it('returns builtin default when simulation: block is not a mapping', () => {
    write('simulation: just-a-scalar\n')
    expect(resolveSimRecipeSelection(dir, undefined)).toMatchObject({ name: 'default', source: 'builtin' })
  })
})
