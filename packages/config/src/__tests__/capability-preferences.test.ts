import { describe, expect, it } from 'vitest';

import { resolveCapabilityPreferences } from '../capability-preferences.js';

import type { CapabilityDiscoveryDescriptor } from '@opensip-tools/core';

// The three real domain descriptors (mirroring the engine manifests), so the
// resolver is pinned against the actual documented key shapes — no rename.
const FIT: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'fit-pack' },
  exportName: 'checks',
  exportShape: 'array',
  configKeys: { packages: 'checkPackages' },
  builtinScope: '@opensip-tools',
};

const SIM: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'name-pattern', prefix: 'scenarios-', defaultScopes: ['@opensip-tools'] },
  exportName: 'scenarios',
  exportShape: 'array',
  configKeys: {
    packages: 'scenarioPackages',
    autoDiscover: 'autoDiscoverScenarios',
    scopes: 'packageScopes',
  },
};

const GRAPH: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'graph-adapter' },
  exportName: 'adapter',
  exportShape: 'single',
  configKeys: { packages: 'graphAdapters', autoDiscover: 'autoDiscoverGraphAdapters' },
};

describe('resolveCapabilityPreferences', () => {
  it('defaults to auto-discover ON with no explicit list when the block is empty', () => {
    expect(resolveCapabilityPreferences(FIT, {})).toEqual({ autoDiscover: true });
    expect(resolveCapabilityPreferences(GRAPH, undefined)).toEqual({ autoDiscover: true });
  });

  it('reads fit checkPackages as the explicit list (marker mode, no scopes)', () => {
    const prefs = resolveCapabilityPreferences(FIT, {
      checkPackages: ['@acme/checks-x', 42, '@acme/checks-y'],
    });
    expect(prefs).toEqual({ packages: ['@acme/checks-x', '@acme/checks-y'], autoDiscover: true });
  });

  it('a present-but-empty explicit list is honored (not treated as absent)', () => {
    expect(resolveCapabilityPreferences(GRAPH, { graphAdapters: [] })).toEqual({
      packages: [],
      autoDiscover: true,
    });
  });

  it('reads graph autoDiscoverGraphAdapters:false as opt-out', () => {
    expect(resolveCapabilityPreferences(GRAPH, { autoDiscoverGraphAdapters: false })).toEqual({
      autoDiscover: false,
    });
  });

  it('a non-boolean autoDiscover value falls back to the ON default', () => {
    expect(resolveCapabilityPreferences(SIM, { autoDiscoverScenarios: 'nope' }).autoDiscover).toBe(
      true,
    );
  });

  it('sim name-pattern: no customer scopes resolves to just the default scope', () => {
    expect(resolveCapabilityPreferences(SIM, {}).scopes).toEqual(['@opensip-tools']);
  });

  it('sim name-pattern: customer packageScopes merge with the default, deduped + validated', () => {
    const prefs = resolveCapabilityPreferences(SIM, {
      packageScopes: ['@acme', '@opensip-tools', 'not-a-scope', '@beta'],
    });
    // default first, valid customer additions appended, the default deduped,
    // and the invalid "not-a-scope" dropped.
    expect(prefs.scopes).toEqual(['@opensip-tools', '@acme', '@beta']);
  });

  it('marker-mode descriptors never carry scopes', () => {
    expect(resolveCapabilityPreferences(FIT, { packageScopes: ['@acme'] }).scopes).toBeUndefined();
    expect(resolveCapabilityPreferences(GRAPH, {}).scopes).toBeUndefined();
  });

  it('explicit list + opt-out together (sim pinned set)', () => {
    const prefs = resolveCapabilityPreferences(SIM, {
      scenarioPackages: ['@acme/scenarios-load'],
      autoDiscoverScenarios: false,
    });
    expect(prefs.packages).toEqual(['@acme/scenarios-load']);
    expect(prefs.autoDiscover).toBe(false);
  });
});
