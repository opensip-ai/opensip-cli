/**
 * @fileoverview Pure library for error/resiliency inventory evidence:
 * JSON-safe parse, bounds, closed-enum validation, canonical sort, digests,
 * and duplicate detection. The CLI entrypoint in scripts/error-resiliency-inventory.mjs
 * imports this module and must not re-implement analysis.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const RUBRIC_VERSION = '1.0.0';
export const DETECTOR_VERSION = '1.0.0';

/** @type {Readonly<Record<string, number>>} */
export const BOUNDS = Object.freeze({
  maxPathLength: 512,
  maxStringLength: 4096,
  maxFilesPerSnapshot: 100_000,
  maxSitesPerFile: 2_000,
  maxRecordsPerPackage: 50_000,
  maxSourceFileBytes: 2 * 1024 * 1024,
  maxNestingDepth: 32,
  maxAcceptedBytes: 50 * 1024 * 1024,
  maxJsonBytes: 10 * 1024 * 1024,
});

export const FILE_CLASSIFICATIONS = Object.freeze([
  'production',
  'runtime-asset',
  'manifest-build',
  'test',
  'fixture',
  'generated',
  'docs',
  'excluded',
]);

export const DISPOSITIONS = Object.freeze([
  'migrate',
  'already-conformant',
  'retain-internal-invariant',
  'normalize-at-enclosing-boundary',
  'remove-obsolete-path',
  'no-error-resiliency-responsibility',
  'excluded-generated-or-vendor',
  'needs-decision',
]);

export const ACCEPTED_DISPOSITIONS = Object.freeze(
  DISPOSITIONS.filter((d) => d !== 'needs-decision'),
);

export const BOUNDARY_FAMILIES = Object.freeze([
  'cli-failure-reporting',
  'worker-ipc-process',
  'filesystem-datastore',
  'http-egress-retry',
  'external-scanner-lifecycle',
  'mcp-stdio-transport',
  'cancellation-timeout',
  'logging-redaction-telemetry',
  'plugin-trust-compatibility',
  'release-init',
  'other',
]);

export const SITE_KINDS = Object.freeze([
  'error-definition',
  'error-construction',
  'throw',
  'catch',
  'retry',
  'timer',
  'signal-listener',
  'fallback',
  'worker-boundary',
  'redaction',
  'logging',
  'timeout',
  'cancellation',
  'cleanup',
  'presentation',
  'serialization',
  'human-flow',
]);

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

export class InventoryError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON-safe parse with size and nesting bounds.
 * @param {string} text
 * @param {{ maxBytes?: number, maxDepth?: number, label?: string }} [opts]
 * @returns {unknown}
 */
export function parseJsonSafe(text, opts = {}) {
  const maxBytes = opts.maxBytes ?? BOUNDS.maxJsonBytes;
  const maxDepth = opts.maxDepth ?? BOUNDS.maxNestingDepth;
  const label = opts.label ?? 'json';
  if (typeof text !== 'string') {
    throw new InventoryError('INVENTORY.JSON.TYPE', `${label} must be a string`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new InventoryError('INVENTORY.JSON.TOO_LARGE', `${label} exceeds ${maxBytes} bytes`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InventoryError('INVENTORY.JSON.PARSE', `${label} is not valid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  assertBoundedDepth(value, maxDepth, label);
  return value;
}

/**
 * @param {unknown} value
 * @param {number} maxDepth
 * @param {string} label
 * @param {number} [depth]
 */
function assertBoundedDepth(value, maxDepth, label, depth = 0) {
  if (depth > maxDepth) {
    throw new InventoryError('INVENTORY.JSON.DEPTH', `${label} exceeds nesting depth ${maxDepth}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedDepth(item, maxDepth, label, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) {
      assertBoundedDepth(child, maxDepth, label, depth + 1);
    }
  }
}

/**
 * Deterministic JSON stringify with sorted object keys at every level.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return `${stableSerialize(value)}\n`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableSerialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new InventoryError('INVENTORY.JSON.NON_FINITE', 'canonical JSON rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareByCodePoint);
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',');
    return `{${body}}`;
  }
  throw new InventoryError('INVENTORY.JSON.TYPE', `unsupported canonical value type: ${typeof value}`);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function compareByCodePoint(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {unknown} value
 * @returns {string} lowercase hex sha256
 */
export function digestCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

/**
 * Sort records by a key path for deterministic snapshots.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 * @returns {T[]}
 */
export function sortByKey(items, keyOf) {
  return [...items].sort((left, right) => compareByCodePoint(keyOf(left), keyOf(right)));
}

/**
 * @param {string} pathValue
 * @param {string} label
 */
export function assertSafeRepoRelativePath(pathValue, label = 'path') {
  if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.length > BOUNDS.maxPathLength) {
    throw new InventoryError('INVENTORY.PATH.INVALID', `${label} must be a bounded non-empty string`);
  }
  if (isAbsolute(pathValue) || pathValue.includes('\0')) {
    throw new InventoryError('INVENTORY.PATH.UNSAFE', `${label} must be repository-relative`);
  }
  const normalized = normalize(pathValue);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.endsWith(`${sep}..`)
  ) {
    throw new InventoryError('INVENTORY.PATH.ESCAPE', `${label} escapes repository root: ${pathValue}`);
  }
  if (pathValue.includes('\\')) {
    throw new InventoryError('INVENTORY.PATH.SEPARATOR', `${label} must use POSIX separators`);
  }
  return pathValue.replace(/^\.\//u, '');
}

/**
 * @param {string} text
 * @param {string} label
 * @param {number} [max]
 */
export function assertBoundedString(text, label, max = BOUNDS.maxStringLength) {
  if (typeof text !== 'string') {
    throw new InventoryError('INVENTORY.STRING.TYPE', `${label} must be a string`);
  }
  if (text.length > max) {
    throw new InventoryError('INVENTORY.STRING.TOO_LONG', `${label} exceeds ${max} characters`);
  }
  return text;
}

/**
 * @param {string} value
 * @param {readonly string[]} allowed
 * @param {string} label
 */
export function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new InventoryError('INVENTORY.ENUM.UNKNOWN', `${label} has unknown value '${value}'`, {
      allowed: [...allowed],
    });
  }
  return value;
}

/**
 * Validate a single file evidence record (closed shape + bounds).
 * @param {unknown} raw
 * @param {{ allowNeedsDecision?: boolean }} [opts]
 */
export function validateFileRecord(raw, opts = {}) {
  if (!isPlainObject(raw)) {
    throw new InventoryError('INVENTORY.FILE.TYPE', 'file record must be an object');
  }
  const allowedKeys = new Set([
    'path',
    'blobOid',
    'classification',
    'exclusionReason',
    'packageName',
    'byteLength',
    'weight',
    'fullFileRead',
    'disposition',
    'reviewers',
    'sites',
    'decisionRefs',
    'rationale',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new InventoryError('INVENTORY.FILE.UNKNOWN_FIELD', `file record has unknown field '${key}'`);
    }
  }
  const pathValue = assertSafeRepoRelativePath(/** @type {string} */ (raw.path), 'path');
  const blobOid = assertBoundedString(/** @type {string} */ (raw.blobOid), 'blobOid', 64);
  if (!/^[0-9a-f]+$/u.test(blobOid)) {
    throw new InventoryError('INVENTORY.FILE.BLOB', 'blobOid must be lowercase hex');
  }
  const classification = assertEnum(
    /** @type {string} */ (raw.classification),
    FILE_CLASSIFICATIONS,
    'classification',
  );
  if (classification === 'excluded') {
    assertBoundedString(/** @type {string} */ (raw.exclusionReason), 'exclusionReason', 512);
  }
  const disposition = assertEnum(/** @type {string} */ (raw.disposition), DISPOSITIONS, 'disposition');
  if (!opts.allowNeedsDecision && disposition === 'needs-decision') {
    throw new InventoryError(
      'INVENTORY.FILE.NEEDS_DECISION',
      `accepted snapshots forbid needs-decision at ${pathValue}`,
    );
  }
  if (typeof raw.fullFileRead !== 'boolean') {
    throw new InventoryError('INVENTORY.FILE.FULL_READ', 'fullFileRead must be boolean');
  }
  assertBoundedString(/** @type {string} */ (raw.packageName), 'packageName', 256);

  /** @type {unknown[]} */
  const sites = Array.isArray(raw.sites) ? raw.sites : [];
  if (sites.length > BOUNDS.maxSitesPerFile) {
    throw new InventoryError('INVENTORY.FILE.SITES', `too many sites on ${pathValue}`);
  }
  const validatedSites = sites.map((site, index) =>
    validateSiteRecord(site, { allowNeedsDecision: opts.allowNeedsDecision, index, path: pathValue }),
  );

  /** @type {unknown[]} */
  const reviewers = Array.isArray(raw.reviewers) ? raw.reviewers : [];
  if (reviewers.length > 8) {
    throw new InventoryError('INVENTORY.FILE.REVIEWERS', 'too many reviewers');
  }

  return {
    path: pathValue,
    blobOid,
    classification,
    ...(typeof raw.exclusionReason === 'string'
      ? { exclusionReason: assertBoundedString(raw.exclusionReason, 'exclusionReason', 512) }
      : {}),
    packageName: /** @type {string} */ (raw.packageName),
    ...(typeof raw.byteLength === 'number' ? { byteLength: raw.byteLength } : {}),
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    fullFileRead: raw.fullFileRead,
    disposition,
    reviewers: reviewers.map((reviewer) => validateReviewer(reviewer)),
    sites: sortByKey(validatedSites, (site) => site.siteId),
    ...(Array.isArray(raw.decisionRefs)
      ? {
          decisionRefs: raw.decisionRefs.map((ref, i) =>
            assertBoundedString(/** @type {string} */ (ref), `decisionRefs[${i}]`, 128),
          ),
        }
      : {}),
    ...(typeof raw.rationale === 'string'
      ? { rationale: assertBoundedString(raw.rationale, 'rationale') }
      : {}),
  };
}

/**
 * @param {unknown} raw
 */
function validateReviewer(raw) {
  if (!isPlainObject(raw)) {
    throw new InventoryError('INVENTORY.REVIEWER.TYPE', 'reviewer must be an object');
  }
  const role = assertEnum(
    /** @type {string} */ (raw.role),
    ['primary', 'secondary', 'boundary', 'lead', 'coordinator'],
    'reviewer.role',
  );
  return {
    role,
    identity: assertBoundedString(/** @type {string} */ (raw.identity), 'reviewer.identity', 128),
    reviewedAt: assertBoundedString(/** @type {string} */ (raw.reviewedAt), 'reviewer.reviewedAt', 64),
  };
}

/**
 * @param {unknown} raw
 * @param {{ allowNeedsDecision?: boolean, index?: number, path?: string }} [opts]
 */
export function validateSiteRecord(raw, opts = {}) {
  if (!isPlainObject(raw)) {
    throw new InventoryError('INVENTORY.SITE.TYPE', 'site record must be an object');
  }
  const siteId = assertBoundedString(/** @type {string} */ (raw.siteId), 'siteId', 256);
  if (siteId.length < 8) {
    throw new InventoryError('INVENTORY.SITE.ID', 'siteId must be at least 8 characters');
  }
  const kind = assertEnum(/** @type {string} */ (raw.kind), SITE_KINDS, 'kind');
  const source = assertEnum(/** @type {string} */ (raw.source), ['structural', 'human'], 'source');
  const disposition = assertEnum(/** @type {string} */ (raw.disposition), DISPOSITIONS, 'disposition');
  if (!opts.allowNeedsDecision && disposition === 'needs-decision') {
    throw new InventoryError(
      'INVENTORY.SITE.NEEDS_DECISION',
      `accepted snapshots forbid needs-decision at site ${siteId}`,
    );
  }
  return {
    siteId,
    kind,
    source,
    ...(typeof raw.boundaryFamily === 'string'
      ? {
          boundaryFamily: assertEnum(raw.boundaryFamily, BOUNDARY_FAMILIES, 'boundaryFamily'),
        }
      : {}),
    ...(typeof raw.owner === 'string' ? { owner: assertBoundedString(raw.owner, 'owner', 256) } : {}),
    ...(typeof raw.currentCode === 'string'
      ? { currentCode: assertBoundedString(raw.currentCode, 'currentCode', 256) }
      : {}),
    ...(typeof raw.targetCode === 'string'
      ? { targetCode: assertBoundedString(raw.targetCode, 'targetCode', 256) }
      : {}),
    disposition,
    ...(typeof raw.risk === 'string' ? { risk: assertEnum(raw.risk, RISK_LEVELS, 'risk') } : {}),
    ...(typeof raw.line === 'number' ? { line: raw.line } : {}),
    ...(typeof raw.column === 'number' ? { column: raw.column } : {}),
    ...(typeof raw.fingerprint === 'string'
      ? { fingerprint: assertBoundedString(raw.fingerprint, 'fingerprint', 128) }
      : {}),
    ...(typeof raw.rationale === 'string'
      ? { rationale: assertBoundedString(raw.rationale, 'rationale') }
      : {}),
  };
}

/**
 * Detect duplicate site IDs and duplicate primary file paths.
 * @param {readonly { path: string, sites?: readonly { siteId: string }[] }[]} files
 * @returns {{ duplicatePaths: string[], duplicateSiteIds: string[] }}
 */
export function findDuplicates(files) {
  /** @type {Map<string, number>} */
  const pathCounts = new Map();
  /** @type {Map<string, number>} */
  const siteCounts = new Map();
  for (const file of files) {
    pathCounts.set(file.path, (pathCounts.get(file.path) ?? 0) + 1);
    for (const site of file.sites ?? []) {
      siteCounts.set(site.siteId, (siteCounts.get(site.siteId) ?? 0) + 1);
    }
  }
  return {
    duplicatePaths: [...pathCounts.entries()].filter(([, n]) => n > 1).map(([p]) => p).sort(compareByCodePoint),
    duplicateSiteIds: [...siteCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id]) => id)
      .sort(compareByCodePoint),
  };
}

/**
 * Load and lightly validate the committed schema document.
 * @param {string} [repoRoot]
 */
export function loadSchemaDocument(repoRoot = defaultRepoRoot()) {
  const schemaPath = join(repoRoot, '.config/error-resiliency-inventory/schema.json');
  const text = readFileSync(schemaPath, 'utf8');
  const schema = parseJsonSafe(text, { label: 'schema.json' });
  if (!isPlainObject(schema) || schema.schemaVersion !== SCHEMA_VERSION) {
    // schema document uses properties.schemaVersion.const; top-level may not have schemaVersion field as value
  }
  if (!isPlainObject(schema) || schema.title === undefined) {
    throw new InventoryError('INVENTORY.SCHEMA.INVALID', 'schema.json is missing required shape');
  }
  const constVersion = schema.properties?.schemaVersion?.const;
  if (constVersion !== SCHEMA_VERSION) {
    throw new InventoryError(
      'INVENTORY.SCHEMA.VERSION',
      `schema.json const schemaVersion must be ${SCHEMA_VERSION}`,
    );
  }
  return schema;
}

/**
 * Load rubric metadata (version line).
 * @param {string} [repoRoot]
 */
export function loadRubricVersion(repoRoot = defaultRepoRoot()) {
  const rubricPath = join(repoRoot, '.config/error-resiliency-inventory/rubric.md');
  const text = readFileSync(rubricPath, 'utf8');
  const match = /\*\*Rubric version:\*\*\s*`([^`]+)`/u.exec(text);
  if (!match) {
    throw new InventoryError('INVENTORY.RUBRIC.VERSION', 'rubric.md missing Rubric version line');
  }
  return match[1];
}

/**
 * Actionable diagnostic for inventory failures.
 * @param {unknown} error
 * @returns {{ code: string, message: string, repair?: string, detail?: Record<string, unknown> }}
 */
export function formatInventoryDiagnostic(error) {
  if (error instanceof InventoryError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.detail,
      repair: repairHint(error.code),
    };
  }
  return {
    code: 'INVENTORY.UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
    repair: 'Inspect the inventory command output and re-run with --help.',
  };
}

/**
 * @param {string} code
 */
function repairHint(code) {
  switch (code) {
    case 'INVENTORY.FILE.NEEDS_DECISION':
    case 'INVENTORY.SITE.NEEDS_DECISION':
      return 'Resolve needs-decision at C3 and re-submit before C4/C5 acceptance.';
    case 'INVENTORY.PATH.ESCAPE':
    case 'INVENTORY.PATH.UNSAFE':
      return 'Use repository-relative POSIX paths without .. segments.';
    case 'INVENTORY.JSON.PARSE':
      return 'Fix JSON syntax in the evidence file and re-run schema validation.';
    case 'INVENTORY.SCHEMA.VERSION':
      return 'Regenerate inventory artifacts with the current schema version 1 tooling.';
    default:
      return 'See .config/error-resiliency-inventory/rubric.md and re-run pnpm error-inventory:check.';
  }
}

/**
 * @returns {string}
 */
export function defaultRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../..');
}

/**
 * Ensure a path under repoRoot does not escape via symlink tricks when resolved.
 * @param {string} repoRoot
 * @param {string} relativePath
 */
export function resolveContainedPath(repoRoot, relativePath) {
  const safeRel = assertSafeRepoRelativePath(relativePath);
  const rootReal = resolve(repoRoot);
  const candidate = resolve(rootReal, safeRel);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new InventoryError('INVENTORY.PATH.ESCAPE', `path escapes repo root: ${relativePath}`);
  }
  return candidate;
}

/**
 * Closed detector coverage manifest (also produced by the sites extractor).
 */
export function defaultDetectorCoverage() {
  return {
    detectorVersion: DETECTOR_VERSION,
    languages: [
      {
        language: 'typescript',
        mode: 'structural-typescript',
        siteKinds: [
          'error-construction',
          'throw',
          'catch',
          'retry',
          'timer',
          'signal-listener',
          'fallback',
          'worker-boundary',
        ],
      },
      {
        language: 'javascript',
        mode: 'structural-typescript',
        siteKinds: [
          'error-construction',
          'throw',
          'catch',
          'retry',
          'timer',
          'signal-listener',
          'fallback',
          'worker-boundary',
        ],
      },
    ],
    siteKinds: [
      'error-construction',
      'throw',
      'catch',
      'retry',
      'timer',
      'signal-listener',
      'fallback',
      'worker-boundary',
    ],
    humanReviewOnly: [
      { language: 'python', reason: 'No structural detector wired; full-file human review only.' },
      { language: 'go', reason: 'No structural detector wired; full-file human review only.' },
      { language: 'rust', reason: 'No structural detector wired; full-file human review only.' },
      { language: 'java', reason: 'No structural detector wired; full-file human review only.' },
      { language: 'cpp', reason: 'No structural detector wired; full-file human review only.' },
    ],
  };
}
