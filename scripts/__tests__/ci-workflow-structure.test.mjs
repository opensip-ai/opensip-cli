/**
 * @fileoverview Plan 10 / ADR-0168 — CI workflow topology guards.
 *
 * Asserts parallel-lane required surface, timeouts, SHA pins, permissions,
 * fork-PR SARIF guards, and shared-workspace restore integrity hooks.
 * Regex-form only for SHAs (never literal pins).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  FULL_SHA,
  assertThirdPartyActionsPinned,
  collectActionRefs,
  readWorkflow,
  stripComments,
} from '../lib/github-workflow-asserts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function readCompositeSetup() {
  return readFileSync(join(REPO_ROOT, '.github/actions/setup-workspace/action.yml'), 'utf8');
}

const REQUIRED_LANES = [
  'lint',
  'test',
  'dogfood',
  'graph-equivalence',
  'policy-and-docs',
  'cold-gate',
];

test('ci.yml declares workflow-level default-deny permissions (exactly contents: read)', () => {
  const raw = readWorkflow('ci.yml');
  // Top-level permissions before jobs: (not only nested under a job).
  const preJobs = raw.slice(0, raw.search(/^jobs:\s*$/m));
  const block = preJobs.match(/^permissions:\n((?: {2}\S[^\n]*\n)+)/m);
  assert.ok(block, 'workflow-level permissions block is required');
  // Exclusivity: a widened default (e.g. an added `actions: write`) must fail —
  // the block is default-deny only if contents: read is its ONLY scope.
  const scopes = block[1]
    .trim()
    .split('\n')
    .map((l) => l.trim());
  assert.deepEqual(
    scopes,
    ['contents: read'],
    'workflow-level permissions must be exactly contents: read',
  );
});

test('ci.yml build-and-test aggregator needs every required lane including cold-gate', () => {
  const raw = readWorkflow('ci.yml');
  const block = raw.match(/build-and-test:\s*\n([\s\S]*?)(?=\n {2}[a-z]|\n*$)/);
  assert.ok(block, 'build-and-test job must exist');
  const needs = block[1].match(/needs:\s*\n((?:\s+-\s+[^\n]+\n)+)/);
  assert.ok(needs, 'build-and-test must declare needs:');
  const listed = [...needs[1].matchAll(/-\s+([a-z0-9-]+)/g)].map((m) => m[1]);
  for (const lane of REQUIRED_LANES) {
    assert.ok(listed.includes(lane), `build-and-test.needs must include ${lane}`);
  }
  assert.match(block[1], /if:\s*always\(\)/, 'aggregator must run if: always()');
  assert.match(
    block[1],
    /COLD:\s*\$\{\{\s*needs\.cold-gate\.result\s*\}\}/,
    'aggregator must read cold-gate result',
  );
});

/** Slice committed ci.yml job map (2-space headers under `jobs:`). */
function sliceCiJobs(raw) {
  const jobsIdx = raw.search(/^jobs:\s*$/m);
  assert.ok(jobsIdx >= 0, 'jobs: block required');
  const body = raw.slice(jobsIdx);
  const headerRe = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm;
  const headers = [];
  for (let m = headerRe.exec(body); m !== null; m = headerRe.exec(body)) {
    headers.push({ name: m[1], start: m.index });
  }
  const jobs = new Map();
  for (const [i, header] of headers.entries()) {
    const end = i + 1 < headers.length ? headers[i + 1].start : body.length;
    jobs.set(header.name, body.slice(header.start, end));
  }
  return jobs;
}

test('ci.yml bounds every job with a JOB-level timeout-minutes', () => {
  const jobs = sliceCiJobs(readWorkflow('ci.yml'));
  assert.ok(jobs.has('setup'), 'setup job expected');
  // Anchor to 4-space indentation: a step-level timeout (8-space) must not
  // satisfy this — the job itself would stay unbounded.
  const jobLevel = /^ {4}timeout-minutes:\s*(\d+)/m;
  for (const [job, segment] of jobs) {
    const m = jobLevel.exec(segment);
    assert.ok(m, `${job} must declare a job-level timeout-minutes`);
    const n = Number(m[1]);
    assert.ok(n >= 5 && n <= 60, `${job} timeout-minutes ${n} out of 5–60 band`);
  }
});

test('ci.yml and setup-workspace pin third-party actions to full SHAs', () => {
  const ci = stripComments(readWorkflow('ci.yml'));
  const setup = stripComments(readCompositeSetup());
  assertThirdPartyActionsPinned(ci, (msg) => assert.fail(msg));
  assertThirdPartyActionsPinned(setup, (msg) => assert.fail(msg));
  // Sanity: at least checkout + upload/download + codeql appear pinned in ci.
  const refs = collectActionRefs(ci);
  assert.ok(refs.length >= 5, 'ci.yml should pin multiple third-party actions');
  for (const ref of refs) {
    assert.match(ref, FULL_SHA);
  }
});

test('ci.yml checkouts set persist-credentials: false', () => {
  const raw = readWorkflow('ci.yml');
  const checkouts = [...raw.matchAll(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*/g)];
  assert.ok(checkouts.length >= 6, 'expected multiple checkout steps');
  // Each checkout step should be followed (within a few lines) by persist-credentials.
  const lines = raw.split('\n');
  let checkoutLines = 0;
  let guarded = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/uses:\s*actions\/checkout@/.test(lines[i])) {
      checkoutLines++;
      const window = lines.slice(i, i + 6).join('\n');
      if (/persist-credentials:\s*false/.test(window)) guarded++;
    }
  }
  assert.equal(guarded, checkoutLines, 'every checkout must set persist-credentials: false');
});

test('ci.yml keeps ADR-0017 gate command counterparts as run: lines', () => {
  const raw = readWorkflow('ci.yml');
  const jobs = sliceCiJobs(raw);
  // End-of-line anchors so a prefix cannot satisfy a shorter literal
  // (e.g. `test:coverage:fresh` must NOT satisfy the `test:coverage` assert),
  // and per-job anchoring so cold-gate's fit:ci cannot mask a dogfood removal.
  assert.match(raw, /^\s*run: pnpm lint$/m, 'run: pnpm lint');
  assert.match(
    jobs.get('test'),
    /^\s*run: pnpm test:coverage$/m,
    'PR coverage line in the test lane',
  );
  assert.match(
    jobs.get('test'),
    /^\s*run: pnpm test:coverage:fresh$/m,
    'fresh coverage line (main) in the test lane',
  );
  assert.match(jobs.get('dogfood'), /^\s*run: pnpm fit:ci$/m, 'dogfood fit:ci');
  assert.match(jobs.get('cold-gate'), /^\s*run: pnpm fit:ci$/m, 'cold-gate fit:ci');
  const graphGate =
    /^\s*run: (?:node packages\/cli\/dist\/index\.js graph --gate-save|pnpm graph:ci)/m;
  assert.match(jobs.get('dogfood'), graphGate, 'dogfood graph gate counterpart');
});

test('ci.yml concurrency cancels in-progress PR runs', () => {
  const raw = readWorkflow('ci.yml');
  assert.match(raw, /concurrency:/);
  assert.match(
    raw,
    /cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}/,
  );
});

test('ci.yml SARIF uploads are guarded for fork PRs', () => {
  const raw = readWorkflow('ci.yml');
  const uploadBlocks = [
    ...raw.matchAll(
      /Upload (?:fit|graph|yagni) SARIF[\s\S]*?uses:\s*github\/codeql-action\/upload-sarif@/g,
    ),
  ];
  assert.equal(uploadBlocks.length, 3, 'three SARIF upload steps');
  for (const block of uploadBlocks) {
    assert.match(
      block[0],
      /head\.repo\.full_name\s*==\s*github\.repository/,
      'each upload-sarif if: must guard same-repo',
    );
  }
  assert.match(raw, /SARIF upload skipped on fork PR/, 'fork skip notice step required');
});

test('warm lanes restore shared workspace and verify injection; cold-gate does not', () => {
  const raw = readWorkflow('ci.yml');
  const jobs = sliceCiJobs(raw);
  const setup = jobs.get('setup');
  assert.ok(setup, 'setup job');
  assert.match(setup, /Pack workspace for warm lanes/);
  // Package-local node_modules holds pnpm's consumer-facing workspace links
  // (for example packages/cli/node_modules/@opensip-cli/config). Root
  // node_modules alone contains the virtual store but cannot resolve those
  // imports from packages/cli/dist after a warm restore.
  assert.match(
    setup,
    /mapfile -t package_node_modules < <\([\s\S]*?find packages -type d -name node_modules -prune -print \| sort[\s\S]*?\)/,
    'workspace tar must discover package-local node_modules link forests',
  );
  // .turbo must ride in the tar — without it, `turbo run test`/`typecheck`
  // re-run the build DAG in consumer lanes despite the restored dist.
  assert.match(
    setup,
    /tar -cpf "\$CI_WORKSPACE_ARTIFACT"[\s\S]*?node_modules[\s\S]*?\.turbo[\s\S]*?"\$\{package_node_modules\[@\]\}"[\s\S]*?"\$\{dists\[@\]\}"/,
    'workspace tar must include root dependencies, package links, .turbo, and dist',
  );
  // upload-artifact v4 artifacts persist across run attempts: without
  // overwrite, "Re-run all jobs" 409s and reds setup + every warm lane.
  assert.match(setup, /overwrite:\s*true/, 'setup upload must set overwrite: true');
  assert.match(raw, /tar -xpf/);
  assert.match(raw, /verify-pnpm-injection\.mjs/);

  const cold = jobs.get('cold-gate');
  assert.ok(cold, 'cold-gate job');
  // Include the env-var indirection (CI_WORKSPACE_ARTIFACT / tar -xpf) so
  // cold-gate cannot consume the warm tar via the workflow-level env either.
  assert.doesNotMatch(
    cold,
    /download-artifact|workspace-\$\{\{\s*github\.sha\s*\}\}|CI_WORKSPACE_ARTIFACT|tar -xpf/,
    'cold-gate must not consume the warm workspace artifact (directly or via env)',
  );
  assert.match(cold, /Install dependencies without package-manager cache/);
  assert.match(cold, /Build from cold install/);

  for (const job of ['lint', 'test', 'dogfood', 'graph-equivalence', 'policy-and-docs']) {
    const segment = jobs.get(job);
    assert.ok(segment, job);
    assert.match(segment, /needs:\s*setup/, `${job} needs setup`);
    assert.match(segment, /verify-pnpm-injection\.mjs/, `${job} verifies injection post-restore`);
    // Integrity gate must run AFTER the restore, not before it.
    const restoreIdx = segment.indexOf('Restore workspace');
    const verifyIdx = segment.indexOf('verify-pnpm-injection.mjs');
    assert.ok(restoreIdx >= 0, `${job} restores the workspace`);
    assert.ok(verifyIdx > restoreIdx, `${job} verifies injection after restore`);
  }

  // Cross-run Turbo task caches for the turbo-task lanes (test re-use is the
  // PR-push cost win; content-addressed entries union safely with the tar's).
  for (const job of ['lint', 'test']) {
    assert.match(jobs.get(job), /path:\s*\.turbo/, `${job} must restore a cross-run .turbo cache`);
  }
});
