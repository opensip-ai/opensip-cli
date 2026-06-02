import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPackageGroupMap } from '../workspace-package-map.js';

let root: string;

function writePkg(relDir: string, name: string): void {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-wpm-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildPackageGroupMap', () => {
  it('maps each package name to its first-segment group (one and two levels deep)', () => {
    writePkg('packages/core', '@scope/core');
    writePkg('packages/fitness/engine', '@scope/fitness');
    writePkg('packages/fitness/checks-typescript', '@scope/checks-typescript');
    writePkg('packages/languages/lang-typescript', '@scope/lang-typescript');

    const map = buildPackageGroupMap(root);
    expect(map.get('@scope/core')).toBe('core');
    expect(map.get('@scope/fitness')).toBe('fitness');
    expect(map.get('@scope/checks-typescript')).toBe('fitness'); // grouped under fitness
    expect(map.get('@scope/lang-typescript')).toBe('languages');
  });

  it('returns an empty map when there is no packages/ directory', () => {
    expect(buildPackageGroupMap(root).size).toBe(0);
  });

  it('skips directories without a readable package.json name', () => {
    writePkg('packages/core', '@scope/core');
    mkdirSync(join(root, 'packages/empty-dir'), { recursive: true }); // no package.json
    writeFileSync(join(root, 'packages/core/extra.txt'), 'x', 'utf8'); // non-dir entry ignored

    const map = buildPackageGroupMap(root);
    expect(map.size).toBe(1);
    expect(map.get('@scope/core')).toBe('core');
  });

  it('skips a package.json whose name is missing or not a string', () => {
    const dir = join(root, 'packages/nameless');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
    expect(buildPackageGroupMap(root).size).toBe(0);
  });
});
