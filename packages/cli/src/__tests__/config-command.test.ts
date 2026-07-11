/**
 * Coverage for `opensip config validate|schema|migrate`.
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
  RunScope,
  ToolRegistry,
  runWithScope,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildConfigDeclarations } from '../bootstrap/config-declarations.js';
import { registerFirstPartyTools } from '../bootstrap/register-tools.js';
import { executeConfigMigrate } from '../commands/config-migrate.js';
import { executeConfigSchema, executeConfigValidate } from '../commands/config.js';
import { buildConfigGroupLeaves } from '../commands/host-subcommand-config.js';
import { buildHostCommandInventory } from '../commands/host-subcommand-groups.js';

import type { CliCommandsContext } from '../commands/shared.js';

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

function makeConfigContext(overrides: Partial<CliCommandsContext> = {}): CliCommandsContext {
  return {
    setExitCode: (code) => {
      void code;
    },
    render: () => Promise.resolve(),
    emitJson: () => undefined,
    emitRaw: () => undefined,
    emitError: () => undefined,
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => undefined,
    ...overrides,
  };
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

describe('executeConfigMigrate', () => {
  it('writes the migrated config by default', () => {
    const configPath = join(dir, 'opensip-cli.config.yml');
    writeFileSync(configPath, 'targets: {}\n', 'utf8');

    const result = executeConfigMigrate({ configPath, cwd: dir });

    expect(result).toMatchObject({
      type: 'config-migrate',
      configPath,
      changed: true,
      dryRun: false,
      check: false,
      wrote: true,
      fromVersion: 1,
      targetVersion: 1,
    });
    expect(result.operations[0]?.kind).toBe('add-schema-version');
    expect(readFileSync(configPath, 'utf8')).toContain('schemaVersion: 1');
  });

  it('supports dry-run without writing', () => {
    const configPath = join(dir, 'opensip-cli.config.yml');
    const original = 'targets: {}\n';
    writeFileSync(configPath, original, 'utf8');

    const result = executeConfigMigrate({ configPath, cwd: dir, dryRun: true });

    expect(result.changed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.wrote).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('treats --check as a dry-run result', () => {
    const configPath = join(dir, 'opensip-cli.config.yml');
    writeFileSync(configPath, 'targets: {}\n', 'utf8');

    const result = executeConfigMigrate({ configPath, cwd: dir, check: true });

    expect(result.changed).toBe(true);
    expect(result.check).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.wrote).toBe(false);
  });

  it('falls back to cwd/opensip-cli.config.yml when no config path is provided', () => {
    const configPath = join(dir, 'opensip-cli.config.yml');

    const result = executeConfigMigrate({ configPath: undefined, cwd: dir });

    expect(result.changed).toBe(false);
    expect(result.configPath).toBe(configPath);
  });
});

describe('host config group inventory', () => {
  it('includes config validate, config schema, and config migrate', () => {
    const inventory = buildHostCommandInventory();
    expect(inventory.groupSubcommands.config).toEqual(['validate', 'schema', 'migrate']);
  });
});

describe('config command specs', () => {
  it('routes validate, schema, and migrate through their shared command base', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const ctx = makeConfigContext({ tools, manifests, provenance });
    const [validate, schema, migrate] = buildConfigGroupLeaves(ctx);
    const configPath = join(dir, 'opensip-cli.config.yml');
    const projectContext = { scope: 'project' as const, projectRoot: dir, configPath };

    const valid = await validate.handler({ projectContext }, ctx);
    expect(valid).toMatchObject({ type: 'config-validate', valid: true });

    const schemaOut = join(dir, 'schema-from-spec.json');
    const schemaResult = await schema.handler({ projectContext, out: schemaOut }, ctx);
    expect(schemaResult).toMatchObject({ type: 'config-schema', outPath: schemaOut });
    expect(readFileSync(schemaOut, 'utf8')).toContain('"fitness"');

    writeFileSync(configPath, 'targets: {}\n', 'utf8');
    const exitCodes: number[] = [];
    const migrateCtx = makeConfigContext({
      tools,
      manifests,
      provenance,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    });
    const migrated = await migrate.handler({ projectContext, check: true }, migrateCtx);
    expect(migrated).toMatchObject({ type: 'config-migrate', check: true, changed: true });
    expect(exitCodes).toEqual([2]);
  });

  it('falls back to the entered scope for tool registries and rejects missing registries', async () => {
    const { tools, manifests, provenance } = await makeRegistry();
    const [validate] = buildConfigGroupLeaves(makeConfigContext());
    const scope = new RunScope({
      tools,
      toolManifests: manifests,
      toolProvenance: provenance,
      projectContext: {
        cwd: dir,
        cwdExplicit: false,
        scope: 'project',
        projectRoot: dir,
        configPath: join(dir, 'opensip-cli.config.yml'),
        walkedUp: 0,
      },
    });

    const valid = await runWithScope(scope, () =>
      Promise.resolve(validate.handler({ cwd: dir }, makeConfigContext())),
    );
    expect(valid).toMatchObject({ type: 'config-validate', valid: true });

    expect(() => validate.handler({ cwd: dir }, makeConfigContext())).toThrow(/tool registry/);
  });
});
