import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildReleaseArtifacts } from '../build-release-artifacts.mjs';
import {
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_SBOM_NAME,
  expectedTarballName,
  parseSha256Sums,
} from '../lib/release-artifacts.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';
import { verifyReleaseArtifacts } from '../verify-release-artifacts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ACTIONS_ATTEST_SHA = 'f6bf1532d7d6793fce74eac584813a8eee607999';

test('release artifact generator writes a verifiable manifest, checksums, and SBOM', async () => {
  const dir = makeReleaseDir('0.2.4');
  try {
    const result = await buildReleaseArtifacts({
      artifactDir: dir,
      expectedVersion: '0.2.4',
      gitTag: 'v0.2.4',
      gitSha: 'abc123',
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    assert.equal(result.manifest.releaseVersion, '0.2.4');
    assert.equal(result.manifest.artifacts.length, RELEASE_PACKAGE_ORDER.length + 1);
    assert.equal(
      result.manifest.artifacts.filter((entry) => entry.kind === 'npm-tarball').length,
      RELEASE_PACKAGE_ORDER.length,
    );
    assert.equal(result.manifest.artifacts.at(-1)?.path, RELEASE_SBOM_NAME);
    assert.equal(
      result.manifest.artifacts.some((entry) => entry.path === RELEASE_MANIFEST_NAME),
      false,
      'the manifest must not contain its own digest',
    );
    assert.equal(
      result.manifest.artifacts.some((entry) => entry.path === RELEASE_CHECKSUMS_NAME),
      false,
      'SHA256SUMS is the verifier input, not a manifest subject',
    );

    const checksumEntries = parseSha256Sums(
      readFileSync(join(dir, RELEASE_CHECKSUMS_NAME), 'utf8'),
    );
    assert.equal(checksumEntries.length, result.manifest.artifacts.length + 1);
    assert.ok(
      checksumEntries.some((entry) => entry.path === RELEASE_MANIFEST_NAME),
      'SHA256SUMS must carry the manifest digest',
    );
    const sbom = JSON.parse(readFileSync(join(dir, RELEASE_SBOM_NAME), 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.ok(
      sbom.components.some((component) => component.name === '@opensip-cli/core'),
      'release-set SBOM must include publishable OpenSIP packages',
    );
    assert.ok(
      sbom.dependencies.some(
        (entry) =>
          entry.ref === 'npm:opensip-cli@0.2.4' &&
          entry.dependsOn.includes('npm:@opensip-cli/core@0.2.4'),
      ),
      'release-set SBOM must include inter-package dependency edges',
    );

    const verified = await verifyReleaseArtifacts({
      artifactDir: dir,
      manifestPath: join(dir, RELEASE_MANIFEST_NAME),
      expectedVersion: 'v0.2.4',
    });
    assert.equal(verified.ok, true, verified.failures.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release artifact verifier rejects tampered tarballs', async () => {
  const dir = makeReleaseDir('0.2.4');
  try {
    await buildReleaseArtifacts({
      artifactDir: dir,
      expectedVersion: '0.2.4',
      gitTag: 'v0.2.4',
      gitSha: 'abc123',
      sbomFile: writeSbomFixture(dir),
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    const firstTarball = expectedTarballName(RELEASE_PACKAGE_ORDER[0], '0.2.4');
    writeFileSync(join(dir, firstTarball), '\nmodified after manifest\n', { flag: 'a' });

    const verified = await verifyReleaseArtifacts({
      artifactDir: dir,
      manifestPath: join(dir, RELEASE_MANIFEST_NAME),
      expectedVersion: 'v0.2.4',
    });
    assert.equal(verified.ok, false);
    assert.match(verified.failures.join('\n'), /sha256 mismatch|size mismatch/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release artifact verifier rejects incomplete checksum subject lists', async () => {
  const dir = makeReleaseDir('0.2.4');
  try {
    await buildReleaseArtifacts({
      artifactDir: dir,
      expectedVersion: '0.2.4',
      gitTag: 'v0.2.4',
      gitSha: 'abc123',
      sbomFile: writeSbomFixture(dir),
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    const firstTarball = expectedTarballName(RELEASE_PACKAGE_ORDER[0], '0.2.4');
    const checksumsPath = join(dir, RELEASE_CHECKSUMS_NAME);
    const checksums = readFileSync(checksumsPath, 'utf8')
      .split('\n')
      .filter((line) => !line.endsWith(`  ${firstTarball}`))
      .join('\n');
    writeFileSync(checksumsPath, `${checksums.trimEnd()}\n`, 'utf8');

    const verified = await verifyReleaseArtifacts({
      artifactDir: dir,
      manifestPath: join(dir, RELEASE_MANIFEST_NAME),
      expectedVersion: 'v0.2.4',
    });
    assert.equal(verified.ok, false);
    assert.match(
      verified.failures.join('\n'),
      new RegExp(`${escapeRegExp(firstTarball)}: missing from ${RELEASE_CHECKSUMS_NAME}`, 'u'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release workflow pins artifact attestations and uploads verification files', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /attestations:\s*write/u);
  assert.match(workflow, /artifact-metadata:\s*write/u);
  assert.match(workflow, new RegExp(`uses:\\s*actions/attest@${ACTIONS_ATTEST_SHA}`, 'u'));
  assert.match(workflow, /subject-checksums:\s*\/tmp\/tarballs\/SHA256SUMS/u);
  assert.match(workflow, /subject-path:\s*\/tmp\/tarballs\/SHA256SUMS/u);
  assert.match(workflow, /sbom-path:\s*\/tmp\/tarballs\/opensip-cli-sbom\.cyclonedx\.json/u);

  const generateIndex = workflow.indexOf('scripts/build-release-artifacts.mjs');
  const verifyIndex = workflow.indexOf('scripts/verify-release-artifacts.mjs');
  const smokeIndex = workflow.indexOf('scripts/smoke-pack.mjs');
  const publishIndex = workflow.indexOf('Publish via npm');
  assert.ok(generateIndex > 0, 'release artifacts must be generated');
  assert.ok(verifyIndex > generateIndex, 'release artifacts must be verified after generation');
  assert.ok(smokeIndex > verifyIndex, 'packed bytes must be smoked after verification');
  assert.ok(publishIndex > smokeIndex, 'publish must happen after artifact verification and smoke');

  for (const artifact of [RELEASE_MANIFEST_NAME, RELEASE_CHECKSUMS_NAME, RELEASE_SBOM_NAME]) {
    assert.match(workflow, new RegExp(`/tmp/tarballs/${escapeRegExp(artifact)}`, 'u'));
  }
});

function makeReleaseDir(version) {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-release-artifacts-'));
  for (const entry of RELEASE_PACKAGE_ORDER) {
    const fileName = expectedTarballName(entry, version);
    writeFileSync(join(dir, fileName), `${entry.name}@${version}\n`, 'utf8');
  }
  return dir;
}

function writeSbomFixture(dir) {
  const sbomPath = join(dir, 'fixture-sbom.json');
  writeFileSync(
    sbomPath,
    `${JSON.stringify(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        components: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return sbomPath;
}

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
