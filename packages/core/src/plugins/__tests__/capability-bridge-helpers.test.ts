import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  capabilityCoContributionValues,
  importCapabilityPackageModule,
  readCapabilityArrayExport,
} from '../capability-bridge-helpers.js';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makePackage(source: string): { readonly packageDir: string; readonly name: string } {
  root = mkdtempSync(join(tmpdir(), 'opensip-capability-helper-'));
  const packageDir = join(root, 'node_modules', '@acme', 'pack');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@acme/pack', type: 'module', main: './index.mjs' }),
  );
  writeFileSync(join(packageDir, 'index.mjs'), source);
  return { packageDir, name: '@acme/pack' };
}

describe('capability bridge helpers', () => {
  it('imports a package module through its declared entry point', async () => {
    const pkg = makePackage('export const checks = [1, 2];');

    await expect(importCapabilityPackageModule(pkg)).resolves.toMatchObject({
      checks: [1, 2],
    });
  });

  it('uses the caller-provided error constructor for unreadable entry points', async () => {
    root = mkdtempSync(join(tmpdir(), 'opensip-capability-helper-missing-'));
    const packageDir = join(root, 'node_modules', '@acme', 'missing');
    mkdirSync(packageDir, { recursive: true });

    await expect(
      importCapabilityPackageModule({
        packageDir,
        name: '@acme/missing',
        errorConstructor: RangeError,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('reads array-shaped exports and rejects scalar exports', () => {
    expect(readCapabilityArrayExport({ checks: ['a'] }, 'checks')).toEqual(['a']);
    expect(() => readCapabilityArrayExport({ checks: 'a' }, 'checks')).toThrow(
      "capability pack export 'checks' must be an array",
    );
  });

  it('normalizes optional co-contribution export shapes', () => {
    expect(capabilityCoContributionValues(undefined, 'array')).toEqual([]);
    expect(capabilityCoContributionValues('single', 'single')).toEqual(['single']);
    expect(capabilityCoContributionValues(['a', 'b'], 'array')).toEqual(['a', 'b']);
    expect(capabilityCoContributionValues('not-array', 'array')).toEqual([]);
  });
});
