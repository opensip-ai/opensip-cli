/**
 * Coverage for `opensip config validate|schema`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeNamespaceClaims,
  partitionUnclaimedNamespaces,
  type NamespaceClaimReport,
  type ToolConfigDeclaration,
} from '@opensip-cli/config';
import {
  ConfigurationError,
  ToolRegistry,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildConfigDeclarations } from '../bootstrap/config-declarations.js';
import { registerFirstPartyTools } from '../bootstrap/register-tools.js';
import { executeConfigSchema, executeConfigValidate } from '../commands/config.js';
import { buildHostCommandInventory } from '../commands/host-subcommand-groups.js';

async function makeRegistry(): Promise<{
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly provenance: readonly ToolProvenance[];
}> {
  const tools = new ToolRegistry();
  const manifests: ToolPluginManifest[] = [];
  const provenance: ToolProvenance[] = [];
  await registerFirstPartyTools(tools, provenance, manifests);
  return { tools, manifests, provenance };
}

let dir: string;

function makeTool(id: string, withConfig = false): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: id },
    commandSpecs: [],
    ...(withConfig
      ? {
          extensionPoints: {
            config: {
              namespace: id,
              schema: z.object({ enabled: z.boolean().optional() }),
            },
          },
        }
      : {}),
  };
}

function registryWith(tools: readonly Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

/**
 * @throws Error when the two serialized verdicts differ.
 */
function assertSameVerdict<T>(label: string, left: T, right: T): void {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson !== rightJson) {
    throw new Error(
      `${label}: verdict mismatch\nleft: ${leftJson ?? '<undefined>'}\nright: ${rightJson ?? '<undefined>'}`,
    );
  }
}

interface UnclaimedNamespaceVerdictScenario {
  readonly label: string;
  readonly declarations: readonly ToolConfigDeclaration[];
  readonly document: unknown;
  readonly loadedToolNames: ReadonlySet<string>;
  readonly validate: () => { readonly warnings?: readonly string[] };
}

interface NamespaceVerdict {
  readonly kind: 'throws' | 'warns';
  readonly namespaces: readonly string[];
}

function summarizePreDispatch(
  report: NamespaceClaimReport,
  loadedToolNames: ReadonlySet<string>,
): NamespaceVerdict {
  const { toolBugs, benign } = partitionUnclaimedNamespaces(report, loadedToolNames);
  if (toolBugs.length > 0) {
    return {
      kind: 'throws',
      namespaces: toolBugs.map((u) => u.namespace).sort(),
    };
  }
  return { kind: 'warns', namespaces: benign.map((u) => u.namespace).sort() };
}

function summarizeValidate(run: () => { readonly warnings?: readonly string[] }): NamespaceVerdict {
  try {
    const result = run();
    return {
      kind: 'warns',
      namespaces: (result.warnings ?? [])
        .map((warning) => /'([^']+):'/.exec(warning)?.[1])
        .filter((namespace): namespace is string => namespace !== undefined)
        .sort(),
    };
  } catch (error) {
    return {
      kind: 'throws',
      namespaces:
        error instanceof Error
          ? [...error.message.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '').sort()
          : [],
    };
  }
}

function assertSameUnclaimedVerdict(scenario: UnclaimedNamespaceVerdictScenario): void {
  const report = analyzeNamespaceClaims(scenario.declarations, scenario.document);
  assertSameVerdict(
    scenario.label,
    summarizeValidate(scenario.validate),
    summarizePreDispatch(report, scenario.loadedToolNames),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-cmd-'));
  writeFileSync(
    join(dir, 'opensip-cli.config.yml'),
    ['schemaVersion: 1', 'fitness:', '  failOnErrors: 1', 'graph:', '  recipe: default'].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('executeConfigValidate', () => {
  it('accepts a valid project config', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const result = executeConfigValidate({
      tools,
      manifests,
      provenance,
      configPath: join(dir, 'opensip-cli.config.yml'),
      cwd: dir,
    });
    expect(result).toMatchObject({
      type: 'config-validate',
      valid: true,
      configPath: join(dir, 'opensip-cli.config.yml'),
    });
    expect(result.namespaces).toEqual(expect.arrayContaining(['fitness', 'graph', 'cli']));
  });

  it('validates an empty document when no config path is provided', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const result = executeConfigValidate({
      tools,
      manifests,
      provenance,
      configPath: undefined,
      cwd: dir,
    });
    expect(result.valid).toBe(true);
    expect(result.configPath).toBe(join(dir, 'opensip-cli.config.yml'));
  });

  it('suggests a nearby namespace for a near-miss unclaimed key', async () => {
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      'fitness:\n  failOnErrors: 1\nfitnes:\n  enabled: true\n',
      'utf8',
    );
    const { tools, manifests, provenance } = await makeRegistry();
    const result = executeConfigValidate({
      tools,
      manifests,
      provenance,
      configPath: join(dir, 'opensip-cli.config.yml'),
      cwd: dir,
    });
    expect(result.warnings?.join('\n')).toMatch(/did you mean 'fitness:'/);
  });

  it('throws ConfigurationError for a typo inside a claimed namespace', async () => {
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      'fitness:\n  failOnErrors: 1\n  typoKey: true\n',
      'utf8',
    );
    const { tools, manifests, provenance } = await makeRegistry();
    expect(() =>
      executeConfigValidate({
        tools,
        manifests,
        provenance,
        configPath: join(dir, 'opensip-cli.config.yml'),
        cwd: dir,
      }),
    ).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError for a non-object config document root', async () => {
    writeFileSync(join(dir, 'opensip-cli.config.yml'), '- fitness\n- graph\n', 'utf8');
    const { tools, manifests, provenance } = await makeRegistry();
    expect(() =>
      executeConfigValidate({
        tools,
        manifests,
        provenance,
        configPath: join(dir, 'opensip-cli.config.yml'),
        cwd: dir,
      }),
    ).toThrow(ConfigurationError);
  });

  it('passes through an unclaimed top-level namespace with a warning', async () => {
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      'fitness:\n  failOnErrors: 1\nacme-audit:\n  enabled: true\n',
      'utf8',
    );
    const { tools, manifests, provenance } = await makeRegistry();
    const result = executeConfigValidate({
      tools,
      manifests,
      provenance,
      configPath: join(dir, 'opensip-cli.config.yml'),
      cwd: dir,
    });
    expect(result.warnings?.join('\n')).toContain('acme-audit');
  });

  it('throws when an unclaimed namespace matches a loaded tool with no config contribution', () => {
    const tools = registryWith([makeTool('configured', true), makeTool('no-config-tool')]);
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      'configured:\n  enabled: true\nno-config-tool:\n  enabled: true\n',
      'utf8',
    );

    expect(() =>
      executeConfigValidate({
        tools,
        configPath: join(dir, 'opensip-cli.config.yml'),
        cwd: dir,
      }),
    ).toThrow(ConfigurationError);
  });

  it('reaches the same unclaimed-namespace verdict as the pre-dispatch policy', () => {
    const tools = registryWith([makeTool('configured', true), makeTool('no-config-tool')]);
    const { declarations } = buildConfigDeclarations({ tools });
    const configPath = join(dir, 'opensip-cli.config.yml');

    writeFileSync(configPath, 'configured:\n  enabled: true\nacme-audit:\n  enabled: true\n');
    expect(() =>
      assertSameUnclaimedVerdict({
        label: 'unknown namespace warns',
        declarations,
        document: {
          configured: { enabled: true },
          'acme-audit': { enabled: true },
        },
        loadedToolNames: new Set(tools.list().map((tool) => tool.metadata.name)),
        validate: () => executeConfigValidate({ tools, configPath, cwd: dir }),
      }),
    ).not.toThrow();

    writeFileSync(configPath, 'configured:\n  enabled: true\nno-config-tool:\n  enabled: true\n');
    expect(() =>
      assertSameUnclaimedVerdict({
        label: 'loaded no-config namespace throws',
        declarations,
        document: {
          configured: { enabled: true },
          'no-config-tool': { enabled: true },
        },
        loadedToolNames: new Set(tools.list().map((tool) => tool.metadata.name)),
        validate: () => executeConfigValidate({ tools, configPath, cwd: dir }),
      }),
    ).not.toThrow();
  });
});

describe('executeConfigSchema', () => {
  it('returns a schema with bundled tool namespaces and no absolute paths', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const result = executeConfigSchema({
      tools,
      manifests,
      provenance,
      configPath: join(dir, 'opensip-cli.config.yml'),
      cwd: dir,
    });
    expect(result.type).toBe('config-schema');
    expect(result.namespaces).toEqual(expect.arrayContaining(['fitness', 'graph']));
    expect(JSON.stringify(result.schema)).not.toMatch(dir);
    expect(result.schema).toHaveProperty('properties.fitness');
  });

  it('writes --out to the requested file and rejects directory targets', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const outFile = join(dir, 'schema.json');
    const result = executeConfigSchema({
      tools,
      manifests,
      provenance,
      configPath: join(dir, 'opensip-cli.config.yml'),
      cwd: dir,
      outPath: 'schema.json',
    });
    expect(result.outPath).toBe(outFile);
    expect(readFileSync(outFile, 'utf8')).toContain('"fitness"');

    mkdirSync(join(dir, 'schema-dir'));
    expect(() =>
      executeConfigSchema({
        tools,
        manifests,
        provenance,
        configPath: join(dir, 'opensip-cli.config.yml'),
        cwd: dir,
        outPath: 'schema-dir',
      }),
    ).toThrow(ConfigurationError);
    expect(statSync(join(dir, 'schema-dir')).isDirectory()).toBe(true);
  });
});

describe('host config group inventory', () => {
  it('includes config validate and config schema', () => {
    const inventory = buildHostCommandInventory();
    expect(inventory.groupSubcommands.config).toEqual(['validate', 'schema']);
  });
});
