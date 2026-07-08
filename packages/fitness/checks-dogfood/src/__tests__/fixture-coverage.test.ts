/**
 * Per-check pass/fail fixture coverage for checks-dogfood.
 *
 * Every dogfood check must have a clean fixture (0 findings) and a violation
 * fixture (>=1) under a co-located `__fixtures__/<slug>/` directory next to the
 * check's source. The ALLOWLIST is empty, so the ratchet is live: a new uncovered
 * check fails this test. The harness runs each check in-process via the engine's
 * internal coverage helpers.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planCoverageCases,
  runCheckOnFixture,
  validateBookkeeping,
  type CoverageConfig,
} from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { checks } from '../index.js';

import {
  ALLOWLIST,
  COMMAND_EXEMPTIONS,
  FILENAME_OVERRIDES,
  KNOWN_UNFIXTURABLE,
} from './fixture-coverage.allowlist.js';

const PACK_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const config: CoverageConfig = {
  packName: 'checks-dogfood',
  checks,
  allowlist: ALLOWLIST,
  commandExemptions: COMMAND_EXEMPTIONS,
  knownUnfixturable: KNOWN_UNFIXTURABLE,
  filenameOverrides: FILENAME_OVERRIDES,
};

const cases = await planCoverageCases(config, PACK_SRC);

describe('checks-dogfood · fixture-coverage bookkeeping', () => {
  it('config is self-consistent (allowlist empty, exemptions valid)', () => {
    expect(validateBookkeeping(config)).toEqual([]);
  });
});

describe('checks-dogfood · fixture-coverage', () => {
  if (cases.length === 0) {
    it('every shipped check is exempted or allowlisted', () => {
      const accounted =
        ALLOWLIST.length +
        Object.keys(COMMAND_EXEMPTIONS).length +
        Object.keys(KNOWN_UNFIXTURABLE).length;
      expect(accounted).toBeGreaterThan(0);
    });
    return;
  }
  it.each(cases)('$label', async (testCase) => {
    if (!testCase.fixture) expect.fail(testCase.missingHint);
    const run = await runCheckOnFixture(testCase.check, testCase.fixture);
    if (testCase.variant === 'clean') {
      expect(
        run.findings,
        `clean fixture for '${testCase.slug}' must produce 0 findings`,
      ).toHaveLength(0);
    } else {
      expect(
        run.findings.length,
        `violation fixture for '${testCase.slug}' must produce >=1 finding`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
