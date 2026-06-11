/**
 * Unit tests for the pure `analyzeReleaseGateParity` detector behind the
 * `release-gate-parity` check (ADR-0017). The detector is a
 * `(content, filePath) => violations[]` function exercised with no framework,
 * no mocks — modelled on `restrict-raw-db-access.test.ts`.
 *
 * It also reads the REAL `.github/workflows/release.yml` to prove the live
 * workflow currently satisfies ADR-0017 (0 violations).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeReleaseGateParity } from '../release-gate-parity.js';

const RELEASE_PATH = '.github/workflows/release.yml';

/** A well-formed release.yml: all four gates present, all BEFORE the pack step. */
const GOOD_RELEASE = `name: Release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm -r run clean
      - run: pnpm build
      - run: pnpm typecheck
      - name: Lint (mirror ci.yml — ADR-0017)
        run: pnpm lint
      - name: Test with coverage thresholds
        run: pnpm test:coverage
      - name: Fit (dogfood)
        run: pnpm fit:ci
      - name: Graph (dogfood)
        run: pnpm graph:ci
      - name: Pack all workspace packages
        run: |
          pnpm --filter "$filter" pack --pack-destination /tmp/tarballs
      - name: Publish via npm
        run: npm publish /tmp/tarballs/*.tgz --provenance
`;

describe('analyzeReleaseGateParity', () => {
  it('returns 0 violations for a well-formed release.yml (all four gates before pack)', () => {
    expect(analyzeReleaseGateParity(GOOD_RELEASE, RELEASE_PATH)).toEqual([]);
  });

  it('flags a missing gate (pnpm test:coverage absent)', () => {
    const missing = GOOD_RELEASE.replace(
      `      - name: Test with coverage thresholds\n        run: pnpm test:coverage\n`,
      '',
    );
    const violations = analyzeReleaseGateParity(missing, RELEASE_PATH);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('pnpm test:coverage');
    expect(violations[0]?.message).toContain('missing');
  });

  it('flags every required gate when none are present', () => {
    const noGates = `name: Release
jobs:
  publish:
    steps:
      - run: pnpm build
      - name: Pack
        run: pnpm --filter "$f" pack --pack-destination /tmp/t
`;
    const violations = analyzeReleaseGateParity(noGates, RELEASE_PATH);
    expect(violations).toHaveLength(4);
    expect(violations.every((v) => v.severity === 'error')).toBe(true);
  });

  it('flags a gate that runs AFTER the pack step (ordering violation)', () => {
    // graph:ci moved below the pack step.
    const afterPack = `name: Release
jobs:
  publish:
    steps:
      - run: pnpm build
      - run: pnpm lint
      - run: pnpm test:coverage
      - run: pnpm fit:ci
      - name: Pack
        run: pnpm --filter "$f" pack --pack-destination /tmp/t
      - name: Graph (too late!)
        run: pnpm graph:ci
`;
    const violations = analyzeReleaseGateParity(afterPack, RELEASE_PATH);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('pnpm graph:ci');
    expect(violations[0]?.message).toContain('at or after the pack step');
    expect(violations[0]?.severity).toBe('error');
  });

  it('does NOT act on a non-release file path (scope guard)', () => {
    // Same offending content, but not release.yml → ignored entirely.
    const ciYml = '.github/workflows/ci.yml';
    expect(
      analyzeReleaseGateParity('jobs:\n  build:\n    steps:\n      - run: echo hi\n', ciYml),
    ).toEqual([]);
    // Even a Windows-style path to a non-release workflow is ignored.
    expect(analyzeReleaseGateParity('no gates here', String.raw`src\release.yml`)).toEqual([]);
  });

  it('matches a Windows-style path to the real release workflow', () => {
    // The scope guard normalises backslashes, so a CRLF/Windows checkout path
    // still resolves to the release workflow and the gates are enforced.
    const winPath = String.raw`repo\.github\workflows\release.yml`;
    expect(analyzeReleaseGateParity(GOOD_RELEASE, winPath)).toEqual([]);
  });

  it('passes clean against the REAL .github/workflows/release.yml (ADR-0017 satisfied)', () => {
    // __tests__ dir → up to repo root: ../../../../../../../ from
    // packages/fitness/checks-universal/src/checks/architecture/__tests__/
    const repoRoot = fileURLToPath(new URL('../../../../../../../', import.meta.url));
    const realContent = readFileSync(`${repoRoot}.github/workflows/release.yml`, 'utf8');
    expect(analyzeReleaseGateParity(realContent, RELEASE_PATH)).toEqual([]);
  });
});
