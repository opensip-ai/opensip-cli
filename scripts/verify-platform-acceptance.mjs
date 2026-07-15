#!/usr/bin/env node
/**
 * @fileoverview Independent verifier for installed-artifact platform-acceptance
 * evidence.
 *
 * A workflow must not trust the acceptance runner's console exit alone, and a
 * support claim must not accept a hand-edited or truncated file. This script is a
 * SEPARATE process that loads the profile independently, revalidates the sealed
 * evidence through the contract parser, and RECOMPUTES every derived claim from
 * the artifact's own contents — the profile digest, the summary, the verdict, and
 * the sealed-body digest — never trusting a value the runner printed.
 *
 * It imports ONLY the contract module (`platform-acceptance/contract.mjs`) plus
 * Node built-ins, so it runs on a bare checkout with no build step. It never
 * echoes child-process diagnostic tails, candidate registry URLs, or absolute
 * paths — only counts, ids, and closed reason codes.
 *
 * Grammar (a closed argv vocabulary):
 *   node scripts/verify-platform-acceptance.mjs
 *     --evidence <path>
 *     --profile <path>
 *     [--expected-version <semver>]
 *     [--expected-candidate-digest <hex>]
 *     [--expect-platform <id>] [--expect-arch <id>]
 *     [--expect-node-abi <n>] [--expect-fs-type <type>]
 *     [--json]
 *
 * Exit codes:
 *   0  evidence verified
 *   1  evidence loaded but did NOT verify (digest/order/verdict/summary/required/
 *      host/cleanup/bounds/timestamp mismatch, or the file is not valid JSON)
 *   2  invalid invocation (bad flags, or the profile/evidence file could not be read)
 *
 * `process.exitCode` is set ONLY at the top-level boundary.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeProfile,
  computeSummary,
  computeVerdict,
  evidenceDigest,
  parseAcceptanceEvidence,
  parseAcceptanceProfile,
  profileDigest,
} from './platform-acceptance/contract.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE_CONFIG_DIR = join(REPO_ROOT, '.config', 'platform-acceptance');

// Absolute read ceilings independent of any profile-declared bound, so a hostile
// file cannot exhaust memory before the profile's own bound is even known.
const ABSOLUTE_MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAX_PROFILE_BYTES = 1024 * 1024;

// Generous slack for wall-clock (ms-resolution ISO) vs monotonic-clock duration
// rounding. A single serial journey can never outlast the whole run window; this
// only guards against a grossly forged duration.
const DURATION_SLACK_MS = 5000;

const VALUE_FLAGS = new Set([
  '--evidence',
  '--profile',
  '--expected-version',
  '--expected-candidate-digest',
  '--expect-platform',
  '--expect-arch',
  '--expect-node-abi',
  '--expect-fs-type',
]);
const BOOLEAN_FLAGS = new Set(['--json']);

const HEX64 = /^[a-f0-9]{64}$/;
// An EXACT semver (matches the candidate-source authority): no ranges, tags,
// URLs, or paths. Prerelease/build metadata allowed.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOWER_TOKEN = /^[a-z][a-z0-9]*$/;
const DIGITS = /^\d+$/;
const FS_TOKEN = /^[A-Za-z][A-Za-z0-9._-]*$/;

const HELP = `verify-platform-acceptance — independently verify installed-artifact acceptance evidence

Usage:
  node scripts/verify-platform-acceptance.mjs --evidence <path> --profile <path> [expected checks] [--json]

Required:
  --evidence <path>   sealed acceptance evidence artifact (JSON) to verify
  --profile <path>    the data-only acceptance profile the run targeted

Optional expected-value cross-checks (each may appear at most once):
  --expected-version <semver>         candidate/installed version must equal this (leading "v" ok)
  --expected-candidate-digest <hex>   candidate identity digest (64 hex chars) must equal this
  --expect-platform <id>              host.platform must equal this (e.g. darwin, linux)
  --expect-arch <id>                  host.arch must equal this (e.g. arm64, x64)
  --expect-node-abi <n>               host Node module ABI must equal this (e.g. 137)
  --expect-fs-type <type>             run-root filesystem type must equal this (e.g. apfs, ext4)

Options:
  --json              print exactly one machine-readable JSON result to stdout
  -h, --help          print this help and exit 0

Exit codes:
  0   evidence verified
  1   evidence loaded but did not verify
  2   invalid invocation (bad flags, or the profile/evidence file could not be read)

A passing common profile qualifies the tested bytes on the tested host only; it is
NOT a declaration of official platform support.

Examples:
  node scripts/verify-platform-acceptance.mjs \\
    --evidence "/tmp/OpenSIP Acceptance/evidence.json" \\
    --profile .config/platform-acceptance/common-v1.json

  node scripts/verify-platform-acceptance.mjs \\
    --evidence "/tmp/acceptación/évidence.json" \\
    --profile .config/platform-acceptance/common-v1.json \\
    --expected-version 0.7.0 --expect-platform darwin --expect-arch arm64 --json`;

// ---------------------------------------------------------------------------
// Argv grammar
// ---------------------------------------------------------------------------

/** True when a value contains a C0/C1 control character. */
function hasControlChars(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalid(message) {
  return { ok: false, message };
}

/** Strip a single leading `v`, trim, and require an exact semver. */
function normalizeVersionInput(raw) {
  const trimmed = raw.trim().replace(/^v/, '');
  return EXACT_SEMVER.test(trimmed) ? trimmed : null;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };

  const seen = new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      return invalid(`unexpected argument ${JSON.stringify(token)}`);
    }
    if (seen.has(token)) return invalid(`duplicate flag ${token}`);
    seen.add(token);
    if (BOOLEAN_FLAGS.has(token)) {
      flags[token] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) return invalid(`unknown flag ${token}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return invalid(`flag ${token} requires a value`);
    }
    if (value.length === 0 || hasControlChars(value)) {
      return invalid(`flag ${token} has an invalid value`);
    }
    flags[token] = value;
    i += 1;
  }

  if (flags['--evidence'] === undefined) return invalid('--evidence is required');
  if (flags['--profile'] === undefined) return invalid('--profile is required');

  const expected = {};
  if (flags['--expected-version'] !== undefined) {
    const version = normalizeVersionInput(flags['--expected-version']);
    if (version === null) return invalid('--expected-version must be an exact semver');
    expected.version = version;
  }
  if (flags['--expected-candidate-digest'] !== undefined) {
    const digest = flags['--expected-candidate-digest'].toLowerCase();
    if (!HEX64.test(digest))
      return invalid('--expected-candidate-digest must be a 64-character hex digest');
    expected.candidateDigest = digest;
  }
  if (flags['--expect-platform'] !== undefined) {
    if (!LOWER_TOKEN.test(flags['--expect-platform']))
      return invalid('--expect-platform must be a lowercase token');
    expected.platform = flags['--expect-platform'];
  }
  if (flags['--expect-arch'] !== undefined) {
    if (!LOWER_TOKEN.test(flags['--expect-arch']))
      return invalid('--expect-arch must be a lowercase token');
    expected.arch = flags['--expect-arch'];
  }
  if (flags['--expect-node-abi'] !== undefined) {
    if (!DIGITS.test(flags['--expect-node-abi']))
      return invalid('--expect-node-abi must be a positive integer');
    expected.nodeAbi = flags['--expect-node-abi'];
  }
  if (flags['--expect-fs-type'] !== undefined) {
    if (!FS_TOKEN.test(flags['--expect-fs-type']))
      return invalid('--expect-fs-type must be a filesystem token');
    expected.fsType = flags['--expect-fs-type'];
  }

  return {
    ok: true,
    evidencePath: flags['--evidence'],
    profilePath: flags['--profile'],
    json: flags['--json'] === true,
    expected,
  };
}

// ---------------------------------------------------------------------------
// Safe, bounded text + input loading
// ---------------------------------------------------------------------------

/** Prefer a closed contract reason code; fall back to a bounded, safe message. */
function reasonOf(error) {
  if (error && typeof error === 'object' && typeof error.reasonCode === 'string') {
    return error.reasonCode;
  }
  return safeText(error instanceof Error ? error.message : String(error));
}

/** Strip C0/C1 control characters, collapse whitespace, and bound the length. */
function safeText(value, max = 200) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  let out = '';
  for (const character of source) {
    const code = character.codePointAt(0);
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Read a small input file with an absolute byte ceiling; never echoes the path. */
function readInputFile(path, maxBytes, label) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, message: `${label} file could not be read` };
  }
  if (!stat.isFile()) return { ok: false, message: `${label} path is not a file` };
  if (stat.size > maxBytes)
    return { ok: false, message: `${label} file exceeds the ${maxBytes}-byte read ceiling` };
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return { ok: false, message: `${label} file could not be read` };
  }
  return { ok: true, buffer, byteLength: buffer.length };
}

/**
 * Load + validate the profile independently. When a base is declared, resolve the
 * known base from `.config/platform-acceptance/<baseId>.json` and run
 * `composeProfile` as a validation gate (a derived profile that weakens a bound or
 * drops a base journey is rejected). The parsed (uncomposed) profile is returned
 * because that is exactly what the runner digests + executes.
 */
function loadProfile(profilePath) {
  const read = readInputFile(profilePath, ABSOLUTE_MAX_PROFILE_BYTES, 'profile');
  if (!read.ok) return read;
  let raw;
  try {
    raw = JSON.parse(read.buffer.toString('utf8'));
  } catch {
    return { ok: false, message: 'profile file is not valid JSON' };
  }
  let profile;
  try {
    profile = parseAcceptanceProfile(raw);
  } catch (error) {
    return { ok: false, message: `profile is invalid (${reasonOf(error)})` };
  }
  if (profile.base) {
    const basePath = join(PROFILE_CONFIG_DIR, `${profile.base.id}.json`);
    const baseRead = readInputFile(basePath, ABSOLUTE_MAX_PROFILE_BYTES, 'base profile');
    if (!baseRead.ok)
      return { ok: false, message: `base profile ${profile.base.id} could not be read` };
    let baseRaw;
    try {
      baseRaw = JSON.parse(baseRead.buffer.toString('utf8'));
    } catch {
      return { ok: false, message: 'base profile file is not valid JSON' };
    }
    let base;
    try {
      base = parseAcceptanceProfile(baseRaw);
    } catch (error) {
      return { ok: false, message: `base profile is invalid (${reasonOf(error)})` };
    }
    try {
      composeProfile(base, raw);
    } catch (error) {
      return {
        ok: false,
        message: `derived profile does not legitimately extend its base (${reasonOf(error)})`,
      };
    }
  }
  return { ok: true, profile };
}

// ---------------------------------------------------------------------------
// The independent verification
// ---------------------------------------------------------------------------

function summariesEqual(a, b) {
  return (
    a.total === b.total &&
    a.passed === b.passed &&
    a.failed === b.failed &&
    a.skipped === b.skipped &&
    a.unavailable === b.unavailable &&
    a.requiredTotal === b.requiredTotal &&
    a.requiredPassed === b.requiredPassed
  );
}

function baseResult(profile) {
  return {
    verified: false,
    verdict: null,
    profile: { id: profile.id, version: profile.version },
    candidate: null,
    host: null,
    summary: null,
    requiredFailures: [],
    failures: [],
  };
}

/**
 * Independently verify a sealed evidence artifact against a validated profile.
 * Returns a redacted, serializable result. Content faults never throw — they
 * become `failures`; `verified` is true only when zero failures accumulate.
 *
 * @param {object} profile             a profile already returned by `loadProfile`.
 * @param {unknown} evidenceRaw        the JSON-parsed evidence artifact.
 * @param {number} evidenceByteLength  the on-disk serialized byte length.
 * @param {object} expected            optional expected candidate/host constraints.
 */
function verifyAcceptance(profile, evidenceRaw, evidenceByteLength, expected) {
  const result = baseResult(profile);
  const fail = (code, detail) =>
    result.failures.push(detail === undefined ? { code } : { code, detail });

  // 1. Revalidate the evidence schema. This ALSO re-verifies the sealed-body
  //    digest against the terminal completion record and rejects a missing one.
  let evidence;
  try {
    evidence = parseAcceptanceEvidence(evidenceRaw);
  } catch (error) {
    fail('evidence-schema-invalid', reasonOf(error));
    return result;
  }

  result.verdict = evidence.verdict;
  result.candidate = { kind: evidence.candidate.kind, version: evidence.candidate.version };
  const fsType = evidence.host.filesystem.type;
  result.host = {
    platform: evidence.host.platform,
    arch: evidence.host.arch,
    nodeModuleAbi: evidence.host.nodeModuleAbi,
    fsType: typeof fsType === 'string' ? fsType : null,
  };

  // 2. Recompute the profile identity digest and cross-check it.
  if (profileDigest(profile) !== evidence.profile.digest) fail('profile-digest-mismatch');
  if (profile.id !== evidence.profile.id) fail('profile-id-mismatch');
  if (profile.version !== evidence.profile.version) fail('profile-version-mismatch');

  // 3. Independently recompute the sealed-body digest and cross-check the
  //    terminal completion record.
  if (evidenceDigest(evidence) !== evidence.completion.evidenceDigest)
    fail('evidence-digest-mismatch');

  // 4. Every profile journey present EXACTLY once, in canonical profile order,
  //    with a matching `required` flag; no unknown/duplicate/omitted ids.
  const results = evidence.results;
  const profileIds = new Set(profile.journeys.map((journey) => journey.id));
  const resultIds = new Set(results.map((entry) => entry.id));
  if (results.length !== profile.journeys.length) fail('journey-count-mismatch');
  for (const entry of results) {
    if (!profileIds.has(entry.id)) fail('unknown-journey', entry.id);
  }
  for (const journey of profile.journeys) {
    if (!resultIds.has(journey.id)) fail('journey-omitted', journey.id);
  }
  const aligned = Math.min(results.length, profile.journeys.length);
  for (let i = 0; i < aligned; i += 1) {
    const journey = profile.journeys[i];
    const entry = results[i];
    if (entry.id !== journey.id) fail('journey-order-mismatch', `index-${i}`);
    else if (entry.required !== journey.required) fail('journey-required-mismatch', journey.id);
  }

  // 5. Recompute the summary from the ordered results and cross-check.
  const recomputedSummary = computeSummary(profile, results);
  result.summary = recomputedSummary;
  if (!summariesEqual(recomputedSummary, evidence.summary)) fail('summary-mismatch');

  // 6. Recompute the verdict + cross-check the terminal state. An
  //    infrastructure fault is untrustworthy evidence — always a failure.
  if (evidence.completion.state === 'infrastructure-fault') {
    if (evidence.verdict !== 'infrastructure-fault') fail('verdict-state-mismatch');
    fail('infrastructure-fault');
  } else {
    const recomputedVerdict = computeVerdict(profile, results, evidence.cleanup);
    if (evidence.verdict !== recomputedVerdict) fail('verdict-mismatch');
  }
  if (evidence.verdict !== 'pass') fail('verdict-not-pass');

  // 7. Any required journey that did not pass is a verifier failure.
  for (const entry of results) {
    if (entry.required && entry.status !== 'pass') {
      result.requiredFailures.push({
        id: entry.id,
        status: entry.status,
        reasonCode: entry.reasonCode,
      });
    }
  }
  if (result.requiredFailures.length > 0) fail('required-journey-not-passed');

  // 8. Cleanup must be certain.
  if (evidence.cleanup.status !== 'clean' || evidence.cleanup.residualDescendants > 0)
    fail('cleanup-uncertain');

  // 9. Candidate identity: shape + expected cross-checks.
  if (!EXACT_SEMVER.test(evidence.candidate.version)) fail('candidate-version-malformed');
  if (!HEX64.test(evidence.candidate.digest)) fail('candidate-digest-malformed');
  if (expected.version !== undefined && evidence.candidate.version !== expected.version)
    fail('candidate-version-mismatch');
  if (
    expected.candidateDigest !== undefined &&
    evidence.candidate.digest !== expected.candidateDigest
  ) {
    fail('candidate-digest-mismatch');
  }

  // 10. Host facts against any expected constraints.
  if (expected.platform !== undefined && evidence.host.platform !== expected.platform)
    fail('host-platform-mismatch');
  if (expected.arch !== undefined && evidence.host.arch !== expected.arch)
    fail('host-arch-mismatch');
  if (expected.nodeAbi !== undefined && evidence.host.nodeModuleAbi !== expected.nodeAbi)
    fail('host-node-abi-mismatch');
  if (
    expected.fsType !== undefined &&
    (typeof fsType !== 'string' || fsType.toLowerCase() !== expected.fsType.toLowerCase())
  ) {
    fail('host-fs-type-mismatch');
  }

  // 11. Evidence byte bound (re-checked against the profile's own bound).
  if (
    typeof evidenceByteLength === 'number' &&
    evidenceByteLength > profile.bounds.maxEvidenceBytes
  ) {
    fail('evidence-bound-exceeded');
  }

  // 12. Timestamp / duration consistency (the contract already rejects a
  //     completedAt before startedAt; re-assert + bound each journey duration by
  //     the wall-clock run window).
  const startedMs = Date.parse(evidence.startedAt);
  const completedMs = Date.parse(evidence.completedAt);
  if (completedMs < startedMs) {
    fail('timestamp-order');
  } else {
    const window = completedMs - startedMs + DURATION_SLACK_MS;
    for (const entry of results) {
      if (entry.durationMs > window) {
        fail('duration-exceeds-window', entry.id);
        break;
      }
    }
  }

  result.verified = result.failures.length === 0;
  return result;
}

// ---------------------------------------------------------------------------
// Bounded output (counts + closed codes + ids only; never child output or paths)
// ---------------------------------------------------------------------------

function renderJson(result) {
  return {
    verified: result.verified,
    verdict: result.verdict,
    profile: result.profile,
    candidate: result.candidate,
    host: result.host,
    summary: result.summary,
    requiredFailures: result.requiredFailures,
    failures: result.failures,
  };
}

function renderHumanLines(result) {
  const lines = [`platform-acceptance verify: ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}`];
  if (result.profile) lines.push(`  profile: ${result.profile.id} v${result.profile.version}`);
  if (result.candidate)
    lines.push(`  candidate: ${result.candidate.kind} ${result.candidate.version}`);
  if (result.verdict) lines.push(`  verdict: ${result.verdict}`);
  if (result.summary) {
    const s = result.summary;
    lines.push(
      `  required: ${s.requiredPassed}/${s.requiredTotal}  (passed ${s.passed}, failed ${s.failed}, skipped ${s.skipped}, unavailable ${s.unavailable})`,
    );
  }
  return lines;
}

function renderFailureLines(result) {
  const lines = [];
  for (const failure of result.failures) {
    const detail = failure.detail === undefined ? '' : ` (${failure.detail})`;
    lines.push(`  FAIL ${failure.code}${detail}`);
  }
  for (const required of result.requiredFailures) {
    lines.push(
      `  REQUIRED ${required.status.toUpperCase()} ${required.id} (${required.reasonCode ?? 'unspecified'})`,
    );
  }
  return lines;
}

function emit(parsed, result) {
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(renderJson(result))}\n`);
  } else {
    process.stdout.write(`${renderHumanLines(result).join('\n')}\n`);
    const failures = renderFailureLines(result);
    if (failures.length > 0) process.stderr.write(`${failures.join('\n')}\n`);
  }
  return result.verified ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!parsed.ok) {
    process.stderr.write(`verify-platform-acceptance: ${parsed.message}\n`);
    return 2;
  }

  // The profile is a TRUSTED spec input: an unreadable/malformed profile is an
  // invalid invocation, not a verification outcome.
  const loaded = loadProfile(parsed.profilePath);
  if (!loaded.ok) {
    process.stderr.write(`verify-platform-acceptance: ${loaded.message}\n`);
    return 2;
  }

  // The evidence is the ARTIFACT UNDER TEST: a missing/unreadable/too-large file
  // is an invocation error; present-but-invalid content is a verification failure.
  const evidenceRead = readInputFile(parsed.evidencePath, ABSOLUTE_MAX_EVIDENCE_BYTES, 'evidence');
  if (!evidenceRead.ok) {
    process.stderr.write(`verify-platform-acceptance: ${evidenceRead.message}\n`);
    return 2;
  }
  let evidenceRaw;
  try {
    evidenceRaw = JSON.parse(evidenceRead.buffer.toString('utf8'));
  } catch {
    const result = baseResult(loaded.profile);
    result.failures.push({ code: 'evidence-not-json' });
    return emit(parsed, result);
  }

  const result = verifyAcceptance(
    loaded.profile,
    evidenceRaw,
    evidenceRead.byteLength,
    parsed.expected,
  );
  return emit(parsed, result);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `verify-platform-acceptance: unexpected error (${error instanceof Error ? error.name : 'error'})\n`,
  );
  process.exitCode = 2;
}
