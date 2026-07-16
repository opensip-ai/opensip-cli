/**
 * @fileoverview Phase 6 residual coverage — the native host-fact collector.
 *
 * `host-profile.mjs` is a dependency-free native collector with no injectable
 * seams (by design — it probes the real host). These tests run the real
 * collector on THIS host for the available paths and assert the SHAPE, the
 * closed capability vocabulary, tagged-`unavailable` facts, that the collected
 * profile is contract-conformant (it round-trips through a sealed evidence
 * artifact), and — most importantly — that NO secret-bearing environment
 * variable, username, home path, or registry credential can enter the model,
 * even when the ambient environment is poisoned.
 *
 * Runs under `node --test` (`pnpm test:scripts`). No CLI or network.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  computeSummary,
  computeVerdict,
  evidenceDigest,
  parseAcceptanceEvidence,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from '../platform-acceptance/contract.mjs';
import { collectHostProfile } from '../platform-acceptance/host-profile.mjs';

const KNOWN_CAPABILITIES = [
  'pty',
  'symlink',
  'permissions',
  'process-tree-rss',
  'process-tree-cleanup',
];

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pa-host-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A fact is either a non-empty string or the closed tagged-unavailable shape. */
function assertFact(fact, label) {
  if (typeof fact === 'string') {
    assert.ok(fact.length > 0, `${label} must be non-empty when a string`);
    return;
  }
  assert.equal(fact.status, 'unavailable', `${label} tagged fact must be unavailable`);
  assert.match(
    fact.reasonCode,
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    `${label} reasonCode kebab-case`,
  );
}

test('collects the allowlisted host shape with a closed capability vocabulary', () => {
  withRoot((root) => {
    const host = collectHostProfile(root);
    assert.equal(host.platform, process.platform);
    assert.equal(host.arch, process.arch);
    assert.equal(host.nodeVersion, process.version);
    assert.equal(host.nodeModuleAbi, String(process.versions.modules));
    assert.equal(typeof host.cpuCount, 'number');
    assert.ok(host.cpuCount >= 1);
    assert.equal(typeof host.totalMemoryBytes, 'number');
    assert.ok(host.totalMemoryBytes >= 0);

    assertFact(host.osRelease, 'osRelease');
    assertFact(host.osVersion, 'osVersion');
    assertFact(host.npmVersion, 'npmVersion');
    assertFact(host.packageManager, 'packageManager');
    assertFact(host.cpuModel, 'cpuModel');
    assertFact(host.shell, 'shell');
    // macOS-independent tuple sources: darwin-only probes (tagged `unavailable`
    // on any other host), always present as a tagged HostFact.
    assertFact(host.swVers, 'swVers');
    assertFact(host.kernelRelease, 'kernelRelease');
    assertFact(host.unameArch, 'unameArch');
    assertFact(host.filesystem.type, 'filesystem.type');
    if (typeof host.filesystem.caseSensitive !== 'boolean') {
      assertFact(host.filesystem.caseSensitive, 'filesystem.caseSensitive');
    }

    // Capabilities are the closed vocabulary, each a boolean.
    assert.deepEqual(Object.keys(host.capabilities).sort(), [...KNOWN_CAPABILITIES].sort());
    for (const [id, value] of Object.entries(host.capabilities)) {
      assert.equal(typeof value, 'boolean', `capability ${id} must be a boolean`);
    }
    assert.equal(
      host.capabilities['process-tree-cleanup'],
      process.platform !== 'win32' && host.capabilities['process-tree-rss'],
      'cleanup qualification requires POSIX process groups plus the fixed native process table',
    );
  });
});

test('additional required capabilities are probed alongside the default set', () => {
  withRoot((root) => {
    const host = collectHostProfile(root, ['symlink', 'pty']);
    // Requiring a known capability does not add an unknown key nor drop the defaults.
    assert.deepEqual(Object.keys(host.capabilities).sort(), [...KNOWN_CAPABILITIES].sort());
  });
});

test('rejects an empty or non-string run root', () => {
  assert.throws(() => collectHostProfile(''), /run-owned root/);
  assert.throws(() => collectHostProfile(42), /run-owned root/);
});

test('the collected profile round-trips as contract-conformant host evidence', () => {
  withRoot((root) => {
    const host = collectHostProfile(root);
    const profile = parseAcceptanceProfile({
      schemaVersion: 1,
      id: 'host-probe',
      version: 1,
      requiredCapabilities: [],
      rssRequired: false,
      bounds: {
        journeyTimeoutMs: 1000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxDiagnosticTailBytes: 1024,
        rssSampleIntervalMs: 100,
        maxEvidenceBytes: 1_000_000,
        maxJourneyResults: 8,
      },
      journeys: [{ id: 'a.one', required: true }],
    });
    const results = [
      {
        id: 'a.one',
        category: 'a',
        required: true,
        status: 'pass',
        reasonCode: null,
        durationMs: 1,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
        diagnostics: [],
      },
    ];
    const cleanup = {
      status: 'clean',
      reasonCode: null,
      removedRoots: 1,
      residualDescendants: 0,
    };
    const body = {
      schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
      profile: {
        id: profile.id,
        version: profile.version,
        digest: profileDigest(profile),
      },
      candidate: {
        kind: 'packed-release',
        version: '0.7.0',
        source: 'packed-release@0.7.0',
        digest: 'a'.repeat(64),
        manifestDigest: 'b'.repeat(64),
      },
      previousCandidate: null,
      execution: {
        runId: 'host-test',
        runAttempt: 1,
        runnerLabel: 'test-runner',
      },
      lifecycle: {
        installedVersion: '0.7.0',
        upgradedVersion: '0.7.0',
        versionMigrated: false,
        stateMigrated: true,
        cliStateRemoved: true,
        packageRemoved: true,
      },
      harnessGitSha: 'abc1234',
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:05:00.000Z',
      host,
      results,
      cleanup,
      summary: computeSummary(profile, results),
      verdict: computeVerdict(profile, results, cleanup),
    };
    const sealed = {
      ...body,
      completion: { state: 'completed', evidenceDigest: evidenceDigest(body) },
    };
    // parseAcceptanceEvidence internally runs parseHostProfile; a non-conformant
    // host shape would throw here.
    assert.doesNotThrow(() => parseAcceptanceEvidence(sealed));
  });
});

test('never leaks secrets, usernames, home paths, or registry credentials — even with a poisoned env', () => {
  const secretCanaries = {
    NPM_TOKEN: 'npm-canary-not-a-real-secret',
    NODE_AUTH_TOKEN: 'auth-canary-not-a-real-secret',
    OPENSIP_API_KEY: 'apikey-canary-not-a-real-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-canary-not-a-real-secret',
    npm_config_registry: 'https://user:pass-canary@registry.internal.example/',
    '//registry.internal.example/:_authToken': 'authtoken-canary-not-a-real-secret',
  };
  const previous = {};
  for (const [key, value] of Object.entries(secretCanaries)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  // Poison the user-agent + shell so any accidental serialization would surface.
  previous.npm_config_user_agent = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = 'pnpm/9.9.9 npm/? node/v24 secret-canary-not-a-real';

  try {
    withRoot((root) => {
      const host = collectHostProfile(root);
      const serialized = JSON.stringify(host);
      for (const value of Object.values(secretCanaries)) {
        assert.ok(!serialized.includes(value), `host profile leaked secret ${value}`);
      }
      assert.ok(
        !serialized.includes('secret-canary-not-a-real'),
        'leaked poisoned user-agent tail',
      );
      // Usernames + absolute home paths must never appear.
      const home = homedir();
      if (home.length > 0)
        assert.ok(!serialized.includes(home), 'host profile leaked the home path');
      const username = userInfo().username;
      if (
        typeof username === 'string' &&
        username.length >= 3 &&
        !/^(root|node|ci)$/i.test(username)
      ) {
        assert.ok(!serialized.includes(username), 'host profile leaked the username');
      }
      // packageManager derives only the leading agent token (e.g. "pnpm").
      if (typeof host.packageManager === 'string') {
        assert.match(host.packageManager, /^[a-z][a-z0-9-]*$/i);
      }
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
