/**
 * @fileoverview False-green guardrails for published registry inventory →
 * installed npm bytes binding. All npm behavior is injected; no network runs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';
import { expectedTarballName } from '../lib/release-artifacts.mjs';
import {
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
} from '../lib/registry-integrity-inventory.mjs';
import {
  REGISTRY_BINDING_REASON_CODES as R,
  resolveRegistryInventoryBinding,
  verifyInstalledRegistryBinding,
} from '../platform-acceptance/registry-install-binding.mjs';

const VERSION = '9.8.7';
const MANIFEST_DIGEST = 'a'.repeat(64);
const REGISTRY = 'https://registry.npmjs.org/';
const roots = [];

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function bytesFor(name) {
  return Buffer.from(`immutable registry tarball for ${name}@${VERSION}\n`, 'utf8');
}

function fixtureInventory() {
  return {
    schemaVersion: 1,
    registry: REGISTRY,
    releaseVersion: VERSION,
    manifestDigest: MANIFEST_DIGEST,
    packages: RELEASE_PACKAGE_ORDER.map((entry) => {
      const bytes = bytesFor(entry.name);
      const tarball = expectedTarballName(entry, VERSION);
      return {
        name: entry.name,
        version: VERSION,
        tarball,
        tarballUrl: `https://registry.npmjs.org/${entry.name}/-/${tarball}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  };
}

function workRoot() {
  const root = mkdtempSync(join(tmpdir(), 'registry-binding-test-'));
  roots.push(root);
  return join(root, 'work');
}

function clean(stdout = '') {
  return {
    status: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    cleanup: { residualDescendants: 0 },
  };
}

function installedTree(overrides = {}) {
  return {
    dependencies: {
      'opensip-cli': {
        version: VERSION,
        dependencies: {
          '@opensip-cli/core': { version: VERSION },
        },
      },
    },
    ...overrides,
  };
}

function fakeNpm(inventory, options = {}) {
  const calls = [];
  const byUrl = new Map(inventory.packages.map((entry) => [entry.tarballUrl, entry]));
  return {
    calls,
    run: (args, label) => {
      calls.push({ args: [...args], label });
      if (args[0] === 'ls') {
        return Promise.resolve(clean(JSON.stringify(options.tree ?? installedTree())));
      }
      if (args[0] !== 'pack') return Promise.resolve({ ...clean(), status: 1 });
      if (options.packFailure) return Promise.resolve({ ...clean(), status: 1 });
      const destination = args[args.indexOf('--pack-destination') + 1];
      for (const url of args.slice(1, args.indexOf('--offline'))) {
        const entry = byUrl.get(url);
        if (entry === undefined) continue;
        if (options.omit === entry.name) continue;
        const bytes =
          options.corrupt === entry.name ? Buffer.from('corrupt\n') : bytesFor(entry.name);
        writeFileSync(join(destination, entry.tarball), bytes);
      }
      if (options.extra) writeFileSync(join(destination, 'unexpected.tgz'), 'extra');
      return Promise.resolve(clean());
    },
  };
}

test('preflight binds canonical bytes to digest, version, registry, and manifest', () => {
  const inventory = fixtureInventory();
  const bytes = Buffer.from(renderRegistryIntegrityInventory(inventory));
  const expectedDigest = registryIntegrityDigest(inventory);
  const bound = resolveRegistryInventoryBinding({
    inventoryBytes: bytes,
    expectedDigest,
    expectedVersion: VERSION,
    expectedRegistry: REGISTRY,
    expectedManifestDigest: MANIFEST_DIGEST,
  });
  assert.equal(bound.digest, expectedDigest);
  assert.equal(bound.inventory.packages.length, RELEASE_PACKAGE_ORDER.length);

  for (const changed of [
    { expectedDigest: 'b'.repeat(64) },
    { expectedVersion: '9.8.6' },
    { expectedRegistry: 'https://mirror.example/' },
    { expectedManifestDigest: 'c'.repeat(64) },
  ]) {
    assert.throws(() =>
      resolveRegistryInventoryBinding({
        inventoryBytes: bytes,
        expectedDigest,
        expectedVersion: VERSION,
        expectedRegistry: REGISTRY,
        expectedManifestDigest: MANIFEST_DIGEST,
        ...changed,
      }),
    );
  }
  assert.throws(() =>
    resolveRegistryInventoryBinding({
      inventoryBytes: Buffer.from(JSON.stringify(inventory)),
      expectedDigest,
      expectedVersion: VERSION,
      expectedRegistry: REGISTRY,
    }),
  );
});

test('replays exact tarball URLs offline from the install cache and hashes every byte', async () => {
  const inventory = fixtureInventory();
  const npm = fakeNpm(inventory);
  const result = await verifyInstalledRegistryBinding({
    inventory,
    workRoot: workRoot(),
    runNpm: npm.run,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.packageCount, 2);
  assert.deepEqual(result.evidence.packageNames, ['@opensip-cli/core', 'opensip-cli']);
  assert.equal(result.evidence.packageCount, 2);
  assert.equal(result.evidence.inventoryDigest, registryIntegrityDigest(inventory));
  assert.match(result.evidence.packageSetDigest, /^[a-f0-9]{64}$/u);
  assert.equal(result.evidence.offlineReplayComplete, true);
  assert.deepEqual(
    npm.calls.map((entry) => entry.label),
    ['registry-binding-list', 'registry-binding-pack'],
  );
  const pack = npm.calls[1].args;
  assert.ok(pack.includes('--offline'));
  assert.ok(pack.includes('--ignore-scripts'));
  assert.equal(pack.includes('opensip-cli@9.8.7'), false);
  assert.deepEqual(
    pack.slice(1, pack.indexOf('--offline')),
    inventory.packages
      .filter((entry) => entry.name === 'opensip-cli' || entry.name === '@opensip-cli/core')
      .map((entry) => entry.tarballUrl),
  );
});

test(
  'refuses a candidate-planted work-root symlink before offline replay',
  { skip: process.platform === 'win32' },
  async () => {
    const inventory = fixtureInventory();
    const npm = fakeNpm(inventory);
    const parent = mkdtempSync(join(tmpdir(), 'registry-binding-parent-'));
    const outside = mkdtempSync(join(tmpdir(), 'registry-binding-outside-'));
    roots.push(parent, outside);
    const planted = join(parent, 'work');
    symlinkSync(outside, planted, 'dir');

    const result = await verifyInstalledRegistryBinding({
      inventory,
      workRoot: planted,
      runNpm: npm.run,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, R.CACHE_PROOF_MISMATCH);
    assert.deepEqual(
      npm.calls.map((entry) => entry.label),
      ['registry-binding-list'],
    );
  },
);

test('rejects invalid installed trees, cache replay failures, and byte substitutions', async () => {
  const inventory = fixtureInventory();
  const cases = [
    {
      options: { tree: installedTree({ problems: ['invalid dependency'] }) },
      reasonCode: R.INSTALLED_TREE_INVALID,
    },
    {
      options: {
        tree: {
          dependencies: {
            'opensip-cli': { version: VERSION },
            '@opensip-cli/unlisted': { version: VERSION },
          },
        },
      },
      reasonCode: R.INSTALLED_TREE_INVALID,
    },
    {
      options: {
        tree: { dependencies: { 'opensip-cli': { version: '9.8.6' } } },
      },
      reasonCode: R.INSTALLED_TREE_INVALID,
    },
    { options: { packFailure: true }, reasonCode: R.CACHE_PROOF_FAILED },
    {
      options: { omit: '@opensip-cli/core' },
      reasonCode: R.CACHE_PROOF_MISMATCH,
    },
    { options: { extra: true }, reasonCode: R.CACHE_PROOF_MISMATCH },
    { options: { corrupt: 'opensip-cli' }, reasonCode: R.CACHE_PROOF_MISMATCH },
  ];
  for (const scenario of cases) {
    const npm = fakeNpm(inventory, scenario.options);
    const result = await verifyInstalledRegistryBinding({
      inventory,
      workRoot: workRoot(),
      runNpm: npm.run,
    });
    assert.equal(result.ok, false, JSON.stringify(scenario.options));
    assert.equal(result.reasonCode, scenario.reasonCode, JSON.stringify(scenario.options));
  }
});

test('malformed inventory and npm output fail closed without a pack replay', async () => {
  const inventory = fixtureInventory();
  const invalid = await verifyInstalledRegistryBinding({
    inventory: { ...inventory, packages: [] },
    workRoot: workRoot(),
    runNpm: () => Promise.resolve(clean()),
  });
  assert.equal(invalid.reasonCode, R.INVENTORY_INVALID);

  const npm = fakeNpm(inventory, { tree: { dependencies: [] } });
  const malformed = await verifyInstalledRegistryBinding({
    inventory,
    workRoot: workRoot(),
    runNpm: npm.run,
  });
  assert.equal(malformed.reasonCode, R.INSTALLED_TREE_INVALID);
  assert.equal(npm.calls.length, 1);
});
