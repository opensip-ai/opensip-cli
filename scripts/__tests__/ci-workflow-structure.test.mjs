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
  SHA_PIN,
  assertThirdPartyActionsPinned,
  collectActionRefs,
  readWorkflow,
  stripComments,
} from '../lib/github-workflow-asserts.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function readCompositeSetup() {
  return readFileSync(
    join(REPO_ROOT, '.github/actions/setup-workspace/action.yml'),
    'utf8',
  );
}

const REQUIRED_LANES = [
  'lint',
  'test',
  'dogfood',
  'graph-equivalence',
  'policy-and-docs',
  'cold-gate',
];

test('ci.yml declares workflow-level default-deny permissions', () => {
  const raw = readWorkflow('ci.yml');
  // Top-level permissions before jobs: (not only nested under a job).
  assert.match(
    raw,
    /^permissions:\s*\n\s*contents:\s*read\s*$/m,
    'workflow-level permissions: contents: read is required',
  );
});

test('ci.yml build-and-test aggregator needs every required lane including cold-gate', () => {
  const raw = readWorkflow('ci.yml');
  const block = raw.match(/build-and-test:\s*\n([\s\S]*?)(?=\n  [a-z]|\n*$)/);
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

test('ci.yml bounds every job with timeout-minutes', () => {
  const jobs = sliceCiJobs(readWorkflow('ci.yml'));
  assert.ok(jobs.has('setup'), 'setup job expected');
  for (const [job, segment] of jobs) {
    assert.match(
      segment,
      /timeout-minutes:\s*(\d+)/,
      `${job} must declare timeout-minutes`,
    );
    const n = Number(/timeout-minutes:\s*(\d+)/.exec(segment)[1]);
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
  void SHA_PIN; // exported for reuse; collectActionRefs already uses it
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
  assert.ok(raw.includes('run: pnpm lint'), 'run: pnpm lint');
  assert.ok(raw.includes('run: pnpm test:coverage'), 'run: pnpm test:coverage');
  assert.ok(raw.includes('run: pnpm fit:ci'), 'run: pnpm fit:ci');
  assert.ok(
    raw.includes('run: node packages/cli/dist/index.js graph --gate-save') ||
      raw.includes('run: pnpm graph:ci'),
    'graph gate counterpart',
  );
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
  const uploadBlocks = [...raw.matchAll(/Upload (?:fit|graph|yagni) SARIF[\s\S]*?uses:\s*github\/codeql-action\/upload-sarif@/g)];
  assert.equal(uploadBlocks.length, 3, 'three SARIF upload steps');
  for (const block of uploadBlocks) {
    assert.match(
      block[0],
      /head\.repo\.full_name\s*==\s*github\.repository/,
      'each upload-sarif if: must guard same-repo',
    );
  }
  assert.match(
    raw,
    /SARIF upload skipped on fork PR/,
    'fork skip notice step required',
  );
});

test('warm lanes restore shared workspace and verify injection; cold-gate does not', () => {
  const raw = readWorkflow('ci.yml');
  const jobs = sliceCiJobs(raw);
  assert.ok(jobs.has('setup'), 'setup job');
  assert.match(jobs.get('setup'), /Pack workspace for warm lanes/);
  assert.match(raw, /tar -cpf/);
  assert.match(raw, /tar -xpf/);
  assert.match(raw, /verify-pnpm-injection\.mjs/);

  const cold = jobs.get('cold-gate');
  assert.ok(cold, 'cold-gate job');
  assert.doesNotMatch(
    cold,
    /download-artifact|workspace-\$\{\{\s*github\.sha\s*\}\}/,
    'cold-gate must not consume the warm workspace artifact',
  );
  assert.match(cold, /Install dependencies without package-manager cache/);
  assert.match(cold, /Build from cold install/);

  for (const job of ['lint', 'test', 'dogfood', 'graph-equivalence', 'policy-and-docs']) {
    const segment = jobs.get(job);
    assert.ok(segment, job);
    assert.match(segment, /needs:\s*setup/, `${job} needs setup`);
    assert.match(segment, /verify-pnpm-injection\.mjs/, `${job} verifies injection post-restore`);
  }
});
