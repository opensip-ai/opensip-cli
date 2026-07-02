import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_NAME = 'opensip-cli-release-manifest.v1.json';
export const RELEASE_CHECKSUMS_NAME = 'SHA256SUMS';
export const RELEASE_SBOM_NAME = 'opensip-cli-sbom.cyclonedx.json';
export const RELEASE_ARTIFACT_GENERATOR = 'opensip-cli-release-artifacts@1';

const ARTIFACT_KINDS = new Set(['npm-tarball', 'sbom']);

export function normalizeVersion(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('version must be a non-empty string');
  }
  return value.trim().replace(/^v/u, '');
}

export function expectedTarballName(entry, version) {
  return entry.name === 'opensip-cli'
    ? `opensip-cli-${version}.tgz`
    : `opensip-cli-${entry.unscoped}-${version}.tgz`;
}

export function isSafeArtifactPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === basename(value) &&
    !isAbsolute(value) &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function statArtifact(filePath, artifactName) {
  const stat = statSync(filePath);
  return {
    path: artifactName ?? basename(filePath),
    sizeBytes: stat.size,
    sha256: await sha256File(filePath),
  };
}

export function renderSha256Sums(entries) {
  return `${[...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join('\n')}\n`;
}

export function parseSha256Sums(text) {
  const entries = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    const match = /^([a-f0-9]{64})\s{2}(.+)$/u.exec(line);
    if (match === null) {
      throw new Error(`invalid SHA256SUMS line ${index + 1}`);
    }
    const [, sha256, path] = match;
    if (!isSafeArtifactPath(path)) {
      throw new Error(`unsafe SHA256SUMS path on line ${index + 1}: ${path}`);
    }
    entries.push({ sha256, path });
  }
  return entries;
}

function stringAt(record, key, sourcePath) {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${sourcePath}: ${key} must be a non-empty string`);
  }
  return value;
}

function normalizeArtifact(raw, index, sourcePath) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourcePath}: artifacts[${index}] must be an object`);
  }
  const artifact = raw;
  const kind = stringAt(artifact, 'kind', sourcePath);
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new Error(`${sourcePath}: artifacts[${index}].kind is invalid`);
  }
  const path = stringAt(artifact, 'path', sourcePath);
  if (!isSafeArtifactPath(path)) {
    throw new Error(`${sourcePath}: artifacts[${index}].path is unsafe`);
  }
  const sha256 = stringAt(artifact, 'sha256', sourcePath);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`${sourcePath}: artifacts[${index}].sha256 must be a SHA-256 hex digest`);
  }
  const sizeBytes = artifact.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`${sourcePath}: artifacts[${index}].sizeBytes must be a non-negative integer`);
  }
  return {
    name: stringAt(artifact, 'name', sourcePath),
    kind,
    path,
    sha256,
    sizeBytes,
    ...(typeof artifact.packageName === 'string' ? { packageName: artifact.packageName } : {}),
    ...(typeof artifact.packageVersion === 'string'
      ? { packageVersion: artifact.packageVersion }
      : {}),
    ...(typeof artifact.format === 'string' ? { format: artifact.format } : {}),
  };
}

export function normalizeReleaseManifest(raw, sourcePath = '<manifest>') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${sourcePath}: manifest must be an object`);
  }
  const manifest = raw;
  if (manifest.schemaVersion !== RELEASE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`${sourcePath}: schemaVersion must be ${RELEASE_ARTIFACT_SCHEMA_VERSION}`);
  }
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((entry, index) => normalizeArtifact(entry, index, sourcePath))
    : [];
  if (artifacts.length === 0) {
    throw new Error(`${sourcePath}: artifacts must be a non-empty array`);
  }
  return {
    schemaVersion: RELEASE_ARTIFACT_SCHEMA_VERSION,
    releaseVersion: normalizeVersion(stringAt(manifest, 'releaseVersion', sourcePath)),
    gitTag: stringAt(manifest, 'gitTag', sourcePath),
    gitSha: stringAt(manifest, 'gitSha', sourcePath),
    generatedAt: stringAt(manifest, 'generatedAt', sourcePath),
    generator: stringAt(manifest, 'generator', sourcePath),
    artifacts,
  };
}

export function expectedTarballEntries(version) {
  return RELEASE_PACKAGE_ORDER.map((entry) => ({
    releaseEntry: entry,
    packageName: entry.name,
    fileName: expectedTarballName(entry, version),
  }));
}

export function discoverTarballFiles(artifactDir, version) {
  return expectedTarballEntries(version).map((entry) => ({
    ...entry,
    filePath: join(artifactDir, entry.fileName),
    exists: existsSync(join(artifactDir, entry.fileName)),
  }));
}

export async function artifactEntryForFile({
  artifactDir,
  fileName,
  name,
  kind,
  packageName,
  packageVersion,
  format,
}) {
  if (!isSafeArtifactPath(fileName)) {
    throw new Error(`unsafe artifact filename: ${fileName}`);
  }
  const filePath = join(artifactDir, fileName);
  const stat = await statArtifact(filePath, fileName);
  return {
    name,
    kind,
    path: fileName,
    sha256: stat.sha256,
    sizeBytes: stat.sizeBytes,
    ...(packageName === undefined ? {} : { packageName }),
    ...(packageVersion === undefined ? {} : { packageVersion }),
    ...(format === undefined ? {} : { format }),
  };
}

export async function verifyManifestArtifacts({ manifest, artifactDir }) {
  const normalized = normalizeReleaseManifest(manifest);
  const failures = [];
  for (const artifact of normalized.artifacts) {
    if (!isSafeArtifactPath(artifact.path)) {
      failures.push(`${artifact.path}: unsafe artifact path`);
      continue;
    }
    const filePath = join(artifactDir, artifact.path);
    if (!existsSync(filePath)) {
      failures.push(`${artifact.path}: file is missing`);
      continue;
    }
    const stat = statSync(filePath);
    if (stat.size !== artifact.sizeBytes) {
      failures.push(
        `${artifact.path}: size mismatch (expected ${artifact.sizeBytes}, got ${stat.size})`,
      );
    }
    const actualHash = await sha256File(filePath);
    if (actualHash !== artifact.sha256) {
      failures.push(
        `${artifact.path}: sha256 mismatch (expected ${artifact.sha256}, got ${actualHash})`,
      );
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    checked: normalized.artifacts.length,
  };
}
