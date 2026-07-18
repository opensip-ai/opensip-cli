/**
 * @fileoverview Schema-v2 profile chain freezes + legacy v1 execution refusal.
 *
 * Proves immutable v1 digests stay stable, v2 digests bind requiredPorts and
 * the cache→Init journey, and the runner refuses production common-v1 /
 * macos-v1 profiles for new execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  composeProfile,
  parseAcceptanceProfile,
  profileDigest,
} from '../platform-acceptance/contract.mjs';
import { COMMON_V1_JOURNEY_IDS, COMMON_V2_JOURNEY_IDS } from '../platform-acceptance/journey-catalog.mjs';
import { runPlatformAcceptance, RUN_OUTCOMES } from '../platform-acceptance/runner.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROFILE_ROOT = join(REPO_ROOT, '.config', 'platform-acceptance');
const FREEZE = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'scripts/__tests__/fixtures/platform-acceptance/profile-digests.json'),
    'utf8',
  ),
);

function load(name) {
  return JSON.parse(readFileSync(join(PROFILE_ROOT, `${name}.json`), 'utf8'));
}

test('frozen common-v1 digest and journey count remain immutable', () => {
  const profile = parseAcceptanceProfile(load('common-v1'));
  const expected = FREEZE.profiles['common-v1'];
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.journeys.length, expected.journeyCount);
  assert.equal(profileDigest(profile), expected.digest);
  assert.deepEqual(
    profile.journeys.map((j) => j.id),
    [...COMMON_V1_JOURNEY_IDS],
  );
});

test('frozen macOS v1 composed digest remains immutable and binds common-v1', () => {
  const base = parseAcceptanceProfile(load('common-v1'));
  const composed = composeProfile(base, load('macos-26-arm64-node24-npm11-v1'));
  const expected = FREEZE.profiles['macos-26-arm64-node24-npm11-v1'];
  assert.equal(composed.schemaVersion, 1);
  assert.equal(composed.journeys.length, expected.journeyCount);
  assert.equal(profileDigest(base), expected.baseDigest);
  assert.equal(profileDigest(composed), expected.digest);
  assert.equal(composed.base?.digest, expected.baseDigest);
});

test('common-v2 freezes requiredPorts and cache-init promotion once', () => {
  const profile = parseAcceptanceProfile(load('common-v2'));
  const expected = FREEZE.profiles['common-v2'];
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.version, 2);
  assert.equal(profile.journeys.length, expected.journeyCount);
  assert.equal(profileDigest(profile), expected.digest);
  assert.equal(expected.hasCacheInitPromotion, true);
  assert.deepEqual(
    profile.journeys.map((j) => j.id),
    [...COMMON_V2_JOURNEY_IDS],
  );
  for (const journey of profile.journeys) {
    assert.ok(Array.isArray(journey.requiredPorts), `${journey.id} missing requiredPorts`);
  }
  const continuity = profile.journeys.find((j) => j.id === 'persistence.cache-init-promotion');
  assert.deepEqual(continuity?.requiredPorts, ['mcp']);
  const mcp = profile.journeys.find((j) => j.id === 'mcp.initialize');
  assert.deepEqual(mcp?.requiredPorts, ['mcp']);
});

test('macOS v2 composes over common-v2 digest and preserves continuity ports', () => {
  const base = parseAcceptanceProfile(load('common-v2'));
  const composed = composeProfile(base, load('macos-26-arm64-node24-npm11-v2'));
  const expected = FREEZE.profiles['macos-26-arm64-node24-npm11-v2'];
  assert.equal(composed.schemaVersion, 2);
  assert.equal(composed.journeys.length, expected.journeyCount);
  assert.equal(profileDigest(base), expected.baseDigest);
  assert.equal(profileDigest(composed), expected.digest);
  const continuity = composed.journeys.find((j) => j.id === 'persistence.cache-init-promotion');
  assert.deepEqual(continuity?.requiredPorts, ['mcp']);
});

test('cross-schema composition is rejected', () => {
  const baseV1 = parseAcceptanceProfile(load('common-v1'));
  assert.throws(
    () => composeProfile(baseV1, load('macos-26-arm64-node24-npm11-v2')),
    /cross-schema|base-id|schema/,
  );
});

test('runner refuses production common-v1 for new execution', async () => {
  const commonV1 = load('common-v1');
  const result = await runPlatformAcceptance(
    {
      profilePath: join(PROFILE_ROOT, 'common-v1.json'),
      repoRoot: REPO_ROOT,
      packedReleaseDir: join(REPO_ROOT, 'does-not-need-to-exist'),
      expectedVersion: '0.0.0',
    },
    {
      clock: { now: () => 0, wallIso: () => '2026-01-01T00:00:00.000Z' },
      readProfile: () => structuredClone(commonV1),
      resolveCandidateSource: () => {
        throw new Error('candidate resolution must not run for a refused legacy profile');
      },
    },
  );
  assert.equal(result.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(result.reasonCode, 'legacy-profile-not-executable');
});
