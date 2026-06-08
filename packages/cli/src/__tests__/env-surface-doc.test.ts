/**
 * Drift guard: the published environment-variable reference must list EVERY
 * variable `describeHostEnv()` declares (release 2.12.0, §5.12). The doc is the
 * human-readable projection of the registry; this test fails if a new EnvVarSpec
 * is added without documenting it (or a documented one is removed).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { describeHostEnv } from '../env/host-env-specs.js'

const DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
  'docs', 'public', '70-reference', '10-environment-variables.md',
)

describe('environment-variable reference', () => {
  it('lists every variable describeHostEnv() declares', () => {
    const doc = readFileSync(DOC_PATH, 'utf8')
    const missing = describeHostEnv()
      .map((spec) => spec.canonical)
      .filter((name) => !doc.includes(`\`${name}\``))
    expect(missing, `undocumented env variables: ${missing.join(', ')}`).toEqual([])
  })
})
