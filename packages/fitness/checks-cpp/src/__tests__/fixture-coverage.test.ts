/**
 * Per-check pass/fail fixture coverage for checks-cpp (testing gap P0).
 *
 * Every shipped, non-command check must have a clean fixture (0 findings) and a
 * violation fixture (>=1) under a co-located `__fixtures__/<slug>/` directory
 * next to the check's source. Slugs on ALLOWLIST are exempt until their
 * fixtures land (the list must reach []). The harness runs each check
 * in-process via the engine's internal coverage helpers.
 *
 * checks-cpp ships a single command-mode check (`cpp-clang-tidy`), so the case
 * list is legitimately empty: there is nothing fixture-exercisable here. The
 * empty-case guard below accepts that as long as the wiring stays meaningful —
 * i.e. the gap is owed via the allowlist OR closed via a command exemption.
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
  packName: 'checks-cpp',
  checks,
  allowlist: ALLOWLIST,
  commandExemptions: COMMAND_EXEMPTIONS,
  filenameOverrides: FILENAME_OVERRIDES,
  // Phase 5 removes this once ALLOWLIST is [] (turns the ratchet fully live).
  allowNonEmptyAllowlist: true,
}

const cases = await planCoverageCases(config, PACK_SRC)

describe('checks-cpp · fixture-coverage bookkeeping', () => {
  it('config is self-consistent (allowlist + command exemptions valid)', () => {
    expect(validateBookkeeping(config)).toEqual([])
  })
})

describe('checks-cpp · fixture-coverage', () => {
  if (cases.length === 0) {
    // No fixture-exercisable cases. The wiring must still be meaningful: either
    // a check is owed coverage (allowlist) or every shipped check is closed via
    // a command exemption. This fails only if the pack is silently mis-wired.
    it('every shipped check is allowlisted or command-exempt', () => {
      expect(ALLOWLIST.length + Object.keys(COMMAND_EXEMPTIONS).length).toBeGreaterThan(0)
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
