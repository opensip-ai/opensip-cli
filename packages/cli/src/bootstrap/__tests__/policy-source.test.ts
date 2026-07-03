import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ORG_POLICY_CACHE_MAX_BYTES,
  loadPreScopePolicySources,
  readValidatedProjectPolicy,
  resolveRuntimePolicy,
} from '../policy-source.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-policy-source-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeOrgCache(path: string, generatedAt = '2026-07-01T00:00:00.000Z'): void {
  mkdirSync(join(root, '.opensip'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      policy: { mode: 'strict' },
    }),
  );
}

describe('policy source loading', () => {
  it('extracts only valid project policy blocks', () => {
    expect(readValidatedProjectPolicy(undefined)).toBeUndefined();
    expect(readValidatedProjectPolicy({})).toBeUndefined();
    expect(readValidatedProjectPolicy({ policy: { mode: 'strict' } })).toEqual({
      mode: 'strict',
    });
    expect(readValidatedProjectPolicy({ policy: { mode: 'bad' } })).toBeUndefined();
  });

  it('loads a fresh org policy cache inside the project root', () => {
    const cachePath = join(root, '.opensip', 'org-policy.json');
    writeOrgCache(cachePath);

    const result = resolveRuntimePolicy({
      projectPolicy: { org: { required: true, cachePath: '.opensip/org-policy.json' } },
      projectRoot: root,
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources.map((source) => source.tier)).toEqual(['project', 'org']);
    expect(result.policy.mode).toBe('strict');
    expect(result.policy.orgStatus).toEqual({ state: 'available', sourceTier: 'org' });
  });

  it('uses user and project policy tiers without an org cache when no project root is known', () => {
    const result = resolveRuntimePolicy({
      userPolicy: { mode: 'permissive' },
      projectPolicy: { mode: 'strict', org: { required: true, cachePath: '.opensip/org.json' } },
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources.map((source) => source.tier)).toEqual(['user', 'project']);
    expect(result.policy.mode).toBe('strict');
  });

  it.each([
    ['cache missing', '.opensip/missing.json'],
    ['cache path escapes project root', '../outside.json'],
  ])('records an unavailable org policy when the %s', (reason, cachePath) => {
    const result = resolveRuntimePolicy({
      projectPolicy: { org: { required: true, cachePath } },
      projectRoot: root,
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(result.diagnostics).toEqual([`org policy ${reason}`]);
    expect(result.policy.orgStatus).toEqual({ state: 'required-unavailable', reason });
  });

  it('rejects stale, invalid, and oversized org policy caches', () => {
    const stalePath = join(root, '.opensip', 'stale.json');
    writeOrgCache(stalePath, '2026-06-01T00:00:00.000Z');
    expect(
      resolveRuntimePolicy({
        projectPolicy: { org: { required: false, cachePath: '.opensip/stale.json', maxAgeMs: 1 } },
        projectRoot: root,
        now: new Date('2026-07-02T00:00:00.000Z'),
      }).policy.orgStatus,
    ).toEqual({ state: 'optional-unavailable', reason: 'cache stale' });

    const invalidPath = join(root, '.opensip', 'invalid.json');
    writeFileSync(invalidPath, 'not json');
    expect(
      resolveRuntimePolicy({
        projectPolicy: { org: { required: false, cachePath: '.opensip/invalid.json' } },
        projectRoot: root,
        now: new Date('2026-07-02T00:00:00.000Z'),
      }).policy.orgStatus,
    ).toEqual({ state: 'optional-unavailable', reason: 'cache invalid' });

    const largePath = join(root, '.opensip', 'large.json');
    writeFileSync(largePath, 'x'.repeat(ORG_POLICY_CACHE_MAX_BYTES + 1));
    expect(
      resolveRuntimePolicy({
        projectPolicy: { org: { required: false, cachePath: '.opensip/large.json' } },
        projectRoot: root,
        now: new Date('2026-07-02T00:00:00.000Z'),
      }).policy.orgStatus,
    ).toEqual({ state: 'optional-unavailable', reason: 'cache too large' });
  });

  it('rejects org policy caches with invalid schema, invalid timestamps, and escaping realpaths', () => {
    const invalidSchema = join(root, '.opensip', 'invalid-schema.json');
    mkdirSync(join(root, '.opensip'), { recursive: true });
    writeFileSync(invalidSchema, JSON.stringify({ schemaVersion: 1, generatedAt: '2026-07-01' }));
    expect(
      resolveRuntimePolicy({
        projectPolicy: { org: { required: true, cachePath: '.opensip/invalid-schema.json' } },
        projectRoot: root,
        now: new Date('2026-07-02T00:00:00.000Z'),
      }).policy.orgStatus,
    ).toEqual({ state: 'required-unavailable', reason: 'cache invalid' });

    const invalidTimestamp = join(root, '.opensip', 'invalid-timestamp.json');
    writeOrgCache(invalidTimestamp, 'not-a-date');
    expect(
      resolveRuntimePolicy({
        projectPolicy: { org: { required: false, cachePath: '.opensip/invalid-timestamp.json' } },
        projectRoot: root,
        now: new Date('2026-07-02T00:00:00.000Z'),
      }).policy.orgStatus,
    ).toEqual({ state: 'optional-unavailable', reason: 'cache invalid' });

    const outside = mkdtempSync(join(tmpdir(), 'opensip-policy-source-outside-'));
    try {
      const outsideCache = join(outside, 'org-policy.json');
      writeOrgCache(outsideCache);
      symlinkSync(outsideCache, join(root, '.opensip', 'linked-org-policy.json'));
      expect(
        resolveRuntimePolicy({
          projectPolicy: { org: { required: false, cachePath: '.opensip/linked-org-policy.json' } },
          projectRoot: root,
          now: new Date('2026-07-02T00:00:00.000Z'),
        }).policy.orgStatus,
      ).toEqual({ state: 'optional-unavailable', reason: 'cache realpath escapes project root' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('loads project policy diagnostics through the pre-scope source loader', () => {
    const configPath = join(root, 'opensip-cli.config.yml');
    writeFileSync(configPath, 'policy:\n  mode: invalid\n');

    const result = loadPreScopePolicySources({
      cwd: root,
      projectRoot: root,
      projectConfigPath: configPath,
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    expect(result.sources.map((source) => source.tier)).not.toContain('project');
    expect(result.diagnostics.join('\n')).toContain('project policy invalid');
  });
});
