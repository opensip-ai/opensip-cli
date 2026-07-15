/**
 * @fileoverview Phase 6 residual coverage — candidate SOURCE resolution + the
 * post-install descriptor derivation (the supply-chain trust boundary).
 *
 * Parser cases NEVER reach npm/network. Packed-release cases build a SYNTHETIC
 * signed-by-checksum release directory in a tmp dir (real SHA256SUMS + manifest
 * via `scripts/lib/release-artifacts.mjs` + `scripts/build-release-artifacts.mjs`)
 * and prove complete-set acceptance plus every tamper rejection. Descriptor
 * derivation proves the JS entrypoint comes ONLY from a validated installed
 * `package.json#bin`, never from shim text, and never escapes the run root.
 *
 * Runs under `node --test` (`pnpm test:scripts`). Offline; no registry.
 */

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { buildReleaseArtifacts } from '../build-release-artifacts.mjs';
import {
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  expectedTarballName,
} from '../lib/release-artifacts.mjs';
import {
  CANDIDATE_REASON_CODES,
  resolveCandidateSource,
  resolveInstalledDescriptors,
} from '../platform-acceptance/candidate-source.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

const roots = [];
function tmpRoot(prefix = 'pa-candidate-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Await a candidate resolution and return only its reason code. */
async function reasonCodeOf(input) {
  const result = await resolveCandidateSource(input);
  return result.reasonCode;
}

// ---------------------------------------------------------------------------
// published-version parser (pure — no filesystem, no network)
// ---------------------------------------------------------------------------

test('published-version accepts an exact semver (incl. prerelease/build metadata)', async () => {
  for (const version of ['0.7.0', '1.2.3', '2.0.0-rc.1', '3.4.5+build.7']) {
    const result = await resolveCandidateSource({ kind: 'published-version', version });
    assert.equal(result.ok, true, `${version}: ${result.message}`);
    assert.equal(result.identity.version, version);
    assert.equal(result.identity.registry, 'registry.npmjs.org');
    assert.equal(result.install.spec, `opensip-cli@${version}`);
  }
});

test('published-version rejects tags, ranges, git/file specs, and control characters', async () => {
  for (const version of [
    'latest',
    '^1.0.0',
    '~1.2',
    '1.x',
    '>=1.0.0',
    '*',
    'git+https://x/y.git',
    'file:../x',
    '1.0.0\n',
  ]) {
    const result = await resolveCandidateSource({ kind: 'published-version', version });
    assert.equal(result.ok, false, `${JSON.stringify(version)} should be rejected`);
    assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INVALID_VERSION);
  }
});

test('published-version rejects credentialed and non-HTTPS registries but accepts a plain HTTPS mirror', async () => {
  const credentialed = await resolveCandidateSource({
    kind: 'published-version',
    version: '0.7.0',
    registry: 'https://user:pass@mirror.example/',
  });
  assert.equal(credentialed.ok, false);
  assert.equal(credentialed.reasonCode, CANDIDATE_REASON_CODES.INVALID_REGISTRY);

  const http = await resolveCandidateSource({
    kind: 'published-version',
    version: '0.7.0',
    registry: 'http://mirror.example/',
  });
  assert.equal(http.ok, false);
  assert.equal(http.reasonCode, CANDIDATE_REASON_CODES.INVALID_REGISTRY);

  const ok = await resolveCandidateSource({
    kind: 'published-version',
    version: '0.7.0',
    registry: 'https://mirror.example/',
  });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.identity.registry, 'mirror.example');
});

test('resolveCandidateSource rejects a non-object, an unknown kind, and unknown keys', async () => {
  assert.equal(await reasonCodeOf('nope'), CANDIDATE_REASON_CODES.INVALID_INPUT);
  assert.equal(await reasonCodeOf({ kind: 'sideload' }), CANDIDATE_REASON_CODES.UNKNOWN_KIND);
  assert.equal(
    await reasonCodeOf({ kind: 'published-version', version: '0.7.0', rogue: 1 }),
    CANDIDATE_REASON_CODES.INVALID_INPUT,
  );
  assert.equal(
    await reasonCodeOf({
      kind: 'packed-release',
      directory: '/x',
      expectedVersion: '0.7.0',
      rogue: 1,
    }),
    CANDIDATE_REASON_CODES.INVALID_INPUT,
  );
});

// ---------------------------------------------------------------------------
// packed-release resolution against a SYNTHETIC signed release directory
// ---------------------------------------------------------------------------

let pristineDir;

before(async () => {
  pristineDir = tmpRoot('pa-release-pristine-');
  for (const entry of RELEASE_PACKAGE_ORDER) {
    writeFileSync(
      join(pristineDir, expectedTarballName(entry, VERSION)),
      `${entry.name}@${VERSION}\n`,
      'utf8',
    );
  }
  await buildReleaseArtifacts({
    artifactDir: pristineDir,
    expectedVersion: VERSION,
    gitTag: `v${VERSION}`,
    gitSha: 'abc123',
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
});

/** Copy the pristine signed dir, apply a destructive mutation, and return the copy. */
function mutatedRelease(
  mutate = () => {
    /* no mutation by default */
  },
) {
  const dir = tmpRoot('pa-release-');
  cpSync(pristineDir, dir, { recursive: true });
  mutate(dir);
  return dir;
}

test('packed-release accepts a complete signed set and binds a redacted identity', async () => {
  const dir = mutatedRelease();
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: dir,
    expectedVersion: VERSION,
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.identity.kind, 'packed-release');
  assert.equal(result.identity.version, VERSION);
  assert.match(result.identity.digest, /^[a-f0-9]{64}$/);
  // The redacted source string must never carry the absolute directory path.
  assert.ok(!result.identity.source.includes(dir), result.identity.source);
  assert.equal(result.install.kind, 'packed-release');
  assert.ok(result.install.cliTarball.endsWith(`opensip-cli-${VERSION}.tgz`));
});

test('packed-release rejects a missing directory', async () => {
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: join(tmpdir(), 'does-not-exist-xyz-pa'),
    expectedVersion: VERSION,
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.MISSING_DIRECTORY);
});

test('packed-release rejects an incomplete package set (a removed tarball file)', async () => {
  const dir = mutatedRelease((d) => {
    rmSync(join(d, expectedTarballName(RELEASE_PACKAGE_ORDER[0], VERSION)));
  });
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: dir,
    expectedVersion: VERSION,
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INCOMPLETE_PACKAGE_SET);
});

test('packed-release rejects a checksum mismatch (a tampered tarball)', async () => {
  const dir = mutatedRelease((d) => {
    writeFileSync(join(d, expectedTarballName(RELEASE_PACKAGE_ORDER[0], VERSION)), 'tampered\n', {
      flag: 'a',
    });
  });
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: dir,
    expectedVersion: VERSION,
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH);
});

test('packed-release rejects an unexpected extra entry in SHA256SUMS', async () => {
  const dir = mutatedRelease((d) => {
    const checksums = join(d, RELEASE_CHECKSUMS_NAME);
    const body = readFileSync(checksums, 'utf8');
    writeFileSync(checksums, `${body}${'0'.repeat(64)}  unexpected-extra.tgz\n`);
  });
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: dir,
    expectedVersion: VERSION,
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH);
});

test('packed-release rejects a manifest releaseVersion that does not match the expected version', async () => {
  const dir = mutatedRelease();
  const result = await resolveCandidateSource({
    kind: 'packed-release',
    directory: dir,
    expectedVersion: '9.9.9',
  });
  // '9.9.9' is a valid exact semver, so this reaches the manifest cross-check.
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INVALID_MANIFEST);
});

test('packed-release rejects a missing / unsafe manifest', async () => {
  const missing = mutatedRelease((d) => rmSync(join(d, RELEASE_MANIFEST_NAME)));
  assert.equal(
    await reasonCodeOf({ kind: 'packed-release', directory: missing, expectedVersion: VERSION }),
    CANDIDATE_REASON_CODES.INVALID_MANIFEST,
  );

  const unsafe = mutatedRelease((d) => {
    const manifest = JSON.parse(readFileSync(join(d, RELEASE_MANIFEST_NAME), 'utf8'));
    manifest.artifacts[0].path = '../escape.tgz';
    writeFileSync(join(d, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  });
  assert.equal(
    await reasonCodeOf({ kind: 'packed-release', directory: unsafe, expectedVersion: VERSION }),
    CANDIDATE_REASON_CODES.INVALID_MANIFEST,
  );
});

test('packed-release rejects a non-exact expected version before touching the directory', async () => {
  const dir = mutatedRelease();
  assert.equal(
    await reasonCodeOf({ kind: 'packed-release', directory: dir, expectedVersion: 'latest' }),
    CANDIDATE_REASON_CODES.INVALID_VERSION,
  );
});

// ---------------------------------------------------------------------------
// resolveInstalledDescriptors — customer shim + JS entrypoint from package.json#bin
// ---------------------------------------------------------------------------

/**
 * Build a run-owned installed layout and return the descriptor inputs.
 * `overrides.bin` sets `package.json#bin`; `overrides.entrypointRel` the JS file.
 */
function installedLayout(overrides = {}) {
  const runRoot = tmpRoot('pa-installed-');
  const packageDir = join(runRoot, 'node_modules', 'opensip-cli');
  const binDir = join(runRoot, 'node_modules', '.bin');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const entrypointRel = overrides.entrypointRel ?? 'dist/index.js';
  if (overrides.writeEntrypoint !== false) {
    writeFileSync(join(packageDir, entrypointRel), '#!/usr/bin/env node\n');
  }
  const pkg = {
    name: overrides.name ?? 'opensip-cli',
    version: overrides.version ?? VERSION,
    bin: overrides.bin ?? { opensip: entrypointRel },
  };
  if (overrides.writePackageJson !== false) {
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  const binName = overrides.platform === 'win32' ? 'opensip.cmd' : 'opensip';
  if (overrides.writeShim !== false) {
    writeFileSync(join(binDir, binName), 'shim\n');
  }
  return { runRoot, packageDir, binDir, platform: overrides.platform };
}

test('resolveInstalledDescriptors resolves a valid POSIX install (object bin) and a single-string bin', () => {
  const objectBin = installedLayout();
  const objectResult = resolveInstalledDescriptors({
    runRoot: objectBin.runRoot,
    packageDir: objectBin.packageDir,
    binDir: objectBin.binDir,
    platform: 'linux',
  });
  assert.equal(objectResult.ok, true, objectResult.message);
  assert.ok(objectResult.installedBin.bin.endsWith('/opensip'));
  assert.ok(objectResult.jsEntrypoint.script.endsWith('dist/index.js'));

  const stringBin = installedLayout({ bin: 'dist/index.js' });
  const stringResult = resolveInstalledDescriptors({
    runRoot: stringBin.runRoot,
    packageDir: stringBin.packageDir,
    binDir: stringBin.binDir,
    platform: 'linux',
  });
  assert.equal(stringResult.ok, true, stringResult.message);
});

test('resolveInstalledDescriptors resolves a Windows install via opensip.cmd', () => {
  const layout = installedLayout({ platform: 'win32' });
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'win32',
  });
  assert.equal(result.ok, true, result.message);
  assert.ok(result.installedBin.bin.endsWith('opensip.cmd'));
  // The JS entrypoint is still the package's real .js file, never the .cmd shim.
  assert.ok(result.jsEntrypoint.script.endsWith('index.js'));
});

test('resolveInstalledDescriptors rejects non-absolute descriptor inputs', () => {
  const layout = installedLayout();
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: 'relative/pkg',
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INVALID_INPUT);
});

test('resolveInstalledDescriptors fails when the customer shim was not produced', () => {
  const layout = installedLayout({ writeShim: false });
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INSTALL_FAILED);
});

test('resolveInstalledDescriptors derives the entrypoint ONLY from package.json#bin, rejecting a .cmd value even when a shim file exists', () => {
  const layout = installedLayout({ bin: { opensip: 'opensip.cmd' } });
  // A real opensip.cmd exists in the package dir — but bin-text is never trusted.
  writeFileSync(join(layout.packageDir, 'opensip.cmd'), '@echo off\n');
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT);
});

test('resolveInstalledDescriptors rejects missing, absolute, escaping, and non-JS bin values', () => {
  const cases = [
    { bin: {}, code: CANDIDATE_REASON_CODES.INVALID_PACKAGE_JSON },
    { bin: { opensip: '/abs/index.js' }, code: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT },
    { bin: { opensip: '../escape.js' }, code: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT },
    { bin: { opensip: 'dist\\index.js' }, code: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT },
    { bin: { opensip: 'dist/index.txt' }, code: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT },
  ];
  for (const { bin, code } of cases) {
    const layout = installedLayout({ bin });
    const result = resolveInstalledDescriptors({
      runRoot: layout.runRoot,
      packageDir: layout.packageDir,
      binDir: layout.binDir,
      platform: 'linux',
    });
    assert.equal(result.reasonCode, code, `bin=${JSON.stringify(bin)}`);
  }
});

test('resolveInstalledDescriptors rejects a package name that is not opensip-cli', () => {
  const layout = installedLayout({ name: 'not-opensip' });
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.INVALID_PACKAGE_JSON);
});

test('resolveInstalledDescriptors rejects a JS entrypoint whose realpath escapes the run root', () => {
  const outside = tmpRoot('pa-outside-');
  const outsideEntry = join(outside, 'evil.js');
  writeFileSync(outsideEntry, 'export default 1;\n');
  const layout = installedLayout({ writeEntrypoint: false });
  // The declared package-relative entrypoint is a symlink to a file OUTSIDE the run root.
  symlinkSync(outsideEntry, join(layout.packageDir, 'dist', 'index.js'));
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.CANDIDATE_BINARY_ESCAPE);
});

test('resolveInstalledDescriptors rejects a customer shim whose realpath escapes the run root', () => {
  const outside = tmpRoot('pa-outside-shim-');
  const outsideShim = join(outside, 'opensip');
  writeFileSync(outsideShim, 'shim\n');
  const layout = installedLayout({ writeShim: false });
  symlinkSync(outsideShim, join(layout.binDir, 'opensip'));
  const result = resolveInstalledDescriptors({
    runRoot: layout.runRoot,
    packageDir: layout.packageDir,
    binDir: layout.binDir,
    platform: 'linux',
  });
  assert.equal(result.reasonCode, CANDIDATE_REASON_CODES.CANDIDATE_BINARY_ESCAPE);
});
