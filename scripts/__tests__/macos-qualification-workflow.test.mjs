/**
 * @fileoverview Phase 5 (Task 5.3) — macOS qualification WORKFLOW TOPOLOGY.
 *
 * The qualification lanes run only on GitHub-hosted macOS and cannot be exercised
 * in a unit test, so their SAFETY INVARIANTS are enforced here by parsing the
 * committed workflow YAML deterministically (string/regex only — no YAML runtime,
 * so this runs on a bare checkout in `pnpm test:scripts` on every PR).
 *
 * It asserts the two properties a broken split would silently regress:
 *   1. the scheduled `macos-qualification.yml` lane pins the exact runner/actions,
 *      is least-privilege, and always uploads evidence; and
 *   2. `release.yml` keeps the four-job `build-release → stage-release →
 *      qualify-macos → promote-release` topology in which repository code
 *      runs outside the credentialed stage boundary and verified macOS evidence
 *      is a HARD dependency between npm staging publish and `latest` promotion —
 *      the promotion secret, `dist-tag add`, and GitHub Release live ONLY in the
 *      final job, and the Mac job holds no publish/promotion credential.
 *
 * The supply-chain verifier (scripts/verify-supply-chain.mjs) and the
 * release-artifact test enforce overlapping guarantees; this file is the
 * dedicated, exhaustive topology regression gate.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildReleaseArtifacts } from '../build-release-artifacts.mjs';
import {
  RELEASE_CHECKSUMS_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_SBOM_NAME,
  expectedTarballName,
  renderSha256Sums,
} from '../lib/release-artifacts.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

import {
  composeProfile,
  isJourneyApplicable,
  isJourneyRequired,
  parseAcceptanceProfile,
} from '../platform-acceptance/contract.mjs';
import { FULL_SHA, SHA_PIN } from '../lib/github-workflow-asserts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROFILE_ROOT = join(REPO_ROOT, '.config', 'platform-acceptance');
const WORKSPACE_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const STAGE_GIT_SHA = 'a'.repeat(40);

const COMMON_PROFILE = parseAcceptanceProfile(
  JSON.parse(readFileSync(join(PROFILE_ROOT, 'common-v1.json'), 'utf8')),
);
const MACOS_PROFILE_RAW = JSON.parse(
  readFileSync(join(PROFILE_ROOT, 'macos-26-arm64-node24-npm11-v1.json'), 'utf8'),
);
const MACOS_PROFILE = composeProfile(COMMON_PROFILE, MACOS_PROFILE_RAW);

function readWorkflow(name) {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
}

/** Drop whole-line YAML comments so prose can never satisfy/violate a check. */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Slice a workflow into `Map<jobId, segment>` by 2-space-indented job headers. */
function sliceJobs(content) {
  const headerRe = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm;
  const headers = [];
  for (let m = headerRe.exec(content); m !== null; m = headerRe.exec(content)) {
    headers.push({ name: m[1], start: m.index });
  }
  const jobs = new Map();
  for (const [i, header] of headers.entries()) {
    const end = i + 1 < headers.length ? headers[i + 1].start : content.length;
    jobs.set(header.name, content.slice(header.start, end));
  }
  return jobs;
}

function extractStageValidator() {
  const stage = sliceJobs(readWorkflow('release.yml')).get('stage-release');
  const inlineMatch = /node <<'NODE'\n([\s\S]*?)\n\s+NODE/u.exec(stage);
  assert.notEqual(inlineMatch, null, 'the closed bundle verifier must remain inline');
  return inlineMatch[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/u, ''))
    .join('\n');
}

async function createStageBundle({ lifecycleScripts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-stage-bundle-'));
  const sourceDir = join(dir, 'tar-source');
  const packageDir = join(sourceDir, 'package');
  mkdirSync(packageDir, { recursive: true });
  for (const [index, entry] of RELEASE_PACKAGE_ORDER.entries()) {
    const packageJson = {
      name: entry.name,
      version: WORKSPACE_VERSION,
      ...(index === 0 && lifecycleScripts !== undefined ? { scripts: lifecycleScripts } : {}),
    };
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(packageJson)}\n`, 'utf8');
    const tarball = join(dir, expectedTarballName(entry, WORKSPACE_VERSION));
    const packed = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', sourceDir, 'package'], {
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr || `could not create ${tarball}`);
  }
  rmSync(sourceDir, { recursive: true, force: true });
  const result = await buildReleaseArtifacts({
    artifactDir: dir,
    expectedVersion: WORKSPACE_VERSION,
    gitTag: `v${WORKSPACE_VERSION}`,
    gitSha: STAGE_GIT_SHA,
    now: new Date('2026-07-15T00:00:00.000Z'),
  });
  return { dir, manifestDigest: sha256(readFileSync(result.manifestPath)) };
}

function rewriteStageManifest(dir, mutate) {
  const manifestPath = join(dir, RELEASE_MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestDigest = sha256(readFileSync(manifestPath));
  const checksums = renderSha256Sums([
    ...manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
    })),
    { path: RELEASE_MANIFEST_NAME, sha256: manifestDigest },
  ]);
  writeFileSync(join(dir, RELEASE_CHECKSUMS_NAME), checksums, 'utf8');
  return manifestDigest;
}

function replaceStageSbom(dir, sbom) {
  const sbomPath = join(dir, RELEASE_SBOM_NAME);
  writeFileSync(sbomPath, `${JSON.stringify(sbom)}\n`, 'utf8');
  const sbomBytes = readFileSync(sbomPath);
  return rewriteStageManifest(dir, (manifest) => {
    const artifact = manifest.artifacts.find((entry) => entry.path === RELEASE_SBOM_NAME);
    assert.notEqual(artifact, undefined, 'fixture manifest must contain the SBOM');
    artifact.sha256 = sha256(sbomBytes);
    artifact.sizeBytes = sbomBytes.length;
  });
}

function runStageValidator(dir, manifestDigest, environment = {}) {
  return spawnSync(process.execPath, [], {
    input: extractStageValidator(),
    encoding: 'utf8',
    env: {
      ...process.env,
      BUNDLE_DIR: dir,
      VERSION: WORKSPACE_VERSION,
      TAG: `v${WORKSPACE_VERSION}`,
      GIT_SHA: STAGE_GIT_SHA,
      STAGING_TAG: `release-candidate-${WORKSPACE_VERSION}`,
      GITHUB_REF_NAME: `v${WORKSPACE_VERSION}`,
      GITHUB_SHA: STAGE_GIT_SHA,
      MANIFEST_DIGEST: manifestDigest,
      ...environment,
    },
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ===========================================================================
// Scheduled packed-candidate lane — .github/workflows/macos-qualification.yml
// ===========================================================================

test('macos-qualification.yml pins the exact runner and never floats a label', () => {
  const raw = readWorkflow('macos-qualification.yml');
  const wf = stripComments(raw);
  assert.match(wf, /runs-on:\s*macos-26\b/, 'the qualification lane must pin macos-26');
  assert.doesNotMatch(wf, /macos-latest/, 'macos-latest is forbidden — it can silently drift');
  assert.doesNotMatch(wf, /runs-on:\s*macos-\d+-(?:large|intel|x64)/, 'no Intel/large label');
});

test('macos-qualification.yml pins every action to a full commit SHA', () => {
  const wf = stripComments(readWorkflow('macos-qualification.yml'));
  const refs = [...wf.matchAll(SHA_PIN)].map((m) => m[1]);
  assert.ok(refs.length >= 3, 'the lane must use pinned actions');
  for (const ref of refs) {
    assert.match(ref, FULL_SHA, `action ref ${ref} must be a full 40-char commit SHA, not a tag`);
  }
});

test('macos-qualification.yml is scheduled, bounded, concurrency-guarded, and frozen', () => {
  const wf = stripComments(readWorkflow('macos-qualification.yml'));
  assert.match(wf, /schedule:/, 'the burn-in lane must run on a schedule');
  assert.match(wf, /cron:\s*'[^']+'/, 'the schedule must declare a cron');
  assert.match(wf, /timeout-minutes:\s*\d+/, 'the job must bound its wall-clock time');
  assert.match(wf, /concurrency:/, 'the lane must declare a concurrency group');
  assert.match(wf, /pnpm install --frozen-lockfile/, 'installs must be frozen');
  // A bare `npm install` (not the `pnpm install` above, and not the pinned
  // `npm install --prefix … npm@11` bootstrap) would be a mutable ambient install.
  assert.doesNotMatch(
    wf,
    /(?<![A-Za-z])npm install\b(?![^\n]*--prefix)/,
    'no mutable ambient npm install',
  );
});

test('macos-qualification.yml is least-privilege and holds no publish/promotion credential', () => {
  const wf = stripComments(readWorkflow('macos-qualification.yml'));
  assert.match(wf, /permissions:\s*\n\s*contents:\s*read/, 'the lane must be contents: read only');
  assert.doesNotMatch(wf, /id-token:\s*write/, 'no OIDC publish token');
  assert.doesNotMatch(wf, /attestations:\s*write/, 'no attestation permission');
  assert.doesNotMatch(wf, /secrets\.MACBOOKM5/, 'no promotion secret');
  assert.doesNotMatch(wf, /\bnpm\s+publish\b/, 'the qualification lane must never publish');
  assert.doesNotMatch(wf, /npm\s+dist-tag\s+add/, 'the qualification lane must never promote');
});

test('macos-qualification.yml binds the exact profile + independent verifier and always uploads evidence', () => {
  const wf = stripComments(readWorkflow('macos-qualification.yml'));
  assert.match(
    wf,
    /\.config\/platform-acceptance\/macos-26-arm64-node24-npm11-v1\.json/,
    'the exact macOS support profile must be pinned',
  );
  assert.match(
    wf,
    /SUPPORT_ROW:\s*macos-26-arm64-node24-npm11-v1/,
    'the support row must be pinned',
  );
  assert.match(
    wf,
    /SUPPORT_CONTRACT_VERSION:\s*'1'/,
    'the support contract version must be pinned',
  );
  assert.match(
    wf,
    /scripts\/verify-platform-acceptance\.mjs/,
    'the independent verifier is the authority, not the runner console',
  );
  assert.match(wf, /--expected-support-row/, 'the verifier must bind the expected support row');
  assert.match(
    wf,
    /--expected-support-contract-version/,
    'the verifier must bind the expected contract version',
  );
  // Evidence uploads on EVERY outcome so a failure is never invisible.
  const upload = wf.slice(wf.indexOf('Upload qualification evidence'));
  assert.match(upload, /if:\s*always\(\)/, 'evidence upload must run under if: always()');
  assert.match(upload, /actions\/upload-artifact@[a-f0-9]{40}/, 'the upload action must be pinned');
  assert.match(upload, /agent-eval-installed-smoke\.json/, 'the sanitized agent report uploads');
});

test('both macOS runners preserve the agent report and bind workflow provenance', () => {
  const scheduled = stripComments(readWorkflow('macos-qualification.yml'));
  const releaseMac = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  for (const [label, job] of [
    ['scheduled', scheduled],
    ['release', releaseMac],
  ]) {
    for (const flag of [
      '--agent-report-out',
      '--expected-manifest-digest',
      '--run-id',
      '--run-attempt',
      '--runner-label macos-26',
      '--expected-git-sha',
      '--expected-run-id',
      '--expected-run-attempt',
      '--expected-runner-label macos-26',
      '--expected-sw-vers-major 26',
      '--expected-kernel-major 25',
      '--expect-uname-arch arm64',
      '--expect-case-sensitive false',
      '--expect-shell zsh',
    ]) {
      assert.match(job, new RegExp(flag.replaceAll('-', '\\-')), `${label} missing ${flag}`);
    }
  }
  assert.match(scheduled, /--expect-no-previous-candidate/);
  assert.match(releaseMac, /--expected-previous-version/);
  assert.match(releaseMac, /--expect-no-previous-candidate/);
});

test('separate-prefix npm 11 is bound into every acceptance npm invocation', () => {
  const scheduled = stripComments(readWorkflow('macos-qualification.yml'));
  const release = stripComments(readWorkflow('release.yml'));
  const seam = 'OPENSIP_ACCEPTANCE_NPM_CLI=$HOME/.npm-cli/node_modules/npm/bin/npm-cli.js';

  assert.equal(
    (scheduled.match(/npm install --prefix "\$HOME\/\.npm-cli" npm@11/gu) ?? []).length,
    1,
  );
  assert.equal(scheduled.split(seam).length - 1, 1);
  assert.match(
    scheduled,
    /if \[ "\$major" != "11" \]; then[\s\S]*npm install --prefix[\s\S]*OPENSIP_ACCEPTANCE_NPM_CLI[\s\S]*fi/,
    'the scheduled lane exports the seam only when it installs separate npm',
  );

  assert.equal(
    (release.match(/npm install --prefix "\$HOME\/\.npm-cli" npm@11/gu) ?? []).length,
    2,
  );
  assert.equal(release.split(seam).length - 1, 2);
  for (const workflow of [scheduled, release]) {
    for (const line of workflow
      .split('\n')
      .filter((entry) => /npm install --prefix "\$HOME\/\.npm-cli" npm@11/.test(entry))) {
      assert.match(line, /--registry https:\/\/registry\.npmjs\.org\//);
    }
  }
  const qualifier = sliceJobs(release).get('qualify-macos');
  const qualifierSeam = qualifier.indexOf('OPENSIP_ACCEPTANCE_NPM_CLI=');
  assert.ok(
    qualifierSeam >= 0 &&
      qualifier.indexOf('id: registry-integrity', qualifierSeam) > qualifierSeam,
    'the pinned npm seam must precede registry inventory and acceptance execution',
  );
});

test('macos-qualification path filters broadly cover measured runtime and build inputs', () => {
  const raw = readWorkflow('macos-qualification.yml');
  for (const expected of [
    "'packages/**'",
    "'scripts/**'",
    "'package.json'",
    "'pnpm-lock.yaml'",
    "'pnpm-workspace.yaml'",
    "'tsconfig*.json'",
    "'turbo.json'",
  ]) {
    assert.equal(
      raw.split(expected).length - 1,
      2,
      `${expected} must trigger both push and pull_request qualification`,
    );
  }
});

// ===========================================================================
// Release topology — .github/workflows/release.yml (four jobs)
// ===========================================================================

test('release.yml keeps the stage-release → qualify-macos → promote-release order', () => {
  const raw = readWorkflow('release.yml');
  const build = raw.indexOf('\n  build-release:');
  const stage = raw.indexOf('\n  stage-release:');
  const macos = raw.indexOf('\n  qualify-macos:');
  const promote = raw.indexOf('\n  promote-release:');
  assert.ok(build > 0 && stage > 0 && macos > 0 && promote > 0, 'all four jobs must exist');
  assert.ok(build < stage, 'build-release precedes stage-release');
  assert.ok(stage < macos, 'stage-release precedes qualify-macos');
  assert.ok(macos < promote, 'qualify-macos precedes promote-release');

  const jobs = sliceJobs(raw);
  assert.match(
    stripComments(jobs.get('stage-release')),
    /needs:\s*build-release\b/,
    'stage-release must depend on the unprivileged builder',
  );
  assert.match(
    stripComments(jobs.get('qualify-macos')),
    /needs:\s*stage-release\b/,
    'qualify-macos must depend on stage-release',
  );
  assert.match(
    stripComments(jobs.get('promote-release')),
    /needs:\s*\[[^\]]*stage-release[^\]]*qualify-macos[^\]]*\]/,
    'promote-release must need both prior jobs',
  );
});

test('release metadata artifact identity is attempt-bound and consumed through one stage output', () => {
  const raw = readWorkflow('release.yml');
  const jobs = sliceJobs(raw);
  const build = stripComments(jobs.get('build-release'));
  const stage = stripComments(jobs.get('stage-release'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promote = stripComments(jobs.get('promote-release'));

  assert.match(
    stage,
    /release-metadata-artifact:\s*\$\{\{\s*steps\.identity\.outputs\.release-metadata-artifact\s*\}\}/,
    'stage-release must expose the attempt-bound metadata artifact name',
  );
  assert.match(build, /RUN_ATTEMPT:\s*\$\{\{\s*github\.run_attempt\s*\}\}/);
  assert.match(
    build,
    /release-metadata-artifact=release-metadata-v\$\{VERSION\}-run\$\{RUN_ATTEMPT\}/,
    'the immutable v4 upload name must include the workflow attempt',
  );
  assert.match(
    stage,
    /name:\s*\$\{\{\s*steps\.identity\.outputs\.release-metadata-artifact\s*\}\}/,
    'the uploader must use the exact typed identity output',
  );
  for (const [label, job] of [
    ['qualify-macos', macos],
    ['promote-release', promote],
  ]) {
    assert.match(
      job,
      /name:\s*\$\{\{\s*needs\.stage-release\.outputs\.release-metadata-artifact\s*\}\}/,
      `${label} must download the exact stage-produced artifact name`,
    );
  }
  assert.doesNotMatch(
    raw,
    /name:\s*release-metadata-\$\{\{\s*(?:steps\.identity|needs\.stage-release)\.outputs\.tag/,
    'no consumer may reconstruct the metadata name from the tag',
  );
});

test('credentialed staging consumes only a validated immutable bundle and executes no repository code', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const build = stripComments(jobs.get('build-release'));
  const stage = stripComments(jobs.get('stage-release'));

  assert.match(build, /permissions:\s*\n\s*contents:\s*read\b/);
  for (const permission of [
    /id-token:\s*write/,
    /attestations:\s*write/,
    /artifact-metadata:\s*write/,
  ]) {
    for (const other of ['build-release', 'qualify-macos', 'promote-release']) {
      assert.doesNotMatch(
        stripComments(jobs.get(other)),
        permission,
        `${other} must not hold staging OIDC/attestation authority`,
      );
    }
    assert.match(
      stage,
      permission,
      'minimal stage-release must hold the required publish authority',
    );
  }
  assert.match(
    build,
    /release-bundle-artifact=release-staging-bundle-v\$\{VERSION\}-run\$\{RUN_ATTEMPT\}/,
  );
  assert.match(build, /Upload immutable staging bundle/);
  assert.match(stage, /needs:\s*build-release/);
  assert.match(
    stage,
    /name:\s*\$\{\{\s*needs\.build-release\.outputs\.release-bundle-artifact\s*\}\}/,
    'stage must download only the builder output, never reconstruct an artifact name',
  );
  assert.match(stage, /MANIFEST_DIGEST:\s*\$\{\{\s*needs\.build-release\.outputs\.manifest-digest/);
  assert.match(stage, /manifest digest mismatch/);
  assert.match(
    stage,
    /tag !== ambientTag \|\| gitSha !== ambientGitSha/,
    'builder identity must be bound to the authoritative event tag and SHA',
  );
  assert.match(stage, /authoritative workflow event identity/);
  assert.match(stage, /stagingTag !== `release-candidate-\$\{version\}`/);
  assert.match(stage, /stagingTag === 'latest'/);
  assert.match(stage, /echo "staging-tag=\$STAGING_TAG" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    stage,
    /STAGING_TAG:\s*\$\{\{\s*steps\.identity\.outputs\.staging-tag\s*\}\}/,
    'publish must consume the identity output derived from the strict validator',
  );
  assert.match(stage, /bundle contains missing or unexpected files/);
  assert.match(stage, /tarball package\.json identity mismatch/);
  assert.match(stage, /forbiddenLifecycleScripts = \['preinstall', 'install', 'postinstall'\]/);
  assert.match(stage, /hasOwnProperty\.call\(packageJson\.scripts, scriptName\)/);
  const expectedOrderDigest = createHash('sha256')
    .update(`${RELEASE_PACKAGE_ORDER.map((entry) => entry.name).join('\n')}\n`)
    .digest('hex');
  assert.match(stage, new RegExp(`expectedPackageOrderDigest = '${expectedOrderDigest}'`));
  assert.match(stage, /npm package set\/order does not match the reviewed canonical release order/);
  const expectedComponentSetDigest = createHash('sha256')
    .update(
      `${RELEASE_PACKAGE_ORDER.map((entry) => entry.name)
        .sort()
        .join('\n')}\n`,
    )
    .digest('hex');
  assert.match(
    stage,
    new RegExp(`expectedReleaseComponentSetDigest = '${expectedComponentSetDigest}'`),
  );
  assert.match(stage, /SBOM schema\/spec version mismatch/);
  assert.match(stage, /SBOM release metadata identity mismatch/);
  assert.match(
    stage,
    /SBOM OpenSIP component set does not match the reviewed canonical release set/,
  );
  assert.match(stage, /node-version:\s*'24\.16\.0'/, 'credentialed runtime must be exact-pinned');
  assert.match(stage, /process\.argv\[1\]!=="11\.13\.0"/);
  assert.doesNotMatch(
    stage,
    /actions\/checkout@/,
    'stage-release must not check out repository code',
  );
  assert.doesNotMatch(stage, /\bpnpm\b/, 'stage-release must not install or execute pnpm');
  assert.doesNotMatch(
    stage,
    /\bnpm\s+(?:install|ci)\b/,
    'stage-release must not install dependencies',
  );
  assert.doesNotMatch(
    stage,
    /node\s+scripts\//,
    'stage-release must not execute repository scripts',
  );
  assert.match(
    stage,
    /npm publish[\s\S]*--ignore-scripts[\s\S]*--registry https:\/\/registry\.npmjs\.org\//,
  );

  const syntax = spawnSync(process.execPath, ['--check'], {
    input: extractStageValidator(),
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr || 'inline stage validator must parse');
});

test('credentialed staging rejects hashed tarballs with customer install lifecycle hooks', async () => {
  const fixture = await createStageBundle({ lifecycleScripts: { postinstall: null } });
  try {
    const result = runStageValidator(fixture.dir, fixture.manifestDigest);
    assert.notEqual(result.status, 0, 'a postinstall key must fail even when its value is inert');
    assert.match(result.stderr, /forbidden install-time lifecycle script: postinstall/u);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('credentialed staging rejects builder identity that differs from the workflow event', async () => {
  const fixture = await createStageBundle();
  try {
    const result = runStageValidator(fixture.dir, fixture.manifestDigest, {
      GITHUB_SHA: 'b'.repeat(40),
    });
    assert.notEqual(result.status, 0, 'the builder SHA must not override the triggering SHA');
    assert.match(result.stderr, /authoritative workflow event identity/u);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('credentialed staging rejects a builder-controlled latest staging tag', async () => {
  const fixture = await createStageBundle();
  try {
    const result = runStageValidator(fixture.dir, fixture.manifestDigest, {
      STAGING_TAG: 'latest',
    });
    assert.notEqual(result.status, 0, 'the builder must not bypass qualification via latest');
    assert.match(result.stderr, /exact version-scoped release-candidate tag/u);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('credentialed staging rejects an internally consistent fake CycloneDX SBOM', async () => {
  const fixture = await createStageBundle();
  try {
    const manifestDigest = replaceStageSbom(fixture.dir, { bomFormat: 'CycloneDX' });
    const result = runStageValidator(fixture.dir, manifestDigest);
    assert.notEqual(result.status, 0, 'a format-only SBOM replacement must fail closed');
    assert.match(result.stderr, /SBOM schema\/spec version mismatch/u);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('credentialed staging rejects an internally consistent noncanonical package order', async () => {
  const fixture = await createStageBundle();
  try {
    const manifestDigest = rewriteStageManifest(fixture.dir, (manifest) => {
      const firstArtifact = manifest.artifacts[0];
      manifest.artifacts[0] = manifest.artifacts[1];
      manifest.artifacts[1] = firstArtifact;
    });
    const result = runStageValidator(fixture.dir, manifestDigest);
    assert.notEqual(result.status, 0, 'a reordered package manifest must fail closed');
    assert.match(
      result.stderr,
      /npm package set\/order does not match the reviewed canonical release order/u,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('previous-version resolution recovers the newest prior stable Release and fails closed', () => {
  const build = stripComments(sliceJobs(readWorkflow('release.yml')).get('build-release'));
  const resolver = build.slice(build.indexOf('Resolve currently promoted latest'));

  assert.match(build, /permissions:\s*\n\s*contents:\s*read/, 'GitHub Release lookup is read-only');
  assert.doesNotMatch(build, /contents:\s*write/, 'build-release must not mutate Releases');
  assert.match(resolver, /npm view opensip-cli@latest version/, 'npm latest stays primary');
  assert.match(resolver, /\[ "\$prev" != "\$candidate" \]/, 'ordinary releases use npm latest');
  assert.match(
    resolver,
    /release-version-policy\.mjs normalize-stable/,
    'candidate and latest must be stable exact SemVer',
  );
  assert.match(
    resolver,
    /release-version-policy\.mjs assert-upgrade "\$1" "\$2"/,
    'candidate must have strictly greater SemVer precedence',
  );
  assert.match(resolver, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(
    resolver,
    /gh api --paginate "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100"/,
  );
  assert.doesNotMatch(resolver, /gh api[^\n]*--method/, 'GitHub API calls must remain GET-only');
  assert.match(
    resolver,
    /select\(\.draft == false and \.prerelease == false\)/,
    'only stable, published GitHub Releases are eligible',
  );
  assert.match(
    resolver,
    /select-prior-stable "\$candidate"/,
    'recovery excludes the candidate and selects by SemVer rather than API order',
  );
  assert.match(
    resolver,
    /npm view "opensip-cli@\$\{recovered\}" version/,
    'the recovered GitHub version must also exist exactly on npm',
  );
  assert.match(
    resolver,
    /require_forward_upgrade "\$candidate" "\$recovered"/,
    'recovered source must remain strictly older than the candidate',
  );
  assert.match(resolver, /npm view opensip-cli versions --json/);
  assert.match(resolver, /select-prior-stable-json "\$candidate"/);
  assert.match(resolver, /npm has a prior stable version but no matching GitHub Release/);
  assert.match(
    resolver,
    /curl --silent --show-error --location[\s\S]*--connect-timeout 10 --max-time 30[\s\S]*https:\/\/registry\.npmjs\.org\/opensip-cli/,
    'bootstrap uses a bounded probe of the fixed public npm registry',
  );
  assert.match(
    resolver,
    /release-version-policy\.mjs classify-npm-status "\$registry_status"/,
    'HTTP registry state is interpreted by the tested fail-closed policy',
  );
  assert.match(
    resolver,
    /if \[ "\$registry_state" != "absent" \]; then[\s\S]*exit 1/,
    'anything except an authoritative npm absence blocks bootstrap',
  );
  assert.match(
    resolver,
    /if \[ -n "\$stable_tags" \]; then[\s\S]*stable GitHub Release history exists[\s\S]*exit 1/,
    'bootstrap independently requires zero stable GitHub Releases',
  );
  assert.doesNotMatch(
    resolver,
    /releases\/latest/,
    'candidate-valued GitHub latest must not block recovery from older stable Releases',
  );
  assert.doesNotMatch(
    resolver,
    /echo[^\n]*\$stable_tags/,
    'unvalidated API tags must not reach logs',
  );
});

test('promotion re-verifies against the qualify-macos evidence attempt across failed-job reruns', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promote = stripComments(jobs.get('promote-release'));

  assert.match(
    macos,
    /evidence-run-attempt:\s*\$\{\{\s*steps\.evidence\.outputs\.evidence-run-attempt\s*\}\}/,
    'qualify-macos must expose the attempt sealed into its evidence',
  );
  assert.match(macos, /e\.execution\?\.runAttempt/);
  assert.match(macos, /evidence-run-attempt=\$evidence_attempt/);
  assert.match(
    promote,
    /EVIDENCE_RUN_ATTEMPT:\s*\$\{\{\s*needs\.qualify-macos\.outputs\.evidence-run-attempt\s*\}\}/,
  );
  assert.match(
    promote,
    /--expected-run-attempt "\$EVIDENCE_RUN_ATTEMPT"/,
    'a rerun promotion must trust the successful qualifier output, not its ambient attempt',
  );
  const recheck = promote.slice(promote.indexOf('Recheck release identity + verified evidence'));
  assert.doesNotMatch(
    recheck,
    /--expected-run-attempt "\$GITHUB_RUN_ATTEMPT"/,
    'promotion attempt N+1 cannot invalidate evidence produced by successful attempt N',
  );
});

test('promotion validates exact source identity before repo scripts and persists no write credential', () => {
  const promote = stripComments(sliceJobs(readWorkflow('release.yml')).get('promote-release'));
  assert.match(promote, /ref:\s*\$\{\{\s*needs\.stage-release\.outputs\.git-sha\s*\}\}/);
  assert.match(promote, /fetch-depth:\s*0/);
  assert.match(promote, /persist-credentials:\s*false/);
  assert.match(promote, /git rev-list -n 1 "\$TAG"/);
  assert.match(promote, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(promote, /checkout persisted a reusable credential/);
  assert.match(promote, /origin URL contains embedded credentials/);
  const identityIndex = promote.indexOf('Validate exact tag, SHA, clean tree');
  const runtimeIndex = promote.indexOf("node-version: '24.16.0'");
  const firstRepoScript = promote.indexOf('node scripts/');
  assert.ok(
    identityIndex >= 0 && runtimeIndex > identityIndex && firstRepoScript > runtimeIndex,
    'git identity must precede exact runtime provisioning and repo code',
  );
  assert.doesNotMatch(promote, /pnpm\/action-setup@|\bpnpm\b/);
  assert.doesNotMatch(promote, /\bnpm\s+(?:install|ci)\b/);
  for (const line of promote
    .split('\n')
    .filter((entry) => /\bnpm\s+(?:view|dist-tag)\b/.test(entry))) {
    assert.match(
      line,
      /--registry https:\/\/registry\.npmjs\.org\//,
      `fixed registry missing: ${line}`,
    );
  }
  assert.match(promote, /NPM_CONFIG_REGISTRY:\s*https:\/\/registry\.npmjs\.org\//);
  // Job-level env cannot read the runner context (GitHub rejects the whole
  // workflow file), so the runner-temp path resolves in a dedicated first step.
  assert.match(
    promote,
    /echo "PROMOTION_ORDER=\$RUNNER_TEMP\/promotion-order\.txt" >> "\$GITHUB_ENV"/,
  );
  const expectedOrderDigest = createHash('sha256')
    .update(`${RELEASE_PACKAGE_ORDER.map((entry) => entry.name).join('\n')}\n`)
    .digest('hex');
  assert.match(promote, new RegExp(`PROMOTION_ORDER_SHA256: ${expectedOrderDigest}`));
  assert.match(promote, /fs\.writeFileSync\(out,names\.join/);

  const tokenStart = promote.indexOf('- name: Promote staged release to latest');
  const tokenEnd = promote.indexOf('\n      - name:', tokenStart + 1);
  const tokenStep = promote.slice(tokenStart, tokenEnd);
  assert.match(tokenStep, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.MACBOOKM5\s*\}\}/);
  assert.match(tokenStep, /mapfile -t package_names < "\$PROMOTION_ORDER"/);
  assert.match(tokenStep, /order_digest.*PROMOTION_ORDER_SHA256/s);
  assert.match(tokenStep, /:_authToken=\$\{NODE_AUTH_TOKEN\}/);
  assert.match(tokenStep, /export NPM_CONFIG_USERCONFIG="\$promotion_npmrc"/);
  assert.match(tokenStep, /trap cleanup_npmrc EXIT/);
  assert.doesNotMatch(
    tokenStep,
    /node\s+scripts\//,
    'the npm credential must never be in scope while repository code executes',
  );
  assert.doesNotMatch(tokenStep, /release-package-order\.mjs/);
});

test('only independently verified nonempty evidence identity can reach promotion', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promote = stripComments(jobs.get('promote-release'));

  assert.match(
    macos,
    /if:\s*always\(\) && steps\.verify\.outputs\.verify_rc == '0'/,
    'evidence outputs are exposed only after the verifier succeeds',
  );
  assert.match(macos, /\^\[a-f0-9\]\{64\}\$/, 'the exposed digest must be lowercase SHA-256');
  assert.match(
    macos,
    /EVIDENCE_DIGEST:\s*\$\{\{\s*steps\.evidence\.outputs\.evidence-digest/,
    'the final Mac gate requires the verified digest output',
  );
  assert.match(promote, /if\(d!==wantDigest\)/, 'promotion compares the digest unconditionally');
  assert.doesNotMatch(promote, /wantDigest&&/, 'an empty expected digest cannot bypass comparison');
});

test('promotion, dist-tag, and GitHub Release markers appear ONLY in promote-release', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const stage = stripComments(jobs.get('stage-release'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promote = stripComments(jobs.get('promote-release'));

  for (const marker of [
    /npm\s+dist-tag\s+add/,
    /softprops\/action-gh-release/,
    /secrets\.MACBOOKM5/,
  ]) {
    assert.match(promote, marker, `promote-release must contain ${marker}`);
    assert.doesNotMatch(stage, marker, `stage-release must NOT contain ${marker}`);
    assert.doesNotMatch(macos, marker, `qualify-macos must NOT contain ${marker}`);
  }
});

test('exact staged-install + verifier markers appear ONLY in qualify-macos', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const stage = stripComments(jobs.get('stage-release'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promoteRaw = jobs.get('promote-release');
  // The published-version acceptance run + registry-tarball compare are Mac-only.
  assert.match(macos, /--published-version/, 'qualify-macos runs the published-version profile');
  assert.match(
    macos,
    /scripts\/verify-platform-acceptance\.mjs/,
    'qualify-macos verifies evidence',
  );
  assert.doesNotMatch(
    stage,
    /--published-version/,
    'stage-release never runs the published profile',
  );
  assert.doesNotMatch(stage, /pnpm platform:acceptance/, 'stage-release never runs acceptance');
  // promote-release re-verifies the sealed evidence but never runs acceptance.
  assert.doesNotMatch(
    stripComments(promoteRaw),
    /pnpm platform:acceptance/,
    'promote never runs it',
  );
});

test('qualify-macos builds every checkout-owned harness prerequisite from a clean checkout', () => {
  const macos = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  assert.match(
    macos,
    /pnpm --filter @opensip-cli\/core build/,
    'the tuple journey requires the untracked core dist/index-lib.js build',
  );
  assert.match(
    macos,
    /pnpm --filter @opensip-cli\/agent-eval build/,
    'installed agent smoke requires the untracked agent-eval dist build',
  );
});

test('qualify-macos is least-privilege: contents: read, no publish OIDC, publish, or promotion secret', () => {
  const macos = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  assert.match(macos, /permissions:\s*\n\s*contents:\s*read/, 'contents: read only');
  assert.doesNotMatch(macos, /id-token:\s*write/, 'no OIDC publish token');
  assert.doesNotMatch(macos, /attestations:\s*write/, 'no attestation permission');
  assert.doesNotMatch(macos, /\bnpm\s+publish\b/, 'the Mac gate must not publish');
  assert.doesNotMatch(
    macos,
    /secrets\.MACBOOKM5/,
    'the Mac gate must not hold the promotion secret',
  );
});

test('qualify-macos downloads the staged manifest and compares registry tarballs by sha256/name/version', () => {
  const macos = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  assert.match(macos, /download-artifact@[a-f0-9]{40}/, 'it downloads the staged release metadata');
  assert.match(
    macos,
    /needs\.stage-release\.outputs\.release-metadata-artifact/,
    'by the exact attempt-bound stage output',
  );
  assert.match(macos, /opensip-cli-release-manifest\.v1\.json/, 'it reads the staged manifest');
  // Manifest digest is rechecked against the staging job output before install.
  assert.match(macos, /MANIFEST_DIGEST:\s*\$\{\{\s*needs\.stage-release\.outputs\.manifest-digest/);
  assert.match(macos, /shasum -a 256/, 'it recomputes tarball sha256');
  assert.match(macos, /sha256/i, 'it compares against the manifest sha256');
});

test('release qualification retains and binds a complete canonical npm integrity inventory', () => {
  const jobs = sliceJobs(readWorkflow('release.yml'));
  const macos = stripComments(jobs.get('qualify-macos'));
  const promote = stripComments(jobs.get('promote-release'));

  assert.match(
    macos,
    /scripts\/registry-integrity-inventory\.mjs build/,
    'the Mac job must verify exact npm SRI and build the closed inventory',
  );
  assert.match(macos, /--directory\s+"\$stage"/, 'the fetched exact tarballs are inventoried');
  assert.match(macos, /--registry https:\/\/registry\.npmjs\.org\//, 'npmjs is fixed explicitly');
  assert.match(
    macos,
    /registry-integrity-digest:\s*\$\{\{\s*steps\.registry-integrity\.outputs\.registry-integrity-digest/,
    'the qualifier exposes the exact inventory digest',
  );
  assert.match(
    macos,
    /--expected-registry-integrity-digest\s+"\$REGISTRY_INTEGRITY_DIGEST"/,
    'runner and verifier bind evidence to the retained inventory',
  );
  assert.match(
    macos,
    /--registry-integrity-inventory\s+"\$EVIDENCE_DIR\/opensip-cli-registry-integrity\.v1\.json"/,
    'the runner and independent verifier consume the exact retained inventory whose digest is in evidence',
  );
  assert.match(
    macos,
    /--expected-candidate-digest\s+"\$CANDIDATE_DIGEST"/,
    'the independent verifier binds the canonical published candidate identity',
  );
  assert.match(
    macos,
    /candidate-digest:\s*\$\{\{\s*steps\.registry-integrity\.outputs\.candidate-digest/,
    'the qualifier exposes the canonical candidate digest to promotion',
  );
  assert.match(macos, /--expected-candidate-kind published-version/);
  assert.match(macos, /opensip-cli-registry-integrity\.v1\.json/, 'inventory is retained');

  assert.match(
    promote,
    /scripts\/registry-integrity-inventory\.mjs verify/,
    'promotion independently parses and verifies the inventory',
  );
  for (const expectedFlag of [
    '--expected-digest "$REGISTRY_INTEGRITY_DIGEST"',
    '--expected-manifest-digest "$MANIFEST_DIGEST"',
    '--expected-candidate-kind published-version',
    '--expected-registry https://registry.npmjs.org/',
    '--expected-candidate-digest "$CANDIDATE_DIGEST"',
    '--expected-registry-integrity-digest "$REGISTRY_INTEGRITY_DIGEST"',
    '--registry-integrity-inventory "$inventory"',
  ]) {
    assert.ok(promote.includes(expectedFlag), `promotion is missing ${expectedFlag}`);
  }
});

test('scheduled packed qualification asserts packed candidate identity', () => {
  const scheduled = stripComments(readWorkflow('macos-qualification.yml'));
  assert.match(scheduled, /--expected-candidate-kind packed-release/);
  assert.match(
    scheduled,
    /--candidate-manifest "\$TARBALL_DIR\/opensip-cli-release-manifest\.v1\.json"/,
  );
  assert.match(scheduled, /--expected-candidate-digest "\$CANDIDATE_DIGEST"/);
  assert.doesNotMatch(scheduled, /--expected-registry-integrity-digest/);
});

test('scheduled packed and published release workflows are structurally compatible with candidate-aware macOS requirements', () => {
  const scheduled = stripComments(readWorkflow('macos-qualification.yml'));
  const published = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  assert.match(scheduled, /--expected-candidate-kind packed-release/);
  assert.match(scheduled, /--expect-no-previous-candidate/);
  assert.doesNotMatch(scheduled, /--previous-version/);
  assert.match(published, /--published-version/);
  assert.match(published, /--expected-candidate-kind published-version/);

  const upgrade = MACOS_PROFILE.journeys.find((journey) => journey.id === 'lifecycle.upgrade');
  const installer = MACOS_PROFILE.journeys.find((journey) => journey.id === 'macos.installer-sh');
  assert.ok(upgrade);
  assert.ok(installer);
  assert.equal(upgrade.required, false, 'bootstrap packed runs cannot require a self-upgrade');
  assert.equal(
    isJourneyRequired(upgrade, null),
    false,
    'no previous candidate makes upgrade an explicit optional semantic skip',
  );
  assert.deepEqual(installer.candidateKinds, ['published-version']);
  assert.equal(
    isJourneyApplicable(installer, 'packed-release'),
    false,
    'the scheduled packed lane must not be blocked by a registry-only installer journey',
  );
  assert.equal(
    isJourneyApplicable(installer, 'published-version'),
    true,
    'the release lane must execute the canonical installer journey',
  );
  assert.equal(installer.required, true, 'published qualification must gate on canonical install');
});

test('the Mac gate qualifies the EXACT staged version and never a mutable latest candidate', () => {
  const macos = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  // The candidate identity is the staged exact version, never `@latest`.
  assert.match(
    macos,
    /needs\.stage-release\.outputs\.candidate-version/,
    'the candidate is the exact staged version',
  );
  assert.doesNotMatch(macos, /--published-version\s+["']?latest/, 'never qualifies @latest');
  assert.doesNotMatch(macos, /@latest\b/, 'the Mac gate never resolves a mutable latest tag');
  assert.doesNotMatch(readWorkflow('release.yml'), /runs-on:\s*macos-latest/, 'never macos-latest');
});

test('published qualification delegates the canonical install to the acceptance lifecycle', () => {
  const macos = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-macos'));
  assert.match(macos, /--published-version/);
  assert.match(
    macos,
    /macos-26-arm64-node24-npm11-v1\.json/,
    'the profile that selects macos.installer-sh must drive the lifecycle',
  );
  assert.doesNotMatch(
    macos,
    /(?:^|\s)(?:sh|bash)\s+(?:\.\/)?scripts\/install\.sh\b/m,
    'the workflow must not create a second install outside the measured lifecycle',
  );
});

test('job outputs and artifact names are built from controlled identifiers, not untrusted event input', () => {
  const raw = readWorkflow('release.yml');
  const qual = readWorkflow('macos-qualification.yml');
  // No untrusted PR/branch/title/body fields are interpolated into any run step
  // (the classic GitHub Actions script-injection vector).
  for (const wf of [raw, qual]) {
    assert.doesNotMatch(wf, /\$\{\{\s*github\.event\.[^}]*\.(?:title|body|name)/, 'no event text');
    assert.doesNotMatch(wf, /\$\{\{\s*github\.head_ref/, 'no head_ref interpolation');
    assert.doesNotMatch(wf, /\$\{\{\s*github\.event\.pull_request/, 'no pull_request payload');
  }
  // Evidence/artifact names derive from the tag, run attempt, and short SHA only.
  const macos = sliceJobs(raw).get('qualify-macos');
  assert.match(
    macos,
    /evidence-artifact=macos-release-qualification-c\$\{SUPPORT_CONTRACT_VERSION\}/,
  );
});

test('the GitHub Release attaches the complete macOS verification bundle', () => {
  const promote = stripComments(sliceJobs(readWorkflow('release.yml')).get('promote-release'));
  const releaseStep = promote.slice(promote.indexOf('Create GitHub Release'));
  for (const file of [
    'opensip-cli-macos-qualification.v1.json',
    'opensip-cli-registry-integrity.v1.json',
    'agent-eval-installed-smoke.json',
    'host-preflight.json',
    'verifier-result.json',
  ]) {
    assert.match(
      releaseStep,
      new RegExp(`macos-evidence/${file.replaceAll('.', '\\.')}`),
      `${file} must be attached to the GitHub Release`,
    );
  }
  assert.match(
    releaseStep,
    /fail_on_unmatched_files:\s*true/,
    'release creation must fail if any claimed evidence attachment is missing',
  );
});
