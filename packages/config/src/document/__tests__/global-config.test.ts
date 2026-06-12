/**
 * Regression coverage for the 2026-05-25 audit fix on writeGlobalConfig.
 *
 * The previous implementation called writeFileSync (which creates files with
 * the process umask, commonly 0o644) and then chmodSync(0o600), leaving a
 * race window during which another local user could read the OpenSIP Cloud
 * API key. The fix routes the write through an O_EXCL temp file with mode
 * 0o600 set at creation time, then atomically renames into place.
 *
 * These tests assert (a) the resulting file mode is 0o600, (b) the temp file
 * is cleaned up on success, and (c) the round-trip read returns the written
 * value.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as NodeOs from 'node:os';

// Stub homedir BEFORE importing the module under test so the module-level
// OPENSIP_DIR constant resolves under our temp directory.
let HOME: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => HOME,
  };
});

// Dynamic import after the mock is set up so the module captures our homedir.
async function loadModule() {
  return await import('../global-config.js');
}

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'opensip-globalcfg-'));
  vi.resetModules();
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe('writeGlobalConfig', () => {
  it('writes the file with mode 0o600 from the moment it exists on disk', async () => {
    const { writeGlobalConfig, GLOBAL_CONFIG_PATH } = await loadModule();

    writeGlobalConfig({ apiKey: 'sk-test-12345' });

    expect(existsSync(GLOBAL_CONFIG_PATH)).toBe(true);
    const mode = statSync(GLOBAL_CONFIG_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips through readGlobalConfig', async () => {
    const { writeGlobalConfig, readGlobalConfig } = await loadModule();

    writeGlobalConfig({ apiKey: 'sk-roundtrip', extraField: 'preserved' });
    const round = readGlobalConfig();

    expect(round.apiKey).toBe('sk-roundtrip');
    expect(round.extraField).toBe('preserved');
  });

  it('does not leave temp files behind on a successful write', async () => {
    const { writeGlobalConfig } = await loadModule();

    writeGlobalConfig({ apiKey: 'sk-clean' });

    const opensipDir = join(HOME, '.opensip-cli');
    const stragglers = readdirSync(opensipDir).filter((name) => name.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('overwrites an existing config file via atomic rename', async () => {
    const { writeGlobalConfig, readGlobalConfig } = await loadModule();

    writeGlobalConfig({ apiKey: 'sk-first' });
    writeGlobalConfig({ apiKey: 'sk-second' });

    expect(readGlobalConfig().apiKey).toBe('sk-second');
  });

  it('cleans up the temp file and rethrows when the rename fails', async () => {
    const { mkdirSync, writeFileSync, readdirSync, existsSync } = await import('node:fs');
    const { writeGlobalConfig, GLOBAL_CONFIG_PATH } = await loadModule();

    // Make the destination a NON-EMPTY directory so renameSync(file → dir)
    // fails (ENOTEMPTY / EISDIR depending on platform). This drives the
    // rename-failure cleanup branch.
    mkdirSync(GLOBAL_CONFIG_PATH, { recursive: true });
    writeFileSync(join(GLOBAL_CONFIG_PATH, 'blocker'), 'x', 'utf8');

    expect(() => writeGlobalConfig({ apiKey: 'sk-doomed' })).toThrow();

    // The temp file must not linger after the failed rename.
    const opensipDir = join(HOME, '.opensip-cli');
    const stragglers = readdirSync(opensipDir).filter((name) => name.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
    // The destination directory is untouched (still a dir, still has blocker).
    expect(existsSync(join(GLOBAL_CONFIG_PATH, 'blocker'))).toBe(true);
  });
});

describe('readGlobalConfig (missing / malformed paths)', () => {
  it('returns {} when the config file does not exist', async () => {
    const { readGlobalConfig } = await loadModule();
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when the YAML content is malformed', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const opensipDir = join(HOME, '.opensip-cli');
    mkdirSync(opensipDir, { recursive: true });
    writeFileSync(join(opensipDir, 'config.yml'), '\t: not valid : :');
    const { readGlobalConfig } = await loadModule();
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when the YAML parses to null/empty', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const opensipDir = join(HOME, '.opensip-cli');
    mkdirSync(opensipDir, { recursive: true });
    writeFileSync(join(opensipDir, 'config.yml'), '');
    const { readGlobalConfig } = await loadModule();
    expect(readGlobalConfig()).toEqual({});
  });
});

describe('resolveApiKey', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENSIP_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the CLI flag value at highest precedence', async () => {
    const { resolveApiKey, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ apiKey: 'sk-from-config' });
    process.env.OPENSIP_API_KEY = 'sk-from-env';
    expect(resolveApiKey('sk-from-flag')).toBe('sk-from-flag');
  });

  it('returns the env var when no flag is supplied', async () => {
    const { resolveApiKey, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ apiKey: 'sk-from-config' });
    process.env.OPENSIP_API_KEY = 'sk-from-env';
    expect(resolveApiKey()).toBe('sk-from-env');
  });

  it('falls back to the saved config value', async () => {
    const { resolveApiKey, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ apiKey: 'sk-from-config' });
    expect(resolveApiKey()).toBe('sk-from-config');
  });

  it('returns undefined when no key is configured anywhere', async () => {
    const { resolveApiKey } = await loadModule();
    expect(resolveApiKey()).toBeUndefined();
  });
});

describe('resolveEffectiveCloudConfig (audit P0-2 — user opt-out layered over project)', () => {
  it('honors the user cloud.sync:false opt-out even when the project enables sync', async () => {
    // The exact privacy gap: a user writes `cloud.sync: false` in
    // ~/.opensip-cli/config.yml and expects sync off everywhere.
    const { resolveEffectiveCloudConfig, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ cloud: { sync: false } });
    expect(resolveEffectiveCloudConfig({ sync: true })?.sync).toBe(false);
  });

  it('honors a project cloud.sync:false opt-out when the user has no cloud block', async () => {
    const { resolveEffectiveCloudConfig } = await loadModule();
    expect(resolveEffectiveCloudConfig({ sync: false })?.sync).toBe(false);
  });

  it('disables when EITHER source is false (the more restrictive wins)', async () => {
    const { resolveEffectiveCloudConfig, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ cloud: { sync: true } });
    expect(resolveEffectiveCloudConfig({ sync: false })?.sync).toBe(false);
  });

  it('falls through to the project value when the user sets no cloud block', async () => {
    const { resolveEffectiveCloudConfig, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ apiKey: 'sk-x' });
    expect(resolveEffectiveCloudConfig({ sync: true })?.sync).toBe(true);
  });

  it('lets the user endpoint override the project endpoint', async () => {
    const { resolveEffectiveCloudConfig, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ cloud: { endpoint: 'https://user.example' } });
    expect(resolveEffectiveCloudConfig({ endpoint: 'https://project.example' })?.endpoint).toBe(
      'https://user.example',
    );
  });

  it('returns undefined when neither user nor project configures cloud', async () => {
    const { resolveEffectiveCloudConfig } = await loadModule();
    expect(resolveEffectiveCloudConfig()).toBeUndefined();
  });

  it('ignores a malformed user cloud block (falls through to project)', async () => {
    const { resolveEffectiveCloudConfig, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ cloud: { sync: 'yes' } as never });
    expect(resolveEffectiveCloudConfig({ sync: true })?.sync).toBe(true);
  });
});
