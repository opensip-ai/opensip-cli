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
 *   2. `release.yml` keeps the three-job `stage-release → qualify-macos →
 *      promote-release` topology in which verified exact-version macOS evidence
 *      is a HARD dependency between npm staging publish and `latest` promotion —
 *      the promotion secret, `dist-tag add`, and GitHub Release live ONLY in the
 *      final job, and the Mac job holds no publish/promotion credential.
 *
 * The supply-chain verifier (scripts/verify-supply-chain.mjs) and the
 * release-artifact test enforce overlapping guarantees; this file is the
 * dedicated, exhaustive topology regression gate.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

const SHA_PIN = /uses:\s*[^@\s]+@([^\s#]+)/g;
const FULL_SHA = /^[a-f0-9]{40}$/;

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
});

// ===========================================================================
// Release topology — .github/workflows/release.yml (three jobs)
// ===========================================================================

test('release.yml keeps the stage-release → qualify-macos → promote-release order', () => {
  const raw = readWorkflow('release.yml');
  const stage = raw.indexOf('\n  stage-release:');
  const macos = raw.indexOf('\n  qualify-macos:');
  const promote = raw.indexOf('\n  promote-release:');
  assert.ok(stage > 0 && macos > 0 && promote > 0, 'all three jobs must exist');
  assert.ok(stage < macos, 'stage-release precedes qualify-macos');
  assert.ok(macos < promote, 'qualify-macos precedes promote-release');

  const jobs = sliceJobs(raw);
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
    /release-metadata-\$\{\{\s*needs\.stage-release\.outputs\.tag/,
    'by exact tag',
  );
  assert.match(macos, /opensip-cli-release-manifest\.v1\.json/, 'it reads the staged manifest');
  // Manifest digest is rechecked against the staging job output before install.
  assert.match(macos, /MANIFEST_DIGEST:\s*\$\{\{\s*needs\.stage-release\.outputs\.manifest-digest/);
  assert.match(macos, /shasum -a 256/, 'it recomputes tarball sha256');
  assert.match(macos, /sha256/i, 'it compares against the manifest sha256');
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
