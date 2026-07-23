/**
 * @fileoverview Phase 2 catalog guardrails — registry identity, profile safety,
 * and packed-smoke ⇄ catalog parity. Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPackedSmokeScenarios } from '../smoke-pack-scenarios.mjs';
import {
  COMMON_V1_JOURNEY_IDS,
  COMMON_V2_JOURNEY_IDS,
  JOURNEY_REGISTRY,
  LINUX_JOURNEY_IDS,
  MACOS_JOURNEY_IDS,
  RELEASE_SMOKE_JOURNEY_IDS,
  getJourney,
  projectReleaseSmokeScenarios,
  resolveProfileJourneys,
} from '../platform-acceptance/journey-catalog.mjs';
import { KNOWN_CAPABILITIES } from '../platform-acceptance/journey-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMON_V1_PATH = join(HERE, '..', '..', '.config', 'platform-acceptance', 'common-v1.json');
const COMMON_V2_PATH = join(HERE, '..', '..', '.config', 'platform-acceptance', 'common-v2.json');
const MACOS_V1_PATH = join(
  HERE,
  '..',
  '..',
  '.config',
  'platform-acceptance',
  'macos-26-arm64-node24-npm11-v1.json',
);
const MACOS_V2_PATH = join(
  HERE,
  '..',
  '..',
  '.config',
  'platform-acceptance',
  'macos-26-arm64-node24-npm11-v2.json',
);
const commonV1 = JSON.parse(readFileSync(COMMON_V1_PATH, 'utf8'));
const commonV2 = JSON.parse(readFileSync(COMMON_V2_PATH, 'utf8'));
const macosV1 = JSON.parse(readFileSync(MACOS_V1_PATH, 'utf8'));
const macosV2 = JSON.parse(readFileSync(MACOS_V2_PATH, 'utf8'));

// Placeholder absolute paths only — this test projects scenarios (no filesystem
// writes), so the exact location is irrelevant and never touched.
const SMOKE_PARAMS = Object.freeze({
  expectedVersion: '9.9.9',
  consumerCwd: '/acceptance-run/consumer',
  toolPluginTarball: '/acceptance-run/tool.tgz',
  fitPackTarball: '/acceptance-run/fit.tgz',
});

test('registry holds exactly COMMON_V2 ∪ MACOS ∪ LINUX ids, once each', () => {
  // The registry is the closed union of common-v2 (every v1 id + cache→Init) and
  // the macOS + Linux additive journeys. Immutable COMMON_V1 remains a strict subset.
  assert.equal(COMMON_V1_JOURNEY_IDS.length, 46);
  assert.equal(COMMON_V2_JOURNEY_IDS.length, 47);
  assert.equal(new Set(COMMON_V1_JOURNEY_IDS).size, 46, 'COMMON_V1_JOURNEY_IDS has a duplicate');
  assert.equal(new Set(COMMON_V2_JOURNEY_IDS).size, 47, 'COMMON_V2_JOURNEY_IDS has a duplicate');
  assert.equal(
    new Set(MACOS_JOURNEY_IDS).size,
    MACOS_JOURNEY_IDS.length,
    'MACOS_JOURNEY_IDS has a duplicate',
  );
  assert.equal(
    new Set(LINUX_JOURNEY_IDS).size,
    LINUX_JOURNEY_IDS.length,
    'LINUX_JOURNEY_IDS has a duplicate',
  );
  for (const id of COMMON_V1_JOURNEY_IDS) {
    assert.ok(COMMON_V2_JOURNEY_IDS.includes(id), `common-v2 drops ${id}`);
  }
  assert.ok(COMMON_V2_JOURNEY_IDS.includes('persistence.cache-init-promotion'));
  const union = new Set([...COMMON_V2_JOURNEY_IDS, ...MACOS_JOURNEY_IDS, ...LINUX_JOURNEY_IDS]);
  assert.equal(
    union.size,
    COMMON_V2_JOURNEY_IDS.length + MACOS_JOURNEY_IDS.length + LINUX_JOURNEY_IDS.length,
    'COMMON_V2 / MACOS / LINUX journey id sets overlap',
  );
  assert.equal(JOURNEY_REGISTRY.size, union.size);
  for (const id of union) {
    assert.ok(JOURNEY_REGISTRY.has(id), `missing registered journey ${id}`);
  }
  for (const id of JOURNEY_REGISTRY.keys()) {
    assert.ok(union.has(id), `registry holds unselected journey ${id}`);
  }
  const cacheInit = JOURNEY_REGISTRY.get('persistence.cache-init-promotion');
  assert.deepEqual(cacheInit?.requiredPorts, ['mcp']);
  assert.deepEqual(JOURNEY_REGISTRY.get('mcp.initialize')?.requiredPorts, ['mcp']);
  assert.deepEqual(JOURNEY_REGISTRY.get('analysis.fit')?.requiredPorts, []);
});

test('the committed common-v1.json selects exactly the catalog ids in order', () => {
  const profileIds = commonV1.journeys.map((entry) => entry.id);
  assert.deepEqual(
    profileIds,
    [...COMMON_V1_JOURNEY_IDS],
    'common-v1.json drifted from the catalog selection',
  );
});

test('the committed common-v2.json selects exactly the catalog ids with requiredPorts', () => {
  assert.equal(commonV2.schemaVersion, 2);
  assert.equal(commonV2.version, 2);
  const profileIds = commonV2.journeys.map((entry) => entry.id);
  assert.deepEqual(
    profileIds,
    [...COMMON_V2_JOURNEY_IDS],
    'common-v2.json drifted from the catalog selection',
  );
  for (const journey of commonV2.journeys) {
    assert.ok(Array.isArray(journey.requiredPorts), `${journey.id} missing requiredPorts`);
  }
  const continuity = commonV2.journeys.find((j) => j.id === 'persistence.cache-init-promotion');
  assert.deepEqual(continuity?.requiredPorts, ['mcp']);
  assert.equal(macosV2.schemaVersion, 2);
  assert.equal(macosV2.base?.id, 'common-v2');
});

test('lifecycle order qualifies the installed target before uninstalling state or package', () => {
  for (const profile of [commonV1, macosV1]) {
    const ids = profile.journeys.map((entry) => entry.id);
    const install = ids.indexOf('lifecycle.install');
    const upgrade = ids.indexOf('lifecycle.upgrade');
    const stateRemove = ids.indexOf('lifecycle.cli-state-uninstall');
    const packageRemove = ids.indexOf('lifecycle.package-uninstall');

    assert.equal(install, 0, `${profile.id}: install must be first`);
    assert.equal(upgrade, 1, `${profile.id}: upgrade must immediately follow install`);
    assert.ok(stateRemove > upgrade, `${profile.id}: state removal ran before upgrade`);
    assert.ok(
      packageRemove > stateRemove,
      `${profile.id}: package removal ran before state removal`,
    );
    assert.equal(
      packageRemove,
      ids.length - 1,
      `${profile.id}: package removal must be the terminal selected journey`,
    );
  }

  const macIds = macosV1.journeys.map((entry) => entry.id);
  const firstRemoval = macIds.indexOf('lifecycle.cli-state-uninstall');
  for (const id of MACOS_JOURNEY_IDS) {
    assert.ok(
      macIds.indexOf(id) > macIds.indexOf('lifecycle.upgrade') && macIds.indexOf(id) < firstRemoval,
      `${id} must run against the target candidate before lifecycle removal`,
    );
  }
});

test('every profile-declared capability is in the known vocabulary and matches the row', () => {
  for (const entry of commonV1.journeys) {
    const journey = getJourney(entry.id);
    for (const capability of entry.capabilities ?? []) {
      assert.ok(
        KNOWN_CAPABILITIES.has(capability),
        `common-v1 declares unknown capability ${capability}`,
      );
      assert.ok(
        journey.capabilities.includes(capability),
        `journey ${entry.id} row omits declared capability ${capability}`,
      );
    }
  }
});

test('a profile can never reference an unregistered journey', () => {
  assert.throws(
    () => resolveProfileJourneys(['analysis.fit', 'not.a.real-journey']),
    /no registered journey/,
  );
});

test('every registered journey is frozen with a valid executor and capabilities', () => {
  for (const journey of JOURNEY_REGISTRY.values()) {
    assert.ok(Object.isFrozen(journey), `journey ${journey.id} is not frozen`);
    assert.equal(typeof journey.executor, 'function', `journey ${journey.id} has no executor`);
    assert.ok(
      journey.id.startsWith(`${journey.category}.`),
      `journey ${journey.id} is not namespaced`,
    );
    for (const capability of journey.capabilities) {
      assert.ok(
        KNOWN_CAPABILITIES.has(capability),
        `journey ${journey.id} declares unknown capability ${capability}`,
      );
    }
  }
});

test('release-smoke journeys are all registered, command-only, and ordered', () => {
  assert.ok(RELEASE_SMOKE_JOURNEY_IDS.length > 0);
  for (const id of RELEASE_SMOKE_JOURNEY_IDS) {
    const journey = getJourney(id);
    assert.equal(
      typeof journey.commandSteps,
      'function',
      `release-smoke journey ${id} has no commandSteps`,
    );
  }
});

test('projected release-smoke scenarios all map to a release-smoke journey with a stable unique id', () => {
  const scenarios = projectReleaseSmokeScenarios({
    ...SMOKE_PARAMS,
    cwd: SMOKE_PARAMS.consumerCwd,
  });
  assert.ok(scenarios.length > 0);
  const ids = new Set();
  for (const scenario of scenarios) {
    assert.equal(typeof scenario.id, 'string');
    assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    const journeyId = scenario.id.split('#')[0];
    assert.ok(
      RELEASE_SMOKE_JOURNEY_IDS.includes(journeyId),
      `scenario ${scenario.id} escapes the release-smoke selection`,
    );
    assert.equal(scenario.cwd, SMOKE_PARAMS.consumerCwd);
    assert.ok(typeof scenario.expect === 'object' && scenario.expect !== null);
  }
});

test('buildPackedSmokeScenarios stays ordered, parity-checked, and version-first', () => {
  const scenarios = buildPackedSmokeScenarios(SMOKE_PARAMS);
  // Same count + order as the raw projection (parity ran inside build without throwing).
  const projected = projectReleaseSmokeScenarios({
    ...SMOKE_PARAMS,
    cwd: SMOKE_PARAMS.consumerCwd,
  });
  assert.equal(scenarios.length, projected.length);
  assert.deepEqual(
    scenarios.map((s) => s.id),
    projected.map((s) => s.id),
  );
  // smoke-pack.mjs finds the strict version check by a name starting with '--version'.
  assert.ok(
    scenarios[0].name.startsWith('--version'),
    'the first scenario must be the --version check',
  );
  // Every scenario carries the deny-by-default installed-tool allowlist.
  for (const scenario of scenarios) {
    assert.equal(scenario.env.OPENSIP_CLI_ALLOW_INSTALLED_TOOLS, 'audit-demo-tool');
  }
});

test('profile data cannot inject argv — argv lives only in journey command steps', () => {
  // A selection is ids only; the projected argv comes from the journey code.
  for (const scenario of projectReleaseSmokeScenarios({
    ...SMOKE_PARAMS,
    cwd: SMOKE_PARAMS.consumerCwd,
  })) {
    assert.ok(Array.isArray(scenario.args));
    for (const arg of scenario.args) assert.equal(typeof arg, 'string');
  }
});
