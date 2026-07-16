/**
 * @fileoverview Published-registry inventory → installed-package binding.
 *
 * npm global installs do not write a package lock, so a candidate version and
 * an independently retained registry inventory are not enough to prove which
 * bytes the isolated installer consumed. This module closes that gap without
 * replacing the customer install path: enumerate the installed logical tree,
 * then ask npm to copy the exact cached tarball URLs in offline mode from the
 * same initially-empty run-owned cache. The copied bytes must match the
 * inventory's SHA-256 and npm SHA-512 SRI exactly.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  canonicalRegistry,
  parseRegistryIntegrityInventory,
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
} from '../lib/registry-integrity-inventory.mjs';
import { readBoundedFileBytes } from './bounded-owned-file.mjs';

export const REGISTRY_BINDING_REASON_CODES = Object.freeze({
  INVENTORY_INVALID: 'registry-inventory-invalid',
  INSTALLED_TREE_INVALID: 'registry-installed-tree-invalid',
  CACHE_PROOF_FAILED: 'registry-cache-proof-failed',
  CACHE_PROOF_MISMATCH: 'registry-cache-proof-mismatch',
});

export const MAX_REGISTRY_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_TREE_NODES = 16_384;
const HEX64 = /^[a-f0-9]{64}$/u;

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

function bindingEvidence(inventory, installedRows) {
  return Object.freeze({
    inventoryDigest: registryIntegrityDigest(inventory),
    packageNames: Object.freeze(installedRows.map((entry) => entry.name)),
    packageCount: installedRows.length,
    packageSetDigest: packageSetDigest(installedRows),
    offlineReplayComplete: true,
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultStdout(result) {
  if (typeof result?.stdout === 'string') return result.stdout;
  if (typeof result?.stdoutCapture === 'string') return result.stdoutCapture;
  return '';
}

function isCleanProcess(result) {
  return (
    result?.status === 0 &&
    result.signal == null &&
    result.timedOut !== true &&
    result.cancelled !== true &&
    result.outputTruncated !== true &&
    (result.cleanup?.residualDescendants ?? 1) === 0
  );
}

function fail(reasonCode, message, child = null) {
  return Object.freeze({ ok: false, reasonCode, message, child });
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/**
 * Validate the canonical inventory bytes against every identity already bound
 * into the published candidate. No path is retained in evidence or install
 * descriptors; callers receive only the normalized immutable inventory.
 */
export function resolveRegistryInventoryBinding(input) {
  const bytes = Buffer.isBuffer(input.inventoryBytes)
    ? input.inventoryBytes
    : Buffer.from(String(input.inventoryBytes), 'utf8');
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError('registry inventory is not valid JSON');
  }
  const inventory = parseRegistryIntegrityInventory(raw);
  const canonical = Buffer.from(renderRegistryIntegrityInventory(inventory), 'utf8');
  if (!bytes.equals(canonical)) throw new TypeError('registry inventory is not canonical JSON');

  const expectedDigest = requireDigest(input.expectedDigest, 'expected inventory digest');
  const digest = registryIntegrityDigest(inventory);
  if (digest !== expectedDigest) throw new TypeError('registry inventory digest mismatch');
  if (inventory.releaseVersion !== input.expectedVersion) {
    throw new TypeError('registry inventory version mismatch');
  }
  if (inventory.registry !== canonicalRegistry(input.expectedRegistry)) {
    throw new TypeError('registry inventory registry mismatch');
  }
  if (input.expectedManifestDigest !== undefined) {
    const expectedManifestDigest = requireDigest(
      input.expectedManifestDigest,
      'expected manifest digest',
    );
    if (inventory.manifestDigest !== expectedManifestDigest) {
      throw new TypeError('registry inventory manifest digest mismatch');
    }
  }
  return Object.freeze({ inventory, digest });
}

function isFirstParty(name) {
  return name === 'opensip-cli' || name.startsWith('@opensip-cli/');
}

function collectInstalledFirstParty(tree) {
  if (!isPlainObject(tree)) throw new TypeError('npm ls output must be an object');
  if (Array.isArray(tree.problems) && tree.problems.length > 0) {
    throw new TypeError('npm ls reported dependency problems');
  }
  const installed = new Map();
  const stack = [tree];
  let observed = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    observed += 1;
    if (observed > MAX_TREE_NODES) throw new TypeError('npm dependency tree exceeded its bound');
    if (!isPlainObject(node)) throw new TypeError('npm dependency tree contains an invalid node');
    if (
      node.invalid === true ||
      node.missing === true ||
      node.extraneous === true ||
      node.link === true ||
      node.error !== undefined
    ) {
      throw new TypeError('npm dependency tree contains an invalid package');
    }
    if (node.dependencies === undefined) continue;
    if (!isPlainObject(node.dependencies)) {
      throw new TypeError('npm dependency tree contains invalid dependencies');
    }
    for (const [name, dependency] of Object.entries(node.dependencies)) {
      if (!isPlainObject(dependency)) {
        throw new TypeError('npm dependency tree contains an invalid dependency');
      }
      if (isFirstParty(name)) {
        if (typeof dependency.version !== 'string' || dependency.version.length === 0) {
          throw new TypeError('installed first-party package omitted its version');
        }
        const prior = installed.get(name);
        if (prior !== undefined && prior !== dependency.version) {
          throw new TypeError('installed first-party package has multiple versions');
        }
        installed.set(name, dependency.version);
      }
      stack.push(dependency);
    }
  }
  if (!installed.has('opensip-cli')) {
    throw new TypeError('installed dependency tree omitted opensip-cli');
  }
  return installed;
}

function exactDirectoryEntries(directory, expectedNames) {
  const actual = readdirSync(directory).sort();
  const expected = [...expectedNames].sort();
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
}

function hashTarball(path) {
  const read = readBoundedFileBytes({
    path,
    maxBytes: MAX_REGISTRY_TARBALL_BYTES,
    reasonPrefix: 'registry-binding-tarball',
    requireNonEmpty: true,
  });
  if (!read.ok) throw new TypeError(`registry tarball read failed (${read.reasonCode})`);
  return {
    sha256: createHash('sha256').update(read.buffer).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(read.buffer).digest('base64')}`,
  };
}

/**
 * Prove a published global install against a normalized inventory.
 * `runNpm(args, label)` must use the exact npm executable, prefix, registry,
 * and run-owned cache used for the install being checked.
 */
export async function verifyInstalledRegistryBinding(input) {
  let inventory;
  try {
    inventory = parseRegistryIntegrityInventory(input.inventory);
  } catch {
    return fail(
      REGISTRY_BINDING_REASON_CODES.INVENTORY_INVALID,
      'registry binding inventory was invalid',
    );
  }
  if (typeof input.runNpm !== 'function') {
    return fail(
      REGISTRY_BINDING_REASON_CODES.INSTALLED_TREE_INVALID,
      'registry binding requires an npm process port',
    );
  }
  if (typeof input.workRoot !== 'string' || input.workRoot.length === 0) {
    return fail(
      REGISTRY_BINDING_REASON_CODES.CACHE_PROOF_MISMATCH,
      'registry binding requires a run-owned work root',
    );
  }

  const listed = await input.runNpm(
    ['ls', '-g', '--all', '--json', '--loglevel', 'error'],
    'registry-binding-list',
  );
  if (!isCleanProcess(listed)) {
    return fail(
      REGISTRY_BINDING_REASON_CODES.INSTALLED_TREE_INVALID,
      'npm could not enumerate a clean installed dependency tree',
      listed,
    );
  }

  let installed;
  try {
    installed = collectInstalledFirstParty(JSON.parse(resultStdout(listed)));
  } catch {
    return fail(
      REGISTRY_BINDING_REASON_CODES.INSTALLED_TREE_INVALID,
      'npm returned an invalid installed dependency tree',
      listed,
    );
  }

  const inventoryByName = new Map(inventory.packages.map((entry) => [entry.name, entry]));
  const installedRows = [];
  for (const inventoryRow of inventory.packages) {
    const installedVersion = installed.get(inventoryRow.name);
    if (installedVersion === undefined) continue;
    if (installedVersion !== inventory.releaseVersion) {
      return fail(
        REGISTRY_BINDING_REASON_CODES.INSTALLED_TREE_INVALID,
        'an installed first-party package did not match the target release version',
        listed,
      );
    }
    installedRows.push(inventoryRow);
  }
  if (
    installedRows.length !== installed.size ||
    [...installed.keys()].some((name) => !inventoryByName.has(name))
  ) {
    return fail(
      REGISTRY_BINDING_REASON_CODES.INSTALLED_TREE_INVALID,
      'the installed first-party package set was not a projection of the inventory',
      listed,
    );
  }

  let destination;
  try {
    // `workRoot` is a dedicated, not-yet-existing child of the harness run
    // root. A candidate install runs before this proof; refusing every existing
    // inode prevents a lifecycle script from planting a predictable symlink (or
    // pre-populated directory) that redirects the offline replay elsewhere.
    mkdirSync(input.workRoot, { mode: 0o700 });
    destination = mkdtempSync(join(input.workRoot, '.registry-binding-'));
  } catch {
    return fail(
      REGISTRY_BINDING_REASON_CODES.CACHE_PROOF_MISMATCH,
      'registry binding could not create its run-owned snapshot directory',
    );
  }
  const packed = await input.runNpm(
    [
      'pack',
      ...installedRows.map((entry) => entry.tarballUrl),
      '--offline',
      '--ignore-scripts',
      '--pack-destination',
      destination,
      '--loglevel',
      'error',
    ],
    'registry-binding-pack',
  );
  if (!isCleanProcess(packed)) {
    return fail(
      REGISTRY_BINDING_REASON_CODES.CACHE_PROOF_FAILED,
      'npm could not replay the installed first-party tarballs from its isolated cache',
      packed,
    );
  }

  if (
    !exactDirectoryEntries(
      destination,
      installedRows.map((entry) => entry.tarball),
    )
  ) {
    return fail(
      REGISTRY_BINDING_REASON_CODES.CACHE_PROOF_MISMATCH,
      'offline npm replay did not produce the exact installed first-party package set',
      packed,
    );
  }
  try {
    for (const entry of installedRows) {
      if (basename(entry.tarball) !== entry.tarball) throw new TypeError('unsafe tarball name');
      const hashes = hashTarball(join(destination, entry.tarball));
      if (hashes.sha256 !== entry.sha256 || hashes.integrity !== entry.integrity) {
        throw new TypeError('registry tarball digest mismatch');
      }
    }
  } catch {
    return fail(
      REGISTRY_BINDING_REASON_CODES.CACHE_PROOF_MISMATCH,
      'offline npm replay bytes did not match the registry inventory',
      packed,
    );
  }

  return Object.freeze({
    ok: true,
    reasonCode: null,
    packageCount: installedRows.length,
    evidence: bindingEvidence(inventory, installedRows),
    children: Object.freeze([listed, packed]),
  });
}
