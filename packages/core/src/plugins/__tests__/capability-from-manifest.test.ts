import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../lib/logger.js';
import {
  CapabilityRegistry,
  registerCapabilityDomainsFromManifest,
} from '../capability-registry.js';
import { admitTool, loadToolManifest } from '../manifest-loader.js';
import { MARKER_KINDS } from '../marker-discovery.js';

let testDir: string;

function writePackageManifest(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

/** A package.json with a conformant identity manifest + a `capabilities` block. */
function fixturePackageJson(capabilities: unknown): object {
  return {
    name: '@acme/audit',
    version: '1.0.0',
    opensipTools: {
      kind: 'tool',
      id: 'audit',
      identity: { name: 'audit' },
      apiVersion: 1,
      commands: [{ name: 'audit', description: 'Run audit rules' }],
      capabilities,
    },
  };
}

function loadAdmittedManifest() {
  const raw = loadToolManifest('installed', testDir);
  expect(raw).toBeDefined();
  if (raw === undefined) throw new Error('expected raw manifest');
  const result = admitTool({
    manifest: raw,
    source: 'installed',
    dir: testDir,
    explicitlyRequested: true,
  });
  expect(result.decision).toBe('admit');
  if (result.decision !== 'admit') throw new Error('expected admitted manifest');
  return result.manifest;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'capability-manifest-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadToolManifest — capabilities slot', () => {
  it('parses a well-formed capabilities array onto the manifest', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'audit-rule',
          apiVersion: 1,
          minSupportedApiVersion: 1,
          contributionSchema: { requiredKeys: ['id', 'name'] },
          contributionKind: 'module-export',
        },
      ]),
    );

    const manifest = loadToolManifest('installed', testDir);
    expect(manifest?.capabilities).toEqual([
      {
        id: 'audit-rule',
        apiVersion: 1,
        minSupportedApiVersion: 1,
        contributionSchema: { requiredKeys: ['id', 'name'] },
        contributionKind: 'module-export',
      },
    ]);
  });

  it('treats an omitted capabilities slot as no declared domains (additive)', () => {
    writePackageManifest(testDir, {
      name: '@acme/audit',
      version: '1.0.0',
      opensipTools: {
        kind: 'tool',
        id: 'audit',
        identity: { name: 'audit' },
        commands: [{ name: 'audit', description: 'Run audit rules' }],
      },
    });
    const manifest = loadToolManifest('installed', testDir);
    expect(manifest).toBeDefined();
    expect(manifest?.capabilities).toBeUndefined();
  });

  it('rejects a manifest with a malformed capabilities entry (strict, like commands)', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([{ id: 'bad', apiVersion: 1 /* missing contributionKind */ }]),
    );
    expect(loadToolManifest('installed', testDir)).toBeUndefined();
  });

  it('rejects a capability declaration missing minSupportedApiVersion', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'audit-rule',
          apiVersion: 1,
          contributionSchema: {},
          contributionKind: 'module-export',
        },
      ]),
    );
    expect(loadToolManifest('installed', testDir)).toBeUndefined();
  });

  it('rejects minSupportedApiVersion greater than apiVersion', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'audit-rule',
          apiVersion: 1,
          minSupportedApiVersion: 2,
          contributionSchema: {},
          contributionKind: 'module-export',
        },
      ]),
    );
    expect(loadToolManifest('installed', testDir)).toBeUndefined();
  });

  it('rejects an unknown contributionKind', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'x',
          apiVersion: 1,
          minSupportedApiVersion: 1,
          contributionSchema: {},
          contributionKind: 'nope',
        },
      ]),
    );
    expect(loadToolManifest('installed', testDir)).toBeUndefined();
  });

  it('rejects non-integer capability epochs (epochs are bounded integers, ADR-0074)', () => {
    for (const entry of [
      { apiVersion: 1.5, minSupportedApiVersion: 1 },
      { apiVersion: 2, minSupportedApiVersion: 1.5 },
    ]) {
      writePackageManifest(
        testDir,
        fixturePackageJson([
          {
            id: 'audit-rule',
            ...entry,
            contributionSchema: {},
            contributionKind: 'module-export',
          },
        ]),
      );
      expect(loadToolManifest('installed', testDir)).toBeUndefined();
    }
  });
});

describe('registerCapabilityDomainsFromManifest — MARKER_KINDS stays a bootstrap default', () => {
  it('registers a manifest-declared domain into the registry WITHOUT a MARKER_KINDS edit', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'audit-rule',
          apiVersion: 2,
          minSupportedApiVersion: 1,
          contributionSchema: { requiredKeys: ['id'] },
          contributionKind: 'module-export',
        },
      ]),
    );
    const manifest = loadAdmittedManifest();

    // The new domain id is NOT in the compiled marker vocabulary — proving
    // discovery is additive and not gated by the enum.
    expect((MARKER_KINDS as readonly string[]).includes('audit-rule')).toBe(false);

    const registry = new CapabilityRegistry();
    const registered = registerCapabilityDomainsFromManifest(manifest, registry);

    expect(registered).toEqual([
      {
        id: 'audit-rule',
        ownerToolId: 'audit', // stamped from manifest.id
        apiVersion: 2,
        minSupportedApiVersion: 1,
        contributionSchema: { requiredKeys: ['id'] },
        contributionKind: 'module-export',
      },
    ]);
    expect(registry.hasDomain('audit-rule')).toBe(true);
    expect(registry.getDomain('audit-rule')?.ownerToolId).toBe('audit');
    expect(registry.getDomain('audit-rule')?.minSupportedApiVersion).toBe(1);
  });

  it('emits a structured capability.domain.from_manifest evt per domain', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'd1',
          apiVersion: 1,
          minSupportedApiVersion: 1,
          contributionSchema: {},
          contributionKind: 'file',
        },
        {
          id: 'd2',
          apiVersion: 1,
          minSupportedApiVersion: 1,
          contributionSchema: {},
          contributionKind: 'manifest-entry',
        },
      ]),
    );
    const manifest = loadAdmittedManifest();
    registerCapabilityDomainsFromManifest(manifest, new CapabilityRegistry());

    const evts = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.evt === 'capability.domain.from_manifest');
    expect(evts).toHaveLength(2);
    expect(evts.map((e) => e.domainId)).toEqual(['d1', 'd2']);
    expect(evts.every((e) => e.ownerToolId === 'audit')).toBe(true);
    expect(evts.every((e) => e.minSupportedApiVersion === 1)).toBe(true);
  });

  it('registers nothing for a manifest without capabilities', () => {
    writePackageManifest(testDir, {
      name: '@acme/audit',
      version: '1.0.0',
      opensipTools: {
        kind: 'tool',
        id: 'audit',
        identity: { name: 'audit' },
        apiVersion: 1,
        commands: [{ name: 'audit', description: 'Run audit rules' }],
      },
    });
    const manifest = loadAdmittedManifest();
    const registry = new CapabilityRegistry();
    expect(registerCapabilityDomainsFromManifest(manifest, registry)).toEqual([]);
    expect(registry.listDomains()).toEqual([]);
  });

  it('routing a contribution before Phase 4 wires the real registrar throws a clear diagnostic', () => {
    writePackageManifest(
      testDir,
      fixturePackageJson([
        {
          id: 'audit-rule',
          apiVersion: 1,
          minSupportedApiVersion: 1,
          contributionSchema: {},
          contributionKind: 'module-export',
        },
      ]),
    );
    const manifest = loadAdmittedManifest();
    const registry = new CapabilityRegistry();
    registerCapabilityDomainsFromManifest(manifest, registry);

    // Schema is unconstrained ({}), so it passes validation and reaches the
    // deferred registrar, which throws until the owning tool wires its real one.
    expect(() => registry.routeContribution('audit-rule', { anything: 1 })).toThrow(
      /has not registered a runtime registrar yet/,
    );
  });
});
