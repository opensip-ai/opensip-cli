/**
 * Platform-support registry data (Plan 02 — macOS GA qualification).
 *
 * The immutable, frozen `PLATFORM_SUPPORT_ROWS` registry plus the fail-closed
 * module-load validation that guards it. Split out of `platform-support.ts` to
 * keep each module focused: the type leaf owns the type vocabulary, the pure
 * host-classification evaluators live in `platform-support-eval.ts`, the
 * fail-closed registry validation lives in `platform-support-validate.ts`, and
 * this module owns the policy DATA those consume.
 *
 * The type import below is `import type` from the dependency-free type leaf, and
 * the validator import is a pure sibling with no data dependency, so this module
 * sits above the leaf and below the classifier/facade with no import cycle.
 *
 * Design invariants (mirrored from `platform-support.ts`):
 *   - Frozen data, no module-level mutable state, no filesystem/process reads.
 *   - `supported` is NEVER implied by package engine compatibility; it is absent
 *     until an external gate promotes a row. macOS launches as `preview`.
 */

import { assertPlatformSupportRowsValid } from './platform-support-validate.js';

import type { PlatformSupportRow } from './platform-support-types.js';

const MACOS_SUPPORT_DOCS_PATH = 'docs/public/70-reference/17-supported-platforms.md';
const MACOS_SUPPORT_DOCS_URL =
  'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms';

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

/**
 * Stable support-row identity (historical binding for v1 verifier evidence).
 * Distinct from the active executable profile id (schema-v2 chain).
 */
const MACOS_PREVIEW_ROW_ID = 'macos-26-arm64-node24-npm11-v1';
/** Active schema-v2 acceptance profile for macOS qualification execution. */
const MACOS_PREVIEW_PROFILE_ID = 'macos-26-arm64-node24-npm11-v2';
/** The stable id of the explicit Intel/x64 macOS exclusion row. */
const MACOS_INTEL_ROW_ID = 'macos-26-intel-unsupported';

export const MACOS_PREVIEW_ROW: PlatformSupportRow = Object.freeze({
  id: MACOS_PREVIEW_ROW_ID,
  status: 'preview',
  tuple: Object.freeze({ ...MACOS_26_BASE_TUPLE, arch: 'arm64' }),
  profile: Object.freeze({ id: MACOS_PREVIEW_PROFILE_ID, version: 2 }),
  docsPath: MACOS_SUPPORT_DOCS_PATH,
  docsUrl: MACOS_SUPPORT_DOCS_URL,
  evidence: Object.freeze({
    artifact: 'opensip-cli-macos-qualification.v2.json',
    url: null,
  }),
  notes:
    'Apple Silicon macOS 26 on Node 24 (ABI 137) / npm 11 over APFS. Active ' +
    'qualification uses schema-v2 profiles (common-v2 + macos-v2); v1 artifacts ' +
    'remain historical verifier inputs only. Preview until 14-day burn-in and a ' +
    'staged release pass promote it to supported.',
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

/**
 * The exact Ubuntu 24.04 x64 tuple (Plan 12 — Linux qualification). The row/
 * profile id is dot-free (`ubuntu-2404-…`) to satisfy the stable-id grammar; the
 * human-facing `ubuntu-24.04` runner label lives only in the qualification
 * workflow's `runs-on`. glibc is NOT a tuple dimension — the `better-sqlite3`
 * prebuild-load journey is the real proof the glibc-linked binding loads.
 */
const UBUNTU_2404_ROW_ID = 'ubuntu-2404-x64-node24-npm11-v1';
const UBUNTU_INSTALL_CHANNELS = Object.freeze(['npm-exact-version'] as const);

export const UBUNTU_2404_PREVIEW_ROW: PlatformSupportRow = Object.freeze({
  id: UBUNTU_2404_ROW_ID,
  status: 'preview',
  tuple: Object.freeze({
    osPlatform: 'linux',
    osName: 'Ubuntu',
    osVersionMajor: 24,
    osVersionRange: '24.x',
    kernelName: 'Linux',
    kernelVersionMajor: 6,
    kernelVersionRange: '6.x',
    arch: 'x64',
    nodeVersionMajor: 24,
    nodeAbi: '137',
    npmVersionMajor: 11,
    filesystemType: 'ext4',
    caseSensitive: true,
    installChannels: UBUNTU_INSTALL_CHANNELS,
  }),
  profile: Object.freeze({ id: 'ubuntu-2404-x64-node24-npm11-v2', version: 2 }),
  docsPath: MACOS_SUPPORT_DOCS_PATH,
  docsUrl: MACOS_SUPPORT_DOCS_URL,
  evidence: Object.freeze({
    artifact: 'opensip-cli-linux-qualification.v2.json',
    url: null,
  }),
  notes:
    'Ubuntu 24.04 LTS on x86_64 with Node 24 (ABI 137) / npm 11 over ext4 ' +
    '(case-sensitive). Qualified via the linux-qualification acceptance lane ' +
    'against published bytes. Preview until a 14-day scheduled-lane burn-in and ' +
    'a staged release pass promote it to supported.',
});

/** The immutable platform-support registry. */
export const PLATFORM_SUPPORT_ROWS: readonly PlatformSupportRow[] = Object.freeze([
  MACOS_PREVIEW_ROW,
  MACOS_INTEL_ROW,
  UBUNTU_2404_PREVIEW_ROW,
]);

// Fail-closed: validate the frozen registry at module load (see
// `platform-support-validate.ts` for the full invariant set).
assertPlatformSupportRowsValid(PLATFORM_SUPPORT_ROWS);
