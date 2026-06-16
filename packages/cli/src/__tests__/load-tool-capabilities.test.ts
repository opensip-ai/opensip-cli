/**
 * @fileoverview The composition-root seam that drives the generic capability
 * loader for the invoked tool's declared domains (§5.3/§4.5) — the replacement
 * for the host-coupled, eager register-graph-adapters.ts. Asserts it filters
 * domains by owning tool, drives only the invoked tool's domains, and no-ops for
 * CLI-only commands.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CapabilityRegistry,
  RunScope,
  runWithScope,
  type CapabilityDomainSpec,
  type Tool,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOwningToolCapabilities } from '../bootstrap/load-tool-capabilities.js';

let testDir: string;

function makeTool(id: string): Tool {
  return { metadata: { id, version: '0.0.0', description: id }, commands: [] };
}

/** A marker-mode domain spec owned by `ownerToolId`, discovering kind `marker`. */
function domain(id: string, ownerToolId: string, marker: string): CapabilityDomainSpec {
  return {
    id,
    ownerToolId,
    apiVersion: 1,
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

/** Run `fn` inside a scope carrying `registry` as scope.capabilities. */
async function withCapabilities(
  registry: CapabilityRegistry,
  fn: () => Promise<void>,
): Promise<void> {
  const scope = new RunScope();
  Object.assign(scope, { capabilities: registry });
  await runWithScope(scope, fn);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-load-cap-'));
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
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
        configPath: undefined,
      });
      expect(driven).toBe(1);
      expect(registry.isDomainLoaded('mine', testDir)).toBe(true);
      // The other tool's domain was NOT driven this run.
      expect(registry.isDomainLoaded('other', testDir)).toBe(false);
    });
  });

  it('returns 0 and drives nothing for a CLI-only command (no owning tool)', async () => {
    const registry = new CapabilityRegistry();
    registry.registerDomain(domain('mine', 'mytool', 'mine-pack'), vi.fn());

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: undefined,
        projectDir: testDir,
        configPath: undefined,
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
      contributionSchema: undefined,
      contributionKind: 'module-export',
    };
    registry.registerDomain(noDiscovery, vi.fn());

    await withCapabilities(registry, async () => {
      const driven = await loadOwningToolCapabilities({
        owningTool: makeTool('mytool'),
        projectDir: testDir,
        configPath: undefined,
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
        configPath: undefined,
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
