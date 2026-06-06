/**
 * Per-check pass/fail fixture coverage for checks-typescript (testing gap P0).
 *
 * Every shipped, non-command check must have a clean fixture (0 findings) and a
 * violation fixture (>=1) under a co-located `__fixtures__/<slug>/` directory
 * next to the check's source. Slugs on ALLOWLIST are exempt until their
 * fixtures land (the list must reach []). The harness runs each check
 * in-process via the engine's internal coverage helpers.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  planCoverageCases,
  runCheckOnFixture,
  validateBookkeeping,
  type CoverageConfig,
} from '@opensip-tools/fitness/internal'
import { describe, expect, it } from 'vitest'

import { checks } from '../index.js'

import { ALLOWLIST, COMMAND_EXEMPTIONS, FILENAME_OVERRIDES } from './fixture-coverage.allowlist.js'

const PACK_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

const config: CoverageConfig = {
  packName: 'checks-typescript',
  checks,
  allowlist: ALLOWLIST,
  commandExemptions: COMMAND_EXEMPTIONS,
  filenameOverrides: FILENAME_OVERRIDES,
  // Phase 5 removes this once ALLOWLIST is [] (turns the ratchet fully live).
  allowNonEmptyAllowlist: true,
}

const cases = await planCoverageCases(config, PACK_SRC)

describe('checks-typescript · fixture-coverage bookkeeping', () => {
  it('config is self-consistent (allowlist + command exemptions valid)', () => {
    expect(validateBookkeeping(config)).toEqual([])
  })
})

describe('checks-typescript · fixture-coverage', () => {
  if (cases.length === 0) {
    // Every shipped check is still allowlisted — nothing to assert yet, but the
    // wiring must be meaningful (this fails if the allowlist is wrongly empty).
    it('every shipped check is allowlisted', () => {
      expect(ALLOWLIST.length).toBeGreaterThan(0)
    })
    return
  }
  it.each(cases)('$label', async (testCase) => {
    if (!testCase.fixture) expect.fail(testCase.missingHint)
    const run = await runCheckOnFixture(testCase.check, testCase.fixture)
    if (testCase.variant === 'clean') {
      expect(run.findings, `clean fixture for '${testCase.slug}' must produce 0 findings`).toHaveLength(0)
    } else {
      expect(
        run.findings.length,
        `violation fixture for '${testCase.slug}' must produce >=1 finding`,
      ).toBeGreaterThanOrEqual(1)
    }
  })
})
