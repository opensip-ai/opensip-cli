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

  it.each(['scalar-value', '- one\n- two\n'])(
    'returns {} when the YAML root is not a mapping',
    async (content) => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const opensipDir = join(HOME, '.opensip-cli');
      mkdirSync(opensipDir, { recursive: true });
      writeFileSync(join(opensipDir, 'config.yml'), content);
      const { readGlobalConfig } = await loadModule();
      expect(readGlobalConfig()).toEqual({});
    },
  );
});

describe('readGlobalTrustPolicy', () => {
  it('returns empty when no user policy exists and parses valid policy blocks', async () => {
    const { readGlobalTrustPolicy, writeGlobalConfig } = await loadModule();

    expect(readGlobalTrustPolicy()).toEqual({});

    writeGlobalConfig({
      policy: {
        mode: 'strict',
        ci: 'strict',
        exceptions: [
          {
            id: 'temp',
            subject: 'baseline:fit',
            action: 'baseline-save',
            reason: 'temporary rollout',
            expiresAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    });

    expect(readGlobalTrustPolicy().policy).toMatchObject({
      mode: 'strict',
      ci: 'strict',
      exceptions: [{ id: 'temp' }],
    });
  });

  it('summarizes invalid user policy blocks without throwing', async () => {
    const { readGlobalTrustPolicy, writeGlobalConfig } = await loadModule();

    writeGlobalConfig({
      policy: {
        mode: 'strict',
        exceptions: [{ id: 'bad', subject: 'baseline:fit', action: 'baseline-save' }],
      },
    });

    expect(readGlobalTrustPolicy().error).toContain('reason');
  });
});

describe('capability trust grant persistence', () => {
  const HASH_A = `sha256:${'a'.repeat(64)}`;
  const HASH_B = `sha256:${'b'.repeat(64)}`;

  it('grants, replaces, and revokes exact capability identities while preserving user config', async () => {
    const {
      grantCapabilityTrust,
      readGlobalConfig,
      readGlobalTrustPolicy,
      revokeCapabilityTrust,
      writeGlobalConfig,
    } = await loadModule();
    writeGlobalConfig({
      apiKey: 'sk-preserved',
      policy: {
        mode: 'strict',
        trustedCapabilityPacks: [
          { id: '@acme/other', manifestHash: HASH_A },
          { id: '@acme/rules', manifestHash: HASH_A },
        ],
      },
    });

    grantCapabilityTrust({
      id: '@acme/rules',
      manifestHash: HASH_B,
      grantedAt: '2026-07-19T00:00:00.000Z',
    });

    expect(readGlobalConfig().apiKey).toBe('sk-preserved');
    expect(readGlobalTrustPolicy().policy).toEqual({
      mode: 'strict',
      trustedCapabilityPacks: [
        { id: '@acme/other', manifestHash: HASH_A },
        {
          id: '@acme/rules',
          manifestHash: HASH_B,
          grantedAt: '2026-07-19T00:00:00.000Z',
        },
      ],
    });

    expect(revokeCapabilityTrust('@acme/rules')).toBe(true);
    expect(readGlobalTrustPolicy().policy).toEqual({
      mode: 'strict',
      trustedCapabilityPacks: [{ id: '@acme/other', manifestHash: HASH_A }],
    });
  });

  it('creates the first grant and treats absent or unmatched revocations as no-ops', async () => {
    const { grantCapabilityTrust, readGlobalTrustPolicy, revokeCapabilityTrust } =
      await loadModule();

    expect(revokeCapabilityTrust('@acme/missing')).toBe(false);
    grantCapabilityTrust({ id: '@acme/first', manifestHash: HASH_A });
    expect(readGlobalTrustPolicy().policy?.trustedCapabilityPacks).toEqual([
      { id: '@acme/first', manifestHash: HASH_A },
    ]);
    expect(revokeCapabilityTrust('@acme/missing')).toBe(false);
  });

  it('fails closed on an invalid policy without mutating it', async () => {
    const { grantCapabilityTrust, readGlobalConfig, revokeCapabilityTrust, writeGlobalConfig } =
      await loadModule();
    const invalidPolicy = { mode: 'invalid-mode' };
    writeGlobalConfig({ apiKey: 'sk-kept', policy: invalidPolicy });

    expect(() => grantCapabilityTrust({ id: '@acme/rules', manifestHash: HASH_A })).toThrow(
      /user-level policy block is invalid/u,
    );
    expect(revokeCapabilityTrust('@acme/rules')).toBe(false);
    expect(readGlobalConfig()).toEqual({
      apiKey: 'sk-kept',
      policy: invalidPolicy,
    });
  });

  it('rejects a grant that would exceed the policy schema limit without mutating it', async () => {
    const { grantCapabilityTrust, readGlobalTrustPolicy, writeGlobalConfig } = await loadModule();
    const grants = Array.from({ length: 200 }, (_, index) => ({
      id: `@acme/rules-${String(index)}`,
      manifestHash: HASH_A,
    }));
    writeGlobalConfig({ policy: { trustedCapabilityPacks: grants } });

    expect(() => grantCapabilityTrust({ id: '@acme/one-too-many', manifestHash: HASH_B })).toThrow(
      /would make the user policy invalid/u,
    );
    expect(readGlobalTrustPolicy().policy?.trustedCapabilityPacks).toEqual(grants);
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

  it('ignores a non-string key in a hand-edited global config', async () => {
    const { resolveApiKey, writeGlobalConfig } = await loadModule();
    writeGlobalConfig({ apiKey: 123 as never });
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
