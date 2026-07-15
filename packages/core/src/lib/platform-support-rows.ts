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

import type { PlatformSupportRow } from './platform-support-types.js';

const MACOS_SUPPORT_DOCS_PATH = 'docs/public/70-reference/17-supported-platforms.md';
const MACOS_SUPPORT_DOCS_URL =
  'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms';

/** The exact initial macOS tuple (spec §4), reused by the preview + Intel rows. */
const MACOS_26_BASE_TUPLE = {
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
  installChannels: ['npm-exact-version', 'install-sh'],
} as const;

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
  evidence: Object.freeze({ artifact: 'opensip-cli-macos-qualification.v1.json', url: null }),
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
    'Intel/x64 macOS is intentionally excluded: no Intel GA evidence. Native ' +
    'dependency, process, TTY, and lifecycle behavior must be qualified separately.',
});

/** The immutable platform-support registry. */
export const PLATFORM_SUPPORT_ROWS: readonly PlatformSupportRow[] = Object.freeze([
  MACOS_PREVIEW_ROW,
  MACOS_INTEL_ROW,
]);

/**
 * Validate the frozen registry at module load (fail-closed): unique ids, no two
 * rows overlapping on the classification discriminator, a qualification
 * profile+evidence on any `supported` row, and a profile on any `preview` row.
 *
 * @throws {Error} When the registry is internally inconsistent.
 */
function assertPlatformSupportRowsValid(rows: readonly PlatformSupportRow[]): void {
  const ids = new Set<string>();
  const discriminators = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      throw new Error(`Duplicate platform-support row id: ${row.id}`);
    }
    ids.add(row.id);
    const discriminator = `${row.tuple.osPlatform}|${String(row.tuple.osVersionMajor)}|${row.tuple.arch}`;
    if (discriminators.has(discriminator)) {
      throw new Error(`Overlapping platform-support rows for tuple ${discriminator}`);
    }
    discriminators.add(discriminator);
    if (row.status === 'supported' && (row.profile === undefined || row.evidence === undefined)) {
      throw new Error(
        `Supported platform-support row ${row.id} lacks a qualification profile/evidence`,
      );
    }
    if (row.status === 'supported' && row.qualification === undefined) {
      throw new Error(`Supported platform-support row ${row.id} lacks qualification metadata`);
    }
    if (row.status === 'preview' && row.profile === undefined) {
      throw new Error(`Preview platform-support row ${row.id} lacks a qualification profile`);
    }
  }
}

assertPlatformSupportRowsValid(PLATFORM_SUPPORT_ROWS);
