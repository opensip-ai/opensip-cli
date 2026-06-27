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
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  composeAndValidateToolConfig,
  wireCapabilityRegistry,
} from '../bootstrap/config-and-capabilities.js';

/** A minimal Tool carrying a config declaration + capability registrars. */
function makeTool(opts: {
  id: string;
  config?: NonNullable<Tool['extensionPoints']>['config'];
  capabilityRegistrars?: Record<string, CapabilityRegistrar>;
}): Tool {
  const extensionPoints = {
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.capabilityRegistrars ? { capabilityRegistrars: opts.capabilityRegistrars } : {}),
  };
  return {
    identity: { name: opts.id },
    metadata: {
      id: opts.id,
      name: opts.id,
      version: '0.0.0',
      description: opts.id,
    },
    commandSpecs: [],
    ...(Object.keys(extensionPoints).length > 0 ? { extensionPoints } : {}),
  };
}

function registryWith(tools: readonly Tool[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of tools) reg.register(tool);
  return reg;
}

const graphTool = makeTool({
  id: 'graph',
  config: {
    namespace: 'graph',
    schema: z.object({ minPackages: z.number().int().optional() }),
  },
});
const fitnessTool = makeTool({
  id: 'fitness',
  config: {
    namespace: 'fitness',
    schema: z.object({ failOnErrors: z.number().int().optional() }),
    defaults: { failOnErrors: 1 },
  },
});

const capabilityPreferenceManifest: ToolPluginManifest = {
  kind: 'tool',
  id: 'capability-owner',
  name: 'capability-owner',
  version: '0.0.0',
  apiVersion: 1,
  commands: [],
  capabilities: [
    {
      id: 'fit-pack',
      apiVersion: 1,
      minSupportedApiVersion: 1,
      contributionSchema: { requiredKeys: ['id'] },
      contributionKind: 'module-export',
      discovery: {
        discovery: { mode: 'marker', markerKind: 'fit-pack' },
        exportName: 'checks',
        exportShape: 'array',
        configKeys: { packages: 'checkPackages' },
        explicitListMode: 'augment',
      },
    },
    {
      id: 'sim-pack',
      apiVersion: 1,
      minSupportedApiVersion: 1,
      contributionSchema: { requiredKeys: ['id'] },
      contributionKind: 'module-export',
      discovery: {
        discovery: {
          mode: 'name-pattern',
          prefix: 'scenarios-',
          defaultScopes: ['@opensip-cli'],
        },
        exportName: 'scenarios',
        exportShape: 'array',
        configKeys: {
          packages: 'scenarioPackages',
          autoDiscover: 'autoDiscoverScenarios',
          scopes: 'packageScopes',
        },
      },
    },
    {
      id: 'graph-adapter',
      apiVersion: 1,
      contributionSchema: { requiredKeys: ['id'] },
      contributionKind: 'module-export',
      discovery: {
        discovery: { mode: 'marker', markerKind: 'graph-adapter' },
        exportName: 'adapter',
        exportShape: 'single',
        configKeys: {
          packages: 'graphAdapters',
          autoDiscover: 'autoDiscoverGraphAdapters',
        },
      },
    },
  ],
};

describe('composeAndValidateToolConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(body: string): string {
    const path = join(dir, 'opensip-cli.config.yml');
    writeFileSync(path, body, 'utf8');
    return path;
  }

  it('returns no config + an empty document when no tool declares config', () => {
    const result = composeAndValidateToolConfig({
      tools: registryWith([makeTool({ id: 'x' })]),
      configPath: undefined,
      env: {},
    });
    expect(result.config).toBeUndefined();
    expect(result.document).toEqual({});
  });

  it('resolves declared defaults when there is no config file', () => {
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessTool]),
      configPath: undefined,
      env: {},
    });
    expect(result.config?.fitness).toEqual({ failOnErrors: 1 });
  });

  it('reads a valid namespace block over the defaults', () => {
    const configPath = writeConfig('fitness:\n  failOnErrors: 3\n');
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessTool]),
      configPath,
      env: {},
    });
    expect(result.config?.fitness).toEqual({ failOnErrors: 3 });
  });

  // Tool identity single source: config namespace aligns with identity.name (`fitness`).
  // The layout key `fit` is not a config namespace alias.
  describe('config namespace aligns with identity.name', () => {
    it('the `fitness:` block validates against the fitness tool', () => {
      const configPath = writeConfig('fitness:\n  failOnErrors: 3\n');
      const result = composeAndValidateToolConfig({
        tools: registryWith([fitnessTool]),
        configPath,
        env: {},
      });
      expect(result.config?.fitness).toEqual({ failOnErrors: 3 });
    });

    it('does not map a `fit:` block onto the fitness tool (layout key is not a config namespace)', () => {
      const configPath = writeConfig('fit:\n  failOnErrors: 3\n');
      const result = composeAndValidateToolConfig({
        tools: registryWith([fitnessTool]),
        configPath,
        env: {},
      });
      expect(result.config?.fitness).toEqual({ failOnErrors: 1 });
      expect((result.config as { fit?: unknown }).fit).toBeUndefined();
    });
  });

  it('validates the claimed host blocks (cli/targets) and still tolerates genuinely-unknown keys', () => {
    // 2.10.1: cli + a well-formed target are now CLAIMED host declarations and
    // validate through the composed schema; a truly-unclaimed top-level key
    // still rides the document `.catchall`.
    const configPath = writeConfig(
      'cli:\n  verbose: true\ntargets:\n  app:\n    description: App\n    include: ["src/**"]\nfutureThing:\n  whatever: 1\n',
    );
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).not.toThrow();
  });

  it('strict-rejects the removed cli.recipe fallback', () => {
    const configPath = writeConfig('cli:\n  recipe: example\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('strict-rejects a malformed claimed host block (a target missing its description)', () => {
    // Previously `targets` rode the catchall untouched; 2.10.1 claims it, so a
    // target missing the required `description` now fails the composed gate.
    const configPath = writeConfig('targets:\n  app:\n    include: ["src/**"]\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('strict-validates plugins preferences declared by capability manifests', () => {
    const configPath = writeConfig(
      [
        'plugins:',
        '  fit: ["@acme/fit-pack"]',
        '  sim: ["@acme/sim-pack"]',
        '  checkPackages: ["@acme/checks"]',
        '  scenarioPackages: ["@acme/scenarios-load"]',
        '  autoDiscoverScenarios: false',
        '  packageScopes: ["@acme"]',
        '  graphAdapters: ["@acme/graph-cpp"]',
        '  autoDiscoverGraphAdapters: false',
        '',
      ].join('\n'),
    );
    const result = composeAndValidateToolConfig({
      tools: registryWith([graphTool, fitnessTool]),
      manifests: [capabilityPreferenceManifest],
      configPath,
      env: {},
    });

    expect(result.config?.plugins).toMatchObject({
      fit: ['@acme/fit-pack'],
      sim: ['@acme/sim-pack'],
      checkPackages: ['@acme/checks'],
      scenarioPackages: ['@acme/scenarios-load'],
      autoDiscoverScenarios: false,
      packageScopes: ['@acme'],
      graphAdapters: ['@acme/graph-cpp'],
      autoDiscoverGraphAdapters: false,
    });
  });

  it.each([
    ['unknown plugin key', 'plugins:\n  scenarioPackagez: ["@acme/scenarios-load"]\n'],
    ['unsupported language plugin key', 'plugins:\n  lang: ["@acme/lang-pack"]\n'],
    ['wrong explicit-list type', 'plugins:\n  graphAdapters: "@acme/graph-cpp"\n'],
    ['wrong auto-discover type', 'plugins:\n  autoDiscoverScenarios: "false"\n'],
  ])('strict-rejects malformed plugins config: %s', (_label, body) => {
    const configPath = writeConfig(body);
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        manifests: [capabilityPreferenceManifest],
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError on a typo inside any tool namespace', () => {
    const configPath = writeConfig('graph:\n  minPackges: 2\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when a config file has a non-object root', () => {
    const configPath = writeConfig('- fitness\n- graph\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('accepts reserved gate keys on any tool namespace and resolves them into tool config', () => {
    const configPath = writeConfig(
      [
        'graph:',
        '  minPackages: 2',
        '  failOnWarnings: 2',
        '  failOnDegraded: false',
        'fitness:',
        '  failOnDegraded: false',
        '',
      ].join('\n'),
    );

    const result = composeAndValidateToolConfig({
      tools: registryWith([graphTool, fitnessTool]),
      configPath,
      env: {},
    });

    expect(result.config?.graph).toMatchObject({
      minPackages: 2,
      failOnWarnings: 2,
      failOnDegraded: false,
    });
    expect(result.config?.fitness).toMatchObject({
      failOnErrors: 1,
      failOnDegraded: false,
    });
  });

  it('keeps reserved gate keys out of host namespaces', () => {
    const configPath = writeConfig('cli:\n  failOnDegraded: false\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects numeric failOnDegraded in tool namespaces', () => {
    const configPath = writeConfig('graph:\n  failOnDegraded: 0\n');
    expect(() =>
      composeAndValidateToolConfig({
        tools: registryWith([graphTool, fitnessTool]),
        configPath,
        env: {},
      }),
    ).toThrow(ConfigurationError);
  });

  // ADR-0023, Phase 4: env bindings are RESOLVED into the scope config, and (with
  // tools now reading scope.toolConfig at runtime) they are no longer no-ops. A
  // tool with env bindings mirroring the real fitness declaration proves the
  // precedence order env > file > defaults at the composition seam.
  const fitnessWithEnv = makeTool({
    id: 'fitness',
    config: {
      namespace: 'fitness',
      schema: z.object({
        failOnErrors: z.number().int().optional(),
        failOnWarnings: z.number().int().optional(),
      }),
      defaults: { failOnErrors: 1, failOnWarnings: 0 },
      env: [
        {
          envVar: 'OPENSIP_FIT_FAIL_ON_ERRORS',
          key: 'failOnErrors',
          type: 'number',
        },
        {
          envVar: 'OPENSIP_FIT_FAIL_ON_WARNINGS',
          key: 'failOnWarnings',
          type: 'number',
        },
      ],
    },
  });

  it('OPENSIP_FIT_FAIL_ON_ERRORS env overrides the file value (env > file)', () => {
    const configPath = writeConfig('fitness:\n  failOnErrors: 5\n');
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessWithEnv]),
      configPath,
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: '0' },
    });
    // env (0) beats the file (5) — this is exactly what makes the gate "never
    // fail on errors" without editing opensip-cli.config.yml.
    expect(result.config?.fitness).toMatchObject({
      failOnErrors: 0,
      failOnWarnings: 0,
    });
  });

  it('OPENSIP_FIT_FAIL_ON_WARNINGS env overrides the default (env > defaults)', () => {
    const result = composeAndValidateToolConfig({
      tools: registryWith([fitnessWithEnv]),
      configPath: undefined,
      env: { OPENSIP_FIT_FAIL_ON_WARNINGS: '1' },
    });
    // defaults say 0; env (1) wins — fail on any warning.
    expect(result.config?.fitness).toMatchObject({
      failOnErrors: 1,
      failOnWarnings: 1,
    });
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
        minSupportedApiVersion: 1,
        contributionSchema: { requiredKeys: ['id'] },
        contributionKind: 'module-export',
      },
    ],
  };
}

describe('wireCapabilityRegistry', () => {
  it('registers manifest domains then replaces the placeholder with the tool real registrar', () => {
    const real = vi.fn();
    const tool = makeTool({
      id: 'graph',
      capabilityRegistrars: { 'graph-adapter': real },
    });
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
    const tool = makeTool({
      id: 'graph',
      capabilityRegistrars: { 'undeclared-domain': real },
    });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [],
      registry: new CapabilityRegistry(),
    });
    expect(registry.hasDomain('undeclared-domain')).toBe(false);
  });

  // ADR-0054 M4-F: the host registers an EXTERNAL tool's manifest domain (pure
  // data) but does NOT install its REAL registrar in-host (running the registrar
  // is external runtime code). The domain keeps its deferred placeholder host-side.
  it('M4-F: does NOT install an EXTERNAL tool real registrar in-host (placeholder kept)', () => {
    const real = vi.fn();
    const tool = makeTool({
      id: 'ext',
      capabilityRegistrars: { 'ext-domain': real },
    });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [manifest('ext', 'ext-domain')],
      registry: new CapabilityRegistry(),
      provenance: [{ source: 'installed', id: 'ext', version: '0.0.0', manifestHash: 'h' }],
    });
    // The domain is registered (manifest data), but routing hits the THROWING
    // placeholder, not the real registrar — the host never ran the external registrar.
    expect(registry.hasDomain('ext-domain')).toBe(true);
    expect(() => registry.routeContribution('ext-domain', { id: 'x' })).toThrow();
    expect(real).not.toHaveBeenCalled();
  });

  it('M4-F: STILL installs a BUNDLED tool real registrar in-host (regression)', () => {
    const real = vi.fn();
    const tool = makeTool({
      id: 'graph',
      capabilityRegistrars: { 'graph-adapter': real },
    });
    const registry = wireCapabilityRegistry({
      tools: registryWith([tool]),
      manifests: [manifest('graph', 'graph-adapter')],
      registry: new CapabilityRegistry(),
      provenance: [{ source: 'bundled', id: 'graph', version: '0.0.0', manifestHash: 'h' }],
    });
    registry.routeContribution('graph-adapter', { id: 'ts' });
    expect(real).toHaveBeenCalledOnce();
  });
});
