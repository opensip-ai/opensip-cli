import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunScope, runWithScope } from '../../lib/run-scope.js';
import {
  type CapabilityDomainSpec,
  type CapabilityDiscoveryDescriptor,
} from '../../tools/capability.js';
import { loadCapabilityDomain } from '../capability-loader.js';
import { CapabilityRegistry } from '../capability-registry.js';

let testDir: string;

const ITEMS_DISCOVERY: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'items-pack' },
  exportName: 'items',
  exportShape: 'array',
  configKeys: { packages: 'itemPackages' },
};

/** A domain spec for the fixtures: marker-discovered `items` arrays, no host schema. */
function itemsDomain(overrides: Partial<CapabilityDomainSpec> = {}): CapabilityDomainSpec {
  return {
    id: 'items',
    ownerToolId: 'items-tool',
    apiVersion: 1,
    contributionSchema: undefined,
    contributionKind: 'module-export',
    discovery: ITEMS_DISCOVERY,
    ...overrides,
  };
}

/** Write a marker fixture package exporting `items = <source>`. */
function writeItemsPackage(name: string, source: string): void {
  const dir = join(testDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './index.mjs',
      opensipTools: { kind: 'items-pack' },
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), `export const items = ${source};\n`);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-cap-loader-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadCapabilityDomain — the live routeContribution path', () => {
  it('routes each discovered contribution through routeContribution to the owner registrar', async () => {
    writeItemsPackage('@acme/items-a', "[{ id: 'a' }, { id: 'b' }]");
    const registrar = vi.fn();
    const registry = new CapabilityRegistry();
    registry.registerDomain(itemsDomain(), registrar);

    const errors = await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });

    expect(errors).toEqual([]);
    expect(registrar).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenNthCalledWith(1, { id: 'a' });
    expect(registrar).toHaveBeenNthCalledWith(2, { id: 'b' });
    expect(registry.isDomainLoaded('items', testDir)).toBe(true);
  });

  it('memoizes per (domain, project): a second load does not re-walk or re-route', async () => {
    writeItemsPackage('@acme/items-a', "[{ id: 'a' }]");
    const registrar = vi.fn();
    const registry = new CapabilityRegistry();
    registry.registerDomain(itemsDomain(), registrar);

    await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });
    expect(registrar).toHaveBeenCalledTimes(1);

    // A new package appears, but the memoized domain is not re-walked.
    writeItemsPackage('@acme/items-b', "[{ id: 'b' }]");
    await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });
    expect(registrar).toHaveBeenCalledTimes(1);
  });

  it('a fresh registry re-loads the same project (F1: load-state is per-scope, not module-global)', async () => {
    writeItemsPackage('@acme/items-a', "[{ id: 'a' }]");

    const first = vi.fn();
    const reg1 = new CapabilityRegistry();
    reg1.registerDomain(itemsDomain(), first);
    await loadCapabilityDomain({ registry: reg1, domainId: 'items', projectDir: testDir });
    expect(first).toHaveBeenCalledTimes(1);

    // A second scope's registry has its own load-state and re-discovers.
    const second = vi.fn();
    const reg2 = new CapabilityRegistry();
    reg2.registerDomain(itemsDomain(), second);
    await loadCapabilityDomain({ registry: reg2, domainId: 'items', projectDir: testDir });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('captures a routing error (schema mismatch) without throwing; other contributions still route', async () => {
    writeItemsPackage('@acme/items-mixed', "[{ id: 'ok' }, { wrong: true }]");
    const registrar = vi.fn();
    const registry = new CapabilityRegistry();
    // Require an `id` key — the second contribution fails the host schema check.
    registry.registerDomain(
      itemsDomain({ contributionSchema: { requiredKeys: ['id'] } }),
      registrar,
    );

    const errors = await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });

    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith({ id: 'ok' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('@acme/items-mixed');
    // The captured errors are retrievable from the registry's load-state.
    expect(registry.domainLoadErrors('items')).toEqual(errors);
  });

  it('a domain with no discovery descriptor is marked loaded with no contributions', async () => {
    const registrar = vi.fn();
    const registry = new CapabilityRegistry();
    registry.registerDomain(itemsDomain({ discovery: undefined }), registrar);

    const errors = await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });

    expect(errors).toEqual([]);
    expect(registrar).not.toHaveBeenCalled();
    expect(registry.isDomainLoaded('items', testDir)).toBe(true);
  });

  it('emits a capability.<domain>.loaded diagnostics event on the scope bus', async () => {
    writeItemsPackage('@acme/items-a', "[{ id: 'a' }]");
    const registry = new CapabilityRegistry();
    registry.registerDomain(itemsDomain(), vi.fn());

    const scope = new RunScope();
    await runWithScope(scope, async () => {
      await loadCapabilityDomain({ registry, domainId: 'items', projectDir: testDir });
    });

    const loaded = scope.diagnostics
      .snapshot()
      .events.find((e) => e.phase === 'load' && e.message.includes("'items'"));
    expect(loaded).toBeDefined();
    expect(loaded?.data?.routed).toBe(1);
  });
});
