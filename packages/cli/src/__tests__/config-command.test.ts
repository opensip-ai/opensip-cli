/**
 * Coverage for `opensip config validate|schema`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, ToolRegistry } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerFirstPartyTools } from '../bootstrap/register-tools.js';
import { executeConfigSchema, executeConfigValidate } from '../commands/config.js';
import { buildHostCommandInventory } from '../commands/host-subcommand-groups.js';

import type { ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

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
