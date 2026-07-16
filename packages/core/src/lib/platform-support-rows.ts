/**
 * Platform-support registry data (Plan 02 — macOS GA qualification).
 *
 * The immutable, frozen `PLATFORM_SUPPORT_ROWS` registry plus the fail-closed
 * module-load validation that guards it. Split out of `platform-support.ts` to
 * keep each module focused: the sibling owns the type vocabulary and the pure
 * host-classification evaluators; this module owns the policy data they read.
 *
 * The type import below is `import type` from the dependency-free type leaf, so
 * this module sits above the leaf and below the classifier/facade with no import
 * cycle.
 *
 * Design invariants (mirrored from `platform-support.ts`):
 *   - Frozen data, no module-level mutable state, no filesystem/process reads.
 *   - `supported` is NEVER implied by package engine compatibility; it is absent
 *     until an external gate promotes a row. macOS launches as `preview`.
 */

import type {
  PlatformSupportEvidence,
  PlatformSupportProfileRef,
  PlatformSupportRow,
  PlatformSupportTuple,
} from './platform-support-types.js';

const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const DECIMAL = /^\d+$/;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOWERCASE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NODE_ABI = /^[1-9]\d*$/;
const EVIDENCE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const SUPPORT_STATUSES = Object.freeze([
  'supported',
  'preview',
  'unqualified',
  'unsupported',
] as const);
const MAX_ID_LENGTH = 128;
const MAX_TOKEN_LENGTH = 64;
const MAX_NAME_LENGTH = 128;
const MAX_NOTES_LENGTH = 2048;

const MACOS_SUPPORT_DOCS_PATH = 'docs/public/70-reference/17-supported-platforms.md';
const MACOS_SUPPORT_DOCS_URL =
  'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms';
const EVIDENCE_RELEASE_ORIGIN = 'https://github.com';
const EVIDENCE_RELEASE_PREFIX = '/opensip-ai/opensip-cli/releases/download/';

/** The exact initial macOS tuple (spec §4), reused by the preview + Intel rows. */
const MACOS_INSTALL_CHANNELS = Object.freeze(['npm-exact-version', 'install-sh'] as const);
const MACOS_26_BASE_TUPLE = Object.freeze({
  osPlatform: 'darwin',
  osName: 'macOS',
  osVersionMajor: 26,
  osVersionRange: '26.x',
  kernelName: 'Darwin',
  kernelVersionMajor: 25,
  kernelVersionRange: '25.x',
  nodeVersionMajor: 24,
  nodeAbi: '137',
  npmVersionMajor: 11,
  filesystemType: 'apfs',
  caseSensitive: false,
  installChannels: MACOS_INSTALL_CHANNELS,
} as const);

/** The stable id shared by the macOS preview row and its acceptance profile. */
const MACOS_PREVIEW_ROW_ID = 'macos-26-arm64-node24-npm11-v1';
/** The stable id of the explicit Intel/x64 macOS exclusion row. */
const MACOS_INTEL_ROW_ID = 'macos-26-intel-unsupported';

export const MACOS_PREVIEW_ROW: PlatformSupportRow = Object.freeze({
  id: MACOS_PREVIEW_ROW_ID,
  status: 'preview',
  tuple: Object.freeze({ ...MACOS_26_BASE_TUPLE, arch: 'arm64' }),
  profile: Object.freeze({ id: MACOS_PREVIEW_ROW_ID, version: 1 }),
  docsPath: MACOS_SUPPORT_DOCS_PATH,
  docsUrl: MACOS_SUPPORT_DOCS_URL,
  evidence: Object.freeze({
    artifact: 'opensip-cli-macos-qualification.v1.json',
    url: null,
  }),
  notes:
    'Apple Silicon macOS 26 on Node 24 (ABI 137) / npm 11 over APFS. Published as ' +
    'preview until 14-day burn-in and a staged release pass promote it to supported.',
});

export const MACOS_INTEL_ROW: PlatformSupportRow = Object.freeze({
  id: MACOS_INTEL_ROW_ID,
  status: 'unsupported',
  tuple: Object.freeze({ ...MACOS_26_BASE_TUPLE, arch: 'x64' }),
  docsPath: MACOS_SUPPORT_DOCS_PATH,
  docsUrl: MACOS_SUPPORT_DOCS_URL,
  notes:
    'This exact Intel/x64 macOS 26 / Node 24 tuple is intentionally excluded: no ' +
    'Intel GA evidence. Other Intel tuples remain unqualified until measured.',
});

/** The immutable platform-support registry. */
export const PLATFORM_SUPPORT_ROWS: readonly PlatformSupportRow[] = Object.freeze([
  MACOS_PREVIEW_ROW,
  MACOS_INTEL_ROW,
]);

/**
 * Validate the frozen registry at module load (fail-closed): complete bounded
 * row data, unique stable ids, no two rows overlapping on the classification
 * discriminator, a qualification profile+evidence on any `supported` row, and
 * a profile on any `preview` row.
 *
 * @throws {Error} When the registry is internally inconsistent.
 */
export function assertPlatformSupportRowsValid(rows: readonly PlatformSupportRow[]): void {
  if (!isArrayValue(rows) || rows.length === 0) {
    throw new Error('Platform-support registry must contain at least one row');
  }
  const ids = new Set<string>();
  const discriminators = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const discriminator = assertRowValid(row, index);
    if (ids.has(row.id)) {
      throw new Error(`Duplicate platform-support row id: ${row.id}`);
    }
    ids.add(row.id);
    if (discriminators.has(discriminator)) {
      throw new Error(`Overlapping platform-support rows for tuple ${discriminator}`);
    }
    discriminators.add(discriminator);
  }
}

function assertRowValid(row: PlatformSupportRow, index: number): string {
  if (row === null || typeof row !== 'object') {
    throw new TypeError(`Platform-support row at index ${String(index)} must be an object`);
  }
  assertStableId(row.id, `Platform-support row at index ${String(index)} has an invalid id`);
  if (!SUPPORT_STATUSES.includes(row.status)) {
    throw new Error(`Unknown platform-support status on row ${row.id}: ${String(row.status)}`);
  }
  assertTupleValid(row.id, row.tuple);
  assertDocsValid(row);
  assertNotesValid(row);
  if (row.profile !== undefined) assertProfileValid(row.id, row.profile);
  if (row.evidence !== undefined) assertEvidenceValid(row.id, row.evidence);
  assertStatusMetadataValid(row);
  return `${row.tuple.osPlatform}|${String(row.tuple.osVersionMajor)}|${row.tuple.arch}`;
}

function assertStatusMetadataValid(row: PlatformSupportRow): void {
  if (row.status === 'supported') {
    assertSupportedQualificationValid(row);
  }
  if (row.status === 'preview' && row.profile === undefined) {
    throw new Error(`Preview platform-support row ${row.id} lacks a qualification profile`);
  }
  if (row.status === 'preview' && row.evidence === undefined) {
    throw new Error(`Preview platform-support row ${row.id} lacks an evidence artifact policy`);
  }
  if (row.status !== 'supported' && row.qualification !== undefined) {
    throw new Error(
      `Only a supported platform-support row may carry qualification metadata: ${row.id}`,
    );
  }
}

function assertTupleValid(rowId: string, tuple: PlatformSupportTuple): void {
  if (tuple === null || typeof tuple !== 'object') {
    throw new Error(`Platform-support row ${rowId} has an invalid tuple`);
  }
  assertLowercaseToken(tuple.osPlatform, `row ${rowId} tuple osPlatform`);
  assertBoundedText(tuple.osName, MAX_NAME_LENGTH, `row ${rowId} tuple osName`);
  assertPositiveSafeInteger(tuple.osVersionMajor, `row ${rowId} tuple osVersionMajor`);
  assertMajorRange(tuple.osVersionRange, tuple.osVersionMajor, `row ${rowId} tuple osVersionRange`);
  assertBoundedText(tuple.kernelName, MAX_NAME_LENGTH, `row ${rowId} tuple kernelName`);
  assertPositiveSafeInteger(tuple.kernelVersionMajor, `row ${rowId} tuple kernelVersionMajor`);
  assertMajorRange(
    tuple.kernelVersionRange,
    tuple.kernelVersionMajor,
    `row ${rowId} tuple kernelVersionRange`,
  );
  assertLowercaseToken(tuple.arch, `row ${rowId} tuple arch`);
  assertPositiveSafeInteger(tuple.nodeVersionMajor, `row ${rowId} tuple nodeVersionMajor`);
  if (typeof tuple.nodeAbi !== 'string' || !NODE_ABI.test(tuple.nodeAbi)) {
    throw new Error(`Platform-support row ${rowId} has an invalid tuple nodeAbi`);
  }
  assertPositiveSafeInteger(tuple.npmVersionMajor, `row ${rowId} tuple npmVersionMajor`);
  assertLowercaseToken(tuple.filesystemType, `row ${rowId} tuple filesystemType`);
  if (typeof tuple.caseSensitive !== 'boolean') {
    throw new TypeError(`Platform-support row ${rowId} has an invalid tuple caseSensitive value`);
  }
  if (!isArrayValue(tuple.installChannels) || tuple.installChannels.length === 0) {
    throw new Error(`Platform-support row ${rowId} must declare at least one install channel`);
  }
  const channels = new Set<string>();
  for (const channel of tuple.installChannels) {
    assertLowercaseToken(channel, `row ${rowId} tuple install channel`);
    if (channels.has(channel)) {
      throw new Error(`Platform-support row ${rowId} has a duplicate install channel: ${channel}`);
    }
    channels.add(channel);
  }
}

function assertProfileValid(rowId: string, profile: PlatformSupportProfileRef): void {
  if (profile === null || typeof profile !== 'object') {
    throw new Error(`Platform-support row ${rowId} has an invalid qualification profile`);
  }
  assertStableId(profile.id, `Platform-support row ${rowId} has an invalid profile id`);
  assertPositiveSafeInteger(profile.version, `row ${rowId} profile version`);
}

function assertDocsValid(row: PlatformSupportRow): void {
  if (!isSafePublicDocsPath(row.docsPath)) {
    throw new Error(`Platform-support row ${row.id} has an invalid public docs path`);
  }
  if (!isSafeHttpsUrl(row.docsUrl)) {
    throw new Error(`Platform-support row ${row.id} has an invalid public docs URL`);
  }
}

function assertEvidenceValid(rowId: string, evidence: PlatformSupportEvidence): void {
  if (evidence === null || typeof evidence !== 'object') {
    throw new Error(`Platform-support row ${rowId} has invalid evidence metadata`);
  }
  if (
    typeof evidence.artifact !== 'string' ||
    evidence.artifact.length > MAX_ID_LENGTH ||
    !EVIDENCE_ARTIFACT.test(evidence.artifact)
  ) {
    throw new Error(`Platform-support row ${rowId} has an invalid evidence artifact filename`);
  }
  if (evidence.url !== null && !isSafeHttpsUrl(evidence.url)) {
    throw new Error(`Platform-support row ${rowId} lacks an immutable HTTPS evidence URL`);
  }
}

function assertNotesValid(row: PlatformSupportRow): void {
  try {
    assertBoundedText(row.notes, MAX_NOTES_LENGTH, `row ${row.id} notes`);
  } catch {
    const description = row.status === 'unsupported' ? 'reason' : 'notes';
    throw new Error(`Platform-support row ${row.id} has invalid or missing ${description}`);
  }
}

function assertStableId(value: string, message: string): void {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !STABLE_ID.test(value)) {
    throw new Error(message);
  }
}

function assertLowercaseToken(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TOKEN_LENGTH ||
    !LOWERCASE_TOKEN.test(value)
  ) {
    throw new Error(`Platform-support ${field} is invalid`);
  }
}

function assertBoundedText(value: string, maximum: number, field: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    containsControlCharacter(value)
  ) {
    throw new Error(`Platform-support ${field} is invalid`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Platform-support ${field} must be a positive safe integer`);
  }
}

function assertMajorRange(value: string, major: number, field: string): void {
  if (value !== `${String(major)}.x`) {
    throw new Error(`Platform-support ${field} must match its major`);
  }
}

function isSafePublicDocsPath(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    containsControlCharacter(value) ||
    !value.startsWith('docs/public/') ||
    !value.endsWith('.md') ||
    value.includes('\\')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isSafeHttpsUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048 || containsControlCharacter(value)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname.length > 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function assertSupportedQualificationValid(row: PlatformSupportRow): void {
  if (row.profile === undefined || row.evidence === undefined) {
    throw new Error(
      `Supported platform-support row ${row.id} lacks a qualification profile/evidence`,
    );
  }
  const qualification = row.qualification;
  if (qualification === undefined) {
    throw new Error(`Supported platform-support row ${row.id} lacks qualification metadata`);
  }
  if (
    !Number.isSafeInteger(qualification.consecutiveDailyPasses) ||
    qualification.consecutiveDailyPasses < 14
  ) {
    throw new Error(
      `Supported platform-support row ${row.id} requires at least 14 consecutive daily passes`,
    );
  }
  if (!isExactSemver(qualification.qualifiedVersion)) {
    throw new Error(
      `Supported platform-support row ${row.id} has an invalid exact qualified version`,
    );
  }
  if (!isCanonicalIsoTimestamp(qualification.qualifiedAt)) {
    throw new Error(
      `Supported platform-support row ${row.id} has an invalid qualification timestamp`,
    );
  }
  if (
    typeof qualification.profileDigest !== 'string' ||
    !SHA256.test(qualification.profileDigest)
  ) {
    throw new Error(
      `Supported platform-support row ${row.id} has an invalid qualification profile digest`,
    );
  }
  if (
    !isImmutableEvidenceUrl(row.evidence.url, row.evidence.artifact, qualification.qualifiedVersion)
  ) {
    throw new Error(
      `Supported platform-support row ${row.id} lacks an immutable HTTPS evidence URL`,
    );
  }
}

function isExactSemver(value: string): boolean {
  if (typeof value !== 'string') return false;
  const buildParts = value.split('+');
  if (buildParts.length > 2) return false;
  const [versionAndPrerelease = '', build] = buildParts;
  if (build !== undefined && !areValidSemverIdentifiers(build, false)) return false;

  const prereleaseAt = versionAndPrerelease.indexOf('-');
  const core =
    prereleaseAt === -1 ? versionAndPrerelease : versionAndPrerelease.slice(0, prereleaseAt);
  const prerelease = prereleaseAt === -1 ? undefined : versionAndPrerelease.slice(prereleaseAt + 1);
  const coreParts = core.split('.');
  if (
    coreParts.length !== 3 ||
    coreParts.some((part) => part !== '0' && !POSITIVE_DECIMAL.test(part))
  ) {
    return false;
  }
  return prerelease === undefined || areValidSemverIdentifiers(prerelease, true);
}

function areValidSemverIdentifiers(value: string, rejectNumericLeadingZero: boolean): boolean {
  const identifiers = value.split('.');
  return identifiers.every(
    (identifier) =>
      SEMVER_IDENTIFIER.test(identifier) &&
      (!rejectNumericLeadingZero ||
        !DECIMAL.test(identifier) ||
        identifier === '0' ||
        !identifier.startsWith('0')),
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isImmutableEvidenceUrl(
  value: string | null,
  artifact: string,
  qualifiedVersion: string,
): boolean {
  if (value === null || !isSafeHttpsUrl(value) || !EVIDENCE_ARTIFACT.test(artifact)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const expectedPath = `${EVIDENCE_RELEASE_PREFIX}v${qualifiedVersion}/${artifact}`;
  return parsed.origin === EVIDENCE_RELEASE_ORIGIN && parsed.pathname === expectedPath;
}

assertPlatformSupportRowsValid(PLATFORM_SUPPORT_ROWS);
