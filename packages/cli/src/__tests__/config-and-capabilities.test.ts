/**
 * Coverage for the pre-dispatch compose/validate + capability-registrar
 * wiring seam (release 2.10.0, ADR-0023 / §5.3, Phase 4 Task 4.3).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CapabilityRegistry,
  ConfigurationError,
  ToolRegistry,
  type CapabilityRegistrar,
  type Tool,
  type ToolPluginManifest,
} from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  composeAndValidateToolConfig,
  wireCapabilityRegistry,
} from '../bootstrap/config-and-capabilities.js';

/** A minimal Tool carrying a config declaration + capability registrars. */
function makeTool(opts: {
  id: string;
  config?: Tool['config'];
  capabilityRegistrars?: Record<string, CapabilityRegistrar>;
}): Tool {
  return {
    metadata: { id: opts.id, version: '0.0.0', description: opts.id },
    commands: [],
    register: () => undefined,
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.capabilityRegistrars ? { capabilityRegistrars: opts.capabilityRegistrars } : {}),
  };
}

function registryWith(tools: readonly Tool[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of tools) reg.register(tool);
  return reg;
}

const graphTool = makeTool({
  id: 'graph',
  config: { namespace: 'graph', schema: z.object({ minPackages: z.number().int().optional() }) },
});
const fitnessTool = makeTool({
  id: 'fitness',
  config: {
    namespace: 'fitness',
    schema: z.object({ failOnErrors: z.number().int().optional() }),
    defaults: { failOnErrors: 1 },
  },
});

describe('composeAndValidateToolConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(body: string): string {
    const path = join(dir, 'opensip-tools.config.yml');
    writeFileSync(path, body, 'utf8');
    return path;
  }

  it('returns undefined when no tool declares config', () => {
    const result = composeAndValidateToolConfig({
      tools: registryWith([makeTool({ id: 'x' })]),
      configPath: undefined,
      env: {},
    });
    expect(result).toBeUndefined();
  });

  it('resolves declared defaults when there is no config file', () => {
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessTool]),
      configPath: undefined,
      env: {},
    });
    expect(result?.fitness).toEqual({ failOnErrors: 1 });
  });

  it('reads a valid namespace block over the defaults', () => {
    const configPath = writeConfig('fitness:\n  failOnErrors: 3\n');
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessTool]),
      configPath,
      env: {},
    });
    expect(result?.fitness).toEqual({ failOnErrors: 3 });
  });

  it('tolerates unclaimed top-level keys (cli/targets ride the catchall)', () => {
    const configPath = writeConfig('cli:\n  recipe: example\ntargets:\n  app:\n    include: ["src/**"]\n');
    expect(() =>
      composeAndValidateToolConfig({ tools: registryWith([graphTool, fitnessTool]), configPath, env: {} }),
    ).not.toThrow();
  });

  it('throws ConfigurationError on a typo inside any tool namespace', () => {
    const configPath = writeConfig('graph:\n  minPackges: 2\n');
    expect(() =>
      composeAndValidateToolConfig({ tools: registryWith([graphTool, fitnessTool]), configPath, env: {} }),
    ).toThrow(ConfigurationError);
  });
});

/** A manifest declaring a single capability domain with a structural schema. */
function manifest(id: string, domainId: string): ToolPluginManifest {
  return {
    kind: 'tool',
    id,
    name: id,
    version: '0.0.0',
    commands: [],
    capabilities: [
      {
        id: domainId,
        apiVersion: 1,
        contributionSchema: { requiredKeys: ['id'] },
        contributionKind: 'module-export',
      },
    ],
  };
}

describe('wireCapabilityRegistry', () => {
  it('registers manifest domains then replaces the placeholder with the tool real registrar', () => {
    const real = vi.fn();
    const tool = makeTool({ id: 'graph', capabilityRegistrars: { 'graph-adapter': real } });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [manifest('graph', 'graph-adapter')],
      registry: new CapabilityRegistry(),
    });

    expect(registry.hasDomain('graph-adapter')).toBe(true);
    // routeContribution reaches the REAL registrar, not the deferred placeholder
    // (which would throw a SystemError).
    registry.routeContribution('graph-adapter', { id: 'ts' });
    expect(real).toHaveBeenCalledOnce();
    expect(real).toHaveBeenCalledWith({ id: 'ts' });
  });

  it('routing a manifest domain with no real registrar still hits the throwing placeholder', () => {
    // A tool declares a domain but supplies no registrar → the deferred
    // placeholder remains and throws on a routed contribution.
    const tool = makeTool({ id: 'graph' });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [manifest('graph', 'graph-adapter')],
      registry: new CapabilityRegistry(),
    });
    expect(() => registry.routeContribution('graph-adapter', { id: 'ts' })).toThrow();
  });

  it('skips a registrar whose domain was not declared in any manifest', () => {
    const real = vi.fn();
    const tool = makeTool({ id: 'graph', capabilityRegistrars: { 'undeclared-domain': real } });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [],
      registry: new CapabilityRegistry(),
    });
    expect(registry.hasDomain('undeclared-domain')).toBe(false);
  });
});
