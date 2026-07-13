import { isUnknownRecord as isRecord, stringsAreUnique } from './value-helpers.js';

const IMPACT_UNCERTAINTY_CODES = new Set([
  'git-shallow',
  'git-merge-base-unavailable',
  'changed-file-deleted',
  'changed-file-renamed',
  'changed-file-unmatched',
  'graph-catalog-unavailable',
  'graph-catalog-incomplete',
  'graph-catalog-approximate',
  'impact-uncertainty-truncated',
  'impact-truncated',
  'impact-malformed-row-omitted',
  'suite-step-unverified',
]);
const IMPACT_UNCERTAINTY_SOURCES = new Set(['git', 'files', 'catalog', 'impact', 'suite']);
const MAX_IMPACT_UNCERTAINTIES = 50;
const MAX_REASON_CODE_BYTES = 128;
const MAX_UNCERTAINTY_MESSAGE_BYTES = 1024;
const MAX_PROJECT_PATH_BYTES = 1024;
const MAX_TEST_SELECTION_FILES = 128;
const MAX_SELECTED_TESTS = 500;
const MAX_SELECTION_COMMANDS = 100;
const MAX_SELECTION_PROOF_ITEMS = 6;
const MAX_SELECTION_COMMAND_ARGUMENTS = 32;
const MAX_SELECTION_REASON_CODES = 32;

const REASON_CODE = /^[a-z0-9][a-z0-9._-]*$/iu;
const TEST_SELECTION_ID = /^ts1:[a-f0-9]{64}$/u;
const INVENTORY_ID = /^i1:[a-f0-9]{64}$/u;

const SELECTED_TEST_BASES = new Set([
  'direct-call',
  'transitive-call',
  'module-import',
  'target-convention',
  'co-located',
]);
const SELECTED_TEST_CONFIDENCES = new Set(['exact', 'high', 'medium', 'low']);
const COMMAND_TIERS = new Set(['focused', 'package', 'full']);
const SELECTION_STATUSES = new Set(['complete', 'partial', 'fallback']);

/** Trust verdict carried inside the `impact_files` data projection. */
export type ImpactTrustAssessment =
  | { readonly valid: false }
  | {
      readonly fullyVerified: boolean;
      readonly reasonCodes: readonly string[];
      readonly valid: true;
    };

/** Validated trust fields needed to decide whether a selection can prove absence. */
export type TestSelectionAssessment =
  | { readonly valid: false }
  | {
      readonly complete: boolean;
      readonly reasonCodes: readonly string[];
      readonly valid: true;
    };

interface ValidImpactUncertainty {
  readonly code: string;
  readonly filePath?: string;
  readonly message: string;
  readonly source: string;
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !/\p{Cc}/u.test(value)
  );
}

function safeProjectPath(value: unknown): value is string {
  if (!boundedText(value, MAX_PROJECT_PATH_BYTES)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes('\\')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function boundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumBytes: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => boundedText(item, maximumBytes))
  );
}

function uncertaintyIsValid(value: unknown): value is ValidImpactUncertainty {
  if (!isRecord(value)) return false;
  const expectedKeys =
    value.filePath === undefined
      ? ['code', 'source', 'message']
      : ['code', 'source', 'message', 'filePath'];
  if (!exactKeys(value, expectedKeys)) return false;
  return (
    typeof value.code === 'string' &&
    IMPACT_UNCERTAINTY_CODES.has(value.code) &&
    Buffer.byteLength(value.code, 'utf8') <= MAX_REASON_CODE_BYTES &&
    typeof value.source === 'string' &&
    IMPACT_UNCERTAINTY_SOURCES.has(value.source) &&
    boundedText(value.message, MAX_UNCERTAINTY_MESSAGE_BYTES) &&
    (value.filePath === undefined || safeProjectPath(value.filePath))
  );
}

function expectedImpactCoverage(
  fallback: 'full-run' | 'targeted',
  uncertaintyCount: number,
): 'full' | 'partial' | 'unknown' {
  if (uncertaintyCount === 0) return 'full';
  return fallback === 'full-run' ? 'partial' : 'unknown';
}

/**
 * Validate the nested impact-trust contract without importing product runtime
 * packages into the black-box harness.
 */
export function assessImpactTrust(payload: unknown): ImpactTrustAssessment {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.trust)) {
    return { valid: false };
  }
  const trust = payload.data.trust;
  if (
    !exactKeys(trust, ['coverage', 'fallback', 'fullyVerified', 'uncertainties']) ||
    (trust.coverage !== 'full' && trust.coverage !== 'partial' && trust.coverage !== 'unknown') ||
    (trust.fallback !== 'targeted' && trust.fallback !== 'full-run') ||
    typeof trust.fullyVerified !== 'boolean' ||
    !Array.isArray(trust.uncertainties) ||
    trust.uncertainties.length > MAX_IMPACT_UNCERTAINTIES ||
    trust.uncertainties.some((uncertainty) => !uncertaintyIsValid(uncertainty))
  ) {
    return { valid: false };
  }
  const uncertainties = trust.uncertainties as readonly ValidImpactUncertainty[];
  const unique = new Set(
    uncertainties.map(
      (uncertainty) =>
        `${uncertainty.code}\u0000${uncertainty.source}\u0000${uncertainty.filePath ?? ''}`,
    ),
  );
  const expectedCoverage = expectedImpactCoverage(trust.fallback, uncertainties.length);
  const expectedFullyVerified = expectedCoverage === 'full' && trust.fallback === 'targeted';
  if (
    unique.size !== uncertainties.length ||
    trust.coverage !== expectedCoverage ||
    trust.fullyVerified !== expectedFullyVerified
  ) {
    return { valid: false };
  }
  const reasonCodes = uncertainties.map((uncertainty) => uncertainty.code);
  if (!expectedFullyVerified && reasonCodes.length === 0)
    reasonCodes.push('impact-full-run-fallback');
  return {
    fullyVerified: expectedFullyVerified,
    reasonCodes: [...new Set(reasonCodes)],
    valid: true,
  };
}

function selectionGraphIdentityIsBound(payload: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(payload.data) || typeof payload.data.graphIdentity !== 'string') return false;
  if (!isRecord(payload.context) || !isRecord(payload.context.catalog)) return false;
  const catalog = payload.context.catalog;
  if (catalog.status === 'loaded') {
    return typeof catalog.identity === 'string' && payload.data.graphIdentity === catalog.identity;
  }
  return catalog.status === 'missing' && payload.data.graphIdentity === 'graph:missing';
}

/** Bind a `select_tests` data projection to the graph identity in its outer envelope. */
export function testSelectionGraphBindingIsValid(payload: unknown): boolean {
  return isRecord(payload) && selectionGraphIdentityIsBound(payload);
}

function selectedTestIsValid(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !exactKeys(value, ['path', 'basis', 'confidence', 'proof', 'observed'])) {
    return false;
  }
  return (
    safeProjectPath(value.path) &&
    typeof value.basis === 'string' &&
    SELECTED_TEST_BASES.has(value.basis) &&
    typeof value.confidence === 'string' &&
    SELECTED_TEST_CONFIDENCES.has(value.confidence) &&
    boundedStringArray(value.proof, MAX_SELECTION_PROOF_ITEMS, 1024) &&
    value.observed === false
  );
}

function verificationCommandIsValid(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !exactKeys(value, ['tier', 'cwd', 'argv', 'basis'])) return false;
  return (
    typeof value.tier === 'string' &&
    COMMAND_TIERS.has(value.tier) &&
    (value.cwd === '.' || safeProjectPath(value.cwd)) &&
    boundedStringArray(value.argv, MAX_SELECTION_COMMAND_ARGUMENTS, 256) &&
    value.argv.length > 0 &&
    boundedText(value.basis, 256)
  );
}

function exactNormalizedFiles(actual: readonly string[], expected: readonly string[]): boolean {
  const normalizedExpected = [
    ...new Set(expected.map((file) => file.replaceAll('\\', '/'))),
  ].sort();
  return (
    actual.length === normalizedExpected.length &&
    actual.every((file, index) => file === normalizedExpected[index])
  );
}

/**
 * Validate the closed test-selection snapshot and its request/catalog bindings.
 * Positive row extraction remains separate; this verdict is specifically the
 * semantic gate for response-derived negative proof.
 */
export function assessTestSelectionTrust(
  payload: unknown,
  expectedFiles: readonly string[],
): TestSelectionAssessment {
  if (!isRecord(payload) || !isRecord(payload.data) || !selectionGraphIdentityIsBound(payload)) {
    return { valid: false };
  }
  const data = payload.data;
  if (
    !exactKeys(data, [
      'schemaVersion',
      'snapshotId',
      'files',
      'tests',
      'commands',
      'uncoveredFiles',
      'trust',
      'graphIdentity',
      'inventoryIdentity',
    ]) ||
    data.schemaVersion !== 1 ||
    typeof data.snapshotId !== 'string' ||
    !TEST_SELECTION_ID.test(data.snapshotId) ||
    typeof data.inventoryIdentity !== 'string' ||
    !INVENTORY_ID.test(data.inventoryIdentity) ||
    !Array.isArray(data.files) ||
    data.files.length === 0 ||
    data.files.length > MAX_TEST_SELECTION_FILES ||
    !data.files.every(safeProjectPath) ||
    !stringsAreUnique(data.files) ||
    !exactNormalizedFiles(data.files, expectedFiles) ||
    !Array.isArray(data.tests) ||
    data.tests.length > MAX_SELECTED_TESTS ||
    data.tests.some((test) => !selectedTestIsValid(test)) ||
    !Array.isArray(data.commands) ||
    data.commands.length > MAX_SELECTION_COMMANDS ||
    data.commands.some((command) => !verificationCommandIsValid(command)) ||
    !Array.isArray(data.uncoveredFiles) ||
    data.uncoveredFiles.length > MAX_TEST_SELECTION_FILES ||
    !data.uncoveredFiles.every(safeProjectPath) ||
    !stringsAreUnique(data.uncoveredFiles) ||
    !isRecord(data.trust) ||
    !exactKeys(data.trust, ['status', 'reasonCodes', 'fallbackTier']) ||
    typeof data.trust.status !== 'string' ||
    !SELECTION_STATUSES.has(data.trust.status) ||
    !boundedStringArray(
      data.trust.reasonCodes,
      MAX_SELECTION_REASON_CODES,
      MAX_REASON_CODE_BYTES,
    ) ||
    !data.trust.reasonCodes.every((reason) => REASON_CODE.test(reason)) ||
    !stringsAreUnique(data.trust.reasonCodes) ||
    (data.trust.fallbackTier !== 'focused' &&
      data.trust.fallbackTier !== 'package' &&
      data.trust.fallbackTier !== 'full')
  ) {
    return { valid: false };
  }

  const tests = data.tests as readonly Readonly<Record<string, unknown>>[];
  const commands = data.commands as readonly Readonly<Record<string, unknown>>[];
  const files = data.files as readonly string[];
  const uncoveredFiles = data.uncoveredFiles as readonly string[];
  const reasonCodes = data.trust.reasonCodes;
  const testPaths = tests.map((test) => String(test.path));
  const commandKeys = commands.map(
    (command) =>
      `${String(command.cwd)}\u0000${(command.argv as readonly string[]).join('\u0000')}`,
  );
  const uncoveredIsSubset = uncoveredFiles.every((file) => files.includes(file));
  const complete = tests.length > 0 && reasonCodes.length === 0 && uncoveredFiles.length === 0;
  let expectedStatus: 'complete' | 'fallback' | 'partial' = 'partial';
  if (tests.length === 0) expectedStatus = 'fallback';
  else if (complete) expectedStatus = 'complete';
  if (
    !stringsAreUnique(testPaths) ||
    !stringsAreUnique(commandKeys) ||
    !uncoveredIsSubset ||
    (!complete && reasonCodes.length === 0) ||
    data.trust.status !== expectedStatus
  ) {
    return { valid: false };
  }
  return { complete, reasonCodes, valid: true };
}
