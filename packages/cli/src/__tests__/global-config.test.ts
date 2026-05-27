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
  return await import('../bootstrap/global-config.js');
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

    const opensipDir = join(HOME, '.opensip-tools');
    const stragglers = readdirSync(opensipDir).filter((name) => name.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });

  it('overwrites an existing config file via atomic rename', async () => {
    const { writeGlobalConfig, readGlobalConfig } = await loadModule();

    writeGlobalConfig({ apiKey: 'sk-first' });
    writeGlobalConfig({ apiKey: 'sk-second' });

    expect(readGlobalConfig().apiKey).toBe('sk-second');
  });
});

describe('readGlobalConfig (missing / malformed paths)', () => {
  it('returns {} when the config file does not exist', async () => {
    const { readGlobalConfig } = await loadModule();
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when the YAML content is malformed', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const opensipDir = join(HOME, '.opensip-tools');
    mkdirSync(opensipDir, { recursive: true });
    writeFileSync(join(opensipDir, 'config.yml'), '\t: not valid : :');
    const { readGlobalConfig } = await loadModule();
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when the YAML parses to null/empty', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const opensipDir = join(HOME, '.opensip-tools');
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
