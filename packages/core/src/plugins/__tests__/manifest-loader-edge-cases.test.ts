import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCommands } from '../manifest-command-normalizer.js';
import {
  normalizeResourceRequirement,
  normalizeResourceRequirements,
  readPackageManifest,
  validateManifest,
  validateOptionalRequirements,
} from '../manifest-loader-helpers.js';
import { admitTool } from '../manifest-loader.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-manifest-edges-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function baseBlock(): Record<string, unknown> {
  return {
    kind: 'tool',
    id: 'edge',
    identity: { name: 'edge' },
    commands: [],
  };
}

describe('manifest loader fail-closed edges', () => {
  it('rejects package files without an object-shaped opensipTools block', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ opensipTools: [] }));

    expect(readPackageManifest(testDir)).toBeUndefined();
  });

  it.each([
    ['empty package version', baseBlock(), 'package', ''],
    ['invalid identity', { ...baseBlock(), identity: { name: '' } }, 'package', '1.0.0'],
    ['non-array capabilities', { ...baseBlock(), capabilities: {} }, 'package', '1.0.0'],
    ['non-record capability', { ...baseBlock(), capabilities: [null] }, 'package', '1.0.0'],
    ['capability without an id', { ...baseBlock(), capabilities: [{}] }, 'package', '1.0.0'],
    ['non-array requirements', { ...baseBlock(), requires: {} }, 'package', '1.0.0'],
    ['non-record plugin layout', { ...baseBlock(), pluginLayout: [] }, 'package', '1.0.0'],
    [
      'empty plugin layout domain',
      { ...baseBlock(), pluginLayout: { domain: '', userSubdirs: [] } },
      'package',
      '1.0.0',
    ],
    ['non-record config', { ...baseBlock(), config: [] }, 'package', '1.0.0'],
    [
      'empty config namespace',
      { ...baseBlock(), config: { namespace: '', schema: {} } },
      'package',
      '1.0.0',
    ],
    [
      'non-record config schema',
      { ...baseBlock(), config: { namespace: 'edge', schema: [] } },
      'package',
      '1.0.0',
    ],
  ])('rejects %s', (_label, block, name, version) => {
    expect(validateManifest(block, name, version)).toBeUndefined();
  });

  it('normalizes valid requirements and rejects each malformed shape', () => {
    expect(normalizeResourceRequirement(null)).toBeUndefined();
    expect(normalizeResourceRequirement({ resource: 'unknown' })).toBeUndefined();
    expect(normalizeResourceRequirement({ resource: 'filesystem', scope: 1 })).toBeUndefined();
    expect(normalizeResourceRequirement({ resource: 'filesystem', reason: 1 })).toBeUndefined();
    expect(
      normalizeResourceRequirement({
        resource: 'filesystem',
        scope: 'project',
        reason: 'read sources',
      }),
    ).toEqual({
      resource: 'filesystem',
      scope: 'project',
      reason: 'read sources',
    });

    expect(normalizeResourceRequirements(undefined)).toBeUndefined();
    expect(normalizeResourceRequirements({})).toBeUndefined();
    expect(normalizeResourceRequirements([null])).toBeUndefined();
    expect(validateOptionalRequirements(undefined)).toBeUndefined();
    expect(validateOptionalRequirements({})).toBe('invalid');
  });

  it('rejects non-record commands, missing descriptions, and malformed aliases', () => {
    expect(normalizeCommands([null])).toBeUndefined();
    expect(normalizeCommands([{ name: 'edge' }])).toBeUndefined();
    expect(
      normalizeCommands([{ name: 'edge', description: 'Run edge', aliases: [1] }]),
    ).toBeUndefined();
  });

  it('fails an explicitly requested manifest closed when apiVersion is absent', () => {
    const manifest = validateManifest(baseBlock(), 'package', '1.0.0');
    expect(manifest).toBeDefined();

    expect(
      admitTool({
        manifest: manifest!,
        source: 'installed',
        dir: testDir,
        explicitlyRequested: true,
      }),
    ).toMatchObject({
      decision: 'fail-closed',
      diagnostic:
        'tool declares no plugin apiVersion; declare `apiVersion` in the supported range 1..1',
    });
  });
});
