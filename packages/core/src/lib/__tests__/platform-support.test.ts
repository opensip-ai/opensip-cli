import { describe, expect, it } from 'vitest';

import {
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  PLATFORM_SUPPORT_ROWS,
  assessHostSupport,
  projectRuntimeHostSupport,
  type ObservedHost,
  type PlatformQualification,
  type PlatformSupportRow,
} from '../../index.js';
import { MACOS_INTEL_ROW, MACOS_PREVIEW_ROW } from '../platform-support-rows.js';
import { assertPlatformSupportRowsValid } from '../platform-support-validate.js';

/** The exact supported tuple (spec §4), fully observed. */
const EXACT_MACOS: ObservedHost = Object.freeze({
  osPlatform: 'darwin',
  osVersion: '26.0.1',
  kernelName: 'Darwin',
  kernelRelease: '25.5.0',
  arch: 'arm64',
  nodeVersion: 'v24.16.0',
  nodeAbi: '137',
  npmVersion: '11.0.0',
  filesystemType: 'apfs',
  caseSensitive: false,
  installChannel: 'npm-exact-version',
});

const QUALIFIED_VERSION = '9.9.9';
const EVIDENCE_ARTIFACT = 'opensip-cli-macos-qualification.v1.json';
const VALID_QUALIFICATION: PlatformQualification = Object.freeze({
  consecutiveDailyPasses: 14,
  qualifiedVersion: QUALIFIED_VERSION,
  qualifiedAt: '2026-08-01T00:00:00.000Z',
  profileDigest: 'a'.repeat(64),
});

function supportedRow(options?: {
  readonly qualification?: Partial<PlatformQualification>;
  readonly evidenceUrl?: string;
}): PlatformSupportRow {
  return Object.freeze({
    ...MACOS_PREVIEW_ROW,
    status: 'supported',
    evidence: Object.freeze({
      artifact: EVIDENCE_ARTIFACT,
      url:
        options?.evidenceUrl ??
        `https://github.com/opensip-ai/opensip-cli/releases/download/v${QUALIFIED_VERSION}/${EVIDENCE_ARTIFACT}`,
    }),
    qualification: Object.freeze({
      ...VALID_QUALIFICATION,
      ...options?.qualification,
    }),
  });
}

describe('platform-support registry', () => {
  it('exposes contract version 1 and rows that are frozen and never supported', () => {
    expect(PLATFORM_SUPPORT_CONTRACT_VERSION).toBe(1);
    expect(Object.isFrozen(PLATFORM_SUPPORT_ROWS)).toBe(true);
    for (const row of PLATFORM_SUPPORT_ROWS) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.tuple)).toBe(true);
      expect(Object.isFrozen(row.tuple.installChannels)).toBe(true);
      if (row.profile !== undefined) expect(Object.isFrozen(row.profile)).toBe(true);
      if (row.evidence !== undefined) expect(Object.isFrozen(row.evidence)).toBe(true);
      // Burn-in has not happened: no row may claim `supported` yet.
      expect(row.status).not.toBe('supported');
    }
    const macos = PLATFORM_SUPPORT_ROWS.find((row) => row.status === 'preview');
    expect(macos?.id).toBe('macos-26-arm64-node24-npm11-v1');
    expect(macos?.profile).toEqual({
      id: 'macos-26-arm64-node24-npm11-v1',
      version: 1,
    });
    expect(macos?.docsPath).toBe('docs/public/70-reference/17-supported-platforms.md');
  });

  it('accepts only complete, immutable GA qualification metadata', () => {
    expect(() => assertPlatformSupportRowsValid([supportedRow()])).not.toThrow();

    // A supported row must carry a profile + evidence + qualification block.
    expect(() =>
      assertPlatformSupportRowsValid([{ ...supportedRow(), profile: undefined }]),
    ).toThrow(/lacks a qualification profile\/evidence/u);
    expect(() =>
      assertPlatformSupportRowsValid([{ ...supportedRow(), qualification: undefined }]),
    ).toThrow(/lacks qualification metadata/u);

    for (const consecutiveDailyPasses of [13, 14.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() =>
        assertPlatformSupportRowsValid([
          supportedRow({ qualification: { consecutiveDailyPasses } }),
        ]),
      ).toThrow(/at least 14 consecutive daily passes/u);
    }

    for (const qualifiedVersion of ['latest', 'v1.2.3', '1.2', '01.2.3', '1.2.3-01']) {
      expect(() =>
        assertPlatformSupportRowsValid([supportedRow({ qualification: { qualifiedVersion } })]),
      ).toThrow(/invalid exact qualified version/u);
    }

    for (const qualifiedAt of ['not-a-date', '2026-02-30T00:00:00.000Z', '2026-08-01T00:00:00Z']) {
      expect(() =>
        assertPlatformSupportRowsValid([supportedRow({ qualification: { qualifiedAt } })]),
      ).toThrow(/invalid qualification timestamp/u);
    }

    for (const profileDigest of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64)]) {
      expect(() =>
        assertPlatformSupportRowsValid([supportedRow({ qualification: { profileDigest } })]),
      ).toThrow(/invalid qualification profile digest/u);
    }
  });

  it('requires a version-addressed immutable HTTPS evidence artifact URL', () => {
    for (const evidenceUrl of [
      `http://example.test/releases/v${QUALIFIED_VERSION}/${EVIDENCE_ARTIFACT}`,
      `https://user:secret@example.test/releases/v${QUALIFIED_VERSION}/${EVIDENCE_ARTIFACT}`,
      `https://example.test/releases/latest/${EVIDENCE_ARTIFACT}`,
      `https://example.test/releases/v${QUALIFIED_VERSION}/other.json`,
      `https://example.test/releases/v${QUALIFIED_VERSION}/${EVIDENCE_ARTIFACT}?download=1`,
      `https://example.test/releases/v${QUALIFIED_VERSION}/${EVIDENCE_ARTIFACT}#fragment`,
    ]) {
      expect(() => assertPlatformSupportRowsValid([supportedRow({ evidenceUrl })])).toThrow(
        /immutable HTTPS evidence URL/u,
      );
    }
  });

  it('rejects unknown statuses and premature qualification claims', () => {
    expect(() =>
      assertPlatformSupportRowsValid([
        {
          ...MACOS_PREVIEW_ROW,
          status: 'mystery',
        } as unknown as PlatformSupportRow,
      ]),
    ).toThrow(/Unknown platform-support status/u);

    expect(() =>
      assertPlatformSupportRowsValid([
        { ...MACOS_PREVIEW_ROW, qualification: VALID_QUALIFICATION },
      ]),
    ).toThrow(/Only a supported platform-support row/u);

    expect(() =>
      assertPlatformSupportRowsValid([{ ...MACOS_PREVIEW_ROW, evidence: undefined }]),
    ).toThrow(/lacks an evidence artifact policy/u);
  });

  it('rejects empty, duplicate, and overlapping registries', () => {
    expect(() => assertPlatformSupportRowsValid([])).toThrow(/at least one row/u);

    expect(() =>
      assertPlatformSupportRowsValid([
        MACOS_PREVIEW_ROW,
        { ...MACOS_INTEL_ROW, id: MACOS_PREVIEW_ROW.id },
      ]),
    ).toThrow(/Duplicate platform-support row id/u);

    expect(() =>
      assertPlatformSupportRowsValid([
        MACOS_PREVIEW_ROW,
        { ...MACOS_PREVIEW_ROW, id: 'macos-overlapping-row' },
      ]),
    ).toThrow(/Overlapping platform-support rows/u);
  });

  it('validates every customer-facing registry field before it can be projected', () => {
    const invalidRows: readonly [PlatformSupportRow, RegExp][] = [
      [{ ...MACOS_PREVIEW_ROW, id: '../macos' }, /invalid id/u],
      [
        {
          ...MACOS_PREVIEW_ROW,
          tuple: { ...MACOS_PREVIEW_ROW.tuple, osVersionRange: '26.*' },
        },
        /osVersionRange must match its major/u,
      ],
      [
        {
          ...MACOS_PREVIEW_ROW,
          tuple: { ...MACOS_PREVIEW_ROW.tuple, installChannels: [] },
        },
        /at least one install channel/u,
      ],
      [
        {
          ...MACOS_PREVIEW_ROW,
          tuple: {
            ...MACOS_PREVIEW_ROW.tuple,
            installChannels: ['install-sh', 'install-sh'],
          },
        },
        /duplicate install channel/u,
      ],
      // A non-lowercase-token tuple field is rejected (exercises assertLowercaseToken).
      [
        { ...MACOS_PREVIEW_ROW, tuple: { ...MACOS_PREVIEW_ROW.tuple, arch: 'ARM64' } },
        /tuple arch is invalid/u,
      ],
      [
        { ...MACOS_PREVIEW_ROW, tuple: { ...MACOS_PREVIEW_ROW.tuple, nodeAbi: 'v137' } },
        /invalid tuple nodeAbi/u,
      ],
      [
        {
          ...MACOS_PREVIEW_ROW,
          tuple: { ...MACOS_PREVIEW_ROW.tuple, caseSensitive: 'no' as unknown as boolean },
        },
        /invalid tuple caseSensitive/u,
      ],
      [{ ...MACOS_PREVIEW_ROW, profile: { id: 'Not Stable', version: 1 } }, /invalid profile id/u],
      [
        {
          ...MACOS_PREVIEW_ROW,
          profile: { id: MACOS_PREVIEW_ROW.id, version: 0 },
        },
        /profile version must be a positive safe integer/u,
      ],
      [{ ...MACOS_PREVIEW_ROW, docsPath: '../private.md' }, /invalid public docs path/u],
      [
        { ...MACOS_PREVIEW_ROW, docsUrl: ['http:', '', 'opensip.ai', 'support'].join('/') },
        /invalid public docs URL/u,
      ],
      // A control character in the URL is rejected by the bounded-input guard
      // (exercises containsControlCharacter's positive branch).
      [
        { ...MACOS_PREVIEW_ROW, docsUrl: `https://opensip.ai/${String.fromCodePoint(1)}` },
        /invalid public docs URL/u,
      ],
      // An over-length URL (> 2048) is rejected before parsing.
      [
        { ...MACOS_PREVIEW_ROW, docsUrl: `https://opensip.ai/${'a'.repeat(2049)}` },
        /invalid public docs URL/u,
      ],
      [
        {
          ...MACOS_PREVIEW_ROW,
          evidence: { artifact: '../evidence.json', url: null },
        },
        /invalid evidence artifact filename/u,
      ],
      [
        {
          ...MACOS_PREVIEW_ROW,
          evidence: {
            artifact: EVIDENCE_ARTIFACT,
            url: 'https://user@example.test/evidence',
          },
        },
        /immutable HTTPS evidence URL/u,
      ],
      [{ ...MACOS_PREVIEW_ROW, notes: '   ' }, /invalid or missing notes/u],
      [{ ...MACOS_INTEL_ROW, notes: '' }, /invalid or missing reason/u],
    ];

    for (const [row, message] of invalidRows) {
      expect(() => assertPlatformSupportRowsValid([row])).toThrow(message);
    }
  });
});

describe('assessHostSupport', () => {
  it('classifies the exact tuple as an exact preview match with no reason codes', () => {
    const assessment = assessHostSupport(EXACT_MACOS);
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('exact');
    expect(assessment.reasonCodes).toEqual([]);
    expect(assessment.unobserved).toEqual([]);
    expect(assessment.row?.id).toBe('macos-26-arm64-node24-npm11-v1');
    expect(Object.isFrozen(assessment)).toBe(true);
  });

  it('projects an injected qualified row as supported without mutating source policy', () => {
    const qualifiedRow = supportedRow();
    const qualifiedRegistry = Object.freeze([qualifiedRow, MACOS_INTEL_ROW]);

    const assessment = assessHostSupport(EXACT_MACOS, qualifiedRegistry);
    expect(assessment.status).toBe('supported');
    expect(assessment.match).toBe('exact');
    expect(assessment.row).toBe(qualifiedRow);

    const projection = projectRuntimeHostSupport(
      {
        platform: 'darwin',
        arch: 'arm64',
        nodeVersion: 'v24.16.0',
        nodeAbi: '137',
      },
      qualifiedRegistry,
    );
    expect(projection.status).toBe('supported');
    expect(projection.rowStatus).toBe('supported');
    expect(projection.match).toBe('partial');

    expect(MACOS_PREVIEW_ROW.status).toBe('preview');
    expect(PLATFORM_SUPPORT_ROWS[0]).toBe(MACOS_PREVIEW_ROW);
  });

  it('never returns exact when a normative dimension is unobserved (partial preview)', () => {
    const assessment = assessHostSupport({
      ...EXACT_MACOS,
      npmVersion: undefined,
    });
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('partial');
    expect(assessment.reasonCodes).toEqual([]);
    expect(assessment.unobserved).toContain('npm-major');
  });

  it('requires the declared Darwin kernel identity for an exact tuple', () => {
    const missing = assessHostSupport({ ...EXACT_MACOS, kernelName: undefined });
    expect(missing.status).toBe('preview');
    expect(missing.match).toBe('partial');
    expect(missing.unobserved).toContain('kernel-name');

    const contradicted = assessHostSupport({ ...EXACT_MACOS, kernelName: 'Linux' });
    expect(contradicted.status).toBe('unqualified');
    expect(contradicted.match).toBe('none');
    expect(contradicted.reasonCodes).toEqual(['kernel-name-mismatch']);
  });

  it('marks the exact Intel/x64 macOS exclusion tuple as unsupported', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, arch: 'x64' });
    expect(assessment.status).toBe('unsupported');
    expect(assessment.row?.id).toBe('macos-26-intel-unsupported');
    expect(assessment.reasonCodes).toEqual(['macos-intel-unsupported']);
  });

  it('does not broaden the Intel exclusion row across older macOS releases', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, arch: 'x64', osVersion: '15.7.1' });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.row).toBeUndefined();
    expect(assessment.match).toBe('none');
    expect(assessment.reasonCodes).toEqual(['os-version-mismatch']);
  });

  it('does not broaden the Intel exclusion row across mismatched Node releases', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, arch: 'x64', nodeVersion: 'v22.18.0' });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.row).toBeUndefined();
    expect(assessment.reasonCodes).toEqual(['node-major-mismatch']);
  });

  it('keeps non-x64 macOS architectures unqualified', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, arch: 'ia32' });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.row).toBeUndefined();
    expect(assessment.reasonCodes).toEqual(['arch-mismatch']);
  });

  it('classifies a non-macOS (Linux) host as unqualified, never "cannot run"', () => {
    const assessment = assessHostSupport({
      osPlatform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.row).toBeUndefined();
    expect(assessment.match).toBe('none');
    expect(assessment.reasonCodes).toEqual(['non-macos-host']);
  });

  it('does not select the macOS row without both platform and architecture identity', () => {
    for (const observed of [{}, { arch: 'arm64' }, { osPlatform: 'darwin' }]) {
      const assessment = assessHostSupport(observed);
      expect(assessment.status).toBe('unqualified');
      expect(assessment.row).toBeUndefined();
      expect(assessment.match).toBe('none');
      expect(assessment.reasonCodes).toEqual(['insufficient-host-facts']);
    }
  });

  it('classifies older macOS, wrong ABI, wrong npm, and case-sensitive APFS as unqualified', () => {
    const cases: [ObservedHost, string][] = [
      [{ ...EXACT_MACOS, osVersion: '14.5.0' }, 'os-version-mismatch'],
      [{ ...EXACT_MACOS, nodeAbi: '127' }, 'node-abi-mismatch'],
      [{ ...EXACT_MACOS, npmVersion: '10.9.0' }, 'npm-major-mismatch'],
      [{ ...EXACT_MACOS, caseSensitive: true }, 'case-sensitivity-mismatch'],
    ];
    for (const [observed, reason] of cases) {
      const assessment = assessHostSupport(observed);
      expect(assessment.status, reason).toBe('unqualified');
      expect(assessment.row, reason).toBeUndefined();
      expect(assessment.match, reason).toBe('none');
      expect(assessment.reasonCodes, reason).toContain(reason);
    }
  });

  it('accepts range versions by major (arm64 macOS 26.4 / Node 24.9 / npm 11.2)', () => {
    const assessment = assessHostSupport({
      ...EXACT_MACOS,
      osVersion: '26.4',
      kernelRelease: '25.10.0',
      nodeVersion: 'v24.9.0',
      npmVersion: '11.2.3',
      filesystemType: 'APFS',
    });
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('exact');
  });

  it('does not extract a matching major from malformed version text', () => {
    for (const observed of [
      { ...EXACT_MACOS, osVersion: 'macOS 26.4' },
      { ...EXACT_MACOS, osVersion: '26.' },
      { ...EXACT_MACOS, kernelRelease: 'Darwin 25.0.0' },
      { ...EXACT_MACOS, nodeVersion: 'node-24.16.0' },
      { ...EXACT_MACOS, npmVersion: 'npm 11.2.3' },
    ]) {
      const assessment = assessHostSupport(observed);
      expect(assessment.status).toBe('unqualified');
      expect(assessment.match).toBe('none');
      expect(assessment.reasonCodes.length).toBeGreaterThan(0);
    }
  });

  it('classifies Windows as unqualified (a later OS profile owns it), never "cannot run"', () => {
    const assessment = assessHostSupport({
      osPlatform: 'win32',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.row).toBeUndefined();
    expect(assessment.match).toBe('none');
    expect(assessment.reasonCodes).toEqual(['non-macos-host']);
  });

  it('classifies a wrong Node major and a wrong install channel as unqualified', () => {
    const wrongNode = assessHostSupport({
      ...EXACT_MACOS,
      nodeVersion: 'v22.14.0',
    });
    expect(wrongNode.status).toBe('unqualified');
    expect(wrongNode.match).toBe('none');
    expect(wrongNode.reasonCodes).toContain('node-major-mismatch');

    const wrongChannel = assessHostSupport({
      ...EXACT_MACOS,
      installChannel: 'homebrew',
    });
    expect(wrongChannel.status).toBe('unqualified');
    expect(wrongChannel.match).toBe('none');
    expect(wrongChannel.reasonCodes).toContain('install-channel-mismatch');
  });

  it('accepts the second install channel (install-sh) as a clean exact match', () => {
    const assessment = assessHostSupport({
      ...EXACT_MACOS,
      installChannel: 'install-sh',
    });
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('exact');
    expect(assessment.reasonCodes).toEqual([]);
  });

  it('emits mismatch reason codes in a stable dimension order (never observation order)', () => {
    // Contradict npm, node-abi, and os-version together. Regardless of which order
    // the object keys are written, the codes come back in the canonical dimension
    // order: os-version, then node-abi, then npm-major.
    const assessment = assessHostSupport({
      ...EXACT_MACOS,
      npmVersion: '10.9.0',
      nodeAbi: '127',
      osVersion: '14.5.0',
    });
    expect(assessment.status).toBe('unqualified');
    expect(assessment.reasonCodes).toEqual([
      'os-version-mismatch',
      'node-abi-mismatch',
      'npm-major-mismatch',
    ]);
  });

  it('requires EVERY normative dimension for an exact match: the process-only subset is partial', () => {
    // Only the four reliably process-observable facts. OS product version,
    // kernel name/release, npm, filesystem, case behavior, and install channel
    // are unobserved, so the row is advertised as preview but never exact.
    const assessment = assessHostSupport({
      osPlatform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('partial');
    expect(assessment.reasonCodes).toEqual([]);
    expect(assessment.observed).toEqual(['os-platform', 'arch', 'node-major', 'node-abi']);
    expect(assessment.unobserved).toEqual([
      'os-version',
      'kernel-name',
      'kernel-version',
      'npm-major',
      'filesystem-type',
      'case-sensitivity',
      'install-channel',
    ]);
  });
});

describe('projectRuntimeHostSupport', () => {
  it('is partial (never exact) for a matching runtime subset and leaves probe dims unobserved', () => {
    const projection = projectRuntimeHostSupport({
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(projection.status).toBe('preview');
    expect(projection.match).toBe('partial');
    expect(projection.rowId).toBe('macos-26-arm64-node24-npm11-v1');
    expect(projection.rowStatus).toBe('preview');
    expect(projection.profile).toEqual({
      id: 'macos-26-arm64-node24-npm11-v1',
      version: 1,
    });
    expect(projection.unobserved).toEqual(
      expect.arrayContaining([
        'os-version',
        'kernel-name',
        'kernel-version',
        'npm-major',
        'filesystem-type',
        'case-sensitivity',
        'install-channel',
      ]),
    );
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it('projects Linux as unqualified with no advertised row', () => {
    const projection = projectRuntimeHostSupport({
      platform: 'linux',
      arch: 'x64',
    });
    expect(projection.status).toBe('unqualified');
    expect(projection.match).toBe('none');
    expect(projection.rowId).toBeNull();
    expect(projection.profile).toBeNull();
    expect(projection.reasonCodes).toEqual(['non-macos-host']);
  });

  it('does not advertise a support row when runtime identity is incomplete', () => {
    for (const facts of [{}, { arch: 'arm64' }, { platform: 'darwin' }]) {
      const projection = projectRuntimeHostSupport(facts);
      expect(projection.status).toBe('unqualified');
      expect(projection.match).toBe('none');
      expect(projection.rowId).toBeNull();
      expect(projection.profile).toBeNull();
      expect(projection.reasonCodes).toEqual(['insufficient-host-facts']);
    }
  });

  it('does not project the exact Intel exclusion without all normative host facts', () => {
    const projection = projectRuntimeHostSupport({
      platform: 'darwin',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(projection.status).toBe('unqualified');
    expect(projection.match).toBe('none');
    expect(projection.rowId).toBeNull();
    expect(projection.rowStatus).toBeNull();
    expect(projection.reasonCodes).toEqual(['insufficient-host-facts']);
    expect(projection.profile).toBeNull();
  });

  it('projects an Intel Mac with a contradicted Node major as unqualified', () => {
    const projection = projectRuntimeHostSupport({
      platform: 'darwin',
      arch: 'x64',
      nodeVersion: 'v22.18.0',
      nodeAbi: '127',
    });
    expect(projection.status).toBe('unqualified');
    expect(projection.match).toBe('none');
    expect(projection.rowId).toBeNull();
    expect(projection.reasonCodes).toEqual(['node-major-mismatch', 'node-abi-mismatch']);
  });

  it('never yields exact and preserves a stable reason order for a contradicted runtime subset', () => {
    // A darwin arm64 host on the wrong Node ABI: partial dims observed, one
    // contradiction. The projection collapses to match: none with the ABI reason.
    const projection = projectRuntimeHostSupport({
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '999',
    });
    expect(projection.match).not.toBe('exact');
    expect(projection.match).toBe('none');
    expect(projection.reasonCodes).toEqual(['node-abi-mismatch']);
  });
});
