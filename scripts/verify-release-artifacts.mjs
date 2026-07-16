#!/usr/bin/env node
//
// Offline verifier for OpenSIP CLI release artifacts. This verifies the local
// release manifest and hashes. Provenance verification remains an explicit
// `gh attestation verify` step when a downloaded bundle and trusted root are
// supplied.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  MAX_RELEASE_CHECKSUMS_BYTES,
  MAX_RELEASE_MANIFEST_BYTES,
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  isSafeArtifactPath,
  normalizeReleaseManifest,
  normalizeVersion,
  parseSha256Sums,
  verifyManifestArtifacts,
} from './lib/release-artifacts.mjs';
import { readBoundedFileBytes } from './platform-acceptance/bounded-owned-file.mjs';

function readReleaseControlFile(path, maxBytes, reasonPrefix) {
  const result = readBoundedFileBytes({
    path,
    maxBytes,
    reasonPrefix,
    requireNonEmpty: true,
  });
  if (!result.ok) throw new Error(result.reasonCode);
  return result.buffer;
}

function usage() {
  return [
    'usage: node scripts/verify-release-artifacts.mjs --dir <artifact-dir> --manifest <manifest>',
    '       [--expected-version <vX.Y.Z>] [--bundle <path>] [--trusted-root <path>]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dir': {
        out.artifactDir = argv[++i];
        break;
      }
      case '--manifest': {
        out.manifestPath = argv[++i];
        break;
      }
      case '--expected-version': {
        out.expectedVersion = argv[++i];
        break;
      }
      case '--bundle': {
        out.bundlePath = argv[++i];
        break;
      }
      case '--trusted-root': {
        out.trustedRootPath = argv[++i];
        break;
      }
      default: {
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
      }
    }
  }
  if (!out.artifactDir) throw new Error(`--dir is required\n${usage()}`);
  if (!out.manifestPath) throw new Error(`--manifest is required\n${usage()}`);
  return out;
}

function failList(failures) {
  for (const failure of failures) console.error(`[release-artifacts] ${failure}`);
}

async function verifySha256Sums({ artifactDir, manifest, manifestPath, manifestBytes }) {
  const checksumsPath = join(artifactDir, RELEASE_CHECKSUMS_NAME);
  if (!existsSync(checksumsPath)) {
    return [`${RELEASE_CHECKSUMS_NAME}: file is missing`];
  }
  const failures = [];
  const entries = parseSha256Sums(
    readReleaseControlFile(
      checksumsPath,
      MAX_RELEASE_CHECKSUMS_BYTES,
      'release-checksums',
    ).toString('utf8'),
  );
  const byPath = new Map();
  for (const entry of entries) {
    if (byPath.has(entry.path)) {
      failures.push(`${RELEASE_CHECKSUMS_NAME}: duplicate entry for ${entry.path}`);
    }
    byPath.set(entry.path, entry.sha256);
  }
  const manifestBase = basename(manifestPath);
  const expected = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  if (manifestBase !== RELEASE_MANIFEST_NAME) {
    failures.push(`manifest filename should be ${RELEASE_MANIFEST_NAME}, got ${manifestBase}`);
  }
  if (isSafeArtifactPath(manifestBase)) {
    expected.set(manifestBase, createHash('sha256').update(manifestBytes).digest('hex'));
  } else {
    failures.push(`${manifestBase}: unsafe manifest path`);
  }

  for (const [path, expectedHash] of expected) {
    const actual = byPath.get(path);
    if (actual === undefined) failures.push(`${path}: missing from ${RELEASE_CHECKSUMS_NAME}`);
    else if (actual !== expectedHash) {
      failures.push(`${path}: checksum file mismatch (expected ${expectedHash}, got ${actual})`);
    }
  }
  for (const path of byPath.keys()) {
    if (!expected.has(path)) {
      failures.push(`${path}: unexpected entry in ${RELEASE_CHECKSUMS_NAME}`);
    }
  }
  return failures;
}

function attestationCommand({ manifestPath, bundlePath, trustedRootPath }) {
  if (bundlePath === undefined && trustedRootPath === undefined) return;
  if (bundlePath === undefined || trustedRootPath === undefined) {
    throw new Error('--bundle and --trusted-root must be provided together');
  }
  return [
    'gh',
    'attestation',
    'verify',
    manifestPath,
    '-R',
    'opensip-ai/opensip-cli',
    '--bundle',
    bundlePath,
    '--custom-trusted-root',
    trustedRootPath,
  ];
}

export async function verifyReleaseArtifacts(options) {
  const manifestBytes = readReleaseControlFile(
    options.manifestPath,
    MAX_RELEASE_MANIFEST_BYTES,
    'release-manifest',
  );
  const manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  const manifest = normalizeReleaseManifest(manifestRaw, options.manifestPath);
  const failures = [];
  if (
    options.expectedVersion !== undefined &&
    normalizeVersion(options.expectedVersion) !== manifest.releaseVersion
  ) {
    failures.push(
      `manifest releaseVersion ${manifest.releaseVersion} does not match ${normalizeVersion(options.expectedVersion)}`,
    );
  }
  const artifactResult = await verifyManifestArtifacts({
    manifest,
    artifactDir: options.artifactDir,
  });
  failures.push(
    ...artifactResult.failures,
    ...(await verifySha256Sums({
      artifactDir: options.artifactDir,
      manifest,
      manifestPath: options.manifestPath,
      manifestBytes,
    })),
  );
  return {
    ok: failures.length === 0,
    failures,
    manifest,
    attestationCommand: attestationCommand(options),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await verifyReleaseArtifacts(parseArgs(process.argv.slice(2)));
    if (!result.ok) {
      failList(result.failures);
      process.exit(1);
    }
    console.log(
      `[release-artifacts] verified ${result.manifest.artifacts.length} manifest artifact(s) for v${result.manifest.releaseVersion}`,
    );
    if (result.attestationCommand !== undefined) {
      console.log('[release-artifacts] hash verification passed. To verify provenance, run:');
      console.log(result.attestationCommand.map((part) => JSON.stringify(part)).join(' '));
    }
  } catch (error) {
    console.error(
      `[release-artifacts] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
