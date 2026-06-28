import { describe, expect, it } from 'vitest';

import { defaultBinaryEnvVar, resolveBinary } from '../binary-resolver.js';

import type { BinaryResolveDeps } from '../binary-resolver.js';

function deps(over: Partial<BinaryResolveDeps> = {}): BinaryResolveDeps {
  return {
    existsSync: () => true,
    which: () => '/usr/bin/gitleaks',
    ...over,
  };
}

describe('resolveBinary — layered, first-hit-wins', () => {
  it('an env pin wins over config and PATH', () => {
    const r = resolveBinary(
      {
        command: 'gitleaks',
        envPath: '/opt/env/gitleaks',
        configuredPath: '/opt/cfg/gitleaks',
        platform: 'linux',
      },
      deps(),
    );
    expect(r).toEqual({ found: true, path: '/opt/env/gitleaks', layer: 'env' });
  });

  it('a config pin wins over PATH when no env pin', () => {
    const r = resolveBinary(
      { command: 'gitleaks', configuredPath: '/opt/cfg/gitleaks', platform: 'linux' },
      deps(),
    );
    expect(r).toEqual({ found: true, path: '/opt/cfg/gitleaks', layer: 'config' });
  });

  it('falls back to PATH when no pin', () => {
    const r = resolveBinary(
      { command: 'gitleaks', platform: 'linux' },
      deps({ which: () => '/usr/local/bin/gitleaks' }),
    );
    expect(r).toEqual({ found: true, path: '/usr/local/bin/gitleaks', layer: 'path' });
  });

  it('a non-absolute pin is a hard miss (no PATH fallback)', () => {
    const r = resolveBinary(
      { command: 'gitleaks', configuredPath: 'gitleaks', platform: 'linux' },
      deps(),
    );
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toMatch(/absolute/);
  });

  it('a missing pinned file is a hard miss (operator pin wins, never falls through)', () => {
    const r = resolveBinary(
      { command: 'gitleaks', envPath: '/opt/env/gitleaks', platform: 'linux' },
      deps({ existsSync: () => false }),
    );
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toMatch(/does not exist/);
  });

  it('a PATH miss returns not-found with a searched trail', () => {
    const r = resolveBinary(
      { command: 'gitleaks', platform: 'linux' },
      deps({ which: () => undefined }),
    );
    expect(r.found).toBe(false);
    if (!r.found) {
      expect(r.command).toBe('gitleaks');
      expect(r.searched).toEqual(['PATH:gitleaks']);
    }
  });

  it('blank pins are ignored and fall to PATH', () => {
    const r = resolveBinary(
      { command: 'gitleaks', envPath: '   ', configuredPath: '', platform: 'linux' },
      deps(),
    );
    expect(r).toEqual({ found: true, path: '/usr/bin/gitleaks', layer: 'path' });
  });

  it('passes the host platform to the PATH lookup', () => {
    let seen: string | undefined;
    resolveBinary(
      { command: 'trivy', platform: 'win32' },
      deps({ which: (_c, p) => ((seen = p), 'C:\\trivy.exe') }),
    );
    expect(seen).toBe('win32');
  });
});

describe('defaultBinaryEnvVar', () => {
  it('derives OPENSIP_<TOOL>_BIN, uppercasing and de-hyphenating', () => {
    expect(defaultBinaryEnvVar('gitleaks')).toBe('OPENSIP_GITLEAKS_BIN');
    expect(defaultBinaryEnvVar('osv-scanner')).toBe('OPENSIP_OSV_SCANNER_BIN');
  });
});
