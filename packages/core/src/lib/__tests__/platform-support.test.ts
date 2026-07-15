import { describe, expect, it } from 'vitest';

import {
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  PLATFORM_SUPPORT_ROWS,
  assessHostSupport,
  projectRuntimeHostSupport,
  type ObservedHost,
} from '../../index.js';

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

describe('platform-support registry', () => {
  it('exposes contract version 1 and rows that are frozen and never supported', () => {
    expect(PLATFORM_SUPPORT_CONTRACT_VERSION).toBe(1);
    expect(Object.isFrozen(PLATFORM_SUPPORT_ROWS)).toBe(true);
    for (const row of PLATFORM_SUPPORT_ROWS) {
      expect(Object.isFrozen(row)).toBe(true);
      // Burn-in has not happened: no row may claim `supported` yet.
      expect(row.status).not.toBe('supported');
    }
    const macos = PLATFORM_SUPPORT_ROWS.find((row) => row.status === 'preview');
    expect(macos?.id).toBe('macos-26-arm64-node24-npm11-v1');
    expect(macos?.profile).toEqual({ id: 'macos-26-arm64-node24-npm11-v1', version: 1 });
    expect(macos?.docsPath).toBe('docs/public/70-reference/17-supported-platforms.md');
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

  it('never returns exact when a normative dimension is unobserved (partial preview)', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, npmVersion: undefined });
    expect(assessment.status).toBe('preview');
    expect(assessment.match).toBe('partial');
    expect(assessment.reasonCodes).toEqual([]);
    expect(assessment.unobserved).toContain('npm-major');
  });

  it('marks Intel/x64 macOS as unsupported (categorical exclusion)', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, arch: 'x64' });
    expect(assessment.status).toBe('unsupported');
    expect(assessment.row?.id).toBe('macos-26-intel-unsupported');
    expect(assessment.reasonCodes).toEqual(['macos-intel-unsupported']);
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
    const wrongNode = assessHostSupport({ ...EXACT_MACOS, nodeVersion: 'v22.14.0' });
    expect(wrongNode.status).toBe('unqualified');
    expect(wrongNode.match).toBe('none');
    expect(wrongNode.reasonCodes).toContain('node-major-mismatch');

    const wrongChannel = assessHostSupport({ ...EXACT_MACOS, installChannel: 'homebrew' });
    expect(wrongChannel.status).toBe('unqualified');
    expect(wrongChannel.match).toBe('none');
    expect(wrongChannel.reasonCodes).toContain('install-channel-mismatch');
  });

  it('accepts the second install channel (install-sh) as a clean exact match', () => {
    const assessment = assessHostSupport({ ...EXACT_MACOS, installChannel: 'install-sh' });
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
    // Only the four reliably process-observable facts. OS/kernel version, npm,
    // filesystem, case behavior, and install channel are unobserved, so the row
    // is advertised as preview but never an exact match.
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
    expect(projection.profile).toEqual({ id: 'macos-26-arm64-node24-npm11-v1', version: 1 });
    expect(projection.unobserved).toEqual(
      expect.arrayContaining([
        'os-version',
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
    const projection = projectRuntimeHostSupport({ platform: 'linux', arch: 'x64' });
    expect(projection.status).toBe('unqualified');
    expect(projection.match).toBe('none');
    expect(projection.rowId).toBeNull();
    expect(projection.profile).toBeNull();
    expect(projection.reasonCodes).toEqual(['non-macos-host']);
  });

  it('projects Intel/x64 macOS as unsupported with the Intel exclusion row', () => {
    const projection = projectRuntimeHostSupport({
      platform: 'darwin',
      arch: 'x64',
      nodeVersion: 'v24.16.0',
      nodeAbi: '137',
    });
    expect(projection.status).toBe('unsupported');
    // The host matches the Intel exclusion row on the observed dims, so the fit
    // is `partial` — but never `exact` from process-only facts.
    expect(projection.match).not.toBe('exact');
    expect(projection.match).toBe('partial');
    expect(projection.rowId).toBe('macos-26-intel-unsupported');
    expect(projection.rowStatus).toBe('unsupported');
    expect(projection.reasonCodes).toEqual(['macos-intel-unsupported']);
    // The Intel row carries no acceptance profile — nothing to advertise.
    expect(projection.profile).toBeNull();
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
