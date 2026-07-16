import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import {
  buildRegistryIntegrityInventory,
  NPM_PUBLIC_REGISTRY,
  parseRegistryIntegrityInventory,
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
  verifyRegistryIntegrityInventory,
} from '../lib/registry-integrity-inventory.mjs';
import { expectedTarballName } from '../lib/release-artifacts.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(REPO_ROOT, 'scripts', 'registry-integrity-inventory.mjs');
const VERSION = '9.8.7';
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sri(value) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opensip-registry-integrity-'));
  roots.push(root);
  const artifactDir = join(root, 'tarballs');
  mkdirSync(artifactDir);
  const metadata = new Map();
  const artifacts = RELEASE_PACKAGE_ORDER.map((entry, index) => {
    const tarball = expectedTarballName(entry, VERSION);
    const bytes = Buffer.from(`registry tarball ${index} ${entry.name}\n`, 'utf8');
    writeFileSync(join(artifactDir, tarball), bytes);
    metadata.set(entry.name, {
      version: VERSION,
      integrity: sri(bytes),
      tarballUrl: `https://registry.npmjs.org/${entry.name}/-/${tarball}`,
    });
    return {
      name: `${entry.name}@${VERSION}`,
      kind: 'npm-tarball',
      path: tarball,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      packageName: entry.name,
      packageVersion: VERSION,
    };
  });
  const manifest = {
    schemaVersion: 1,
    releaseVersion: VERSION,
    gitTag: `v${VERSION}`,
    gitSha: 'a'.repeat(40),
    generatedAt: '2026-07-15T00:00:00.000Z',
    generator: 'test',
    artifacts,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestPath = join(root, 'opensip-cli-release-manifest.v1.json');
  writeFileSync(manifestPath, manifestBytes);
  return { root, artifactDir, manifestBytes, manifestPath, metadata };
}

async function buildFixtureInventory(setup) {
  return buildRegistryIntegrityInventory({
    artifactDir: setup.artifactDir,
    manifestBytes: setup.manifestBytes,
    version: VERSION,
    registry: NPM_PUBLIC_REGISTRY,
    expectedManifestDigest: sha256(setup.manifestBytes),
    metadataForPackage: ({ name }) => setup.metadata.get(name),
  });
}

test('build binds the complete canonical package order, npm SRI, and staged manifest', async () => {
  const setup = fixture();
  const inventory = await buildFixtureInventory(setup);

  assert.equal(inventory.packages.length, RELEASE_PACKAGE_ORDER.length);
  assert.deepEqual(
    inventory.packages.map((entry) => entry.name),
    RELEASE_PACKAGE_ORDER.map((entry) => entry.name),
  );
  assert.equal(inventory.manifestDigest, sha256(setup.manifestBytes));
  assert.match(registryIntegrityDigest(inventory), /^[a-f0-9]{64}$/u);

  const rendered = renderRegistryIntegrityInventory(inventory);
  const verified = verifyRegistryIntegrityInventory({
    inventoryBytes: Buffer.from(rendered),
    manifestBytes: setup.manifestBytes,
    expectedVersion: VERSION,
    expectedRegistry: NPM_PUBLIC_REGISTRY,
    expectedManifestDigest: sha256(setup.manifestBytes),
    expectedDigest: registryIntegrityDigest(inventory),
  });
  assert.equal(verified.digest, registryIntegrityDigest(inventory));
});

test('build fails closed on an SRI mismatch, incomplete set, symlink, or extra tarball', async (t) => {
  await t.test('SRI mismatch', async () => {
    const setup = fixture();
    setup.metadata.set(RELEASE_PACKAGE_ORDER[0].name, {
      version: VERSION,
      integrity: sri('different bytes'),
      tarballUrl: `https://registry.npmjs.org/${RELEASE_PACKAGE_ORDER[0].name}/-/mismatch.tgz`,
    });
    await assert.rejects(buildFixtureInventory(setup), /registry integrity mismatch/u);
  });

  await t.test('missing package', async () => {
    const setup = fixture();
    rmSync(join(setup.artifactDir, expectedTarballName(RELEASE_PACKAGE_ORDER[0], VERSION)));
    await assert.rejects(buildFixtureInventory(setup), /complete canonical package set/u);
  });

  await t.test('extra tarball', async () => {
    const setup = fixture();
    writeFileSync(join(setup.artifactDir, 'unexpected.tgz'), 'extra');
    await assert.rejects(buildFixtureInventory(setup), /complete canonical package set/u);
  });

  await t.test('symlinked package', async () => {
    const setup = fixture();
    const tarball = expectedTarballName(RELEASE_PACKAGE_ORDER[0], VERSION);
    const path = join(setup.artifactDir, tarball);
    const target = join(setup.root, 'target.tgz');
    writeFileSync(target, 'redirected');
    rmSync(path);
    symlinkSync(target, path);
    await assert.rejects(buildFixtureInventory(setup), /escaped|regular|ELOOP/u);
  });

  await t.test('symlink swap at open', async () => {
    const setup = fixture();
    const tarball = expectedTarballName(RELEASE_PACKAGE_ORDER[0], VERSION);
    const victim = join(setup.artifactDir, tarball);
    const target = join(setup.root, 'swapped-target.tgz');
    writeFileSync(target, 'redirected');
    let swapped = false;
    await assert.rejects(
      buildRegistryIntegrityInventory({
        artifactDir: setup.artifactDir,
        manifestBytes: setup.manifestBytes,
        version: VERSION,
        registry: NPM_PUBLIC_REGISTRY,
        expectedManifestDigest: sha256(setup.manifestBytes),
        metadataForPackage: ({ name }) => setup.metadata.get(name),
        fileSystem: {
          openSync(path, flags) {
            if (!swapped && path === victim) {
              swapped = true;
              rmSync(victim);
              symlinkSync(target, victim);
            }
            return openSync(path, flags);
          },
        },
      }),
      /changed|ELOOP/u,
    );
  });
});

test('parser rejects unknown fields, duplicates/reordering, and noncanonical JSON bytes', async () => {
  const setup = fixture();
  const inventory = await buildFixtureInventory(setup);
  const raw = JSON.parse(renderRegistryIntegrityInventory(inventory));

  assert.throws(
    () => parseRegistryIntegrityInventory({ ...raw, untrusted: true }),
    /unknown field/u,
  );
  const reordered = structuredClone(raw);
  const first = reordered.packages[0];
  reordered.packages[0] = reordered.packages[1];
  reordered.packages[1] = first;
  assert.throws(() => parseRegistryIntegrityInventory(reordered), /canonical release order/u);

  const outsideRegistry = structuredClone(raw);
  outsideRegistry.packages[0].tarballUrl = 'https://mirror.example/opensip-cli.tgz';
  assert.throws(
    () => parseRegistryIntegrityInventory(outsideRegistry),
    /remain under inventory\.registry/u,
  );
  const credentialed = structuredClone(raw);
  credentialed.packages[0].tarballUrl = 'https://user:pass@registry.npmjs.org/x.tgz';
  assert.throws(() => parseRegistryIntegrityInventory(credentialed), /credential-free HTTPS URL/u);
  const duplicateUrl = structuredClone(raw);
  duplicateUrl.packages[1].tarballUrl = duplicateUrl.packages[0].tarballUrl;
  assert.throws(() => parseRegistryIntegrityInventory(duplicateUrl), /must be unique/u);

  const noncanonical = Buffer.from(JSON.stringify(raw), 'utf8');
  assert.throws(
    () =>
      verifyRegistryIntegrityInventory({
        inventoryBytes: noncanonical,
        manifestBytes: setup.manifestBytes,
      }),
    /not canonical JSON/u,
  );
});

test('verification rejects inventory, registry, version, and manifest substitutions', async () => {
  const setup = fixture();
  const inventory = await buildFixtureInventory(setup);
  const inventoryBytes = Buffer.from(renderRegistryIntegrityInventory(inventory));
  const common = { inventoryBytes, manifestBytes: setup.manifestBytes };

  assert.throws(
    () => verifyRegistryIntegrityInventory({ ...common, expectedDigest: '0'.repeat(64) }),
    /inventory digest mismatch/u,
  );
  assert.throws(
    () => verifyRegistryIntegrityInventory({ ...common, expectedVersion: '9.8.6' }),
    /inventory version mismatch/u,
  );
  assert.throws(
    () =>
      verifyRegistryIntegrityInventory({
        ...common,
        expectedRegistry: 'https://registry.example.test/',
      }),
    /inventory registry mismatch/u,
  );
  const changedManifest = Buffer.from(
    setup.manifestBytes.toString('utf8').replace('"gitSha": "a', '"gitSha": "b'),
  );
  assert.throws(
    () => verifyRegistryIntegrityInventory({ ...common, manifestBytes: changedManifest }),
    /manifest digest mismatch/u,
  );
});

test('verify CLI uses a closed grammar and prints only the verified digest', async () => {
  const setup = fixture();
  const inventory = await buildFixtureInventory(setup);
  const inventoryPath = join(setup.root, 'inventory.json');
  writeFileSync(inventoryPath, renderRegistryIntegrityInventory(inventory));
  const digest = registryIntegrityDigest(inventory);

  const result = spawnSync(
    process.execPath,
    [
      CLI,
      'verify',
      '--inventory',
      inventoryPath,
      '--manifest',
      setup.manifestPath,
      '--expected-version',
      VERSION,
      '--expected-registry',
      NPM_PUBLIC_REGISTRY,
      '--expected-manifest-digest',
      sha256(setup.manifestBytes),
      '--expected-digest',
      digest,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${digest}\n`);

  const linkedInventory = join(setup.root, 'inventory-link.json');
  symlinkSync(inventoryPath, linkedInventory);
  const linked = spawnSync(
    process.execPath,
    [
      CLI,
      'verify',
      '--inventory',
      linkedInventory,
      '--manifest',
      setup.manifestPath,
      '--expected-version',
      VERSION,
      '--expected-registry',
      NPM_PUBLIC_REGISTRY,
      '--expected-manifest-digest',
      sha256(setup.manifestBytes),
      '--expected-digest',
      digest,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(linked.status, 1);

  const unknown = spawnSync(process.execPath, [CLI, 'verify', '--wat', 'x'], {
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown verify flag/u);
});

test('fixture inventory bytes remain readable for regression diagnostics', async () => {
  const setup = fixture();
  const inventory = await buildFixtureInventory(setup);
  const path = join(setup.root, 'inventory.json');
  writeFileSync(path, renderRegistryIntegrityInventory(inventory));
  assert.equal(readFileSync(path, 'utf8'), renderRegistryIntegrityInventory(inventory));
});
