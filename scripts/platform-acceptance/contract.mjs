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
 *   - The versioned evidence artifact is authoritative. A verifier recomputes
 *     the profile digest, summary, verdict, and sealed-body digest from the
 *     artifact contents; it never trusts a claimed value.
 *   - RSS is a tagged measurement. Bare `0`/`undefined` is never a measurement.
 */

import { createHash } from 'node:crypto';

export const PLATFORM_ACCEPTANCE_SCHEMA_VERSION = 1;

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
const MAX_RESULTS = 512;
const MAX_BOUND_VALUE = Number.MAX_SAFE_INTEGER;

const JOURNEY_STATUSES = new Set(['pass', 'fail', 'skipped', 'unavailable']);
const VERDICTS = new Set(['pass', 'fail', 'infrastructure-fault']);
const CANDIDATE_KINDS = new Set(['packed-release', 'published-version']);
const CLEANUP_STATUSES = new Set(['clean', 'incomplete']);
const COMPLETION_STATES = new Set(['completed', 'infrastructure-fault']);
const KNOWN_BASE_IDS_DEFAULT = ['common-v1'];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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
  return requireString(value, label, { max: MAX_ID_LENGTH, pattern: ID_PATTERN });
}

function requireReasonCode(value, label) {
  return requireString(value, label, { max: MAX_REASON_CODE_LENGTH, pattern: REASON_CODE_PATTERN });
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
const JOURNEY_SELECTION_KEY_SET = new Set(['id', 'required', 'capabilities']);
const BASE_REF_KEY_SET = new Set(['id', 'digest']);
const SUPPORT_ROW_KEY_SET = new Set(['contractVersion', 'rowId']);

function parseBounds(raw) {
  const record = requireObject(raw, 'profile.bounds');
  rejectUnknownKeys(record, BOUNDS_KEY_SET, 'profile.bounds');
  const bounds = {};
  for (const key of BOUND_KEYS) {
    bounds[key] = requirePositiveInt(record[key], `profile.bounds.${key}`);
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
    if (seen.has(id)) {
      throw contractError('duplicate-capability', `${label} has duplicate ${JSON.stringify(id)}`);
    }
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

function parseJourneySelection(raw, index) {
  const record = requireObject(raw, `profile.journeys[${index}]`);
  rejectUnknownKeys(record, JOURNEY_SELECTION_KEY_SET, `profile.journeys[${index}]`);
  const selection = {
    id: requireId(record.id, `profile.journeys[${index}].id`),
    required: requireBoolean(record.required, `profile.journeys[${index}].required`),
  };
  const capabilities = parseCapabilities(
    record.capabilities,
    `profile.journeys[${index}].capabilities`,
  );
  if (capabilities) selection.capabilities = capabilities;
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

/** Validate and freeze a data-only acceptance profile. */
export function parseAcceptanceProfile(input) {
  const record = requireObject(input, 'profile');
  rejectUnknownKeys(record, PROFILE_KEY_SET, 'profile');
  if (record.schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION) {
    throw contractError(
      'schema-version',
      `profile.schemaVersion must be ${PLATFORM_ACCEPTANCE_SCHEMA_VERSION}`,
    );
  }
  const journeysRaw = record.journeys;
  if (!Array.isArray(journeysRaw) || journeysRaw.length === 0) {
    throw contractError('empty-journeys', 'profile.journeys must be a non-empty array');
  }
  if (journeysRaw.length > MAX_JOURNEYS) {
    throw contractError('too-many-journeys', `profile.journeys exceeds ${MAX_JOURNEYS}`);
  }
  const seen = new Set();
  const journeys = journeysRaw.map((entry, index) => {
    const selection = parseJourneySelection(entry, index);
    if (seen.has(selection.id)) {
      throw contractError(
        'duplicate-journey',
        `profile.journeys has duplicate ${JSON.stringify(selection.id)}`,
      );
    }
    seen.add(selection.id);
    return selection;
  });

  const profile = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    id: requireId(record.id, 'profile.id'),
    version: requirePositiveInt(record.version, 'profile.version'),
    requiredCapabilities:
      parseCapabilities(record.requiredCapabilities, 'profile.requiredCapabilities') ??
      Object.freeze([]),
    rssRequired: requireBoolean(record.rssRequired, 'profile.rssRequired'),
    bounds: parseBounds(record.bounds),
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
 * tighten (never weaken) bounds. Base journeys cannot be removed, overridden, or
 * downgraded to optional.
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
  }

  // Result: base journeys carried in base order (with any strengthening),
  // then any brand-new derived journeys in derived order.
  const journeys = [];
  for (const journey of base.journeys) {
    journeys.push(derivedById.get(journey.id));
  }
  for (const journey of parsedDerived.journeys) {
    if (!baseById.has(journey.id)) journeys.push(journey);
  }

  const requiredCapabilities = [
    ...new Set([...base.requiredCapabilities, ...parsedDerived.requiredCapabilities]),
  ];

  const composed = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    id: parsedDerived.id,
    version: parsedDerived.version,
    base: parsedDerived.base,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    rssRequired: parsedDerived.rssRequired,
    bounds: parsedDerived.bounds,
    journeys: Object.freeze(journeys),
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

const CANDIDATE_KEY_SET = new Set(['kind', 'version', 'source', 'digest', 'registry']);

function parseCandidateIdentity(raw) {
  const record = requireObject(raw, 'candidate');
  rejectUnknownKeys(record, CANDIDATE_KEY_SET, 'candidate');
  const candidate = {
    kind: requireEnum(record.kind, CANDIDATE_KINDS, 'candidate.kind'),
    version: requireString(record.version, 'candidate.version', { max: MAX_ID_LENGTH }),
    source: requireString(record.source, 'candidate.source', { max: MAX_SOURCE_LENGTH }),
    digest: requireString(record.digest, 'candidate.digest', { max: MAX_DIGEST_LENGTH }),
  };
  if (record.registry !== undefined) {
    candidate.registry = requireString(record.registry, 'candidate.registry', {
      max: MAX_SOURCE_LENGTH,
    });
    if (/[:@]/.test(candidate.registry) && !/^https?:\/\//.test(candidate.registry)) {
      throw contractError('invalid-registry', 'candidate.registry must not embed credentials');
    }
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
    platform: requireString(record.platform, 'host.platform', { max: MAX_ID_LENGTH }),
    arch: requireString(record.arch, 'host.arch', { max: MAX_ID_LENGTH }),
    osRelease: parseHostFact(record.osRelease, 'host.osRelease', (v, l) => requireString(v, l)),
    osVersion: parseHostFact(record.osVersion, 'host.osVersion', (v, l) => requireString(v, l)),
    nodeVersion: requireString(record.nodeVersion, 'host.nodeVersion', { max: MAX_ID_LENGTH }),
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

const JOURNEY_RESULT_KEY_SET = new Set([
  'id',
  'category',
  'required',
  'status',
  'reasonCode',
  'durationMs',
  'rss',
  'diagnostics',
]);

function parseJourneyResult(raw, index) {
  const record = requireObject(raw, `results[${index}]`);
  rejectUnknownKeys(record, JOURNEY_RESULT_KEY_SET, `results[${index}]`);
  const diagnosticsRaw = record.diagnostics;
  if (!Array.isArray(diagnosticsRaw)) {
    throw contractError('invalid-diagnostics', `results[${index}].diagnostics must be an array`);
  }
  if (diagnosticsRaw.length > MAX_DIAGNOSTICS_PER_JOURNEY) {
    throw contractError(
      'too-many-diagnostics',
      `results[${index}].diagnostics exceeds ${MAX_DIAGNOSTICS_PER_JOURNEY}`,
    );
  }
  const diagnostics = diagnosticsRaw.map((entry, i) =>
    requireString(entry, `results[${index}].diagnostics[${i}]`, { max: MAX_DIAGNOSTIC_LENGTH }),
  );
  let reasonCode = null;
  if (record.reasonCode !== null && record.reasonCode !== undefined) {
    reasonCode = requireReasonCode(record.reasonCode, `results[${index}].reasonCode`);
  }
  return Object.freeze({
    id: requireId(record.id, `results[${index}].id`),
    category: requireId(record.category, `results[${index}].category`),
    required: requireBoolean(record.required, `results[${index}].required`),
    status: requireEnum(record.status, JOURNEY_STATUSES, `results[${index}].status`),
    reasonCode,
    durationMs: requireNonNegativeInt(record.durationMs, `results[${index}].durationMs`),
    rss: parseRss(record.rss, `results[${index}].rss`),
    diagnostics: Object.freeze(diagnostics),
  });
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
  const requiredIds = new Set(profile.journeys.filter((j) => j.required).map((j) => j.id));
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

/**
 * The overall verdict. Every required journey must be present and `pass`;
 * cleanup must be `clean`. When the profile sets `rssRequired`, the run must also
 * exhibit at least one real peak-RSS measurement from a required journey — a host
 * that cannot sample RSS anywhere cannot satisfy an RSS-required profile, and a
 * bare `unavailable` never green-washes into proof. Otherwise the run fails.
 * (`infrastructure-fault` is a separate terminal state set by the writer, not
 * derivable from results here.)
 */
export function computeVerdict(profile, results, cleanup) {
  if (cleanup.status !== 'clean' || cleanup.residualDescendants > 0) return 'fail';
  const byId = new Map(results.map((result) => [result.id, result]));
  let rssProven = false;
  for (const journey of profile.journeys) {
    if (!journey.required) continue;
    const result = byId.get(journey.id);
    if (!result || result.status !== 'pass') return 'fail';
    if (result.rss.status === 'available') rssProven = true;
  }
  if (profile.rssRequired && !rssProven) return 'fail';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const EVIDENCE_KEY_SET = new Set([
  'schemaVersion',
  'profile',
  'candidate',
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
  if (record.schemaVersion !== PLATFORM_ACCEPTANCE_SCHEMA_VERSION) {
    throw contractError(
      'schema-version',
      `evidence.schemaVersion must be ${PLATFORM_ACCEPTANCE_SCHEMA_VERSION}`,
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
    const result = parseJourneyResult(entry, index);
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

  const evidence = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: parseEvidenceProfileRef(record.profile),
    candidate: parseCandidateIdentity(record.candidate),
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
