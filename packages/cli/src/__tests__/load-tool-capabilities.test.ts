/**
 * @fileoverview The composition-root seam that drives the generic capability
 * loader for the invoked tool's declared domains (§5.3/§4.5) — the replacement
 * for the host-coupled, eager register-graph-adapters.ts. Asserts it filters
 * domains by owning tool, drives only the invoked tool's domains, and no-ops for
 * CLI-only commands.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHash } from 'node:crypto';

import { BUILTIN_TRUST_POLICY, type ResolvedTrustPolicy } from '@opensip-cli/config';
import {
  CapabilityRegistry,
  RunScope,
  logger,
  runWithScope,
  type CapabilityIsolationBridge,
  type CapabilityDomainSpec,
  type Tool,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOwningToolCapabilities } from '../bootstrap/load-tool-capabilities.js';

/** The manifest hash the discovery layer stamps: sha256 of the opensipTools block. */
function manifestHashOf(block: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(block)).digest('hex')}`;
}

/** A resolved policy carrying operator capability-trust grants (user tier). */
function policyWithGrants(
  grants: readonly { id: string; manifestHash: string }[],
): ResolvedTrustPolicy {
  return { ...BUILTIN_TRUST_POLICY, capabilityGrants: grants };
}

let testDir: string;

function makeTool(id: string): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: id },
    commands: [],
  };
}

/** A marker-mode domain spec owned by `ownerToolId`, discovering kind `marker`. */
function domain(id: string, ownerToolId: string, marker: string): CapabilityDomainSpec {
  return {
    id,
    ownerToolId,
    apiVersion: 1,
    minSupportedApiVersion: 1,
    contributionSchema: undefined,
    contributionKind: 'module-export',
    discovery: {
      discovery: { mode: 'marker', markerKind: marker },
      exportName: 'adapter',
      exportShape: 'single',
      configKeys: { packages: 'pkgs' },
    },
  };
}

/** Write an explicit capability package that has no discovery marker. */
function writeExplicitAdapterPackage(
  name: string,
  exportSource: string,
  targetDomain = 'mine',
): void {
  const dir = join(testDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './index.mjs',
      opensipTools: {
        targetDomain,
        targetDomainApiVersion: 1,
      },
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), `export const adapter = ${exportSource};\n`);
}

/** Write a marker-discovered package whose module would throw if imported. */
function writeThrowingMarkedAdapterPackage(
  name: string,
  markerKind: string,
  targetDomain = 'mine',
): void {
  const dir = join(testDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './index.mjs',
      opensipTools: {
        kind: markerKind,
        targetDomain,
        targetDomainApiVersion: 1,
      },
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), "throw new Error('must not import denied pack');\n");
}

function writeWorkerAdapterPackage(name: string): void {
  const dir = join(testDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './index.mjs',
      opensipTools: {
        targetDomain: 'mine',
        targetDomainApiVersion: 1,
        requires: [{ resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' }],
      },
    }),
  );
  writeFileSync(join(dir, 'index.mjs'), "throw new Error('must not import in host');\n");
}

/** Run `fn` inside a scope carrying `registry` as scope.capabilities. */
async function withCapabilities(
  registry: CapabilityRegistry,
  fn: () => Promise<void>,
  trustPolicy?: ResolvedTrustPolicy,
): Promise<void> {
  const scope = new RunScope(trustPolicy === undefined ? {} : { trustPolicy });
  Object.assign(scope, { capabilities: registry });
  await runWithScope(scope, fn);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-load-cap-'));
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadOwningToolCapabilities', () => {
  it("drives only the invoked tool's declared domains", async () => {
    const registry = new CapabilityRegistry();
    const mine = vi.fn();
    const other = vi.fn();
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), mine);
    registry.registerDomain(domain('other', 'othertool', 'other-pack'), other);

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('mytool'),
        projectDir: testDir, // empty → 0 packages discovered, but the domain is driven + marked loaded
        pluginsConfig: {},
      });
      expect(driven).toBe(1);
      expect(registry.isDomainLoaded('mine', testDir)).toBe(true);
      // The other tool's domain was NOT driven this run.
      expect(registry.isDomainLoaded('other', testDir)).toBe(false);
    });
  });

  it('denies a pack referenced only by the analyzed-repo config (config selects, never trusts)', async () => {
    // Plan 09 Phase 3: the analyzed repo's own `plugins.<domain>` entry must
    // not be admitted as operator intent — that inverts the trust direction
    // for a tool whose job is analyzing code it does not trust.
    const registry = new CapabilityRegistry();
    const registrar = vi.fn();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), registrar);
    writeExplicitAdapterPackage('@acme/configured-adapter', "{ id: 'from-config' }");

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('mytool'),
        projectDir: testDir,
        pluginsConfig: { pkgs: ['@acme/configured-adapter'] },
      });

      expect(driven).toBe(1);
      expect(registrar).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'cli.capability.trust_denied',
          packageName: '@acme/configured-adapter',
          grantPresent: false,
        }),
      );
    });
  });

  it('admits a config-selected pack whose user-level grant matches the resolved provenance', async () => {
    const registry = new CapabilityRegistry();
    const registrar = vi.fn();
    const workerBridge: CapabilityIsolationBridge = {
      createHostContributions: vi.fn(() =>
        Promise.resolve([{ contribution: { id: 'from-config' } }]),
      ),
      runInWorker: vi.fn(),
    };
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), registrar);
    writeExplicitAdapterPackage('@acme/configured-adapter', "{ id: 'from-config' }");
    const grants = [
      {
        id: '@acme/configured-adapter',
        manifestHash: manifestHashOf({ targetDomain: 'mine', targetDomainApiVersion: 1 }),
      },
    ];

    await withCapabilities(
      registry,
      async () => {
        const driven = await loadOwningToolCapabilities({
          owningTool: {
            ...makeTool('mytool'),
            extensionPoints: { capabilityIsolationBridges: { mine: workerBridge } },
          },
          projectDir: testDir,
          pluginsConfig: { pkgs: ['@acme/configured-adapter'] },
        });

        expect(driven).toBe(1);
        expect(workerBridge.createHostContributions).toHaveBeenCalledTimes(1);
        expect(registrar).toHaveBeenCalledTimes(1);
        expect(registrar).toHaveBeenCalledWith({ id: 'from-config' });
      },
      policyWithGrants(grants),
    );
  });

  it('denies a granted name whose resolved provenance differs (shadowed pack)', async () => {
    const registry = new CapabilityRegistry();
    const registrar = vi.fn();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), registrar);
    writeExplicitAdapterPackage('@acme/configured-adapter', "{ id: 'from-config' }");
    const staleGrant = [
      { id: '@acme/configured-adapter', manifestHash: `sha256:${'0'.repeat(64)}` },
    ];

    await withCapabilities(
      registry,
      async () => {
        const driven = await loadOwningToolCapabilities({
          owningTool: makeTool('mytool'),
          projectDir: testDir,
          pluginsConfig: { pkgs: ['@acme/configured-adapter'] },
        });

        expect(driven).toBe(1);
        expect(registrar).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            evt: 'cli.capability.trust_denied',
            packageName: '@acme/configured-adapter',
            grantPresent: true,
            provenanceMatched: false,
          }),
        );
      },
      policyWithGrants(staleGrant),
    );
  });

  it('routes worker-admitted external packages through the owning tool isolation bridge', async () => {
    const registry = new CapabilityRegistry();
    const registrar = vi.fn();
    const createHostContributions = vi.fn((context) => {
      expect(context.domainId).toBe('mine');
      expect(context.pkg.name).toBe('@acme/worker-adapter');
      expect(context.pkg.packageRequires).toEqual([
        { resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' },
      ]);
      expect(context.resourceDecision).toMatchObject({
        isolation: 'worker',
        allowedResources: [{ resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' }],
        denyUndeclared: true,
      });
      return Promise.resolve([{ contribution: { id: 'from-worker-proxy' } }]);
    }) satisfies CapabilityIsolationBridge['createHostContributions'];
    const workerBridge: CapabilityIsolationBridge = {
      createHostContributions,
      runInWorker: vi.fn(),
    };
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), registrar);
    writeWorkerAdapterPackage('@acme/worker-adapter');
    const grants = [
      {
        id: '@acme/worker-adapter',
        manifestHash: manifestHashOf({
          targetDomain: 'mine',
          targetDomainApiVersion: 1,
          requires: [{ resource: 'env', scope: 'OPENAI_API_KEY', reason: 'fixture auth' }],
        }),
      },
    ];

    await withCapabilities(
      registry,
      async () => {
        const driven = await loadOwningToolCapabilities({
          owningTool: {
            ...makeTool('mytool'),
            extensionPoints: { capabilityIsolationBridges: { mine: workerBridge } },
          },
          projectDir: testDir,
          pluginsConfig: { pkgs: ['@acme/worker-adapter'] },
        });

        expect(driven).toBe(1);
        expect(createHostContributions).toHaveBeenCalledTimes(1);
        expect(registrar).toHaveBeenCalledWith({ id: 'from-worker-proxy' });
      },
      policyWithGrants(grants),
    );
  });

  it('denies an unlisted marker-discovered capability pack before import (no grant)', async () => {
    const registry = new CapabilityRegistry();
    const registrar = vi.fn();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), registrar);
    writeThrowingMarkedAdapterPackage('@acme/denied-adapter', 'mine-pack');

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('mytool'),
        projectDir: testDir,
        pluginsConfig: {},
      });

      expect(driven).toBe(1);
      expect(registrar).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'cli.capability.trust_denied',
          packageName: '@acme/denied-adapter',
          grantPresent: false,
        }),
      );
    });
  });

  it('returns 0 and drives nothing for a CLI-only command (no owning tool)', async () => {
    const registry = new CapabilityRegistry();
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), vi.fn());

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: undefined,
        projectDir: testDir,
        pluginsConfig: {},
      });
      expect(driven).toBe(0);
      expect(registry.isDomainLoaded('mine', testDir)).toBe(false);
    });
  });

  it('skips a domain with no discovery descriptor (counts only driven domains)', async () => {
    const registry = new CapabilityRegistry();
    const noDiscovery: CapabilityDomainSpec = {
      id: 'nodisco',
      ownerToolId: 'mytool',
      apiVersion: 1,
      minSupportedApiVersion: 1,
      contributionSchema: undefined,
      contributionKind: 'module-export',
    };
    registry.registerDomain(noDiscovery, vi.fn());

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('mytool'),
        projectDir: testDir,
        pluginsConfig: {},
      });
      expect(driven).toBe(0);
    });
  });
});

/** Task 4: Capability-Wiring Diagnostics (build-per-run-scope + pre-action-hook + load seam).
 * Diagnostics must surface enough to debug "owning tool's capability domain did not load":
 *  - domains wired (buildPerRunScope)
 *  - owning tool domains driven + contribution counts (pre-action after loadOwning...)
 *  - load errors per-domain (emitted by the generic loader, ride on scope bus)
 * The return value of load + registry.isDomainLoaded + scope.diagnostics.snapshot() give the picture.
 */
describe('capability wiring diagnostics contract (Task 4)', () => {
  it('returns driven count; callers (pre-action) record capabilities.driven + per-domain events for debuggability', async () => {
    const registry = new CapabilityRegistry();
    const driver = vi.fn();
    registry.registerDomain(domain('d1', 'tool-a', 'pack-a'), driver);

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('tool-a'),
        projectDir: testDir,
        pluginsConfig: {},
      });
      expect(driven).toBe(1);
      // The pre-action-hook then does:
      // scope.diagnostics.event('load', 'debug', `drove ${driven} owning-tool capability domain(s)...`)
      // scope.diagnostics.counter('capabilities.driven', driven)
      // plus per-domain 'capability ... loaded' events from inside the generic loader.
      // build-per-run-scope records the 'wired' count + 'contribute' counts upstream.
      expect(registry.isDomainLoaded('d1', testDir)).toBe(true);
    });
  });
});
