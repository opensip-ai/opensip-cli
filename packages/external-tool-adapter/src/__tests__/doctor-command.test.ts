import { describe, expect, it } from 'vitest';

import { compareVersion, doctorReportLines, probeAdapter } from '../doctor-command.js';
import { probeVersionReport } from '../version-command.js';

import type { DoctorProbeDeps } from '../doctor-command.js';

function deps(over: Partial<DoctorProbeDeps> = {}): DoctorProbeDeps {
  return {
    binaryDeps: { existsSync: () => true, which: () => '/usr/bin/gitleaks' },
    probeVersion: () => '8.18.0',
    env: {},
    ...over,
  };
}

describe('compareVersion', () => {
  it('classifies ok / too-old / unknown / not-applicable', () => {
    expect(compareVersion('8.18.0', '8.0.0')).toBe('ok');
    expect(compareVersion('8.18.0', '8.18.0')).toBe('ok');
    expect(compareVersion('7.9.9', '8.0.0')).toBe('too-old');
    expect(compareVersion(undefined, '8.0.0')).toBe('unknown');
    expect(compareVersion('not-a-version!', '8.0.0')).toBe('unknown');
    expect(compareVersion('8.0.0', undefined)).toBe('not-applicable');
  });
});

describe('probeAdapter', () => {
  const binary = {
    command: 'gitleaks',
    versionArgs: ['version'],
    minVersion: '8.0.0',
    installHint: 'brew install gitleaks',
  };

  it('reports ready when the binary is found and recent enough', () => {
    const report = probeAdapter(
      { tool: 'gitleaks', network: 'local-only', binary, config: {} },
      deps(),
    );
    expect(report.binary.found).toBe(true);
    expect(report.binary.layer).toBe('path');
    expect(report.version).toMatchObject({ detected: '8.18.0', minVersion: '8.0.0', status: 'ok' });
    expect(report.ready).toBe(true);
    expect(report.installHint).toBeUndefined();
  });

  it('reports not-ready + an install hint when the binary is missing', () => {
    const report = probeAdapter(
      { tool: 'gitleaks', network: 'local-only', binary, config: {} },
      deps({ binaryDeps: { existsSync: () => false, which: () => undefined } }),
    );
    expect(report.binary.found).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.installHint).toBe('brew install gitleaks');
  });

  it('reports not-ready when the version is too old', () => {
    const report = probeAdapter(
      { tool: 'gitleaks', network: 'local-only', binary, config: {} },
      deps({ probeVersion: () => '7.0.0' }),
    );
    expect(report.version.status).toBe('too-old');
    expect(report.ready).toBe(false);
  });

  it('honors a config-file pin', () => {
    const report = probeAdapter(
      {
        tool: 'gitleaks',
        network: 'local-only',
        binary,
        config: { binaries: { gitleaks: { path: '/opt/gitleaks' } } },
      },
      deps(),
    );
    expect(report.binary.path).toBe('/opt/gitleaks');
    expect(report.binary.layer).toBe('config');
  });

  it('surfaces credential presence (presence only) for an auth-required posture', () => {
    const present = probeAdapter(
      {
        tool: 'snyk',
        network: 'auth-required',
        binary: { command: 'snyk', versionArgs: ['--version'] },
        config: {},
      },
      deps({ env: { OPENSIP_SNYK_TOKEN: 'secret-value' } }),
    );
    expect(present.credentialEnv).toEqual({ name: 'OPENSIP_SNYK_TOKEN', present: true });
    expect(present.ready).toBe(true);

    const missing = probeAdapter(
      {
        tool: 'snyk',
        network: 'auth-required',
        binary: { command: 'snyk', versionArgs: ['--version'] },
        config: {},
      },
      deps(),
    );
    expect(missing.credentialEnv?.present).toBe(false);
    expect(missing.ready).toBe(false);
  });
});

describe('doctorReportLines', () => {
  it('renders a found+ready report', () => {
    const lines = doctorReportLines(
      probeAdapter(
        {
          tool: 'gitleaks',
          network: 'local-only',
          binary: { command: 'gitleaks', versionArgs: ['version'], minVersion: '8.0.0' },
          config: {},
        },
        deps(),
      ),
    );
    expect(lines.join('\n')).toContain('ready:   yes');
    expect(lines.join('\n')).toContain('network: local-only');
  });
});

describe('probeVersionReport', () => {
  it('returns the resolved path + version', () => {
    const report = probeVersionReport(
      { tool: 'gitleaks', binary: { command: 'gitleaks', versionArgs: ['version'] }, config: {} },
      deps(),
    );
    expect(report).toMatchObject({
      tool: 'gitleaks',
      found: true,
      path: '/usr/bin/gitleaks',
      version: '8.18.0',
      layer: 'path',
    });
  });

  it('reports not-found cleanly', () => {
    const report = probeVersionReport(
      { tool: 'gitleaks', binary: { command: 'gitleaks', versionArgs: ['version'] }, config: {} },
      deps({ binaryDeps: { existsSync: () => false, which: () => undefined } }),
    );
    expect(report).toMatchObject({ found: false, command: 'gitleaks' });
    expect(report.version).toBeUndefined();
  });
});
