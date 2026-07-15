/**
 * @fileoverview Verified candidate-source resolution for platform acceptance.
 *
 * Two — and only two — trusted candidate forms may enter a run:
 *   - `packed-release`: the freshly-packed npm tarballs in a directory, proven
 *     against the release manifest + SHA256SUMS by the existing release-artifact
 *     authority (`scripts/lib/release-artifacts.mjs` +
 *     `scripts/verify-release-artifacts.mjs`) BEFORE any tarball path is read.
 *   - `published-version`: an EXACT normalized semver already on a registry
 *     (npmjs by default; an explicit HTTPS mirror only through validation).
 *
 * This module is the SOURCE authority: it validates the closed union, and for
 * packed candidates it verifies the complete expected package set and binds the
 * manifest/checksum digest into a redacted `CandidateIdentity`. It also defines
 * post-install descriptor derivation (`resolveInstalledDescriptors`) — the
 * platform-aware customer invocation and the JS entrypoint derived ONLY from the
 * installed package's validated `package.json#bin`, realpathed under the run
 * root. The candidate lifecycle owns the actual install; this module owns
 * validation + the closed reason-code vocabulary.
 *
 * Dependency-free apart from Node built-ins so a release script can import it
 * with no build step. It never spawns a process, never prints, and never fetches
 * a network resource; it returns typed result objects only.
 *
 * @typedef {import('./contract.d.mts').CandidateIdentity} CandidateIdentity
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  RELEASE_MANIFEST_NAME,
  discoverTarballFiles,
  expectedTarballEntries,
  normalizeReleaseManifest,
  normalizeVersion,
  renderSha256Sums,
} from '../lib/release-artifacts.mjs';
import { verifyReleaseArtifacts } from '../verify-release-artifacts.mjs';

/**
 * The closed, stable reason-code vocabulary for candidate resolution and
 * post-install descriptor derivation. Every failure result carries exactly one
 * of these kebab-case codes; nothing else is a candidate failure.
 */
export const CANDIDATE_REASON_CODES = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  UNKNOWN_KIND: 'unknown-kind',
  INVALID_VERSION: 'invalid-version',
  INVALID_REGISTRY: 'invalid-registry',
  MISSING_DIRECTORY: 'missing-directory',
  INVALID_MANIFEST: 'invalid-manifest',
  CHECKSUM_MISMATCH: 'checksum-mismatch',
  INCOMPLETE_PACKAGE_SET: 'incomplete-package-set',
  REGISTRY_UNAVAILABLE: 'registry-unavailable',
  INSTALL_FAILED: 'install-failed',
  INVALID_PACKAGE_JSON: 'invalid-package-json',
  INVALID_ENTRYPOINT: 'invalid-entrypoint',
  CANDIDATE_BINARY_ESCAPE: 'candidate-binary-escape',
});

/** The default public registry. Host-only form lands in the CandidateIdentity. */
export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';

const R = CANDIDATE_REASON_CODES;

// An EXACT semver — no ranges (`^`, `~`, `>=`, `*`, `x`), no dist-tags
// (`latest`), no URLs, no local paths, no credentials. Prerelease/build
// metadata are allowed; everything else is rejected structurally.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// C0/C1 control characters never belong in a path, version, or registry.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

const PACKED_KEYS = ['kind', 'directory', 'manifest', 'expectedVersion'];
const PUBLISHED_KEYS = ['kind', 'version', 'registry'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(reasonCode, message) {
  return Object.freeze({ ok: false, reasonCode, message });
}

function hasControlChars(value) {
  return CONTROL_CHARS.test(value);
}

function firstUnknownKey(record, allowed) {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!set.has(key)) return key;
  }
}

/** True when `target` is a strict descendant of `root` (both realpath'd). */
function isUnderRoot(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Resolve the manifest path: default in-directory name, or an explicit path. */
function resolveManifestPath(manifest, directory) {
  if (manifest === undefined) return join(directory, RELEASE_MANIFEST_NAME);
  return isAbsolute(manifest) ? manifest : join(directory, manifest);
}

function summarizeFailures(failures) {
  const head = failures.slice(0, 3).join('; ');
  const suffix = failures.length > 3 ? ` (+${failures.length - 3} more)` : '';
  const text = `${head}${suffix}`;
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/**
 * Resolve and validate a candidate SOURCE. Returns a frozen result:
 *   - `{ ok: true, identity, install }` on success, where `identity` is a
 *     redacted `CandidateIdentity` and `install` carries what the lifecycle
 *     needs to install (never printed, never persisted to evidence).
 *   - `{ ok: false, reasonCode, message }` on any validation failure.
 *
 * @param {unknown} input a closed union: `{ kind: 'packed-release', directory,
 *   manifest?, expectedVersion }` or `{ kind: 'published-version', version,
 *   registry? }`.
 */
export async function resolveCandidateSource(input) {
  if (!isPlainObject(input)) {
    return fail(R.INVALID_INPUT, 'candidate source input must be an object');
  }
  switch (input.kind) {
    case 'packed-release': {
      return resolvePackedRelease(input);
    }
    case 'published-version': {
      return resolvePublishedVersion(input);
    }
    default: {
      return fail(R.UNKNOWN_KIND, `unknown candidate kind ${JSON.stringify(input.kind)}`);
    }
  }
}

async function resolvePackedRelease(input) {
  const unknown = firstUnknownKey(input, PACKED_KEYS);
  if (unknown !== undefined) {
    return fail(R.INVALID_INPUT, `packed-release has unknown key ${JSON.stringify(unknown)}`);
  }
  if (typeof input.directory !== 'string' || input.directory.length === 0) {
    return fail(R.INVALID_INPUT, 'packed-release.directory must be a non-empty string');
  }
  if (hasControlChars(input.directory)) {
    return fail(R.INVALID_INPUT, 'packed-release.directory contains control characters');
  }
  if (
    input.manifest !== undefined &&
    (typeof input.manifest !== 'string' || input.manifest.length === 0)
  ) {
    return fail(
      R.INVALID_INPUT,
      'packed-release.manifest, when present, must be a non-empty string',
    );
  }
  if (typeof input.manifest === 'string' && hasControlChars(input.manifest)) {
    return fail(R.INVALID_INPUT, 'packed-release.manifest contains control characters');
  }

  const versionResult = normalizeExactVersion(
    input.expectedVersion,
    'packed-release.expectedVersion',
  );
  if (!versionResult.ok) return versionResult;
  const version = versionResult.version;

  if (!existsSync(input.directory)) {
    return fail(R.MISSING_DIRECTORY, 'packed-release directory does not exist');
  }
  let directory;
  try {
    directory = realpathSync(resolve(input.directory));
  } catch {
    return fail(R.MISSING_DIRECTORY, 'packed-release directory could not be resolved');
  }

  const manifestPath = resolveManifestPath(input.manifest, directory);

  if (!existsSync(manifestPath)) {
    return fail(R.INVALID_MANIFEST, 'release manifest file was not found');
  }
  let manifest;
  try {
    manifest = normalizeReleaseManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
      manifestPath,
    );
  } catch {
    return fail(R.INVALID_MANIFEST, 'release manifest is missing, malformed, or unreadable');
  }
  if (manifest.releaseVersion !== version) {
    return fail(
      R.INVALID_MANIFEST,
      `manifest releaseVersion ${manifest.releaseVersion} does not match expected ${version}`,
    );
  }

  // Require the COMPLETE expected package set: every release tarball must be
  // both declared in the manifest AND present on disk.
  const expected = expectedTarballEntries(version);
  const manifestByPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const diskByName = new Map(discoverTarballFiles(directory, version).map((t) => [t.fileName, t]));
  const missing = [];
  for (const entry of expected) {
    if (!manifestByPath.has(entry.fileName))
      missing.push(`${entry.fileName} (absent from manifest)`);
    else if (!diskByName.get(entry.fileName)?.exists)
      missing.push(`${entry.fileName} (file missing)`);
  }
  if (missing.length > 0) {
    return fail(
      R.INCOMPLETE_PACKAGE_SET,
      `packed release is missing ${missing.length} expected package(s): ${summarizeFailures(missing)}`,
    );
  }

  // Reuse the release-artifact authority to hash-verify every declared artifact
  // and the SHA256SUMS file BEFORE any tarball path is trusted.
  let verified;
  try {
    verified = await verifyReleaseArtifacts({
      artifactDir: directory,
      manifestPath,
      expectedVersion: `v${version}`,
    });
  } catch {
    return fail(R.INVALID_MANIFEST, 'release manifest could not be verified');
  }
  if (!verified.ok) {
    return fail(
      R.CHECKSUM_MISMATCH,
      `release artifact verification failed: ${summarizeFailures(verified.failures)}`,
    );
  }

  // Bind the checksum content into the identity digest and build the install
  // payload from the authoritative release order.
  const overrides = {};
  let cliTarball;
  for (const entry of expected) {
    const abs = join(directory, entry.fileName);
    if (entry.releaseEntry.name === 'opensip-cli') cliTarball = abs;
    else overrides[entry.releaseEntry.name] = `file:${abs}`;
  }
  if (cliTarball === undefined) {
    return fail(
      R.INCOMPLETE_PACKAGE_SET,
      'packed release does not contain the opensip-cli entry-point tarball',
    );
  }

  const checksumBody = renderSha256Sums(
    manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
    })),
  );
  const digest = createHash('sha256')
    .update('packed\n')
    .update(version)
    .update('\n')
    .update(checksumBody)
    .digest('hex');

  /** @type {CandidateIdentity} */
  const identity = Object.freeze({
    kind: 'packed-release',
    version,
    source: `packed-release@${version} (${expected.length} npm tarballs)`,
    digest,
  });

  return Object.freeze({
    ok: true,
    reasonCode: null,
    identity,
    install: Object.freeze({
      kind: 'packed-release',
      directory,
      cliTarball,
      overrides: Object.freeze(overrides),
      version,
    }),
  });
}

function resolvePublishedVersion(input) {
  const unknown = firstUnknownKey(input, PUBLISHED_KEYS);
  if (unknown !== undefined) {
    return fail(R.INVALID_INPUT, `published-version has unknown key ${JSON.stringify(unknown)}`);
  }
  const versionResult = normalizeExactVersion(input.version, 'published-version.version');
  if (!versionResult.ok) return versionResult;
  const version = versionResult.version;

  let registryUrl = NPMJS_REGISTRY;
  if (input.registry !== undefined) {
    const registryResult = validateRegistry(input.registry);
    if (!registryResult.ok) return registryResult;
    registryUrl = registryResult.url;
  }
  const registryHost = new URL(registryUrl).host;

  const digest = createHash('sha256')
    .update('published\nopensip-cli@')
    .update(version)
    .update('\n')
    .update(registryHost)
    .digest('hex');

  /** @type {CandidateIdentity} */
  const identity = Object.freeze({
    kind: 'published-version',
    version,
    source: `npm:opensip-cli@${version}`,
    digest,
    registry: registryHost,
  });

  return Object.freeze({
    ok: true,
    reasonCode: null,
    identity,
    install: Object.freeze({
      kind: 'published-version',
      spec: `opensip-cli@${version}`,
      version,
      registry: registryUrl,
    }),
  });
}

function normalizeExactVersion(raw, label) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(R.INVALID_VERSION, `${label} must be a non-empty string`);
  }
  if (hasControlChars(raw)) {
    return fail(R.INVALID_VERSION, `${label} contains control characters`);
  }
  let version;
  try {
    version = normalizeVersion(raw);
  } catch {
    return fail(R.INVALID_VERSION, `${label} must be a non-empty version`);
  }
  if (!EXACT_SEMVER.test(version)) {
    return fail(
      R.INVALID_VERSION,
      `${label} ${JSON.stringify(raw)} is not an exact semver (tags, ranges, URLs, and paths are rejected)`,
    );
  }
  return { ok: true, version };
}

function validateRegistry(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(R.INVALID_REGISTRY, 'registry must be a non-empty string');
  }
  if (hasControlChars(value)) {
    return fail(R.INVALID_REGISTRY, 'registry contains control characters');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return fail(R.INVALID_REGISTRY, 'registry is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    return fail(R.INVALID_REGISTRY, 'registry must use https://');
  }
  if (url.username !== '' || url.password !== '') {
    return fail(R.INVALID_REGISTRY, 'registry must not embed credentials');
  }
  return { ok: true, url: url.href };
}

/**
 * Derive the two installed descriptors for an install rooted under `runRoot`,
 * WITHOUT parsing any shim text:
 *   (a) `installedBin` — the platform-aware customer invocation shim
 *       (`.../opensip`, or `.../opensip.cmd` on Windows). Its realpath must
 *       resolve under the run root.
 *   (b) `jsEntrypoint` — the package JS entrypoint derived ONLY from the
 *       installed `opensip-cli` package's validated `package.json#bin.opensip`,
 *       realpathed under the run root. A `.cmd`/non-JS bin value is rejected.
 *
 * Returns `{ ok: true, installedBin, jsEntrypoint }` or `{ ok: false,
 * reasonCode, message }`. Never falls back to a workspace dist path or ambient
 * PATH.
 *
 * @param {{ runRoot: string, packageDir: string, binDir: string, platform?: string }} options
 */
export function resolveInstalledDescriptors(options) {
  if (!isPlainObject(options)) {
    return fail(R.INVALID_INPUT, 'descriptor options must be an object');
  }
  const { runRoot, packageDir, binDir } = options;
  const platform = options.platform ?? process.platform;
  for (const [name, value] of [
    ['runRoot', runRoot],
    ['packageDir', packageDir],
    ['binDir', binDir],
  ]) {
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      return fail(R.INVALID_INPUT, `${name} must be an absolute path`);
    }
  }
  let rootReal;
  try {
    rootReal = realpathSync(runRoot);
  } catch {
    return fail(R.INVALID_INPUT, 'runRoot does not exist');
  }

  // (a) the customer invocation shim — invoked exactly as a customer would, but
  // its realpath is required to resolve under the run root.
  const binName = platform === 'win32' ? 'opensip.cmd' : 'opensip';
  const binPath = join(binDir, binName);
  if (!existsSync(binPath)) {
    return fail(R.INSTALL_FAILED, 'installed customer bin was not produced by the install');
  }
  let binReal;
  try {
    binReal = realpathSync(binPath);
  } catch {
    return fail(R.INSTALL_FAILED, 'installed customer bin could not be resolved');
  }
  if (!isUnderRoot(rootReal, binReal)) {
    return fail(R.CANDIDATE_BINARY_ESCAPE, 'installed customer bin resolves outside the run root');
  }

  // (b) the JS entrypoint from the validated package.json#bin.
  const entrypoint = resolvePackageEntrypoint(packageDir, rootReal);
  if (!entrypoint.ok) return entrypoint;

  return Object.freeze({
    ok: true,
    reasonCode: null,
    installedBin: Object.freeze({ kind: 'installed-bin', bin: binPath }),
    jsEntrypoint: Object.freeze({
      kind: 'node-script',
      script: entrypoint.script,
    }),
  });
}

function resolvePackageEntrypoint(packageDir, rootReal) {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return fail(R.INVALID_PACKAGE_JSON, 'installed opensip-cli package.json was not found');
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return fail(R.INVALID_PACKAGE_JSON, 'installed opensip-cli package.json is not valid JSON');
  }
  if (!isPlainObject(pkg)) {
    return fail(R.INVALID_PACKAGE_JSON, 'installed opensip-cli package.json is not an object');
  }
  if (pkg.name !== 'opensip-cli') {
    return fail(
      R.INVALID_PACKAGE_JSON,
      `installed package name is ${JSON.stringify(pkg.name)}, expected "opensip-cli"`,
    );
  }
  const binValue = extractBinValue(pkg.bin);
  if (binValue === undefined) {
    return fail(R.INVALID_PACKAGE_JSON, 'package.json#bin does not declare the opensip command');
  }
  if (typeof binValue !== 'string' || binValue.length === 0 || hasControlChars(binValue)) {
    return fail(R.INVALID_PACKAGE_JSON, 'package.json#bin.opensip is not a usable path');
  }
  // The entrypoint must be a package-relative POSIX path to a JS file. A `.cmd`
  // shim, an absolute path, a parent escape, or a backslash path is rejected —
  // a JS entrypoint is never a shim.
  if (isAbsolute(binValue) || binValue.includes('\\') || binValue.split('/').includes('..')) {
    return fail(R.INVALID_ENTRYPOINT, 'package.json#bin.opensip must be a package-relative path');
  }
  if (!/\.(?:js|mjs|cjs)$/i.test(binValue)) {
    return fail(
      R.INVALID_ENTRYPOINT,
      'package.json#bin.opensip must reference a JS file (.js/.mjs/.cjs)',
    );
  }
  const abs = resolve(packageDir, binValue);
  if (!existsSync(abs)) {
    return fail(R.INVALID_ENTRYPOINT, 'package JS entrypoint file does not exist');
  }
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return fail(R.INVALID_ENTRYPOINT, 'package JS entrypoint could not be resolved');
  }
  if (!isUnderRoot(rootReal, real)) {
    return fail(R.CANDIDATE_BINARY_ESCAPE, 'package JS entrypoint resolves outside the run root');
  }
  return { ok: true, script: real };
}

/**
 * Extract the `opensip` command target from a package `bin` field. `bin` is
 * either a string (single-bin: the target is the JS file itself) or an object
 * keyed by command name.
 */
function extractBinValue(bin) {
  if (typeof bin === 'string') return bin;
  if (isPlainObject(bin)) return bin.opensip;
}
