/**
 * @fileoverview Canonical npm-registry integrity inventory for release
 * qualification.
 *
 * The release manifest proves the bytes packed by the staging job. This
 * inventory proves which immutable registry bytes were fetched by the macOS
 * qualification job: every publishable package, in RELEASE_PACKAGE_ORDER, is
 * bound by exact name/version/tarball path, SHA-256, and npm's SHA-512 SRI.
 *
 * The representation is deliberately closed and canonical. Consumers hash the
 * exact canonical bytes and reject alternate JSON spellings, unknown fields,
 * omissions, duplicates, or reordering. That makes the digest suitable for the
 * platform-acceptance candidate identity and for independent promotion checks.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';
import { expectedTarballName, normalizeReleaseManifest } from './release-artifacts.mjs';

export const REGISTRY_INTEGRITY_SCHEMA_VERSION = 1;
export const NPM_PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'registry',
  'releaseVersion',
  'manifestDigest',
  'packages',
]);
const PACKAGE_KEYS = new Set(['name', 'version', 'tarball', 'tarballUrl', 'integrity', 'sha256']);
const HEX64 = /^[a-f0-9]{64}$/u;
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)';
const SEMVER_PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_SEMVER = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}` +
    `(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  'u',
);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const DEFAULT_FILE_SYSTEM = Object.freeze({
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  statSync,
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireClosedObject(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new TypeError(`${label} has an invalid value`);
  }
  return value;
}

function requireExactVersion(value, label) {
  return requireString(value, label, EXACT_SEMVER);
}

function requireTarballUrl(value, label) {
  const raw = requireString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== raw
  ) {
    throw new TypeError(`${label} must be a canonical credential-free HTTPS URL`);
  }
  return raw;
}

/** Normalize a credential-free HTTPS npm registry to directory URL form. */
export function canonicalRegistry(value) {
  requireString(value, 'registry');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('registry must be a valid URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('registry must be a credential-free HTTPS URL');
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return `${url.origin}${url.pathname}`;
}

/** Parse one strict `sha512-<base64>` npm Subresource Integrity value. */
function parseSha512Integrity(value, label) {
  const integrity = requireString(value, label);
  if (!integrity.startsWith('sha512-')) {
    throw new TypeError(`${label} must use sha512`);
  }
  const encoded = integrity.slice('sha512-'.length);
  if (!BASE64.test(encoded)) throw new TypeError(`${label} is not canonical base64`);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== encoded) {
    throw new TypeError(`${label} is not a SHA-512 digest`);
  }
  return { integrity, digest: decoded };
}

function normalizePackage(raw, index, releaseEntry, releaseVersion) {
  const label = `packages[${index}]`;
  const record = requireClosedObject(raw, PACKAGE_KEYS, label);
  const expectedTarball = expectedTarballName(releaseEntry, releaseVersion);
  const entry = {
    name: requireString(record.name, `${label}.name`),
    version: requireExactVersion(record.version, `${label}.version`),
    tarball: requireString(record.tarball, `${label}.tarball`),
    tarballUrl: requireTarballUrl(record.tarballUrl, `${label}.tarballUrl`),
    integrity: parseSha512Integrity(record.integrity, `${label}.integrity`).integrity,
    sha256: requireString(record.sha256, `${label}.sha256`, HEX64),
  };
  if (entry.name !== releaseEntry.name) {
    throw new TypeError(`${label}.name is out of canonical release order`);
  }
  if (entry.version !== releaseVersion) {
    throw new TypeError(`${label}.version does not match releaseVersion`);
  }
  if (entry.tarball !== expectedTarball) {
    throw new TypeError(`${label}.tarball does not match the canonical package path`);
  }
  return Object.freeze(entry);
}

/** Parse and canonicalize a closed registry-integrity inventory object. */
export function parseRegistryIntegrityInventory(raw) {
  const record = requireClosedObject(raw, TOP_LEVEL_KEYS, 'inventory');
  if (record.schemaVersion !== REGISTRY_INTEGRITY_SCHEMA_VERSION) {
    throw new TypeError(`inventory.schemaVersion must be ${REGISTRY_INTEGRITY_SCHEMA_VERSION}`);
  }
  const registry = canonicalRegistry(record.registry);
  if (record.registry !== registry) {
    throw new TypeError('inventory.registry must use canonical URL form');
  }
  const releaseVersion = requireExactVersion(record.releaseVersion, 'inventory.releaseVersion');
  const manifestDigest = requireString(record.manifestDigest, 'inventory.manifestDigest', HEX64);
  if (!Array.isArray(record.packages)) {
    throw new TypeError('inventory.packages must be an array');
  }
  if (record.packages.length !== RELEASE_PACKAGE_ORDER.length) {
    throw new TypeError(
      `inventory.packages must contain exactly ${RELEASE_PACKAGE_ORDER.length} packages`,
    );
  }
  const packages = Object.freeze(
    record.packages.map((entry, index) =>
      normalizePackage(entry, index, RELEASE_PACKAGE_ORDER[index], releaseVersion),
    ),
  );
  const registryUrl = new URL(registry);
  if (
    packages.some((entry) => {
      const tarballUrl = new URL(entry.tarballUrl);
      return (
        tarballUrl.origin !== registryUrl.origin ||
        !tarballUrl.pathname.startsWith(registryUrl.pathname)
      );
    })
  ) {
    throw new TypeError('inventory package tarball URLs must remain under inventory.registry');
  }
  if (new Set(packages.map((entry) => entry.tarballUrl)).size !== packages.length) {
    throw new TypeError('inventory package tarball URLs must be unique');
  }
  return Object.freeze({
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    registry,
    releaseVersion,
    manifestDigest,
    packages,
  });
}

/** Render the only accepted byte representation for an inventory. */
export function renderRegistryIntegrityInventory(inventory) {
  const normalized = parseRegistryIntegrityInventory(inventory);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/** SHA-256 of the exact canonical inventory bytes. */
export function registryIntegrityDigest(inventory) {
  return createHash('sha256').update(renderRegistryIntegrityInventory(inventory)).digest('hex');
}

function isUnder(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hashTarball(path, artifactRoot, fileSystem = {}) {
  const fs = { ...DEFAULT_FILE_SYSTEM, ...fileSystem };
  let descriptor;
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  try {
    const pathReal = fs.realpathSync(path);
    if (!isUnder(artifactRoot, pathReal)) {
      throw new TypeError('registry tarball escaped its run-owned directory');
    }
    const pathStat = fs.statSync(pathReal);
    if (!pathStat.isFile()) throw new TypeError('registry tarball is not a regular file');
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = fs.openSync(path, constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile() || !sameFile(pathStat, openedStat)) {
      throw new TypeError('registry tarball changed before it was opened');
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(path, { autoClose: false, fd: descriptor });
      stream.on('error', reject);
      stream.on('data', (chunk) => {
        sha256.update(chunk);
        sha512.update(chunk);
      });
      stream.on('end', resolve);
    });
    const completedStat = fs.fstatSync(descriptor);
    if (
      !sameFile(openedStat, completedStat) ||
      openedStat.size !== completedStat.size ||
      openedStat.mtimeMs !== completedStat.mtimeMs ||
      openedStat.ctimeMs !== completedStat.ctimeMs
    ) {
      throw new TypeError('registry tarball changed while it was hashed');
    }
    return {
      sha256: sha256.digest('hex'),
      sha512: sha512.digest(),
      sizeBytes: completedStat.size,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeRegistryMetadata(raw, name, version) {
  if (!isPlainObject(raw)) throw new TypeError(`registry metadata for ${name} is invalid`);
  if (raw.version !== version) {
    throw new TypeError(`registry metadata version mismatch for ${name}`);
  }
  return {
    ...parseSha512Integrity(raw.integrity, `registry metadata integrity for ${name}`),
    tarballUrl: requireTarballUrl(raw.tarballUrl, `registry metadata tarball URL for ${name}`),
  };
}

function manifestTarballs(manifest, releaseVersion) {
  if (manifest.releaseVersion !== releaseVersion) {
    throw new TypeError('release manifest version does not match inventory version');
  }
  const npmArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === 'npm-tarball');
  if (npmArtifacts.length !== RELEASE_PACKAGE_ORDER.length) {
    throw new TypeError('release manifest does not contain the complete npm package set');
  }
  const byName = new Map();
  for (const artifact of npmArtifacts) {
    if (typeof artifact.packageName !== 'string' || byName.has(artifact.packageName)) {
      throw new TypeError('release manifest has missing or duplicate npm package identity');
    }
    byName.set(artifact.packageName, artifact);
  }
  return byName;
}

function verifyInventoryAgainstManifest(inventory, manifest) {
  const byName = manifestTarballs(manifest, inventory.releaseVersion);
  for (const [index, releaseEntry] of RELEASE_PACKAGE_ORDER.entries()) {
    const artifact = byName.get(releaseEntry.name);
    const pkg = inventory.packages[index];
    if (
      artifact === undefined ||
      artifact.packageVersion !== inventory.releaseVersion ||
      artifact.path !== pkg.tarball ||
      artifact.sha256 !== pkg.sha256
    ) {
      throw new TypeError(`release manifest does not match inventory package ${releaseEntry.name}`);
    }
  }
}

function requireManifestDigest(manifestBytes, expectedManifestDigest) {
  const digest = createHash('sha256').update(manifestBytes).digest('hex');
  if (expectedManifestDigest !== undefined) {
    requireString(expectedManifestDigest, 'expected manifest digest', HEX64);
    if (digest !== expectedManifestDigest) {
      throw new TypeError('release manifest digest does not match the expected digest');
    }
  }
  return digest;
}

function parseManifestBytes(manifestBytes) {
  const bytes = Buffer.isBuffer(manifestBytes)
    ? manifestBytes
    : Buffer.from(String(manifestBytes), 'utf8');
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError('release manifest is not valid JSON');
  }
  return { bytes, manifest: normalizeReleaseManifest(raw) };
}

function requireClosedTarballDirectory(artifactDir, version, fileSystem = {}) {
  const fs = { ...DEFAULT_FILE_SYSTEM, ...fileSystem };
  const directoryStat = fs.lstatSync(artifactDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new TypeError('registry tarball directory must be a regular directory');
  }
  const artifactRoot = fs.realpathSync(artifactDir);
  const expected = RELEASE_PACKAGE_ORDER.map((entry) => expectedTarballName(entry, version));
  const expectedSet = new Set(expected);
  const actual = fs
    .readdirSync(artifactRoot)
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  const canonicalActual = [...expected].sort();
  if (
    actual.length !== canonicalActual.length ||
    actual.some((name, index) => name !== canonicalActual[index])
  ) {
    throw new TypeError('registry tarball directory is not the complete canonical package set');
  }
  for (const name of actual) {
    if (!expectedSet.has(name)) throw new TypeError('registry tarball directory has an extra file');
  }
  return artifactRoot;
}

/**
 * Build an inventory from fetched registry tarballs. `metadataForPackage` must
 * return `{ version, integrity }` from the exact registry package document.
 */
export async function buildRegistryIntegrityInventory(input) {
  const releaseVersion = requireExactVersion(input.version, 'version');
  const registry = canonicalRegistry(input.registry);
  if (typeof input.artifactDir !== 'string' || input.artifactDir.length === 0) {
    throw new TypeError('artifactDir must be a non-empty path');
  }
  if (typeof input.metadataForPackage !== 'function') {
    throw new TypeError('metadataForPackage must be a function');
  }
  const manifestInput = parseManifestBytes(input.manifestBytes);
  const manifestDigest = requireManifestDigest(manifestInput.bytes, input.expectedManifestDigest);
  const byName = manifestTarballs(manifestInput.manifest, releaseVersion);
  const artifactRoot = requireClosedTarballDirectory(
    input.artifactDir,
    releaseVersion,
    input.fileSystem,
  );

  const packages = [];
  for (const releaseEntry of RELEASE_PACKAGE_ORDER) {
    const tarball = expectedTarballName(releaseEntry, releaseVersion);
    const path = join(input.artifactDir, tarball);
    const [hashes, metadataRaw] = await Promise.all([
      hashTarball(path, artifactRoot, input.fileSystem),
      input.metadataForPackage({
        name: releaseEntry.name,
        version: releaseVersion,
        registry,
      }),
    ]);
    const metadata = normalizeRegistryMetadata(metadataRaw, releaseEntry.name, releaseVersion);
    if (
      hashes.sha512.byteLength !== metadata.digest.byteLength ||
      !timingSafeEqual(hashes.sha512, metadata.digest)
    ) {
      throw new TypeError(`registry integrity mismatch for ${releaseEntry.name}`);
    }
    const artifact = byName.get(releaseEntry.name);
    if (
      artifact === undefined ||
      artifact.packageVersion !== releaseVersion ||
      artifact.path !== tarball ||
      artifact.sha256 !== hashes.sha256 ||
      artifact.sizeBytes !== hashes.sizeBytes
    ) {
      throw new TypeError(
        `registry tarball does not match release manifest for ${releaseEntry.name}`,
      );
    }
    packages.push(
      Object.freeze({
        name: releaseEntry.name,
        version: releaseVersion,
        tarball,
        tarballUrl: metadata.tarballUrl,
        integrity: metadata.integrity,
        sha256: hashes.sha256,
      }),
    );
  }

  return parseRegistryIntegrityInventory({
    schemaVersion: REGISTRY_INTEGRITY_SCHEMA_VERSION,
    registry,
    releaseVersion,
    manifestDigest,
    packages,
  });
}

/**
 * Verify canonical inventory bytes, expected identities, and its complete
 * SHA-256 mapping back to the staged release manifest.
 */
export function verifyRegistryIntegrityInventory(input) {
  const bytes = Buffer.isBuffer(input.inventoryBytes)
    ? input.inventoryBytes
    : Buffer.from(String(input.inventoryBytes), 'utf8');
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new TypeError('registry integrity inventory is not valid JSON');
  }
  const inventory = parseRegistryIntegrityInventory(raw);
  const canonicalBytes = Buffer.from(renderRegistryIntegrityInventory(inventory), 'utf8');
  if (!bytes.equals(canonicalBytes)) {
    throw new TypeError('registry integrity inventory is not canonical JSON');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (input.expectedDigest !== undefined) {
    requireString(input.expectedDigest, 'expected inventory digest', HEX64);
    if (digest !== input.expectedDigest) {
      throw new TypeError('registry integrity inventory digest mismatch');
    }
  }
  if (
    input.expectedVersion !== undefined &&
    inventory.releaseVersion !== requireExactVersion(input.expectedVersion, 'expected version')
  ) {
    throw new TypeError('registry integrity inventory version mismatch');
  }
  if (
    input.expectedRegistry !== undefined &&
    inventory.registry !== canonicalRegistry(input.expectedRegistry)
  ) {
    throw new TypeError('registry integrity inventory registry mismatch');
  }

  const manifestInput = parseManifestBytes(input.manifestBytes);
  const manifestDigest = requireManifestDigest(manifestInput.bytes, input.expectedManifestDigest);
  if (inventory.manifestDigest !== manifestDigest) {
    throw new TypeError('registry integrity inventory manifest digest mismatch');
  }
  verifyInventoryAgainstManifest(inventory, manifestInput.manifest);
  return Object.freeze({ inventory, digest });
}
