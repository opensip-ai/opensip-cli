import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { normalizeMatrixConfig, runCompatibilityMatrix } from '../compatibility-matrix.mjs';

test('normalizeMatrixConfig validates the top-level version', () => {
  assert.throws(
    () => normalizeMatrixConfig({ version: 2, contracts: [], fixtures: [] }),
    /version must be 1/,
  );
});

test('runCompatibilityMatrix passes with matching policies, constants, and fixtures', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-compat-matrix-'));
  const files = fixtureFiles(repoRoot, { signalEnvelopeVersion: 2 });
  let reportText = '';
  const result = await runCompatibilityMatrix(['--check', '--out', 'report.json'], {
    repoRoot,
    runtime: fakeRuntime(),
    loadMatrixConfig: async () => matrixConfig(),
    readFile: async (path) => {
      const value = files.get(String(path));
      if (value === undefined) throw new Error(`missing fixture ${String(path)}`);
      return value;
    },
    writeFile: async (_path, content) => {
      reportText = content;
    },
    consoleLog: () => null,
  });

  assert.equal(result.exitCode, 0);
  const report = JSON.parse(reportText);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.counts.fail, 0);
  await rm(repoRoot, { recursive: true, force: true });
});

test('runCompatibilityMatrix fails when a fixture drifts from the contract version', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'opensip-compat-matrix-'));
  const files = fixtureFiles(repoRoot, { signalEnvelopeVersion: 99 });
  let reportText = '';
  const result = await runCompatibilityMatrix(['--out', 'report.json'], {
    repoRoot,
    runtime: fakeRuntime(),
    loadMatrixConfig: async () => matrixConfig(),
    readFile: async (path) => files.get(String(path)) ?? '',
    writeFile: async (_path, content) => {
      reportText = content;
    },
    consoleLog: () => null,
  });

  assert.equal(result.exitCode, 1);
  const report = JSON.parse(reportText);
  assert.equal(report.verdict, 'fail');
  assert.match(
    report.checks.find((check) => check.id.includes('signal-envelope')).details.message,
    /schemaVersion mismatch/,
  );
  await rm(repoRoot, { recursive: true, force: true });
});

function matrixConfig() {
  return {
    version: 1,
    contracts: [
      { class: 'cli-command-surface' },
      { class: 'project-config' },
      { class: 'public-json' },
      { class: 'tool-plugin-api' },
      { class: 'cloud-wire' },
      { class: 'release-artifact' },
      { class: 'datastore-payload' },
    ],
    fixtures: [
      {
        contract: 'public-json',
        kind: 'signal-envelope',
        path: 'fixtures/signal-envelope.json',
      },
      {
        contract: 'public-json',
        kind: 'command-outcome',
        path: 'fixtures/command-outcome.json',
      },
      {
        contract: 'cloud-wire',
        kind: 'signal-batch',
        path: 'fixtures/signal-batch.json',
      },
      {
        contract: 'project-config',
        kind: 'config-migration',
        path: 'fixtures/legacy.yml',
        expectChanged: true,
      },
    ],
  };
}

function fakeRuntime() {
  const policies = new Map(
    [
      ['cli-command-surface', 1],
      ['project-config', 1],
      ['public-json', 2],
      ['tool-plugin-api', 3],
      ['cloud-wire', 1],
      ['release-artifact', 1],
      ['datastore-payload', 1],
    ].map(([className, version]) => [className, { class: className, version }]),
  );
  return {
    core: {
      CLI_COMMAND_SURFACE_CONTRACT_VERSION: 1,
      CLI_SUPPORTED_SCHEMA_VERSION: 1,
      PUBLIC_JSON_CONTRACT_VERSION: 2,
      PLUGIN_API_VERSION: 3,
      CLOUD_WIRE_CONTRACT_VERSION: 1,
      RELEASE_ARTIFACT_CONTRACT_VERSION: 1,
      DATASTORE_PAYLOAD_CONTRACT_VERSION: 1,
      SIGNAL_BATCH_SCHEMA_VERSION: 1,
      COMPATIBILITY_CONTRACT_CLASSES: [...policies.keys()],
      assertCompatibilityPoliciesComplete: () => policies.size,
      findCompatibilityPolicy: (className) => policies.get(className),
    },
    contracts: {
      SIGNAL_ENVELOPE_SCHEMA_VERSION: 2,
      COMMAND_OUTCOME_CONTRACT_VERSION: 1,
    },
    config: {
      migrateConfigText: ({ text }) => ({
        changed: !text.includes('schemaVersion: 1'),
        migratedText: text.includes('schemaVersion: 1') ? text : `schemaVersion: 1\n${text}`,
        targetVersion: 1,
      }),
    },
  };
}

function fixtureFiles(repoRoot, { signalEnvelopeVersion }) {
  return new Map([
    [
      resolve(repoRoot, 'fixtures/signal-envelope.json'),
      JSON.stringify({
        schemaVersion: signalEnvelopeVersion,
        tool: 'fit',
        runId: 'RUN_fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: {},
        units: [],
        signals: [],
        baselineIdentity: {},
      }),
    ],
    [
      resolve(repoRoot, 'fixtures/command-outcome.json'),
      JSON.stringify({ kind: 'config.validate', status: 'ok', exitCode: 0, data: {} }),
    ],
    [
      resolve(repoRoot, 'fixtures/signal-batch.json'),
      JSON.stringify({
        schemaVersion: 1,
        tool: 'fit',
        repo: {},
        runId: 'RUN_fixture',
        createdAt: '2026-01-01T00:00:00.000Z',
        counts: {},
        signals: [],
      }),
    ],
    [resolve(repoRoot, 'fixtures/legacy.yml'), 'targets: {}\n'],
  ]);
}
