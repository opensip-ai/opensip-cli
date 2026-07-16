import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectedTarballName } from '../lib/release-artifacts.mjs';
import {
  parseRegistryIntegrityInventory,
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
} from '../lib/registry-integrity-inventory.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

function packageSetDigest(rows) {
  const canonicalRows = rows.map((entry) => ({
    name: entry.name,
    version: entry.version,
    tarball: entry.tarball,
    tarballUrl: entry.tarballUrl,
    integrity: entry.integrity,
    sha256: entry.sha256,
  }));
  return createHash('sha256')
    .update('opensip-registry-install-binding-v1\n')
    .update(JSON.stringify(canonicalRows))
    .digest('hex');
}

export function createRegistryProofFixture(options = {}) {
  const version = options.version ?? '0.7.0';
  const registry = options.registry ?? 'https://registry.npmjs.org/';
  const manifestDigest = options.manifestDigest ?? 'a'.repeat(64);
  const inventory = parseRegistryIntegrityInventory({
    schemaVersion: 1,
    registry,
    releaseVersion: version,
    manifestDigest,
    packages: RELEASE_PACKAGE_ORDER.map((entry) => {
      const bytes = Buffer.from(`registry fixture ${entry.name}@${version}\n`, 'utf8');
      const tarball = expectedTarballName(entry, version);
      return {
        name: entry.name,
        version,
        tarball,
        tarballUrl: `${registry}${encodeURIComponent(entry.name)}/-/${tarball}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  });
  const inventoryDigest = registryIntegrityDigest(inventory);
  const makeProof = (packageNames = ['opensip-cli']) => {
    const names = new Set(packageNames);
    const rows = inventory.packages.filter((entry) => names.has(entry.name));
    if (rows.length !== names.size) throw new TypeError('unknown registry proof fixture package');
    return {
      inventoryDigest,
      packageNames: rows.map((entry) => entry.name),
      packageCount: rows.length,
      packageSetDigest: packageSetDigest(rows),
      offlineReplayComplete: true,
    };
  };
  return Object.freeze({ inventory, inventoryDigest, makeProof });
}

export function writeRegistryProofFixture(directory, fixture, name = 'registry-inventory.json') {
  const path = join(directory, name);
  writeFileSync(path, renderRegistryIntegrityInventory(fixture.inventory));
  return path;
}
