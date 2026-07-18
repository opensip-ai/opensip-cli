/**
 * @fileoverview Installed-artifact platform-acceptance contract — the closed,
 * fail-closed vocabulary for support qualification evidence.
 *
 * Dependency-free (only `node:crypto`) so release scripts and an independent
 * verifier can import it with no build step. Types live in the sibling
 * `contract.d.mts` — the single source of type truth (the repo has `allowJs`
 * off, so TS consumers read the declaration, not JSDoc). Keep this file's
 * comments to prose/rationale; encode types in the `.d.mts`.
 *
 * Design invariants:
 *   - A profile is data. It selects journey IDs, `required` flags, capability
 *     prerequisites, and numeric bounds. It can never inject argv, environment
 *     keys, or code.
 *   - Every required journey passes only with status `pass`. A required
 *     `skipped` or `unavailable`, or any cleanup uncertainty, fails the verdict.
 *   - The versioned evidence artifact is authoritative. The schema recomputes
 *     claims derivable without the profile; the independent verifier loads the
 *     exact profile and recomputes its digest and profile-dependent verdict.
 *   - RSS is a tagged measurement. Bare `0`/`undefined` is never a measurement.
 */

import { createHash } from 'node:crypto';

/** Schema version used by legacy immutable common-v1 / macOS-v1 artifacts. */
export const PLATFORM_ACCEPTANCE_SCHEMA_VERSION = 1;
/** Schema version for cache→Init continuity profiles (requiredPorts + continuityProof). */
export const PLATFORM_ACCEPTANCE_SCHEMA_VERSION_V2 = 2;
/** Supported schema versions for independent verification. */
export const PLATFORM_ACCEPTANCE_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const PLATFORM_ACCEPTANCE_CAPABILITIES = Object.freeze([
  'pty',
  'symlink',
  'permissions',
  'process-tree-rss',
  'process-tree-cleanup',
]);
const PLATFORM_ACCEPTANCE_CAPABILITY_SET = new Set(PLATFORM_ACCEPTANCE_CAPABILITIES);

/** Closed injected-port vocabulary (mirrors journey-kit; kept free of cycle). */
export const PLATFORM_ACCEPTANCE_INJECTED_PORTS = Object.freeze(['mcp']);
const PLATFORM_ACCEPTANCE_INJECTED_PORT_SET = new Set(PLATFORM_ACCEPTANCE_INJECTED_PORTS);

// Bounds on the contract's own strings/arrays (independent of a profile's
// runtime output bounds). Keep them generous but finite so a hand-edited or
// hostile artifact cannot exhaust memory or smuggle unbounded content.
const MAX_ID_LENGTH = 128;
const MAX_REASON_CODE_LENGTH = 128;
const MAX_SOURCE_LENGTH = 512;
const MAX_DIGEST_LENGTH = 256;
const MAX_STRING_LENGTH = 1024;
const MAX_JOURNEYS = 256;
const MAX_CAPABILITIES = 64;
const MAX_DIAGNOSTICS_PER_JOURNEY = 64;
const MAX_DIAGNOSTIC_LENGTH = 4096;
const MAX_STEPS_PER_JOURNEY = 64;
const MAX_DIAGNOSTICS_PER_STEP = 8;
const MAX_RESULTS = 512;
const MAX_REGISTRY_BINDING_PACKAGES = 256;
const MAX_BOUND_VALUE = Number.MAX_SAFE_INTEGER;

// A profile is data, not trusted executable configuration. These ceilings keep
// a hostile or accidentally malformed profile from turning the acceptance
// harness into an unbounded allocator, sampler, or long-running process. The
// committed common/macOS profiles remain comfortably below every limit.
export const PLATFORM_ACCEPTANCE_BOUND_LIMITS = Object.freeze({
  journeyTimeoutMs: Object.freeze({ min: 1, max: 10 * 60 * 1000 }),
  maxStdoutBytes: Object.freeze({ min: 1, max: 16 * 1024 * 1024 }),
  maxStderrBytes: Object.freeze({ min: 1, max: 16 * 1024 * 1024 }),
  maxDiagnosticTailBytes: Object.freeze({ min: 1, max: 64 * 1024 }),
  // Sub-10ms sampling can consume a core; multi-second sampling can make an
  // rssRequired profile claim coverage while barely observing the process.
  rssSampleIntervalMs: Object.freeze({ min: 10, max: 1000 }),
  maxEvidenceBytes: Object.freeze({ min: 1, max: 64 * 1024 * 1024 }),
  maxJourneyResults: Object.freeze({ min: 1, max: MAX_JOURNEYS }),
});

const JOURNEY_STATUSES = new Set(['pass', 'fail', 'skipped', 'unavailable']);
const VERDICTS = new Set(['pass', 'fail', 'infrastructure-fault']);
const CANDIDATE_KINDS = new Set(['packed-release', 'published-version']);
const INSTALL_CHANNELS = new Set(['canonical-installer', 'npm-direct', 'packed-consumer']);
const CLEANUP_STATUSES = new Set(['clean', 'incomplete']);
const COMPLETION_STATES = new Set(['completed', 'infrastructure-fault']);
const STEP_STAGES = new Set(['process', 'lifecycle', 'mcp']);
const KNOWN_BASE_IDS_DEFAULT = ['common-v1', 'common-v2'];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)';
const SEMVER_PRERELEASE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}` +
    `(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);
const SIGNAL_PATTERN = /^SIG[A-Z0-9]+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const FIRST_PARTY_PACKAGE_PATTERN = /^(?:opensip-cli|@opensip-cli\/[a-z0-9][a-z0-9._-]*)$/;

/** Construct a closed, machine-readable contract failure. */
export function contractError(reasonCode, message) {
  const error = new Error(`${reasonCode}: ${message}`);
  error.name = 'ContractError';
  error.reasonCode = reasonCode;
  return error;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw contractError('invalid-object', `${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw contractError('unknown-key', `${label} has unknown key ${JSON.stringify(key)}`);
    }
  }
}

function requireString(value, label, { max = MAX_STRING_LENGTH, pattern } = {}) {
  if (typeof value !== 'string') {
    throw contractError('invalid-string', `${label} must be a string`);
  }
  if (value.length === 0) {
    throw contractError('empty-string', `${label} must not be empty`);
  }
  if (value.length > max) {
    throw contractError('string-too-long', `${label} exceeds ${max} characters`);
  }
  // No control characters (C0/C1) — they corrupt evidence and terminals.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw contractError('control-characters', `${label} contains control characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw contractError('malformed-string', `${label} does not match required shape`);
  }
  return value;
}

function requireId(value, label) {
  return requireString(value, label, {
    max: MAX_ID_LENGTH,
    pattern: ID_PATTERN,
  });
}

function requireReasonCode(value, label) {
  return requireString(value, label, {
    max: MAX_REASON_CODE_LENGTH,
    pattern: REASON_CODE_PATTERN,
  });
}

function requirePositiveInt(value, label, { max = MAX_BOUND_VALUE } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw contractError('invalid-number', `${label} must be a safe integer`);
  }
  if (value <= 0) {
    throw contractError('non-positive-bound', `${label} must be a positive integer`);
  }
  if (value > max) {
    throw contractError('bound-too-large', `${label} exceeds ${max}`);
  }
  return value;
}

function requireNonNegativeInt(value, label, { max = MAX_BOUND_VALUE } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw contractError('invalid-number', `${label} must be a non-negative safe integer`);
  }
  if (value > max) {
    throw contractError('bound-too-large', `${label} exceeds ${max}`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw contractError('invalid-boolean', `${label} must be a boolean`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw contractError('invalid-enum', `${label} must be one of ${[...allowed].join(', ')}`);
  }
  return value;
}

function requireTimestamp(value, label) {
  requireString(value, label, { max: 64, pattern: ISO_TIMESTAMP_PATTERN });
  if (Number.isNaN(Date.parse(value))) {
    throw contractError('invalid-timestamp', `${label} is not a valid ISO timestamp`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

/**
 * Stable, key-sorted canonical JSON. Object keys are sorted; array order is
 * preserved (it is meaningful for journeys/results). Rejects non-finite numbers
 * and non-JSON values so a digest can never depend on `NaN`/`Infinity` or an
 * unstable representation.
 */
export function canonicalize(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw contractError('non-finite-number', 'cannot canonicalize a non-finite number');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) continue;
      out[key] = canonicalValue(entry);
    }
    return out;
  }
  throw contractError('non-json-value', `cannot canonicalize value of type ${typeof value}`);
}

/** sha256 hex digest of the canonical form of `value`. */
export function digestOf(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Digest of the profile's effective identity (the whole resolved profile). */
export function profileDigest(profile) {
  return digestOf(profile);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const BOUND_KEYS = [
  'journeyTimeoutMs',
  'maxStdoutBytes',
  'maxStderrBytes',
  'maxDiagnosticTailBytes',
  'rssSampleIntervalMs',
  'maxEvidenceBytes',
  'maxJourneyResults',
];
const BOUNDS_KEY_SET = new Set(BOUND_KEYS);
const PROFILE_KEY_SET = new Set([
  'schemaVersion',
  'id',
  'version',
  'base',
  'requiredCapabilities',
  'rssRequired',
  'bounds',
  'journeys',
  'supportRow',
]);
const JOURNEY_SELECTION_KEY_SET_V1 = new Set(['id', 'required', 'capabilities', 'candidateKinds']);
const JOURNEY_SELECTION_KEY_SET_V2 = new Set([
  'id',
  'required',
  'capabilities',
  'candidateKinds',
  'requiredPorts',
]);
const BASE_REF_KEY_SET = new Set(['id', 'digest']);
const SUPPORT_ROW_KEY_SET = new Set(['contractVersion', 'rowId']);

function parseBounds(raw) {
  const record = requireObject(raw, 'profile.bounds');
  rejectUnknownKeys(record, BOUNDS_KEY_SET, 'profile.bounds');
  const bounds = {};
  for (const key of BOUND_KEYS) {
    const limit = PLATFORM_ACCEPTANCE_BOUND_LIMITS[key];
    const value = requirePositiveInt(record[key], `profile.bounds.${key}`, {
      max: limit.max,
    });
    if (value < limit.min) {
      throw contractError('bound-too-small', `profile.bounds.${key} must be at least ${limit.min}`);
    }
    bounds[key] = value;
  }
  return Object.freeze(bounds);
}

function parseCapabilities(raw, label) {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw contractError('invalid-array', `${label} must be an array`);
  }
  if (raw.length > MAX_CAPABILITIES) {
    throw contractError('array-too-long', `${label} exceeds ${MAX_CAPABILITIES} entries`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const id = requireId(entry, `${label} entry`);
    if (!PLATFORM_ACCEPTANCE_CAPABILITY_SET.has(id)) {
      throw contractError(
        'unknown-capability',
        `${label} has unknown capability ${JSON.stringify(id)}`,
      );
    }
    if (seen.has(id)) {
      throw contractError('duplicate-capability', `${label} has duplicate ${JSON.stringify(id)}`);
    }
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

function parseCandidateKinds(raw, label) {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw contractError('invalid-array', `${label} must be an array`);
  }
  if (raw.length === 0) {
    throw contractError('empty-candidate-kinds', `${label} must not be empty`);
  }
  if (raw.length > CANDIDATE_KINDS.size) {
    throw contractError('array-too-long', `${label} exceeds ${CANDIDATE_KINDS.size} entries`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const kind = requireEnum(entry, CANDIDATE_KINDS, `${label} entry`);
    if (seen.has(kind)) {
      throw contractError(
        'duplicate-candidate-kind',
        `${label} has duplicate ${JSON.stringify(kind)}`,
      );
    }
    seen.add(kind);
    out.push(kind);
  }
  return Object.freeze(out);
}

function parseRequiredPorts(raw, label) {
  if (!Array.isArray(raw)) {
    throw contractError('invalid-array', `${label} must be an array`);
  }
  if (raw.length > PLATFORM_ACCEPTANCE_INJECTED_PORTS.length) {
    throw contractError(
      'array-too-long',
      `${label} exceeds ${PLATFORM_ACCEPTANCE_INJECTED_PORTS.length} entries`,
    );
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const port = requireId(entry, `${label} entry`);
    if (!PLATFORM_ACCEPTANCE_INJECTED_PORT_SET.has(port)) {
      throw contractError(
        'unknown-required-port',
        `${label} has unknown port ${JSON.stringify(port)}`,
      );
    }
    if (seen.has(port)) {
      throw contractError('duplicate-required-port', `${label} has duplicate ${JSON.stringify(port)}`);
    }
    seen.add(port);
    out.push(port);
  }
  // Canonical order matches PLATFORM_ACCEPTANCE_INJECTED_PORTS.
  out.sort(
    (a, b) =>
      PLATFORM_ACCEPTANCE_INJECTED_PORTS.indexOf(a) - PLATFORM_ACCEPTANCE_INJECTED_PORTS.indexOf(b),
  );
  return Object.freeze(out);
}

function parseJourneySelection(raw, index, schemaVersion) {
  const record = requireObject(raw, `profile.journeys[${index}]`);
  const keySet = schemaVersion === 2 ? JOURNEY_SELECTION_KEY_SET_V2 : JOURNEY_SELECTION_KEY_SET_V1;
  rejectUnknownKeys(record, keySet, `profile.journeys[${index}]`);
  const selection = {
    id: requireId(record.id, `profile.journeys[${index}].id`),
    required: requireBoolean(record.required, `profile.journeys[${index}].required`),
  };
  const capabilities = parseCapabilities(
    record.capabilities,
    `profile.journeys[${index}].capabilities`,
  );
  if (capabilities) selection.capabilities = capabilities;
  const candidateKinds = parseCandidateKinds(
    record.candidateKinds,
    `profile.journeys[${index}].candidateKinds`,
  );
  if (candidateKinds) selection.candidateKinds = candidateKinds;
  if (schemaVersion === 2) {
    if (!Object.hasOwn(record, 'requiredPorts')) {
      throw contractError(
        'missing-required-ports',
        `profile.journeys[${index}].requiredPorts is required for schema version 2`,
      );
    }
    selection.requiredPorts = parseRequiredPorts(
      record.requiredPorts,
      `profile.journeys[${index}].requiredPorts`,
    );
  }
  return Object.freeze(selection);
}

function parseBaseRef(raw) {
  if (raw === undefined) return;
  const record = requireObject(raw, 'profile.base');
  rejectUnknownKeys(record, BASE_REF_KEY_SET, 'profile.base');
  return Object.freeze({
    id: requireId(record.id, 'profile.base.id'),
    digest: requireString(record.digest, 'profile.base.digest', {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    }),
  });
}

/**
 * Optional binding to the platform-support contract. It pins the profile to a
 * platform-support contract version + support-row id so acceptance evidence can
 * never satisfy a different public support claim. Part of the profile digest.
 */
function parseSupportRow(raw) {
  if (raw === undefined) return;
  const record = requireObject(raw, 'profile.supportRow');
  rejectUnknownKeys(record, SUPPORT_ROW_KEY_SET, 'profile.supportRow');
  return Object.freeze({
    contractVersion: requirePositiveInt(
      record.contractVersion,
      'profile.supportRow.contractVersion',
    ),
    rowId: requireId(record.rowId, 'profile.supportRow.rowId'),
  });
}

/** Validate and freeze a data-only acceptance profile (schema v1 or v2). */
export function parseAcceptanceProfile(input) {
  const record = requireObject(input, 'profile');
  rejectUnknownKeys(record, PROFILE_KEY_SET, 'profile');
  const schemaVersion = record.schemaVersion;
  if (
    schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION &&
    schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION_V2
  ) {
    throw contractError(
      'schema-version',
      `profile.schemaVersion must be one of ${PLATFORM_ACCEPTANCE_SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }
  // Schema/version alignment: v1 profiles use version 1; v2 profiles use version 2.
  const expectedProfileVersion = schemaVersion;
  const journeysRaw = record.journeys;
  if (!Array.isArray(journeysRaw) || journeysRaw.length === 0) {
    throw contractError('empty-journeys', 'profile.journeys must be a non-empty array');
  }
  if (journeysRaw.length > MAX_JOURNEYS) {
    throw contractError('too-many-journeys', `profile.journeys exceeds ${MAX_JOURNEYS}`);
  }
  const bounds = parseBounds(record.bounds);
  if (journeysRaw.length > bounds.maxJourneyResults) {
    throw contractError(
      'max-journey-results-exceeded',
      `profile.journeys has ${journeysRaw.length} entries, exceeding profile.bounds.maxJourneyResults (${bounds.maxJourneyResults})`,
    );
  }
  const seen = new Set();
  const journeys = journeysRaw.map((entry, index) => {
    const selection = parseJourneySelection(entry, index, schemaVersion);
    if (seen.has(selection.id)) {
      throw contractError(
        'duplicate-journey',
        `profile.journeys has duplicate ${JSON.stringify(selection.id)}`,
      );
    }
    seen.add(selection.id);
    return selection;
  });

  const profileVersion = requirePositiveInt(record.version, 'profile.version');
  if (profileVersion !== expectedProfileVersion) {
    throw contractError(
      'profile-version-schema-mismatch',
      `profile.version ${profileVersion} does not match schemaVersion ${schemaVersion}`,
    );
  }

  const profile = {
    schemaVersion,
    id: requireId(record.id, 'profile.id'),
    version: profileVersion,
    requiredCapabilities:
      parseCapabilities(record.requiredCapabilities, 'profile.requiredCapabilities') ??
      Object.freeze([]),
    rssRequired: requireBoolean(record.rssRequired, 'profile.rssRequired'),
    bounds,
    journeys: Object.freeze(journeys),
  };
  const base = parseBaseRef(record.base);
  if (base) profile.base = base;
  const supportRow = parseSupportRow(record.supportRow);
  if (supportRow) profile.supportRow = supportRow;
  return Object.freeze(profile);
}

/**
 * Compose an OS-specific derived profile over a validated base. Additive only:
 * derived may add journeys/capabilities, strengthen optional→required, and
 * tighten (never weaken) bounds. Base journeys cannot be removed, reordered, or
 * downgraded to optional; new journeys may be inserted between base journeys.
 */
export function composeProfile(base, derived, options = {}) {
  const knownBaseIds = new Set(options.knownBaseIds ?? KNOWN_BASE_IDS_DEFAULT);
  const parsedDerived = parseAcceptanceProfile(derived);
  if (!parsedDerived.base) {
    throw contractError('missing-base', 'derived profile must declare a base');
  }
  if (!knownBaseIds.has(parsedDerived.base.id)) {
    throw contractError('unknown-base', `unknown base id ${JSON.stringify(parsedDerived.base.id)}`);
  }
  if (parsedDerived.base.id === parsedDerived.id) {
    throw contractError('cyclic-base', 'a profile cannot compose itself');
  }
  if (base.id !== parsedDerived.base.id) {
    throw contractError('base-id-mismatch', 'base profile id does not match derived.base.id');
  }
  if (base.base) {
    throw contractError(
      'base-not-root',
      'composition is one level only; base must be a root profile',
    );
  }
  if (base.schemaVersion !== parsedDerived.schemaVersion) {
    throw contractError(
      'cross-schema-composition',
      `base schemaVersion ${base.schemaVersion} cannot compose with derived schemaVersion ${parsedDerived.schemaVersion}`,
    );
  }
  if (profileDigest(base) !== parsedDerived.base.digest) {
    throw contractError(
      'base-digest-mismatch',
      'derived.base.digest does not match the base profile',
    );
  }

  // Bounds may only tighten (smaller output/timeout/evidence budgets).
  for (const key of BOUND_KEYS) {
    if (parsedDerived.bounds[key] > base.bounds[key]) {
      throw contractError('weaker-bound', `derived profile weakens bound ${key}`);
    }
  }
  if (base.rssRequired && !parsedDerived.rssRequired) {
    throw contractError('weaker-rss', 'derived profile cannot drop a required RSS measurement');
  }
  const derivedRequiredCapabilities = new Set(parsedDerived.requiredCapabilities);
  for (const capability of base.requiredCapabilities) {
    if (!derivedRequiredCapabilities.has(capability)) {
      throw contractError(
        'removed-required-capability',
        `derived profile removes required capability ${JSON.stringify(capability)}`,
      );
    }
  }

  const baseById = new Map(base.journeys.map((journey) => [journey.id, journey]));
  const derivedById = new Map(parsedDerived.journeys.map((journey) => [journey.id, journey]));
  for (const journey of base.journeys) {
    const override = derivedById.get(journey.id);
    if (!override) {
      throw contractError(
        'removed-journey',
        `derived profile removes base journey ${JSON.stringify(journey.id)}`,
      );
    }
    if (journey.required && !override.required) {
      throw contractError(
        'downgraded-journey',
        `derived profile downgrades required journey ${JSON.stringify(journey.id)}`,
      );
    }
    const overrideCapabilities =
      override.capabilities === undefined ? new Set() : new Set(override.capabilities);
    for (const capability of journey.capabilities ?? []) {
      if (!overrideCapabilities.has(capability)) {
        throw contractError(
          'removed-journey-capability',
          `derived profile removes capability ${JSON.stringify(capability)} from ${JSON.stringify(journey.id)}`,
        );
      }
    }
    const baseCandidateKinds = journey.candidateKinds ?? CANDIDATE_KINDS;
    const overrideCandidateKinds = new Set(override.candidateKinds ?? CANDIDATE_KINDS);
    for (const candidateKind of baseCandidateKinds) {
      if (!overrideCandidateKinds.has(candidateKind)) {
        throw contractError(
          'narrowed-journey-applicability',
          `derived profile removes candidate kind ${JSON.stringify(candidateKind)} from ${JSON.stringify(journey.id)}`,
        );
      }
    }
    // Schema v2: inherited requiredPorts must be identical (no add/remove/reorder).
    if (base.schemaVersion === 2) {
      const basePorts = journey.requiredPorts ?? [];
      const overridePorts = override.requiredPorts ?? [];
      if (
        basePorts.length !== overridePorts.length ||
        basePorts.some((port, i) => port !== overridePorts[i])
      ) {
        throw contractError(
          'mutated-required-ports',
          `derived profile mutates requiredPorts for ${JSON.stringify(journey.id)}`,
        );
      }
    }
  }

  // The derived document owns executable order so OS-specific probes can run
  // before terminal lifecycle-removal rows. Its base rows must still form the
  // exact base-order subsequence; only new rows may be interleaved.
  const derivedBaseIds = parsedDerived.journeys
    .filter((journey) => baseById.has(journey.id))
    .map((journey) => journey.id);
  const baseIds = base.journeys.map((journey) => journey.id);
  if (derivedBaseIds.some((id, index) => id !== baseIds[index])) {
    throw contractError('reordered-base-journey', 'derived profile reorders base journeys');
  }

  const requiredCapabilities = [
    ...new Set([...base.requiredCapabilities, ...parsedDerived.requiredCapabilities]),
  ];

  const composed = {
    schemaVersion: base.schemaVersion,
    id: parsedDerived.id,
    version: parsedDerived.version,
    base: parsedDerived.base,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    rssRequired: parsedDerived.rssRequired,
    bounds: parsedDerived.bounds,
    journeys: parsedDerived.journeys,
  };
  // The support-row binding is OS-specific: carry the derived profile's binding
  // (falling back to a base binding if one exists). It stays part of the digest.
  const supportRow = parsedDerived.supportRow ?? base.supportRow;
  if (supportRow) composed.supportRow = supportRow;
  return Object.freeze(composed);
}

// ---------------------------------------------------------------------------
// Host / candidate
// ---------------------------------------------------------------------------

const HOST_FACT_KEY_SET = new Set(['status', 'reasonCode']);

function parseHostFact(raw, label, validate) {
  if (isPlainObject(raw) && 'status' in raw) {
    rejectUnknownKeys(raw, HOST_FACT_KEY_SET, label);
    if (raw.status !== 'unavailable') {
      throw contractError('invalid-host-fact', `${label}.status must be 'unavailable' when tagged`);
    }
    return Object.freeze({
      status: 'unavailable',
      reasonCode: requireReasonCode(raw.reasonCode, `${label}.reasonCode`),
    });
  }
  return validate(raw, label);
}

const CANDIDATE_KEY_SET = new Set([
  'kind',
  'version',
  'source',
  'digest',
  'registry',
  'manifestDigest',
  'registryIntegrityDigest',
]);

function parseCandidateIdentity(raw, label = 'candidate', options = {}) {
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, CANDIDATE_KEY_SET, label);
  const candidate = {
    kind: requireEnum(record.kind, CANDIDATE_KINDS, `${label}.kind`),
    version: requireString(record.version, `${label}.version`, {
      max: MAX_ID_LENGTH,
      pattern: EXACT_SEMVER_PATTERN,
    }),
    source: requireString(record.source, `${label}.source`, {
      max: MAX_SOURCE_LENGTH,
    }),
    digest: requireString(record.digest, `${label}.digest`, {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    }),
  };
  if (record.registry !== undefined) {
    candidate.registry = requireString(record.registry, `${label}.registry`, {
      max: MAX_SOURCE_LENGTH,
    });
    let registryUrl;
    try {
      registryUrl = new URL(candidate.registry);
    } catch {
      throw contractError('invalid-registry', `${label}.registry must be a canonical HTTPS URL`);
    }
    if (
      registryUrl.protocol !== 'https:' ||
      registryUrl.username !== '' ||
      registryUrl.password !== '' ||
      registryUrl.search !== '' ||
      registryUrl.hash !== ''
    ) {
      throw contractError(
        'invalid-registry',
        `${label}.registry must be credential-free HTTPS origin + pathname`,
      );
    }
    registryUrl.pathname = `${registryUrl.pathname.replace(/\/+$/, '')}/`;
    const canonicalRegistry = `${registryUrl.origin}${registryUrl.pathname}`;
    if (candidate.registry !== canonicalRegistry) {
      throw contractError('invalid-registry', `${label}.registry must use canonical URL form`);
    }
  }
  if (record.manifestDigest !== undefined) {
    candidate.manifestDigest = requireString(record.manifestDigest, `${label}.manifestDigest`, {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    });
  }
  if (record.registryIntegrityDigest !== undefined) {
    candidate.registryIntegrityDigest = requireString(
      record.registryIntegrityDigest,
      `${label}.registryIntegrityDigest`,
      { max: MAX_DIGEST_LENGTH, pattern: HEX_DIGEST_PATTERN },
    );
  }
  if (candidate.kind === 'packed-release') {
    if (candidate.registry !== undefined || candidate.registryIntegrityDigest !== undefined) {
      throw contractError(
        'candidate-kind-mismatch',
        `${label} packed-release cannot carry registry integrity fields`,
      );
    }
    if (candidate.manifestDigest === undefined) {
      throw contractError(
        'candidate-integrity-missing',
        `${label} packed-release requires manifestDigest`,
      );
    }
  } else if (
    candidate.registry === undefined ||
    (options.requireRegistryIntegrity === true && candidate.registryIntegrityDigest === undefined)
  ) {
    throw contractError(
      'candidate-integrity-missing',
      `${label} published-version requires registry${options.requireRegistryIntegrity === true ? ' and registryIntegrityDigest' : ''}`,
    );
  }
  return Object.freeze(candidate);
}

const HOST_KEY_SET = new Set([
  'platform',
  'arch',
  'osRelease',
  'osVersion',
  'nodeVersion',
  'nodeModuleAbi',
  'npmVersion',
  'packageManager',
  'cpuModel',
  'cpuCount',
  'totalMemoryBytes',
  'filesystem',
  'shell',
  'swVers',
  'kernelRelease',
  'unameArch',
  'capabilities',
]);
const FILESYSTEM_KEY_SET = new Set(['type', 'caseSensitive']);

function parseCapabilityMap(raw) {
  const record = requireObject(raw, 'host.capabilities');
  const keys = Object.keys(record);
  if (keys.length > MAX_CAPABILITIES) {
    throw contractError('too-many-capabilities', `host.capabilities exceeds ${MAX_CAPABILITIES}`);
  }
  const out = {};
  for (const key of keys) {
    requireId(key, 'host.capabilities key');
    if (!PLATFORM_ACCEPTANCE_CAPABILITY_SET.has(key)) {
      throw contractError(
        'unknown-capability',
        `host.capabilities has unknown capability ${JSON.stringify(key)}`,
      );
    }
    out[key] = requireBoolean(record[key], `host.capabilities.${key}`);
  }
  return Object.freeze(out);
}

function parseHostProfile(raw) {
  const record = requireObject(raw, 'host');
  rejectUnknownKeys(record, HOST_KEY_SET, 'host');
  const fs = requireObject(record.filesystem, 'host.filesystem');
  rejectUnknownKeys(fs, FILESYSTEM_KEY_SET, 'host.filesystem');
  return Object.freeze({
    platform: requireString(record.platform, 'host.platform', {
      max: MAX_ID_LENGTH,
    }),
    arch: requireString(record.arch, 'host.arch', { max: MAX_ID_LENGTH }),
    osRelease: parseHostFact(record.osRelease, 'host.osRelease', (v, l) => requireString(v, l)),
    osVersion: parseHostFact(record.osVersion, 'host.osVersion', (v, l) => requireString(v, l)),
    nodeVersion: requireString(record.nodeVersion, 'host.nodeVersion', {
      max: MAX_ID_LENGTH,
    }),
    nodeModuleAbi: requireString(record.nodeModuleAbi, 'host.nodeModuleAbi', {
      max: MAX_ID_LENGTH,
    }),
    npmVersion: parseHostFact(record.npmVersion, 'host.npmVersion', (v, l) =>
      requireString(v, l, { max: MAX_ID_LENGTH }),
    ),
    packageManager: parseHostFact(record.packageManager, 'host.packageManager', (v, l) =>
      requireString(v, l, { max: MAX_ID_LENGTH }),
    ),
    cpuModel: parseHostFact(record.cpuModel, 'host.cpuModel', (v, l) => requireString(v, l)),
    cpuCount: requirePositiveInt(record.cpuCount, 'host.cpuCount'),
    totalMemoryBytes: requireNonNegativeInt(record.totalMemoryBytes, 'host.totalMemoryBytes'),
    filesystem: Object.freeze({
      type: parseHostFact(fs.type, 'host.filesystem.type', (v, l) =>
        requireString(v, l, { max: MAX_ID_LENGTH }),
      ),
      caseSensitive: parseHostFact(fs.caseSensitive, 'host.filesystem.caseSensitive', (v, l) =>
        requireBoolean(v, l),
      ),
    }),
    shell: parseHostFact(record.shell, 'host.shell', (v, l) => requireString(v, l)),
    swVers: parseHostFact(record.swVers, 'host.swVers', (v, l) =>
      requireString(v, l, { max: MAX_ID_LENGTH }),
    ),
    kernelRelease: parseHostFact(record.kernelRelease, 'host.kernelRelease', (v, l) =>
      requireString(v, l, { max: MAX_ID_LENGTH }),
    ),
    unameArch: parseHostFact(record.unameArch, 'host.unameArch', (v, l) =>
      requireString(v, l, { max: MAX_ID_LENGTH }),
    ),
    capabilities: parseCapabilityMap(record.capabilities),
  });
}

// ---------------------------------------------------------------------------
// Journey results / cleanup / summary / verdict
// ---------------------------------------------------------------------------

const RSS_KEY_SET = new Set(['status', 'peakBytes', 'reasonCode']);

function parseRss(raw, label) {
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, RSS_KEY_SET, label);
  if (record.status === 'available') {
    if ('reasonCode' in record) {
      throw contractError(
        'invalid-rss',
        `${label} available measurement must not carry a reasonCode`,
      );
    }
    return Object.freeze({
      status: 'available',
      peakBytes: requireNonNegativeInt(record.peakBytes, `${label}.peakBytes`),
    });
  }
  if (record.status === 'unavailable') {
    if ('peakBytes' in record) {
      throw contractError(
        'invalid-rss',
        `${label} unavailable measurement must not carry peakBytes`,
      );
    }
    return Object.freeze({
      status: 'unavailable',
      reasonCode: requireReasonCode(record.reasonCode, `${label}.reasonCode`),
    });
  }
  throw contractError('invalid-rss', `${label}.status must be 'available' or 'unavailable'`);
}

const JOURNEY_RESULT_KEY_SET_V1 = new Set([
  'id',
  'category',
  'required',
  'status',
  'reasonCode',
  'durationMs',
  'rss',
  'diagnostics',
  'steps',
]);
const JOURNEY_RESULT_KEY_SET_V2 = new Set([
  ...JOURNEY_RESULT_KEY_SET_V1,
  'requiredPorts',
  'continuityProof',
]);

const CONTINUITY_PROOF_KEY_SET = new Set([
  'kind',
  'proofSchemaVersion',
  'parentRunId',
  'steps',
  'identityDigest',
  'preReportRunId',
  'postReportRunId',
  'prePlane',
  'postPlane',
  'cliMcpEqualPre',
  'cliMcpEqualPost',
  'prePostEqual',
  'busyInitObserved',
  'mcpCleanRetry',
  'cacheSourceRetired',
  'cleanupStatus',
]);
const CONTINUITY_PROOF_STEP_KEY_SET = new Set(['runStepId', 'sessionId']);
const CONTINUITY_PLANES = new Set(['cache', 'project']);
const CONTINUITY_CLEANUP = new Set(['clean', 'incomplete']);
const CONTINUITY_PROOF_DOMAIN = 'opensip-cli/cache-init-continuity-proof/v1\0';
const MAX_CONTINUITY_PROOF_STEPS = 64;
const MAX_CONTINUITY_ID_LENGTH = 128;

const STEP_EVIDENCE_KEY_SET = new Set([
  'label',
  'stage',
  'exitCode',
  'signal',
  'deliveredSignal',
  'timedOut',
  'cancelled',
  'outputTruncated',
  'durationMs',
  'rss',
  'residualDescendants',
  'reasonCode',
  'diagnostics',
]);

function parseDiagnostics(raw, label, maxEntries) {
  if (!Array.isArray(raw)) {
    throw contractError('invalid-diagnostics', `${label} must be an array`);
  }
  if (raw.length > maxEntries) {
    throw contractError('too-many-diagnostics', `${label} exceeds ${maxEntries}`);
  }
  return Object.freeze(
    raw.map((entry, index) =>
      requireString(entry, `${label}[${index}]`, {
        max: MAX_DIAGNOSTIC_LENGTH,
      }),
    ),
  );
}

function parseNullableReasonCode(value, label) {
  return value === null || value === undefined ? null : requireReasonCode(value, label);
}

function parseJourneyStep(raw, resultIndex, stepIndex) {
  const label = `results[${resultIndex}].steps[${stepIndex}]`;
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, STEP_EVIDENCE_KEY_SET, label);
  const exitCode =
    record.exitCode === null ? null : requireNonNegativeInt(record.exitCode, `${label}.exitCode`);
  const signal =
    record.signal === null
      ? null
      : requireString(record.signal, `${label}.signal`, {
          max: 32,
          pattern: SIGNAL_PATTERN,
        });
  let deliveredSignal;
  if (record.deliveredSignal !== undefined) {
    deliveredSignal =
      record.deliveredSignal === null
        ? null
        : requireString(record.deliveredSignal, `${label}.deliveredSignal`, {
            max: 32,
            pattern: SIGNAL_PATTERN,
          });
  }
  if (exitCode !== null && signal !== null) {
    throw contractError('invalid-step-terminal', `${label} cannot carry exitCode and signal`);
  }
  const timedOut = requireBoolean(record.timedOut, `${label}.timedOut`);
  const cancelled = requireBoolean(record.cancelled, `${label}.cancelled`);
  if (timedOut && cancelled) {
    throw contractError('invalid-step-terminal', `${label} cannot be timed out and cancelled`);
  }
  const outputTruncated = requireBoolean(record.outputTruncated, `${label}.outputTruncated`);
  const residualDescendants = requireNonNegativeInt(
    record.residualDescendants,
    `${label}.residualDescendants`,
  );
  const reasonCode = parseNullableReasonCode(record.reasonCode, `${label}.reasonCode`);
  const abnormal =
    exitCode === null ||
    exitCode !== 0 ||
    signal !== null ||
    timedOut ||
    cancelled ||
    outputTruncated ||
    residualDescendants > 0;
  if (abnormal && reasonCode === null) {
    throw contractError('missing-step-reason', `${label} abnormal terminal outcome needs a reason`);
  }
  if (!abnormal && reasonCode !== null) {
    throw contractError('unexpected-step-reason', `${label} clean terminal outcome has a reason`);
  }
  return Object.freeze({
    label: requireId(record.label, `${label}.label`),
    stage: requireEnum(record.stage, STEP_STAGES, `${label}.stage`),
    exitCode,
    signal,
    ...(deliveredSignal === undefined ? {} : { deliveredSignal }),
    timedOut,
    cancelled,
    outputTruncated,
    durationMs: requireNonNegativeInt(record.durationMs, `${label}.durationMs`),
    rss: parseRss(record.rss, `${label}.rss`),
    residualDescendants,
    reasonCode,
    diagnostics: parseDiagnostics(
      record.diagnostics,
      `${label}.diagnostics`,
      MAX_DIAGNOSTICS_PER_STEP,
    ),
  });
}

function parseJourneySteps(raw, resultIndex) {
  if (!Array.isArray(raw)) {
    throw contractError('invalid-steps', `results[${resultIndex}].steps must be an array`);
  }
  if (raw.length > MAX_STEPS_PER_JOURNEY) {
    throw contractError(
      'too-many-steps',
      `results[${resultIndex}].steps exceeds ${MAX_STEPS_PER_JOURNEY}`,
    );
  }
  const seen = new Set();
  const steps = raw.map((entry, stepIndex) => {
    const step = parseJourneyStep(entry, resultIndex, stepIndex);
    if (seen.has(step.label)) {
      throw contractError(
        'duplicate-step-label',
        `results[${resultIndex}].steps has duplicate ${JSON.stringify(step.label)}`,
      );
    }
    seen.add(step.label);
    return step;
  });
  return Object.freeze(steps);
}

/**
 * Domain-separated digest over parent Run ID + ordered step/session linkage.
 * Used by journey executors and the independent verifier.
 */
export function continuityProofIdentityDigest(proof) {
  const payload = {
    proofSchemaVersion: proof.proofSchemaVersion,
    parentRunId: proof.parentRunId,
    steps: proof.steps.map((step) => ({
      runStepId: step.runStepId,
      sessionId: step.sessionId,
    })),
  };
  return createHash('sha256')
    .update(CONTINUITY_PROOF_DOMAIN)
    .update(JSON.stringify(payload))
    .digest('hex');
}

function parseContinuityProof(raw, label) {
  if (raw === null) return null;
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, CONTINUITY_PROOF_KEY_SET, label);
  if (record.kind !== 'cache-init-continuity') {
    throw contractError('invalid-continuity-proof-kind', `${label}.kind must be cache-init-continuity`);
  }
  const proofSchemaVersion = requirePositiveInt(
    record.proofSchemaVersion,
    `${label}.proofSchemaVersion`,
  );
  if (proofSchemaVersion !== 1) {
    throw contractError(
      'invalid-continuity-proof-schema',
      `${label}.proofSchemaVersion must be 1`,
    );
  }
  const parentRunId = requireString(record.parentRunId, `${label}.parentRunId`, {
    max: MAX_CONTINUITY_ID_LENGTH,
  });
  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    throw contractError('invalid-continuity-steps', `${label}.steps must be a non-empty array`);
  }
  if (record.steps.length > MAX_CONTINUITY_PROOF_STEPS) {
    throw contractError(
      'too-many-continuity-steps',
      `${label}.steps exceeds ${MAX_CONTINUITY_PROOF_STEPS}`,
    );
  }
  const steps = record.steps.map((entry, stepIndex) => {
    const stepLabel = `${label}.steps[${stepIndex}]`;
    const step = requireObject(entry, stepLabel);
    rejectUnknownKeys(step, CONTINUITY_PROOF_STEP_KEY_SET, stepLabel);
    return Object.freeze({
      runStepId: requireString(step.runStepId, `${stepLabel}.runStepId`, {
        max: MAX_CONTINUITY_ID_LENGTH,
      }),
      sessionId:
        step.sessionId === null
          ? null
          : requireString(step.sessionId, `${stepLabel}.sessionId`, {
              max: MAX_CONTINUITY_ID_LENGTH,
            }),
    });
  });
  const proof = {
    kind: 'cache-init-continuity',
    proofSchemaVersion,
    parentRunId,
    steps: Object.freeze(steps),
    identityDigest: requireString(record.identityDigest, `${label}.identityDigest`, {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    }),
    preReportRunId: requireString(record.preReportRunId, `${label}.preReportRunId`, {
      max: MAX_CONTINUITY_ID_LENGTH,
    }),
    postReportRunId: requireString(record.postReportRunId, `${label}.postReportRunId`, {
      max: MAX_CONTINUITY_ID_LENGTH,
    }),
    prePlane: requireEnum(record.prePlane, CONTINUITY_PLANES, `${label}.prePlane`),
    postPlane: requireEnum(record.postPlane, CONTINUITY_PLANES, `${label}.postPlane`),
    cliMcpEqualPre: requireBoolean(record.cliMcpEqualPre, `${label}.cliMcpEqualPre`),
    cliMcpEqualPost: requireBoolean(record.cliMcpEqualPost, `${label}.cliMcpEqualPost`),
    prePostEqual: requireBoolean(record.prePostEqual, `${label}.prePostEqual`),
    busyInitObserved: requireBoolean(record.busyInitObserved, `${label}.busyInitObserved`),
    mcpCleanRetry: requireBoolean(record.mcpCleanRetry, `${label}.mcpCleanRetry`),
    cacheSourceRetired: requireBoolean(record.cacheSourceRetired, `${label}.cacheSourceRetired`),
    cleanupStatus: requireEnum(record.cleanupStatus, CONTINUITY_CLEANUP, `${label}.cleanupStatus`),
  };
  const recomputed = continuityProofIdentityDigest(proof);
  if (recomputed !== proof.identityDigest) {
    throw contractError(
      'continuity-proof-digest-mismatch',
      `${label}.identityDigest does not match recomputed identity digest`,
    );
  }
  return Object.freeze(proof);
}

function parseJourneyResult(raw, index, schemaVersion = 1) {
  const record = requireObject(raw, `results[${index}]`);
  const keySet = schemaVersion === 2 ? JOURNEY_RESULT_KEY_SET_V2 : JOURNEY_RESULT_KEY_SET_V1;
  rejectUnknownKeys(record, keySet, `results[${index}]`);
  const result = {
    id: requireId(record.id, `results[${index}].id`),
    category: requireId(record.category, `results[${index}].category`),
    required: requireBoolean(record.required, `results[${index}].required`),
    status: requireEnum(record.status, JOURNEY_STATUSES, `results[${index}].status`),
    reasonCode: parseNullableReasonCode(record.reasonCode, `results[${index}].reasonCode`),
    durationMs: requireNonNegativeInt(record.durationMs, `results[${index}].durationMs`),
    rss: parseRss(record.rss, `results[${index}].rss`),
    diagnostics: parseDiagnostics(
      record.diagnostics,
      `results[${index}].diagnostics`,
      MAX_DIAGNOSTICS_PER_JOURNEY,
    ),
  };
  // Early v1 artifacts omitted `steps`. Preserve that absence during parsing so
  // their sealed digest remains reproducible; the independent verifier still
  // rejects any required passing result without new step evidence.
  if (record.steps !== undefined) result.steps = parseJourneySteps(record.steps, index);
  if (schemaVersion === 2) {
    if (!Object.hasOwn(record, 'requiredPorts')) {
      throw contractError(
        'missing-required-ports',
        `results[${index}].requiredPorts is required for schema version 2`,
      );
    }
    result.requiredPorts = parseRequiredPorts(
      record.requiredPorts,
      `results[${index}].requiredPorts`,
    );
    if (!Object.hasOwn(record, 'continuityProof')) {
      throw contractError(
        'missing-continuity-proof',
        `results[${index}].continuityProof is required for schema version 2 (may be null)`,
      );
    }
    result.continuityProof = parseContinuityProof(
      record.continuityProof,
      `results[${index}].continuityProof`,
    );
  }
  return Object.freeze(result);
}

const CLEANUP_KEY_SET = new Set(['status', 'reasonCode', 'removedRoots', 'residualDescendants']);

function parseCleanup(raw) {
  const record = requireObject(raw, 'cleanup');
  rejectUnknownKeys(record, CLEANUP_KEY_SET, 'cleanup');
  let reasonCode = null;
  if (record.reasonCode !== null && record.reasonCode !== undefined) {
    reasonCode = requireReasonCode(record.reasonCode, 'cleanup.reasonCode');
  }
  return Object.freeze({
    status: requireEnum(record.status, CLEANUP_STATUSES, 'cleanup.status'),
    reasonCode,
    removedRoots: requireNonNegativeInt(record.removedRoots, 'cleanup.removedRoots'),
    residualDescendants: requireNonNegativeInt(
      record.residualDescendants,
      'cleanup.residualDescendants',
    ),
  });
}

/** Deterministic count summary derived from the ordered results. */
export function computeSummary(profile, results) {
  const requiredIds = new Set(
    results.filter((result) => result.required).map((result) => result.id),
  );
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let unavailable = 0;
  let requiredPassed = 0;
  for (const result of results) {
    switch (result.status) {
      case 'pass': {
        passed += 1;
        break;
      }
      case 'fail': {
        failed += 1;
        break;
      }
      case 'skipped': {
        skipped += 1;
        break;
      }
      default: {
        unavailable += 1;
      }
    }
    if (requiredIds.has(result.id) && result.status === 'pass') requiredPassed += 1;
  }
  return Object.freeze({
    total: results.length,
    passed,
    failed,
    skipped,
    unavailable,
    requiredTotal: requiredIds.size,
    requiredPassed,
  });
}

/** A supplied exact previous candidate turns the common upgrade row into a gate. */
export function isJourneyRequired(journey, previousCandidate) {
  return (
    journey.required === true || (journey.id === 'lifecycle.upgrade' && previousCandidate !== null)
  );
}

/** A profile may retain a row while declaring it inapplicable to one candidate form. */
export function isJourneyApplicable(journey, candidateKind) {
  return journey.candidateKinds === undefined || journey.candidateKinds.includes(candidateKind);
}

/**
 * The overall verdict. Every required journey must be present and `pass`;
 * cleanup must be `clean`. When the profile sets `rssRequired`, every required
 * journey must carry a real aggregate peak and at least one real step peak.
 * A genuinely short-lived child may report `rss-child-too-short`; sampler or
 * process-table faults may not be hidden by a different sampled child.
 * (`infrastructure-fault` is a separate terminal state set by the writer, not
 * derivable from results here.)
 */
export function computeVerdict(profile, results, cleanup) {
  if (cleanup.status !== 'clean' || cleanup.residualDescendants > 0) return 'fail';
  const byId = new Map(results.map((result) => [result.id, result]));
  for (const journey of profile.journeys) {
    const result = byId.get(journey.id);
    if (!result) return 'fail';
    // `required` is the runner's effective, candidate-aware requirement. The
    // independent verifier recomputes and validates this flag before trusting
    // the verdict, including dynamic upgrade and applicability semantics.
    if (result.required !== true) continue;
    if (result.status !== 'pass') return 'fail';
    if (profile.rssRequired) {
      if (result.rss.status !== 'available' || result.rss.peakBytes <= 0) return 'fail';
      if (!Array.isArray(result.steps) || result.steps.length === 0) return 'fail';
      let sampledStep = false;
      let maxStepPeak = 0;
      for (const step of result.steps) {
        if (step.rss.status === 'available') {
          sampledStep = true;
          maxStepPeak = Math.max(maxStepPeak, step.rss.peakBytes);
        } else if (step.rss.reasonCode !== 'rss-child-too-short') {
          return 'fail';
        }
      }
      if (!sampledStep || result.rss.peakBytes < maxStepPeak) return 'fail';
    }
  }
  return 'pass';
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const EVIDENCE_KEY_SET = new Set([
  'schemaVersion',
  'profile',
  'candidate',
  'previousCandidate',
  'execution',
  'lifecycle',
  'registryBindings',
  'harnessGitSha',
  'startedAt',
  'completedAt',
  'host',
  'results',
  'cleanup',
  'summary',
  'verdict',
  'completion',
]);
const EVIDENCE_PROFILE_KEY_SET = new Set(['id', 'version', 'digest']);
const SUMMARY_KEY_SET = new Set([
  'total',
  'passed',
  'failed',
  'skipped',
  'unavailable',
  'requiredTotal',
  'requiredPassed',
]);
const COMPLETION_KEY_SET = new Set(['state', 'evidenceDigest']);
const EXECUTION_KEY_SET = new Set(['runId', 'runAttempt', 'runnerLabel']);
const LIFECYCLE_EVIDENCE_KEY_SET = new Set([
  'installedVersion',
  'upgradedVersion',
  'versionMigrated',
  'stateMigrated',
  'cliStateRemoved',
  'packageRemoved',
  'targetInstallChannel',
  'integrityChecks',
]);
const INTEGRITY_CHECKS_KEY_SET = new Set(['count', 'durationMs']);
const REGISTRY_BINDINGS_KEY_SET = new Set(['candidateLifecycle', 'canonicalInstaller']);
const REGISTRY_BINDING_PROOF_KEY_SET = new Set([
  'inventoryDigest',
  'packageNames',
  'packageCount',
  'packageSetDigest',
  'offlineReplayComplete',
]);

function parseExecutionIdentity(raw) {
  const record = requireObject(raw, 'execution');
  rejectUnknownKeys(record, EXECUTION_KEY_SET, 'execution');
  return Object.freeze({
    runId: requireString(record.runId, 'execution.runId', {
      max: MAX_ID_LENGTH,
    }),
    runAttempt: requirePositiveInt(record.runAttempt, 'execution.runAttempt'),
    runnerLabel: requireString(record.runnerLabel, 'execution.runnerLabel', {
      max: MAX_ID_LENGTH,
    }),
  });
}

function parseNullableString(value, label) {
  return value === null ? null : requireString(value, label, { max: MAX_ID_LENGTH });
}

function parseNullableBoolean(value, label) {
  return value === null ? null : requireBoolean(value, label);
}

function parseLifecycleEvidence(raw) {
  const record = requireObject(raw, 'lifecycle');
  rejectUnknownKeys(record, LIFECYCLE_EVIDENCE_KEY_SET, 'lifecycle');
  const parsed = {
    installedVersion: parseNullableString(record.installedVersion, 'lifecycle.installedVersion'),
    upgradedVersion: parseNullableString(record.upgradedVersion, 'lifecycle.upgradedVersion'),
    versionMigrated: parseNullableBoolean(record.versionMigrated, 'lifecycle.versionMigrated'),
    stateMigrated: parseNullableBoolean(record.stateMigrated, 'lifecycle.stateMigrated'),
    cliStateRemoved: parseNullableBoolean(record.cliStateRemoved, 'lifecycle.cliStateRemoved'),
    packageRemoved: parseNullableBoolean(record.packageRemoved, 'lifecycle.packageRemoved'),
  };
  if (Object.hasOwn(record, 'targetInstallChannel')) {
    parsed.targetInstallChannel =
      record.targetInstallChannel === null
        ? null
        : requireEnum(
            record.targetInstallChannel,
            INSTALL_CHANNELS,
            'lifecycle.targetInstallChannel',
          );
  }
  if (Object.hasOwn(record, 'integrityChecks')) {
    const integrityChecks = requireObject(record.integrityChecks, 'lifecycle.integrityChecks');
    rejectUnknownKeys(integrityChecks, INTEGRITY_CHECKS_KEY_SET, 'lifecycle.integrityChecks');
    parsed.integrityChecks = Object.freeze({
      count: requireNonNegativeInt(integrityChecks.count, 'lifecycle.integrityChecks.count'),
      durationMs: requireNonNegativeInt(
        integrityChecks.durationMs,
        'lifecycle.integrityChecks.durationMs',
      ),
    });
  }
  return Object.freeze(parsed);
}

function parseRegistryBindingProof(raw, label, candidate) {
  if (raw === null) return null;
  const record = requireObject(raw, label);
  rejectUnknownKeys(record, REGISTRY_BINDING_PROOF_KEY_SET, label);
  if (!Array.isArray(record.packageNames)) {
    throw contractError('invalid-array', `${label}.packageNames must be an array`);
  }
  if (
    record.packageNames.length === 0 ||
    record.packageNames.length > MAX_REGISTRY_BINDING_PACKAGES
  ) {
    throw contractError(
      'invalid-registry-binding-package-count',
      `${label}.packageNames must contain 1-${MAX_REGISTRY_BINDING_PACKAGES} entries`,
    );
  }
  const seen = new Set();
  const packageNames = record.packageNames.map((name, index) => {
    const normalized = requireString(name, `${label}.packageNames[${index}]`, {
      max: MAX_ID_LENGTH,
      pattern: FIRST_PARTY_PACKAGE_PATTERN,
    });
    if (seen.has(normalized)) {
      throw contractError('duplicate-registry-binding-package', `${label} repeats ${normalized}`);
    }
    seen.add(normalized);
    return normalized;
  });
  const packageCount = requirePositiveInt(record.packageCount, `${label}.packageCount`, {
    max: MAX_REGISTRY_BINDING_PACKAGES,
  });
  if (packageCount !== packageNames.length) {
    throw contractError(
      'registry-binding-package-count-mismatch',
      `${label}.packageCount must equal packageNames.length`,
    );
  }
  const inventoryDigest = requireString(record.inventoryDigest, `${label}.inventoryDigest`, {
    max: MAX_DIGEST_LENGTH,
    pattern: HEX_DIGEST_PATTERN,
  });
  if (
    candidate.registryIntegrityDigest !== undefined &&
    inventoryDigest !== candidate.registryIntegrityDigest
  ) {
    throw contractError(
      'registry-binding-inventory-mismatch',
      `${label}.inventoryDigest does not match candidate.registryIntegrityDigest`,
    );
  }
  if (record.offlineReplayComplete !== true) {
    throw contractError(
      'registry-binding-replay-incomplete',
      `${label}.offlineReplayComplete must be true`,
    );
  }
  return Object.freeze({
    inventoryDigest,
    packageNames: Object.freeze(packageNames),
    packageCount,
    packageSetDigest: requireString(record.packageSetDigest, `${label}.packageSetDigest`, {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    }),
    offlineReplayComplete: true,
  });
}

function parseRegistryBindings(raw, candidate) {
  if (raw === undefined) {
    // Early common-v1 packed artifacts predate this proof. Published artifacts
    // never receive the compatibility path: their registry binding fails closed.
    if (candidate.kind === 'published-version') {
      throw contractError(
        'registry-binding-evidence-missing',
        'published evidence must carry registryBindings',
      );
    }
    return;
  }
  const record = requireObject(raw, 'registryBindings');
  rejectUnknownKeys(record, REGISTRY_BINDINGS_KEY_SET, 'registryBindings');
  const parsed = Object.freeze({
    candidateLifecycle: parseRegistryBindingProof(
      record.candidateLifecycle,
      'registryBindings.candidateLifecycle',
      candidate,
    ),
    canonicalInstaller: parseRegistryBindingProof(
      record.canonicalInstaller,
      'registryBindings.canonicalInstaller',
      candidate,
    ),
  });
  if (
    candidate.kind === 'packed-release' &&
    (parsed.candidateLifecycle !== null || parsed.canonicalInstaller !== null)
  ) {
    throw contractError(
      'candidate-kind-mismatch',
      'packed-release evidence cannot carry registry binding proofs',
    );
  }
  return parsed;
}

function parseEvidenceProfileRef(raw) {
  const record = requireObject(raw, 'profile');
  rejectUnknownKeys(record, EVIDENCE_PROFILE_KEY_SET, 'profile');
  return Object.freeze({
    id: requireId(record.id, 'profile.id'),
    version: requirePositiveInt(record.version, 'profile.version'),
    digest: requireString(record.digest, 'profile.digest', {
      max: MAX_DIGEST_LENGTH,
      pattern: HEX_DIGEST_PATTERN,
    }),
  });
}

function parseSummary(raw) {
  const record = requireObject(raw, 'summary');
  rejectUnknownKeys(record, SUMMARY_KEY_SET, 'summary');
  const summary = {};
  for (const key of SUMMARY_KEY_SET) {
    summary[key] = requireNonNegativeInt(record[key], `summary.${key}`);
  }
  return Object.freeze(summary);
}

/** Digest of the evidence body with `completion` stripped (the sealed body). */
export function evidenceDigest(evidence) {
  const body = { ...evidence };
  delete body.completion;
  return digestOf(body);
}

/**
 * Validate a full evidence artifact and internally re-verify its derived
 * claims: the summary, the completion digest over the sealed body, and (unless
 * the verdict is `infrastructure-fault`) that results/cleanup are internally
 * consistent. This intentionally does NOT recompute the profile digest or the
 * verdict against a profile — that cross-check belongs to the verifier, which
 * loads the profile independently.
 */
export function parseAcceptanceEvidence(input) {
  const record = requireObject(input, 'evidence');
  rejectUnknownKeys(record, EVIDENCE_KEY_SET, 'evidence');
  const schemaVersion = record.schemaVersion;
  if (
    schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION &&
    schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION_V2
  ) {
    throw contractError(
      'schema-version',
      `evidence.schemaVersion must be one of ${PLATFORM_ACCEPTANCE_SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
  }
  const resultsRaw = record.results;
  if (!Array.isArray(resultsRaw)) {
    throw contractError('invalid-results', 'evidence.results must be an array');
  }
  if (resultsRaw.length > MAX_RESULTS) {
    throw contractError('too-many-results', `evidence.results exceeds ${MAX_RESULTS}`);
  }
  const seenIds = new Set();
  const results = resultsRaw.map((entry, index) => {
    const result = parseJourneyResult(entry, index, schemaVersion);
    if (seenIds.has(result.id)) {
      throw contractError(
        'duplicate-result',
        `evidence.results has duplicate ${JSON.stringify(result.id)}`,
      );
    }
    seenIds.add(result.id);
    return result;
  });

  const completionRecord = requireObject(record.completion, 'evidence.completion');
  rejectUnknownKeys(completionRecord, COMPLETION_KEY_SET, 'evidence.completion');

  const candidate = parseCandidateIdentity(record.candidate, 'candidate', {
    requireRegistryIntegrity: true,
  });
  const registryBindings = parseRegistryBindings(record.registryBindings, candidate);
  const evidence = {
    schemaVersion,
    profile: parseEvidenceProfileRef(record.profile),
    candidate,
    previousCandidate:
      record.previousCandidate === null
        ? null
        : parseCandidateIdentity(record.previousCandidate, 'previousCandidate'),
    execution: parseExecutionIdentity(record.execution),
    lifecycle: parseLifecycleEvidence(record.lifecycle),
    ...(registryBindings === undefined ? {} : { registryBindings }),
    harnessGitSha: requireString(record.harnessGitSha, 'evidence.harnessGitSha', {
      max: MAX_ID_LENGTH,
    }),
    startedAt: requireTimestamp(record.startedAt, 'evidence.startedAt'),
    completedAt: requireTimestamp(record.completedAt, 'evidence.completedAt'),
    host: parseHostProfile(record.host),
    results: Object.freeze(results),
    cleanup: parseCleanup(record.cleanup),
    summary: parseSummary(record.summary),
    verdict: requireEnum(record.verdict, VERDICTS, 'evidence.verdict'),
    completion: Object.freeze({
      state: requireEnum(completionRecord.state, COMPLETION_STATES, 'evidence.completion.state'),
      evidenceDigest: requireString(
        completionRecord.evidenceDigest,
        'evidence.completion.evidenceDigest',
        {
          max: MAX_DIGEST_LENGTH,
          pattern: HEX_DIGEST_PATTERN,
        },
      ),
    }),
  };

  if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
    throw contractError('timestamp-order', 'evidence.completedAt precedes startedAt');
  }

  const recomputedSummary = computeSummary(null, evidence.results);
  for (const key of SUMMARY_KEY_SET) {
    if (evidence.summary[key] !== recomputedSummary[key]) {
      throw contractError(
        'summary-mismatch',
        `evidence.summary.${key} is not derived from results`,
      );
    }
  }

  const internallyPassing =
    evidence.cleanup.status === 'clean' &&
    evidence.cleanup.residualDescendants === 0 &&
    evidence.results.every((result) => !result.required || result.status === 'pass');
  if (evidence.completion.state === 'infrastructure-fault') {
    if (evidence.verdict !== 'infrastructure-fault') {
      throw contractError(
        'completion-verdict-mismatch',
        'infrastructure-fault completion requires infrastructure-fault verdict',
      );
    }
  } else if (
    evidence.verdict === 'infrastructure-fault' ||
    (evidence.verdict === 'pass' && !internallyPassing)
  ) {
    // The standalone schema can prove that a claimed pass is impossible from
    // required statuses or cleanup. It cannot prove that an internally passing
    // set satisfies profile-only predicates such as `rssRequired`, because the
    // evidence carries a profile identity rather than the full profile. A
    // pessimistic `fail` is therefore valid here; the independent verifier
    // loads the bound profile and recomputes the exact verdict.
    throw contractError(
      'completion-verdict-mismatch',
      evidence.verdict === 'infrastructure-fault'
        ? 'completed evidence cannot carry an infrastructure-fault verdict'
        : 'completed evidence cannot pass with failed required status or cleanup',
    );
  }

  // Re-verify the sealed-body digest.
  const recomputedDigest = evidenceDigest(evidence);
  if (recomputedDigest !== evidence.completion.evidenceDigest) {
    throw contractError(
      'evidence-digest-mismatch',
      'completion.evidenceDigest does not match the sealed body',
    );
  }

  return Object.freeze(evidence);
}
