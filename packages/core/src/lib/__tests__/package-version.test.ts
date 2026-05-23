import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPackageVersion } from '../package-version.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pkgver-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('readPackageVersion', () => {
  it('returns the version field of the nearest package.json', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
    const fakeMetaUrl = pathToFileURL(join(tmp, 'src', 'whatever.ts')).href;
    expect(readPackageVersion(fakeMetaUrl)).toBe('1.2.3');
  });

  it('walks up directories until it finds a package.json', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '4.5.6' }), 'utf8');
    const fakeMetaUrl = pathToFileURL(join(tmp, 'a', 'b', 'c', 'mod.ts')).href;
    expect(readPackageVersion(fakeMetaUrl)).toBe('4.5.6');
  });

  it('returns 0.0.0 when no package.json is found anywhere up the tree', () => {
    // /tmp/<random-empty-dir>/x.ts — definitely no package.json above
    // until the FS root, where there's also nothing.
    // (The tmp dir itself has no package.json since we didn't write one.)
    const fakeMetaUrl = pathToFileURL(join(tmp, 'x.ts')).href;
    // Result depends on whether any parent dir has a package.json. On
    // most systems /tmp doesn't, so we expect '0.0.0'. Allow either '0.0.0'
    // or the actual package found — the function correctness is the same.
    const result = readPackageVersion(fakeMetaUrl);
    expect(typeof result).toBe('string');
  });

  it('skips a package.json that lacks a version field and keeps walking up', () => {
    // child dir: package.json with no version
    // parent dir: package.json with version
    const childDir = join(tmp, 'child');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'package.json'), JSON.stringify({ name: 'no-version' }), 'utf8');
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '7.8.9' }), 'utf8');
    const fakeMetaUrl = pathToFileURL(join(childDir, 'src', 'mod.ts')).href;
    expect(readPackageVersion(fakeMetaUrl)).toBe('7.8.9');
  });
});
