import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDeclaredCapabilityPackageMetadata } from '../capability-package-manifest.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-cap-manifest-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writePackageJson(value: unknown): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'package.json'), JSON.stringify(value), 'utf8');
}

describe('readDeclaredCapabilityPackageMetadata', () => {
  it('returns undefined when no capability metadata is declared', () => {
    expect(readDeclaredCapabilityPackageMetadata(testDir)).toBeUndefined();

    writePackageJson({ name: '@acme/plain', opensipTools: { ignored: true } });

    expect(readDeclaredCapabilityPackageMetadata(testDir)).toBeUndefined();
  });

  it('returns undefined for malformed package JSON', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'package.json'), '{ invalid json', 'utf8');

    expect(readDeclaredCapabilityPackageMetadata(testDir)).toBeUndefined();
  });

  it('normalizes target metadata and resource requirements', () => {
    writePackageJson({
      name: '@acme/pack',
      opensipTools: {
        kind: 'tool-pack',
        targetDomain: 'fit',
        targetDomainApiVersion: 2,
        requires: [{ resource: 'env', scope: 'TOKEN', reason: 'download rules' }],
      },
    });

    expect(readDeclaredCapabilityPackageMetadata(testDir)).toMatchObject({
      kind: 'tool-pack',
      targetDomain: 'fit',
      targetDomainApiVersion: 2,
      requires: [{ resource: 'env', scope: 'TOKEN', reason: 'download rules' }],
      manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('preserves a manifest hash while marking invalid requirements', () => {
    writePackageJson({
      name: '@acme/bad-requires',
      opensipTools: {
        kind: 'tool-pack',
        requires: [{ resource: 'unknown' }],
      },
    });

    expect(readDeclaredCapabilityPackageMetadata(testDir)).toMatchObject({
      kind: 'tool-pack',
      requiresInvalid: true,
      manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });
});
