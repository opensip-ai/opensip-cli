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
 * It imports only repository-local release/acceptance authorities plus Node
 * built-ins, so it runs on a bare checkout with no build step. It never echoes
 * child-process diagnostic tails, candidate registry URLs, or absolute paths —
 * only counts, ids, and closed reason codes.
 *
 * Grammar (a closed argv vocabulary):
 *   node scripts/verify-platform-acceptance.mjs
 *     --evidence <path>
 *     --profile <path>
 *     [--expected-version <semver>]
 *     [--expected-candidate-kind <packed-release|published-version>]
 *     [--expected-registry <https-url>]
 *     [--registry-integrity-inventory <path>]
 *     [--expected-candidate-digest <hex>]
 *     [--candidate-manifest <path>]
 *     [--expect-platform <id>] [--expect-arch <id>]
 *     [--expect-node-abi <n>] [--expect-fs-type <type>]
 *     [--expected-node-major <n>] [--expected-npm-major <n>]
 *     [--expected-support-row <rowId>] [--expected-support-contract-version <n>]
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

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareReleaseVersions } from './lib/release-version-policy.mjs';
import {
  MAX_RELEASE_MANIFEST_BYTES,
  normalizeReleaseManifest,
  renderSha256Sums,
} from './lib/release-artifacts.mjs';
import {
  parseRegistryIntegrityInventory,
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
} from './lib/registry-integrity-inventory.mjs';

import {
  composeProfile,
  computeSummary,
  computeVerdict,
  evidenceDigest,
  isJourneyApplicable,
  isJourneyRequired,
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
const ABSOLUTE_MAX_REGISTRY_INVENTORY_BYTES = 8 * 1024 * 1024;

// Generous slack for wall-clock (ms-resolution ISO) vs monotonic-clock duration
// rounding. A single serial journey can never outlast the whole run window; this
// only guards against a grossly forged duration.
const DURATION_SLACK_MS = 5000;

const VALUE_FLAGS = new Set([
  '--evidence',
  '--profile',
  '--expected-version',
  '--expected-candidate-kind',
  '--expected-registry',
  '--expected-candidate-digest',
  '--candidate-manifest',
  '--expected-manifest-digest',
  '--expected-registry-integrity-digest',
  '--registry-integrity-inventory',
  '--expected-previous-version',
  '--expected-git-sha',
  '--expected-run-id',
  '--expected-run-attempt',
  '--expected-runner-label',
  '--expect-platform',
  '--expect-arch',
  '--expect-node-abi',
  '--expect-fs-type',
  '--expected-node-major',
  '--expected-npm-major',
  '--expected-sw-vers-major',
  '--expected-kernel-major',
  '--expect-uname-arch',
  '--expect-case-sensitive',
  '--expect-shell',
  '--expected-support-row',
  '--expected-support-contract-version',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--expect-no-previous-candidate']);

const HEX64 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{7,64}$/;
// An EXACT semver (matches the candidate-source authority): no ranges, tags,
// URLs, or paths. Prerelease/build metadata allowed.
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)';
const SEMVER_PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_SEMVER = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}` +
    `(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const LOWER_TOKEN = /^[a-z][a-z0-9]*$/;
const FS_TOKEN = /^[A-Za-z][A-Za-z0-9._-]*$/;
// A support-row id token (kebab, dotted segments allowed) — mirrors the
// contract's id shape without importing the contract's private pattern.
const ROW_ID_TOKEN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CANDIDATE_KINDS = new Set(['packed-release', 'published-version']);

// A small, closed set of journeys intentionally treats a non-zero CLI exit as
// the behavior under test (for example, a seeded fitness finding exits 1). All
// other passing journeys must carry clean zero-exit terminal evidence.
export const EXPECTED_NON_ZERO_EXIT = new Map([
  // The cache-init promotion journey intentionally drives two clean command
  // failures — a bounded-lock/refusal exit (2) and a gate/config exit (1) — and
  // asserts each fails cleanly (structured error, no signal/timeout). Allow both
  // exact codes; the exact count is pinned in EXPECTED_ABNORMAL_TERMINAL_COUNTS.
  ['persistence.cache-init-promotion', new Set([1, 2])],
  ['analysis.audit-preinit', new Set([1])],
  ['analysis.fit', new Set([1])],
  ['analysis.yagni', new Set([1])],
  ['output.human-non-tty', new Set([1])],
  ['output.no-color', new Set([1])],
  ['output.json', new Set([1])],
  ['output.filters-raw', new Set([1])],
  ['output.pty', new Set([1])],
  ['extensions.fit-pack', new Set([1])],
  ['resilience.spaces-unicode', new Set([1])],
  ['resilience.symlink-root', new Set([1])],
  ['macos.path-semantics', new Set([1])],
  ['macos.pty-human-view', new Set([1])],
]);
export const EXPECTED_POSITIVE_EXIT = new Set([
  'extensions.sim-pack',
  'persistence.contention-retry',
  'resilience.permissions',
  'macos.permissions',
  'macos.browser-open',
  'macos.contention-recovery',
]);
export const EXPECTED_ABNORMAL_TERMINAL_COUNTS = new Map([
  ['persistence.cache-init-promotion', new Map([['positive-exit', 2]])],
  ['persistence.contention-retry', new Map([['positive-exit', 1]])],
  ['persistence.interrupted-recovery', new Map([['cancellation', 1]])],
  ['resilience.signals', new Map([['cancellation', 1]])],
  ['resilience.timeout-cleanup', new Map([['timeout', 1]])],
  // This composite macOS journey proves both bounded lock exhaustion and
  // cancellation of a blocked writer before replaying cleanly.
  [
    'macos.contention-recovery',
    new Map([
      ['positive-exit', 1],
      ['cancellation', 1],
    ]),
  ],
]);

const HELP = `verify-platform-acceptance — independently verify installed-artifact acceptance evidence

Usage:
  node scripts/verify-platform-acceptance.mjs --evidence <path> --profile <path> [expected checks] [--json]

Required:
  --evidence <path>   sealed acceptance evidence artifact (JSON) to verify
  --profile <path>    the data-only acceptance profile the run targeted

Optional expected-value cross-checks (each may appear at most once):
  --expected-version <semver>         candidate/installed version must equal this (leading "v" ok)
  --expected-candidate-kind <kind>    candidate kind: packed-release or published-version
  --expected-registry <https-url>     canonical registry identity must equal this
  --expected-candidate-digest <hex>   candidate identity digest (64 hex chars) must equal this
  --candidate-manifest <path>         release manifest used to recompute a packed candidate digest
  --expected-manifest-digest <hex>    bound release-manifest SHA-256 must equal this
  --expected-registry-integrity-digest <hex>
                                      bound registry-integrity inventory SHA-256
  --registry-integrity-inventory <path>
                                      canonical inventory used to recompute published binding proofs
  --expected-previous-version <semver> exact upgrade source must equal this
  --expect-no-previous-candidate      require a bootstrap/self-reinstall run
  --expected-git-sha <hex>            harness git SHA must equal this
  --expected-run-id <id>              workflow run identity must equal this
  --expected-run-attempt <n>          workflow run attempt must equal this
  --expected-runner-label <label>     pinned runner/image label must equal this
  --expect-platform <id>              host.platform must equal this (e.g. darwin, linux)
  --expect-arch <id>                  host.arch must equal this (e.g. arm64, x64)
  --expect-node-abi <n>               host Node module ABI must equal this (e.g. 137)
  --expect-fs-type <type>             run-root filesystem type must equal this (e.g. apfs, ext4)
  --expected-node-major <n>           host Node version major must equal this (e.g. 24)
  --expected-npm-major <n>            host npm version major must equal this (e.g. 11)
  --expected-sw-vers-major <n>        macOS product major from sw_vers must equal this
  --expected-kernel-major <n>         Darwin kernel major from uname -r must equal this
  --expect-uname-arch <id>            raw uname architecture must equal this
  --expect-case-sensitive <bool>      filesystem case-sensitivity must equal true/false
  --expect-shell <id>                 bounded shell basename must equal this
  --expected-support-row <rowId>      the profile's support-row binding id must equal this
  --expected-support-contract-version <n>  the profile's support-row contract version must equal this

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

/** Validate and canonicalize an npm registry identity without retaining credentials. */
function normalizeRegistryInput(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return `${url.origin}${url.pathname}`;
}

/** Leading integer major of a version string (`v24.16.0`/`11.0.0` → "24"/"11"), else null. */
function versionMajor(value) {
  if (typeof value !== 'string') return null;
  // Host-fact versions are NOT release semver: `sw_vers -productVersion`
  // reports two-component versions ("26.4") except on patch releases, and a
  // semver parser rejecting them fired host-sw-vers-major-mismatch on every
  // correctly-versioned macOS 26 runner. Accept v?MAJOR(.N)* and compare the
  // major; anything else (empty, leading zero, non-numeric) stays null so an
  // absent or malformed fact still fails loudly.
  const match = /^v?(0|[1-9]\d*)(?:\.\d+)*$/.exec(value.trim());
  return match === null ? null : match[1];
}

function positiveSafeIntegerString(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };

  const seen = new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // pnpm 11 (and some npm versions) forward the bare `--` script separator
    // as argv. Ignore end-of-options markers so package-script invocations match
    // direct-node invocations (same contract as run-platform-acceptance.mjs).
    if (token === '--') continue;
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
  if (flags['--expected-candidate-kind'] !== undefined) {
    const kind = flags['--expected-candidate-kind'];
    if (!CANDIDATE_KINDS.has(kind)) {
      return invalid('--expected-candidate-kind must be packed-release or published-version');
    }
    expected.candidateKind = kind;
  }
  if (flags['--expected-registry'] !== undefined) {
    const registry = normalizeRegistryInput(flags['--expected-registry']);
    if (registry === null) {
      return invalid('--expected-registry must be a credential-free HTTPS registry URL');
    }
    expected.registry = registry;
  }
  if (flags['--expected-candidate-digest'] !== undefined) {
    const digest = flags['--expected-candidate-digest'].toLowerCase();
    if (!HEX64.test(digest))
      return invalid('--expected-candidate-digest must be a 64-character hex digest');
    expected.candidateDigest = digest;
  }
  if (flags['--expected-manifest-digest'] !== undefined) {
    const digest = flags['--expected-manifest-digest'].toLowerCase();
    if (!HEX64.test(digest))
      return invalid('--expected-manifest-digest must be a 64-character hex digest');
    expected.manifestDigest = digest;
  }
  if (flags['--expected-registry-integrity-digest'] !== undefined) {
    const digest = flags['--expected-registry-integrity-digest'].toLowerCase();
    if (!HEX64.test(digest)) {
      return invalid('--expected-registry-integrity-digest must be a 64-character hex digest');
    }
    expected.registryIntegrityDigest = digest;
  }
  if (
    expected.candidateKind === 'packed-release' &&
    (expected.registry !== undefined ||
      expected.registryIntegrityDigest !== undefined ||
      flags['--registry-integrity-inventory'] !== undefined)
  ) {
    return invalid(
      'registry expectations and --registry-integrity-inventory are incompatible with packed-release',
    );
  }
  if (
    expected.candidateKind === 'published-version' &&
    flags['--candidate-manifest'] !== undefined
  ) {
    return invalid('--candidate-manifest is only valid with a packed-release candidate');
  }
  if (flags['--expected-previous-version'] !== undefined) {
    const version = normalizeVersionInput(flags['--expected-previous-version']);
    if (version === null) return invalid('--expected-previous-version must be an exact semver');
    expected.previousVersion = version;
  }
  if (
    flags['--expected-previous-version'] !== undefined &&
    flags['--expect-no-previous-candidate'] === true
  ) {
    return invalid(
      '--expected-previous-version and --expect-no-previous-candidate are mutually exclusive',
    );
  }
  if (flags['--expect-no-previous-candidate'] === true) expected.noPreviousCandidate = true;
  if (flags['--expected-git-sha'] !== undefined) {
    const sha = flags['--expected-git-sha'].toLowerCase();
    if (!/^[a-f0-9]{7,64}$/.test(sha))
      return invalid('--expected-git-sha must be a 7-64 character hex SHA');
    expected.gitSha = sha;
  }
  for (const [flag, key] of [
    ['--expected-run-id', 'runId'],
    ['--expected-runner-label', 'runnerLabel'],
  ]) {
    if (flags[flag] !== undefined) {
      if (!/^[A-Za-z0-9._-]+$/.test(flags[flag])) return invalid(`${flag} has an invalid value`);
      expected[key] = flags[flag];
    }
  }
  if (flags['--expected-run-attempt'] !== undefined) {
    const value = positiveSafeIntegerString(flags['--expected-run-attempt']);
    if (value === null) return invalid('--expected-run-attempt must be a positive safe integer');
    expected.runAttempt = Number(value);
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
    const value = positiveSafeIntegerString(flags['--expect-node-abi']);
    if (value === null) return invalid('--expect-node-abi must be a positive safe integer');
    expected.nodeAbi = value;
  }
  if (flags['--expect-fs-type'] !== undefined) {
    if (!FS_TOKEN.test(flags['--expect-fs-type']))
      return invalid('--expect-fs-type must be a filesystem token');
    expected.fsType = flags['--expect-fs-type'];
  }
  if (flags['--expected-node-major'] !== undefined) {
    const value = positiveSafeIntegerString(flags['--expected-node-major']);
    if (value === null) return invalid('--expected-node-major must be a positive safe integer');
    expected.nodeMajor = value;
  }
  if (flags['--expected-npm-major'] !== undefined) {
    const value = positiveSafeIntegerString(flags['--expected-npm-major']);
    if (value === null) return invalid('--expected-npm-major must be a positive safe integer');
    expected.npmMajor = value;
  }
  for (const [flag, key] of [
    ['--expected-sw-vers-major', 'swVersMajor'],
    ['--expected-kernel-major', 'kernelMajor'],
  ]) {
    if (flags[flag] !== undefined) {
      const value = positiveSafeIntegerString(flags[flag]);
      if (value === null) return invalid(`${flag} must be a positive safe integer`);
      expected[key] = value;
    }
  }
  for (const [flag, key] of [
    ['--expect-uname-arch', 'unameArch'],
    ['--expect-shell', 'shell'],
  ]) {
    if (flags[flag] !== undefined) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(flags[flag]))
        return invalid(`${flag} must be a bounded token`);
      expected[key] = flags[flag];
    }
  }
  if (flags['--expect-case-sensitive'] !== undefined) {
    if (!['true', 'false'].includes(flags['--expect-case-sensitive']))
      return invalid('--expect-case-sensitive must be true or false');
    expected.caseSensitive = flags['--expect-case-sensitive'] === 'true';
  }
  if (flags['--expected-support-row'] !== undefined) {
    if (!ROW_ID_TOKEN.test(flags['--expected-support-row']))
      return invalid('--expected-support-row must be a support-row id token');
    expected.supportRowId = flags['--expected-support-row'];
  }
  if (flags['--expected-support-contract-version'] !== undefined) {
    const value = positiveSafeIntegerString(flags['--expected-support-contract-version']);
    if (value === null) {
      return invalid('--expected-support-contract-version must be a positive safe integer');
    }
    expected.supportContractVersion = value;
  }

  return {
    ok: true,
    evidencePath: flags['--evidence'],
    profilePath: flags['--profile'],
    candidateManifestPath: flags['--candidate-manifest'],
    registryInventoryPath: flags['--registry-integrity-inventory'],
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

/**
 * Read a small input file from one no-follow descriptor with an absolute byte
 * ceiling. The pre-open identity, descriptor identity, and post-read metadata
 * must agree so a path replacement or concurrent mutation cannot substitute
 * different bytes between validation and parsing. Never echoes the path.
 */
function readInputFile(path, maxBytes, label) {
  let pathStat;
  try {
    pathStat = lstatSync(path);
  } catch {
    return { ok: false, message: `${label} file could not be read` };
  }
  if (!pathStat.isFile()) return { ok: false, message: `${label} path is not a regular file` };
  if (pathStat.size > maxBytes)
    return {
      ok: false,
      message: `${label} file exceeds the ${maxBytes}-byte read ceiling`,
    };

  let descriptor;
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    return { ok: false, message: `${label} file could not be read` };
  }

  try {
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      return {
        ok: false,
        message: `${label} file changed before it could be read`,
      };
    }
    if (openedStat.size > maxBytes) {
      return {
        ok: false,
        message: `${label} file exceeds the ${maxBytes}-byte read ceiling`,
      };
    }

    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let byteLength = 0;
    while (byteLength < bounded.length) {
      const count = readSync(descriptor, bounded, byteLength, bounded.length - byteLength, null);
      if (count === 0) break;
      byteLength += count;
    }
    if (byteLength > maxBytes) {
      return {
        ok: false,
        message: `${label} file exceeds the ${maxBytes}-byte read ceiling`,
      };
    }

    const completedStat = fstatSync(descriptor);
    if (
      completedStat.dev !== openedStat.dev ||
      completedStat.ino !== openedStat.ino ||
      completedStat.size !== openedStat.size ||
      completedStat.size !== byteLength ||
      completedStat.mtimeMs !== openedStat.mtimeMs ||
      completedStat.ctimeMs !== openedStat.ctimeMs
    ) {
      return {
        ok: false,
        message: `${label} file changed while it was being read`,
      };
    }

    const buffer = bounded.subarray(0, byteLength);
    return { ok: true, buffer, byteLength };
  } catch {
    return { ok: false, message: `${label} file could not be read` };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Load + validate the profile independently. When a base is declared, resolve the
 * known base from `.config/platform-acceptance/<baseId>.json` and run
 * `composeProfile` as the executable profile (a derived profile that weakens a
 * bound or drops a base journey is rejected before either process trusts it).
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
      return {
        ok: false,
        message: `base profile ${profile.base.id} could not be read`,
      };
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
      return {
        ok: false,
        message: `base profile is invalid (${reasonOf(error)})`,
      };
    }
    try {
      profile = composeProfile(base, raw);
    } catch (error) {
      return {
        ok: false,
        message: `derived profile does not legitimately extend its base (${reasonOf(error)})`,
      };
    }
  }
  return { ok: true, profile };
}

/** Load the exact release manifest needed to reproduce packed candidate identity. */
function loadCandidateManifest(manifestPath) {
  const read = readInputFile(manifestPath, MAX_RELEASE_MANIFEST_BYTES, 'candidate manifest');
  if (!read.ok) return read;
  let raw;
  try {
    raw = JSON.parse(read.buffer.toString('utf8'));
  } catch {
    return { ok: false, message: 'candidate manifest file is not valid JSON' };
  }
  let manifest;
  try {
    manifest = normalizeReleaseManifest(raw, '<candidate-manifest>');
  } catch (error) {
    return {
      ok: false,
      message: `candidate manifest is invalid (${reasonOf(error)})`,
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      manifest,
      digest: createHash('sha256').update(read.buffer).digest('hex'),
    }),
  };
}

/** Load the retained closed inventory whose rows independently bind published installs. */
function loadRegistryInventory(inventoryPath) {
  const read = readInputFile(
    inventoryPath,
    ABSOLUTE_MAX_REGISTRY_INVENTORY_BYTES,
    'registry integrity inventory',
  );
  if (!read.ok) return read;
  let raw;
  try {
    raw = JSON.parse(read.buffer.toString('utf8'));
  } catch {
    return {
      ok: false,
      message: 'registry integrity inventory is not valid JSON',
    };
  }
  let inventory;
  try {
    inventory = parseRegistryIntegrityInventory(raw);
  } catch (error) {
    return {
      ok: false,
      message: `registry integrity inventory is invalid (${reasonOf(error)})`,
    };
  }
  const canonical = Buffer.from(renderRegistryIntegrityInventory(inventory), 'utf8');
  if (!read.buffer.equals(canonical)) {
    return {
      ok: false,
      message: 'registry integrity inventory is not canonical JSON',
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      inventory,
      digest: registryIntegrityDigest(inventory),
    }),
  };
}

/** Reproduce candidate-source.mjs's redacted identity digest from trusted inputs. */
function canonicalCandidateDigest(candidate, manifestBinding) {
  if (candidate.kind === 'published-version') {
    if (manifestBinding !== undefined) {
      return { ok: false, reasonCode: 'candidate-manifest-unexpected' };
    }
    if (typeof candidate.registry !== 'string') {
      return { ok: false, reasonCode: 'candidate-registry-missing' };
    }
    return {
      ok: true,
      digest: createHash('sha256')
        .update('published\nopensip-cli@')
        .update(candidate.version)
        .update('\n')
        .update(candidate.registry)
        .update('\n')
        .update(candidate.registryIntegrityDigest ?? 'unbound-registry-integrity')
        .update('\n')
        .update(candidate.manifestDigest ?? 'unbound-manifest')
        .digest('hex'),
    };
  }

  if (manifestBinding === undefined) {
    return { ok: false, reasonCode: 'candidate-manifest-required' };
  }
  if (manifestBinding.manifest.releaseVersion !== candidate.version) {
    return { ok: false, reasonCode: 'candidate-manifest-version-mismatch' };
  }
  if (manifestBinding.digest !== candidate.manifestDigest) {
    return { ok: false, reasonCode: 'candidate-manifest-digest-mismatch' };
  }
  const checksumBody = renderSha256Sums(
    manifestBinding.manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
    })),
  );
  return {
    ok: true,
    digest: createHash('sha256')
      .update('packed\n')
      .update(candidate.version)
      .update('\n')
      .update(checksumBody)
      .digest('hex'),
  };
}

function registryPackageSetDigest(rows) {
  const canonicalRows = rows.map((entry) => ({
    name: entry.name,
    version: entry.version,
    tarball: entry.tarball,
    tarballUrl: entry.tarballUrl,
    integrity: entry.integrity,
    sha256: entry.sha256,
  }));
  return createHash('sha256')
    .update('opensip-registry-install-binding-v1\n')
    .update(JSON.stringify(canonicalRows))
    .digest('hex');
}

function verifyRegistryBindingProof(proof, inventoryBinding, prefix, fail) {
  if (proof === null) {
    fail(`${prefix}-missing`);
    return;
  }
  const { inventory, digest } = inventoryBinding;
  if (proof.inventoryDigest !== digest) fail(`${prefix}-inventory-digest-mismatch`);
  if (proof.offlineReplayComplete !== true) fail(`${prefix}-offline-replay-incomplete`);
  if (proof.packageCount !== proof.packageNames.length) fail(`${prefix}-package-count-mismatch`);

  const indexByName = new Map(inventory.packages.map((entry, index) => [entry.name, index]));
  const rows = [];
  let previousIndex = -1;
  let validProjection = true;
  for (const name of proof.packageNames) {
    const index = indexByName.get(name);
    if (index === undefined || index <= previousIndex) {
      validProjection = false;
      break;
    }
    previousIndex = index;
    rows.push(inventory.packages[index]);
  }
  if (!proof.packageNames.includes('opensip-cli') || !validProjection) {
    fail(`${prefix}-package-projection-mismatch`);
    return;
  }
  if (registryPackageSetDigest(rows) !== proof.packageSetDigest) {
    fail(`${prefix}-package-set-digest-mismatch`);
  }
}

function sameRegistryBindingProof(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.inventoryDigest === right.inventoryDigest &&
    left.packageCount === right.packageCount &&
    left.packageSetDigest === right.packageSetDigest &&
    left.offlineReplayComplete === right.offlineReplayComplete &&
    left.packageNames.length === right.packageNames.length &&
    left.packageNames.every((name, index) => name === right.packageNames[index])
  );
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
 * The only passing journeys allowed to contain an intentionally abnormal
 * process terminal. Ordinary command journeys must never turn a signal,
 * cancellation, or timeout into an expected non-zero exit.
 */
function isExpectedNonZeroExit(journeyId, step) {
  if (
    step.exitCode === null ||
    step.exitCode === 0 ||
    step.signal !== null ||
    step.timedOut ||
    step.cancelled ||
    step.reasonCode !== 'command-failed'
  ) {
    return false;
  }
  const exact = EXPECTED_NON_ZERO_EXIT.get(journeyId);
  return exact?.has(step.exitCode) === true || EXPECTED_POSITIVE_EXIT.has(journeyId);
}

function expectedAbnormalTerminalKind(journeyId, step) {
  if (isExpectedNonZeroExit(journeyId, step)) return 'positive-exit';
  if (journeyId === 'resilience.signals') {
    return step.cancelled === true && step.timedOut === false && step.reasonCode === 'cancelled'
      ? 'cancellation'
      : null;
  }
  if (journeyId === 'resilience.timeout-cleanup') {
    return step.timedOut === true && step.reasonCode === 'timed-out' ? 'timeout' : null;
  }
  if (
    journeyId === 'persistence.interrupted-recovery' ||
    journeyId === 'macos.contention-recovery'
  ) {
    return step.cancelled === true && step.timedOut === false && step.reasonCode === 'cancelled'
      ? 'cancellation'
      : null;
  }
  if (journeyId === 'macos.signals') {
    const delivered = step.deliveredSignal;
    return step.timedOut === false &&
      step.cancelled === false &&
      (delivered === 'SIGINT' || delivered === 'SIGTERM') &&
      (step.signal === null || step.signal === delivered) &&
      (step.signal !== null || (step.exitCode !== null && step.exitCode !== 0)) &&
      step.reasonCode === 'command-failed'
      ? `native-signal:${delivered}`
      : null;
  }
  return null;
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
  result.candidate = {
    kind: evidence.candidate.kind,
    version: evidence.candidate.version,
  };
  const fsType = evidence.host.filesystem.type;
  result.host = {
    platform: evidence.host.platform,
    arch: evidence.host.arch,
    nodeModuleAbi: evidence.host.nodeModuleAbi,
    fsType: typeof fsType === 'string' ? fsType : null,
  };
  if (
    evidence.host.platform === 'win32' &&
    evidence.host.capabilities['process-tree-cleanup'] === true
  ) {
    fail('impossible-host-capability-claim', 'process-tree-cleanup');
  }

  // 2. Schema and profile identity must agree (v1 history vs v2 execution).
  if (profile.schemaVersion !== evidence.schemaVersion) {
    fail(
      'evidence-schema-mismatch',
      `profile=${profile.schemaVersion} evidence=${evidence.schemaVersion}`,
    );
  }
  if (profileDigest(profile) !== evidence.profile.digest) fail('profile-digest-mismatch');
  if (profile.id !== evidence.profile.id) fail('profile-id-mismatch');
  if (profile.version !== evidence.profile.version) fail('profile-version-mismatch');
  for (const capability of profile.requiredCapabilities) {
    if (evidence.host.capabilities[capability] !== true) {
      fail('required-host-capability-unavailable', capability);
    }
  }

  // 3. Independently recompute the sealed-body digest and cross-check the
  //    terminal completion record.
  if (evidenceDigest(evidence) !== evidence.completion.evidenceDigest)
    fail('evidence-digest-mismatch');

  // 4. Every profile journey present EXACTLY once, in canonical profile order,
  //    with a matching `required` flag; no unknown/duplicate/omitted ids.
  const results = evidence.results;
  if (results.length > profile.bounds.maxJourneyResults) {
    fail('max-journey-results-exceeded');
  }
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
    if (entry.id === journey.id) {
      const applicable = isJourneyApplicable(journey, evidence.candidate.kind);
      const expectedRequired = applicable && isJourneyRequired(journey, evidence.previousCandidate);
      if (entry.required !== expectedRequired) fail('journey-required-mismatch', journey.id);

      // Schema-v2: result requiredPorts must equal the profile selection exactly.
      if (profile.schemaVersion === 2) {
        const expectedPorts = journey.requiredPorts ?? [];
        const actualPorts = entry.requiredPorts ?? [];
        if (
          expectedPorts.length !== actualPorts.length ||
          expectedPorts.some((port, index) => port !== actualPorts[index])
        ) {
          fail('required-ports-mismatch', journey.id);
        }
        // Only persistence.cache-init-promotion may pass with a non-null continuityProof.
        if (journey.id === 'persistence.cache-init-promotion') {
          if (entry.status === 'pass' && entry.continuityProof === null) {
            fail('continuity-proof-required', journey.id);
          }
        } else if (entry.continuityProof != null) {
          fail('continuity-proof-forbidden', journey.id);
        }
      }

      let expectedSkipReason = null;
      if (applicable) {
        if (journey.id === 'lifecycle.upgrade' && evidence.previousCandidate === null) {
          expectedSkipReason = 'previous-candidate-not-supplied';
        }
      } else {
        expectedSkipReason = 'candidate-kind-not-applicable';
      }
      if (expectedSkipReason !== null) {
        if (entry.status !== 'skipped' || entry.reasonCode !== expectedSkipReason) {
          fail(
            expectedSkipReason === 'candidate-kind-not-applicable'
              ? 'candidate-kind-skip-mismatch'
              : 'previous-candidate-skip-mismatch',
            journey.id,
          );
        }
        if (
          entry.durationMs !== 0 ||
          (entry.steps?.length ?? 0) > 0 ||
          entry.rss.status !== 'unavailable' ||
          entry.rss.reasonCode !== 'rss-not-sampled'
        ) {
          fail('semantic-skip-effects-present', journey.id);
        }
      }
    } else {
      fail('journey-order-mismatch', `index-${i}`);
    }
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

  // A required pass without terminal child evidence is not independently
  // auditable. Any passing row that admits truncated output, uncollected
  // descendants, or a missing terminal observation is likewise untrustworthy.
  for (const entry of results) {
    const steps = entry.steps;
    if (entry.status === 'pass' && (!Array.isArray(steps) || steps.length === 0)) {
      fail('passing-step-evidence-missing', entry.id);
      continue;
    }
    if (!Array.isArray(steps)) continue;
    let sampledStep = false;
    let maxStepPeak = 0;
    const expectedAbnormalTerminalCounts = new Map();
    const nativeSignalObservations = [];
    for (const step of steps) {
      if (step.exitCode === null && step.signal === null) {
        fail('step-terminal-missing', `${entry.id}:${step.label}`);
      }
      const abnormalTerminal =
        (step.exitCode !== null && step.exitCode !== 0) ||
        step.signal !== null ||
        step.timedOut === true ||
        step.cancelled === true;
      if (abnormalTerminal) {
        const terminalKind = expectedAbnormalTerminalKind(entry.id, step);
        if (terminalKind !== null) {
          expectedAbnormalTerminalCounts.set(
            terminalKind,
            (expectedAbnormalTerminalCounts.get(terminalKind) ?? 0) + 1,
          );
          if (entry.id === 'macos.signals') {
            nativeSignalObservations.push(step.deliveredSignal);
          }
        } else if (entry.status === 'pass') {
          fail('unexpected-abnormal-terminal', `${entry.id}:${step.label}`);
        }
      }
      if (step.outputTruncated || step.residualDescendants > 0) {
        fail('step-integrity-failed', `${entry.id}:${step.label}`);
      }
      if (entry.required && entry.status === 'pass' && profile.rssRequired) {
        if (step.rss.status === 'available') {
          sampledStep = true;
          maxStepPeak = Math.max(maxStepPeak, step.rss.peakBytes);
        } else if (step.rss.reasonCode !== 'rss-child-too-short') {
          fail('required-step-rss-untrustworthy', `${entry.id}:${step.label}`);
        }
      }
    }
    const requiredTerminalCounts = EXPECTED_ABNORMAL_TERMINAL_COUNTS.get(entry.id);
    if (entry.status === 'pass' && requiredTerminalCounts !== undefined) {
      for (const [terminalKind, requiredCount] of requiredTerminalCounts) {
        const actualCount = expectedAbnormalTerminalCounts.get(terminalKind) ?? 0;
        const detail = `${entry.id}:${terminalKind}:expected=${requiredCount}:actual=${actualCount}`;
        if (actualCount < requiredCount) {
          fail('expected-abnormal-terminal-missing', detail);
        } else if (actualCount > requiredCount) {
          fail('expected-abnormal-terminal-duplicate', detail);
        }
      }
    }
    if (
      entry.status === 'pass' &&
      entry.id === 'macos.signals' &&
      (nativeSignalObservations.length !== 2 ||
        nativeSignalObservations.filter((signal) => signal === 'SIGINT').length !== 1 ||
        nativeSignalObservations.filter((signal) => signal === 'SIGTERM').length !== 1)
    ) {
      fail('native-signal-observations-mismatch', entry.id);
    }
    if (entry.required && entry.status === 'pass' && profile.rssRequired) {
      if (!sampledStep) fail('required-step-rss-missing', entry.id);
      if (entry.rss.status !== 'available' || entry.rss.peakBytes < maxStepPeak) {
        fail('aggregate-rss-understates-step', entry.id);
      }
    }
  }

  // 8. Cleanup must be certain.
  if (evidence.cleanup.status !== 'clean' || evidence.cleanup.residualDescendants > 0)
    fail('cleanup-uncertain');

  // 9. Candidate identity: shape + expected cross-checks.
  if (!EXACT_SEMVER.test(evidence.candidate.version)) fail('candidate-version-malformed');
  if (!HEX64.test(evidence.candidate.digest)) fail('candidate-digest-malformed');
  const recomputedCandidate = canonicalCandidateDigest(
    evidence.candidate,
    expected.candidateManifest,
  );
  if (!recomputedCandidate.ok) {
    fail(recomputedCandidate.reasonCode);
  } else if (recomputedCandidate.digest !== evidence.candidate.digest) {
    fail('candidate-digest-mismatch');
  }
  if (expected.candidateKind !== undefined && evidence.candidate.kind !== expected.candidateKind) {
    fail('candidate-kind-mismatch');
  }
  if (expected.registry !== undefined && evidence.candidate.registry !== expected.registry) {
    fail('candidate-registry-mismatch');
  }
  if (expected.version !== undefined && evidence.candidate.version !== expected.version)
    fail('candidate-version-mismatch');
  if (
    expected.candidateDigest !== undefined &&
    evidence.candidate.digest !== expected.candidateDigest
  ) {
    fail('candidate-digest-mismatch');
  }
  if (
    expected.manifestDigest !== undefined &&
    evidence.candidate.manifestDigest !== expected.manifestDigest
  ) {
    fail('candidate-manifest-digest-mismatch');
  }
  if (
    evidence.candidate.manifestDigest !== undefined &&
    !HEX64.test(evidence.candidate.manifestDigest)
  ) {
    fail('candidate-manifest-digest-malformed');
  }
  if (
    expected.registryIntegrityDigest !== undefined &&
    evidence.candidate.registryIntegrityDigest !== expected.registryIntegrityDigest
  ) {
    fail('candidate-registry-integrity-digest-mismatch');
  }
  if (
    evidence.candidate.registryIntegrityDigest !== undefined &&
    !HEX64.test(evidence.candidate.registryIntegrityDigest)
  ) {
    fail('candidate-registry-integrity-digest-malformed');
  }
  if (evidence.candidate.kind === 'published-version') {
    if (
      evidence.lifecycle.targetInstallChannel !== undefined &&
      evidence.lifecycle.targetInstallChannel !== 'npm-direct' &&
      evidence.lifecycle.targetInstallChannel !== 'canonical-installer'
    ) {
      fail('lifecycle-install-channel-candidate-kind-mismatch');
    }
    const inventoryBinding = expected.registryInventory;
    const registryBindings = evidence.registryBindings;
    if (registryBindings === undefined) {
      fail('registry-binding-evidence-missing');
    }
    if (inventoryBinding === undefined) {
      fail('registry-inventory-required');
    } else if (registryBindings !== undefined) {
      const { inventory, digest } = inventoryBinding;
      if (digest !== evidence.candidate.registryIntegrityDigest) {
        fail('registry-inventory-digest-mismatch');
      }
      if (inventory.releaseVersion !== evidence.candidate.version) {
        fail('registry-inventory-version-mismatch');
      }
      if (inventory.registry !== evidence.candidate.registry) {
        fail('registry-inventory-registry-mismatch');
      }
      if (
        evidence.candidate.manifestDigest !== undefined &&
        inventory.manifestDigest !== evidence.candidate.manifestDigest
      ) {
        fail('registry-inventory-manifest-digest-mismatch');
      }
      verifyRegistryBindingProof(
        registryBindings.candidateLifecycle,
        inventoryBinding,
        'registry-candidate-lifecycle-binding',
        fail,
      );
      const canonicalInstallerSelection = profile.journeys.find(
        (entry) => entry.id === 'macos.installer-sh',
      );
      const canonicalInstallerSelected =
        canonicalInstallerSelection !== undefined &&
        isJourneyApplicable(canonicalInstallerSelection, evidence.candidate.kind);
      const canonicalChannel = evidence.lifecycle.targetInstallChannel === 'canonical-installer';
      if (canonicalInstallerSelected && !canonicalChannel) {
        fail('canonical-installer-channel-unproven');
      }
      if (canonicalChannel) {
        verifyRegistryBindingProof(
          registryBindings.canonicalInstaller,
          inventoryBinding,
          'registry-canonical-installer-binding',
          fail,
        );
        if (
          !sameRegistryBindingProof(
            registryBindings.candidateLifecycle,
            registryBindings.canonicalInstaller,
          )
        ) {
          fail('registry-install-bindings-target-mismatch');
        }
      } else if (registryBindings.canonicalInstaller !== null) {
        fail('registry-canonical-installer-binding-unexpected');
      }
    }
  } else {
    if (
      evidence.lifecycle.targetInstallChannel !== undefined &&
      evidence.lifecycle.targetInstallChannel !== 'packed-consumer'
    ) {
      fail('lifecycle-install-channel-candidate-kind-mismatch');
    }
    const packedBindings = evidence.registryBindings;
    if (
      expected.registryInventory !== undefined ||
      packedBindings?.candidateLifecycle != null ||
      packedBindings?.canonicalInstaller != null
    ) {
      fail('registry-binding-unexpected-for-packed-candidate');
    }
  }
  if (
    expected.previousVersion !== undefined &&
    evidence.previousCandidate?.version !== expected.previousVersion
  ) {
    fail('previous-candidate-version-mismatch');
  }
  if (expected.noPreviousCandidate === true && evidence.previousCandidate !== null)
    fail('unexpected-previous-candidate');
  if (evidence.previousCandidate !== null) {
    if (!EXACT_SEMVER.test(evidence.previousCandidate.version))
      fail('previous-candidate-version-malformed');
    if (evidence.previousCandidate.kind !== evidence.candidate.kind)
      fail('previous-candidate-kind-mismatch');
    if (evidence.previousCandidate.kind === 'published-version') {
      const recomputedPrevious = canonicalCandidateDigest(evidence.previousCandidate);
      if (!recomputedPrevious.ok) {
        fail(`previous-${recomputedPrevious.reasonCode}`);
      } else if (recomputedPrevious.digest !== evidence.previousCandidate.digest) {
        fail('previous-candidate-digest-mismatch');
      }
    } else {
      // The current invocation grammar only admits an exact published previous
      // version. A packed previous candidate would require its own independently
      // retained manifest, which this verifier does not accept implicitly.
      fail('previous-candidate-proof-unavailable');
    }
    try {
      if (
        compareReleaseVersions(evidence.previousCandidate.version, evidence.candidate.version) >= 0
      ) {
        fail('previous-candidate-not-older');
      }
    } catch {
      fail('previous-candidate-version-malformed');
    }
  }
  const expectedInstalledVersion =
    evidence.previousCandidate?.version ?? evidence.candidate.version;
  if (evidence.lifecycle.installedVersion !== expectedInstalledVersion)
    fail('lifecycle-installed-version-mismatch');
  const upgradeJourney = profile.journeys.find((journey) => journey.id === 'lifecycle.upgrade');
  const upgradeResult = results.find((entry) => entry.id === 'lifecycle.upgrade');
  const upgradeRequired =
    upgradeJourney !== undefined &&
    isJourneyApplicable(upgradeJourney, evidence.candidate.kind) &&
    isJourneyRequired(upgradeJourney, evidence.previousCandidate);
  const upgradePassed = upgradeResult?.status === 'pass';
  // An optional failed/skipped/unavailable upgrade is visible evidence, but it
  // does not gate the profile. Successful upgrade claims, and every dynamically
  // required previous→target migration, must still prove their lifecycle facts.
  if (upgradeRequired || upgradePassed) {
    if (evidence.lifecycle.upgradedVersion !== evidence.candidate.version)
      fail('lifecycle-upgraded-version-mismatch');
    if (evidence.lifecycle.stateMigrated !== true) fail('lifecycle-state-migration-unproven');
    if (evidence.previousCandidate !== null && evidence.lifecycle.versionMigrated !== true)
      fail('lifecycle-version-migration-unproven');
  } else if (
    upgradeJourney !== undefined &&
    evidence.previousCandidate === null &&
    (evidence.lifecycle.upgradedVersion !== null ||
      evidence.lifecycle.versionMigrated !== null ||
      evidence.lifecycle.stateMigrated !== null)
  ) {
    fail('unexpected-upgrade-effects-without-previous');
  }
  if (evidence.lifecycle.cliStateRemoved !== true) fail('lifecycle-cli-state-removal-unproven');
  if (evidence.lifecycle.packageRemoved !== true) fail('lifecycle-package-removal-unproven');
  if (!GIT_SHA.test(evidence.harnessGitSha)) fail('harness-git-sha-malformed');
  if (expected.gitSha !== undefined && evidence.harnessGitSha !== expected.gitSha)
    fail('harness-git-sha-mismatch');
  if (expected.runId !== undefined && evidence.execution.runId !== expected.runId)
    fail('execution-run-id-mismatch');
  if (expected.runAttempt !== undefined && evidence.execution.runAttempt !== expected.runAttempt) {
    fail('execution-run-attempt-mismatch');
  }
  if (
    expected.runnerLabel !== undefined &&
    evidence.execution.runnerLabel !== expected.runnerLabel
  ) {
    fail('execution-runner-label-mismatch');
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
  if (expected.nodeMajor !== undefined) {
    const major = versionMajor(evidence.host.nodeVersion);
    if (major === null || major !== expected.nodeMajor) fail('host-node-major-mismatch');
  }
  if (expected.npmMajor !== undefined) {
    // npmVersion is a tagged HostFact; an unavailable/malformed fact cannot prove
    // a major, so it is a mismatch (never a silent pass).
    const npm = evidence.host.npmVersion;
    const major = typeof npm === 'string' ? versionMajor(npm) : null;
    if (major === null || major !== expected.npmMajor) fail('host-npm-major-mismatch');
  }
  if (expected.swVersMajor !== undefined) {
    const value = evidence.host.swVers;
    const major = typeof value === 'string' ? versionMajor(value) : null;
    if (major === null || major !== expected.swVersMajor) fail('host-sw-vers-major-mismatch');
  }
  if (expected.kernelMajor !== undefined) {
    const value = evidence.host.kernelRelease;
    const major = typeof value === 'string' ? versionMajor(value) : null;
    if (major === null || major !== expected.kernelMajor) fail('host-kernel-major-mismatch');
  }
  if (expected.unameArch !== undefined && evidence.host.unameArch !== expected.unameArch) {
    fail('host-uname-arch-mismatch');
  }
  if (
    expected.caseSensitive !== undefined &&
    evidence.host.filesystem.caseSensitive !== expected.caseSensitive
  ) {
    fail('host-case-sensitivity-mismatch');
  }
  if (expected.shell !== undefined && evidence.host.shell !== expected.shell)
    fail('host-shell-mismatch');
  for (const capability of profile.requiredCapabilities) {
    if (evidence.host.capabilities[capability] !== true) {
      fail('required-capability-unavailable', capability);
    }
  }

  // 10b. Support-row binding: the loaded profile must pin the EXPECTED
  //      platform-support row + contract version, so acceptance evidence can
  //      never satisfy a different public support claim. A profile that carries
  //      no binding (or the wrong one) fails when a binding is expected.
  if (expected.supportRowId !== undefined || expected.supportContractVersion !== undefined) {
    const binding = profile.supportRow;
    const rowOk =
      expected.supportRowId === undefined ||
      (binding !== undefined && binding.rowId === expected.supportRowId);
    const versionOk =
      expected.supportContractVersion === undefined ||
      (binding !== undefined &&
        String(binding.contractVersion) === expected.supportContractVersion);
    if (binding === undefined || !rowOk || !versionOk) fail('support-row-binding-mismatch');
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

  if (parsed.candidateManifestPath !== undefined) {
    const manifest = loadCandidateManifest(parsed.candidateManifestPath);
    if (!manifest.ok) {
      process.stderr.write(`verify-platform-acceptance: ${manifest.message}\n`);
      return 2;
    }
    parsed.expected.candidateManifest = manifest.value;
  }
  if (parsed.registryInventoryPath !== undefined) {
    const inventory = loadRegistryInventory(parsed.registryInventoryPath);
    if (!inventory.ok) {
      process.stderr.write(`verify-platform-acceptance: ${inventory.message}\n`);
      return 2;
    }
    parsed.expected.registryInventory = inventory.value;
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

// Run only when invoked directly (CI: `node scripts/verify-platform-acceptance.mjs …`),
// not when imported for its exported allowlist constants — otherwise the import
// side-effect parses the importer's argv and clobbers its exit code.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `verify-platform-acceptance: unexpected error (${error instanceof Error ? error.name : 'error'})\n`,
    );
    process.exitCode = 2;
  }
}
