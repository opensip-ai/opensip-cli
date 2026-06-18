/**
 * Unit coverage for the pure plugin domain-resolution logic: domain
 * enumeration and domain resolution (inference + rejection of arbitrary
 * strings). The pack `plugin` group is mounted under each pack-supporting
 * tool primary, so the domain is bound from that tool — there is no
 * `--domain` flag and no Tool-target auto-detection here (whole Tool plugins
 * are managed by `opensip tools …`).
 */

import { describe, expect, it } from 'vitest';

import { domainNames, resolveDomain } from '../domain-resolution.js';

import type { PluginLayout } from '@opensip-cli/core';

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
