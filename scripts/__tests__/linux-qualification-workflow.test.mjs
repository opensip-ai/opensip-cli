/**
 * @fileoverview Phase 2 (Plan 12) — Linux qualification WORKFLOW TOPOLOGY.
 *
 * The qualification lane runs only on a GitHub-hosted `ubuntu-24.04` runner and
 * cannot be exercised in a unit test, so its SAFETY INVARIANTS are enforced here
 * by parsing the committed workflow YAML deterministically (string/regex only —
 * no YAML runtime, so this runs on a bare checkout in `pnpm test:scripts` on
 * every PR). It mirrors the scheduled-lane half of
 * `macos-qualification-workflow.test.mjs`; the `release.yml` `qualify-linux`
 * topology is Phase 3's gate.
 *
 * It asserts the properties a broken split would silently regress:
 *   1. the scheduled lane pins the exact runner/actions, is least-privilege,
 *      always uploads evidence, and binds the exact Ubuntu profile + support row;
 *   2. the independent verifier binds the full Linux tuple (linux / x64 / ABI
 *      137 / ext4 / case-sensitive / kernel 6 / os 24 / npm 11) and no macOS
 *      token leaks into the Linux lane; and
 *   3. (Phase 3) the release-topology `qualify-linux` job is a least-privilege
 *      sibling of `qualify-macos`, and its promotion gating moves in LOCKSTEP
 *      with the registry row status — advisory (out of `promote.needs`) while the
 *      row is `preview`, a hard promote dependency once it is `supported`. The
 *      lockstep is read from the committed, gate-synced supported-platforms doc,
 *      so a `supported` flip cannot land with an advisory gate.
 *
 * `--expect-shell` is DELIBERATELY absent from both lanes: macOS proves /bin/zsh
 * by executing it, but on Linux the shell fact is only the recorded `$SHELL`
 * basename and is not a tuple dimension — gating it would risk a mystery-red (the
 * backlog-19 anti-pattern). This test pins that omission so a later edit cannot
 * reintroduce a fragile shell gate unreviewed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { FULL_SHA, SHA_PIN } from '../lib/github-workflow-asserts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW = 'linux-qualification.yml';
const PROFILE_PATH = '.config/platform-acceptance/ubuntu-2404-x64-node24-npm11-v2.json';

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

/** The ubuntu row's status as published in the committed, gate-synced matrix. */
function ubuntuRowStatus() {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs', 'public', '70-reference', '17-supported-platforms.md'),
    'utf8',
  );
  const match = doc.match(/\|\s*`ubuntu-2404-x64-node24-npm11-v1`\s*\|\s*`(\w+)`\s*\|/);
  assert.ok(match, 'the generated supported-platforms matrix must list the ubuntu row + status');
  return match[1];
}

test('linux-qualification.yml pins the exact runner and never floats a label', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  assert.match(wf, /runs-on:\s*ubuntu-24\.04\b/, 'the qualification lane must pin ubuntu-24.04');
  assert.doesNotMatch(wf, /ubuntu-latest/, 'ubuntu-latest is forbidden — it can silently drift');
  assert.doesNotMatch(wf, /runs-on:\s*ubuntu-\d+\.\d+-(?:arm|large)/, 'no arm/large label');
});

test('linux-qualification.yml pins every action to a full commit SHA', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  const refs = [...wf.matchAll(SHA_PIN)].map((m) => m[1]);
  assert.ok(refs.length >= 3, 'the lane must use pinned actions');
  for (const ref of refs) {
    assert.match(ref, FULL_SHA, `action ref ${ref} must be a full 40-char commit SHA, not a tag`);
  }
});

test('linux-qualification.yml is scheduled, bounded, concurrency-guarded, and frozen', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  assert.match(wf, /schedule:/, 'the burn-in lane must run on a schedule');
  assert.match(wf, /cron:\s*'[^']+'/, 'the schedule must declare a cron');
  assert.match(wf, /workflow_dispatch:/, 'the lane must be manually dispatchable');
  assert.match(wf, /timeout-minutes:\s*\d+/, 'the job must bound its wall-clock time');
  assert.match(wf, /concurrency:/, 'the lane must declare a concurrency group');
  assert.match(wf, /persist-credentials:\s*false/, 'checkout must not persist credentials');
  assert.match(wf, /pnpm install --frozen-lockfile/, 'installs must be frozen');
  // A bare `npm install` (not the `pnpm install` above, and not the pinned
  // `npm install --prefix … npm@11` bootstrap) would be a mutable ambient install.
  assert.doesNotMatch(
    wf,
    /(?<![A-Za-z])npm install\b(?![^\n]*--prefix)/,
    'no mutable ambient npm install',
  );
});

test('linux-qualification.yml is least-privilege and holds no publish/promotion credential', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  assert.match(wf, /permissions:\s*\n\s*contents:\s*read/, 'the lane must be contents: read only');
  assert.doesNotMatch(wf, /id-token:\s*write/, 'no OIDC publish token');
  assert.doesNotMatch(wf, /attestations:\s*write/, 'no attestation permission');
  assert.doesNotMatch(wf, /secrets\./, 'no secret of any kind in the qualification lane');
  assert.doesNotMatch(wf, /\bnpm\s+publish\b/, 'the qualification lane must never publish');
  assert.doesNotMatch(wf, /npm\s+dist-tag\s+add/, 'the qualification lane must never promote');
});

test('linux-qualification.yml binds the exact profile + independent verifier and always uploads evidence', () => {
  const raw = readWorkflow(WORKFLOW);
  const wf = stripComments(raw);
  assert.match(
    wf,
    new RegExp(PROFILE_PATH.replaceAll('.', '\\.')),
    'the exact Ubuntu profile must be pinned',
  );
  assert.equal(
    raw.split(PROFILE_PATH).length - 1,
    1,
    'the profile path is referenced exactly once (the LINUX_PROFILE env), then used via $LINUX_PROFILE',
  );
  assert.match(
    wf,
    /SUPPORT_ROW:\s*ubuntu-2404-x64-node24-npm11-v1/,
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
  assert.match(
    upload,
    /opensip-cli-linux-qualification\.v2\.json/,
    'the sealed Linux evidence uploads',
  );
  assert.match(upload, /agent-eval-installed-smoke\.json/, 'the sanitized agent report uploads');
});

test('linux-qualification.yml carries the full Linux tuple verifier flags and no macOS token', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  for (const flag of [
    '--runner-label ubuntu-24.04',
    '--agent-report-out',
    '--expected-manifest-digest',
    '--run-id',
    '--run-attempt',
    '--expected-git-sha',
    '--expected-run-id',
    '--expected-run-attempt',
    '--expected-runner-label ubuntu-24.04',
    '--expect-platform linux',
    '--expect-arch x64',
    '--expect-node-abi 137',
    '--expect-fs-type ext4',
    '--expected-node-major 24',
    '--expected-npm-major 11',
    '--expected-sw-vers-major 24',
    '--expected-kernel-major 6',
    '--expect-uname-arch x86_64',
    '--expect-case-sensitive true',
    '--expect-no-previous-candidate',
  ]) {
    assert.match(
      wf,
      new RegExp(flag.replaceAll('-', '\\-').replaceAll('.', '\\.')),
      `missing ${flag}`,
    );
  }
  // Deliberately NOT gated on Linux (documented omission; still recorded in evidence).
  assert.doesNotMatch(
    wf,
    /--expect-shell/,
    'the Linux lane must not gate the fragile shell dimension',
  );
  // No macOS tuple token may leak into the Linux lane.
  for (const macToken of [
    /\barm64\b/,
    /\bapfs\b/,
    /\bdarwin\b/,
    /macos-\d+/,
    /--expected-sw-vers-major 26/,
    /--expected-kernel-major 25/,
  ]) {
    assert.doesNotMatch(wf, macToken, `macOS token ${macToken} must not appear in the Linux lane`);
  }
});

test('linux-qualification.yml asserts packed candidate identity (not a registry inventory)', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  assert.match(wf, /--expected-candidate-kind packed-release/);
  assert.match(wf, /--candidate-manifest "\$TARBALL_DIR\/opensip-cli-release-manifest\.v1\.json"/);
  assert.match(wf, /--expected-candidate-digest "\$CANDIDATE_DIGEST"/);
  // Registry SRI inventory is a release-lane (published-version) concern, not this packed lane.
  assert.doesNotMatch(wf, /--expected-registry-integrity-digest/);
  assert.doesNotMatch(wf, /--published-version/);
});

test('separate-prefix npm 11 is bound into the acceptance npm invocation', () => {
  const wf = stripComments(readWorkflow(WORKFLOW));
  const seam = 'OPENSIP_ACCEPTANCE_NPM_CLI=$HOME/.npm-cli/node_modules/npm/bin/npm-cli.js';
  assert.equal(
    (wf.match(/npm install --prefix "\$HOME\/\.npm-cli" npm@11/gu) ?? []).length,
    1,
    'exactly one pinned npm@11 bootstrap',
  );
  assert.equal(wf.split(seam).length - 1, 1, 'exactly one seam export');
  assert.match(
    wf,
    /if \[ "\$major" != "11" \]; then[\s\S]*npm install --prefix[\s\S]*OPENSIP_ACCEPTANCE_NPM_CLI[\s\S]*fi/,
    'the lane exports the seam only when it installs separate npm',
  );
  for (const line of wf
    .split('\n')
    .filter((entry) => /npm install --prefix "\$HOME\/\.npm-cli" npm@11/.test(entry))) {
    assert.match(
      line,
      /--registry https:\/\/registry\.npmjs\.org\//,
      'npm bootstrap pins the registry',
    );
  }
});

test('linux-qualification path filters broadly cover measured runtime and build inputs', () => {
  const raw = readWorkflow(WORKFLOW);
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

test('linux-qualification artifact/evidence names use controlled identifiers, not untrusted event input', () => {
  const wf = readWorkflow(WORKFLOW);
  assert.doesNotMatch(
    wf,
    /\$\{\{\s*github\.event\.[^}]*\.(?:title|body|name)/,
    'no untrusted event text',
  );
  assert.doesNotMatch(wf, /\$\{\{\s*github\.head_ref/, 'no head_ref interpolation');
  assert.doesNotMatch(
    wf,
    /\$\{\{\s*github\.event\.pull_request/,
    'no pull_request payload interpolation',
  );
  assert.match(
    stripComments(wf),
    /artifact="linux-qualification-c\$\{SUPPORT_CONTRACT_VERSION\}/,
    'the evidence artifact name is built from controlled identifiers',
  );
});

// ===========================================================================
// Release topology — .github/workflows/release.yml qualify-linux (Phase 3)
// ===========================================================================

test('release qualify-linux is a pinned, least-privilege sibling of qualify-macos', () => {
  const linux = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-linux'));
  assert.ok(linux, 'release.yml must define a qualify-linux job');
  assert.match(linux, /runs-on:\s*ubuntu-24\.04\b/, 'qualify-linux must pin ubuntu-24.04');
  assert.match(linux, /needs:\s*stage-release\b/, 'qualify-linux must depend on stage-release');
  assert.match(linux, /permissions:\s*\n\s*contents:\s*read/, 'contents: read only');
  assert.match(
    linux,
    /ref:\s*\$\{\{\s*needs\.stage-release\.outputs\.git-sha\s*\}\}/,
    'checkout the exact staged SHA, never a branch or latest',
  );
  assert.match(linux, /persist-credentials:\s*false/, 'checkout must not persist credentials');
  assert.doesNotMatch(linux, /id-token:\s*write/, 'no OIDC publish token');
  assert.doesNotMatch(linux, /attestations:\s*write/, 'no attestation permission');
  assert.doesNotMatch(linux, /secrets\./, 'no secret of any kind in the qualification job');
  assert.doesNotMatch(linux, /\bnpm\s+publish\b/, 'the Linux gate must never publish');
  assert.doesNotMatch(linux, /npm\s+dist-tag\s+add/, 'the Linux gate must never promote');
  assert.doesNotMatch(
    linux,
    /softprops\/action-gh-release/,
    'the Linux gate must never cut a Release',
  );
});

test('release qualify-linux runs the published-version profile with the full Linux tuple', () => {
  const linux = stripComments(sliceJobs(readWorkflow('release.yml')).get('qualify-linux'));
  for (const flag of [
    '--published-version',
    '--expected-candidate-kind published-version',
    '--expected-registry https://registry.npmjs.org/',
    '--expected-runner-label ubuntu-24.04',
    '--expect-platform linux',
    '--expect-arch x64',
    '--expect-node-abi 137',
    '--expect-fs-type ext4',
    '--expected-node-major 24',
    '--expected-npm-major 11',
    '--expected-sw-vers-major 24',
    '--expected-kernel-major 6',
    '--expect-uname-arch x86_64',
    '--expect-case-sensitive true',
    '--expected-support-row',
    '--registry-integrity-inventory',
  ]) {
    assert.ok(linux.includes(flag), `qualify-linux is missing ${flag}`);
  }
  assert.doesNotMatch(
    linux,
    /--expect-shell/,
    'the Linux gate must not gate the fragile shell dimension',
  );
  for (const macToken of [
    /\barm64\b/,
    /\bapfs\b/,
    /\bdarwin\b/,
    /macos-\d+/,
    /--expected-kernel-major 25/,
  ]) {
    assert.doesNotMatch(
      linux,
      macToken,
      `macOS token ${macToken} must not appear in qualify-linux`,
    );
  }
  assert.match(
    linux,
    /opensip-cli-linux-qualification\.v2\.json/,
    'qualify-linux seals the Linux evidence',
  );
});

test('status↔gate lockstep: qualify-linux gates promotion iff the ubuntu row is supported', () => {
  const status = ubuntuRowStatus();
  const promote = stripComments(sliceJobs(readWorkflow('release.yml')).get('promote-release'));
  const inNeeds = /needs:\s*\[[^\]]*\bqualify-linux\b[^\]]*\]/.test(promote);
  if (status === 'supported') {
    assert.ok(
      inNeeds,
      'a `supported` ubuntu row REQUIRES qualify-linux in promote-release.needs — a supported row with an advisory gate is a false promise',
    );
    assert.match(
      promote,
      /qualify-linux/,
      'a supported row must have promotion consume the qualify-linux evidence',
    );
  } else {
    assert.ok(
      !inNeeds,
      `a \`${status}\` ubuntu row must NOT gate promotion — qualify-linux stays out of promote-release.needs during burn-in`,
    );
  }
  // macOS remains a hard promote dependency regardless of the Linux row status.
  assert.match(
    promote,
    /needs:\s*\[[^\]]*\bqualify-macos\b[^\]]*\]/,
    'macOS must remain a hard promote dependency',
  );
});

test('release qualify-linux npm@11 seam precedes registry inventory and acceptance', () => {
  const linux = sliceJobs(readWorkflow('release.yml')).get('qualify-linux');
  const seam = linux.indexOf('OPENSIP_ACCEPTANCE_NPM_CLI=');
  assert.ok(
    seam >= 0 && linux.indexOf('id: registry-integrity', seam) > seam,
    'the pinned npm seam must precede registry inventory and acceptance execution',
  );
});
