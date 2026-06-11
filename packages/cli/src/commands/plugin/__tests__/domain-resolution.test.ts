/**
 * Unit coverage for the pure plugin domain-resolution logic: domain
 * enumeration, --domain resolution (inference + rejection of arbitrary
 * strings), and Tool-target detection. The `npm view` network branch of
 * detectPluginKind is exercised indirectly via isToolTarget's explicit
 * --domain shortcuts and a local-path spec (no network).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOOL_DOMAIN, domainNames, isToolTarget, resolveDomain } from '../domain-resolution.js';

import type { PluginLayout } from '@opensip-tools/core';

const layouts: readonly PluginLayout[] = [
  { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
  { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
];

describe('domainNames', () => {
  it('projects the contributed layouts to their domain names', () => {
    expect(domainNames(layouts)).toEqual(['fit', 'sim']);
  });

  it('returns an empty list for no layouts', () => {
    expect(domainNames([])).toEqual([]);
  });
});

describe('resolveDomain', () => {
  const domains = ['fit', 'sim'];

  it('honours an explicit override that is a known domain', () => {
    expect(resolveDomain('sim', '@acme/anything', domains)).toBe('sim');
  });

  it('rejects an arbitrary override string (path-traversal guard)', () => {
    expect(resolveDomain('../../etc', '@acme/anything', domains)).toBeUndefined();
  });

  it('infers the domain whose name appears as a word in the package name', () => {
    expect(resolveDomain(undefined, '@acme/sim-scenarios', domains)).toBe('sim');
  });

  it('falls back to the first declared domain when no name matches', () => {
    expect(resolveDomain(undefined, '@acme/unrelated', domains)).toBe('fit');
  });

  it('returns undefined when there are no declared domains and no override', () => {
    expect(resolveDomain(undefined, '@acme/x', [])).toBeUndefined();
  });
});

describe('isToolTarget', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-domain-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true for an explicit --domain tool', () => {
    expect(isToolTarget(TOOL_DOMAIN, '@acme/x', dir)).toBe(true);
  });

  it('is false for an explicit fit/sim --domain (no detection)', () => {
    expect(isToolTarget('fit', '@acme/x', dir)).toBe(false);
  });

  it('detects a local-path Tool plugin by its marker when no --domain given', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/audit', opensipTools: { kind: 'tool' } }),
    );
    expect(isToolTarget(undefined, '.', dir)).toBe(true);
  });

  it('is false for a local-path package with a non-tool marker', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/checks', opensipTools: { kind: 'fit-pack' } }),
    );
    expect(isToolTarget(undefined, '.', dir)).toBe(false);
  });

  it('is false for a local-path package with no marker at all', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/plain' }));
    expect(isToolTarget(undefined, '.', dir)).toBe(false);
  });
});
