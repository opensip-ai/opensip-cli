import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { metadata } from '../index.js';

describe('@opensip-tools/checks-python metadata', () => {
  it('exposes a semver-shaped version (not the stale hardcoded literal)', () => {
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+/);
    // Guard against the previous stale hardcoded value.
    expect(metadata.version).not.toBe('0.6.1');
  });

  it('matches the package.json version (single source of truth)', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(metadata.version).toBe(pkg.version);
  });

  it('declares the canonical package name', () => {
    expect(metadata.name).toBe('@opensip-tools/checks-python');
  });
});
