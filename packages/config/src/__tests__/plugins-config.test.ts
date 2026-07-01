import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import { composeConfigSchema } from '../composer.js';
import { hostConfigDeclarations } from '../document/host-declarations.js';
import {
  createPluginsConfigSchema,
  type PluginConfigKeyDeclaration,
  type PluginsConfig,
} from '../document/targeting.js';

import type { ToolPluginManifest } from '@opensip-cli/core';

function manifestWithPluginKeys(keys: PluginConfigKeyDeclaration[]): readonly ToolPluginManifest[] {
  return [
    {
      id: 'new-tool',
      apiVersion: 1,
      capabilities: [
        {
          id: 'new-cap',
          apiVersion: 1,
          contributionKind: 'module-export',
          discovery: {
            discovery: { mode: 'marker', markerKind: 'new-marker' },
            exportName: 'items',
            exportShape: 'array',
            configKeys: {
              packages: keys.find((k) => k.kind === 'packages')?.key,
              autoDiscover: keys.find((k) => k.kind === 'autoDiscover')?.key,
              scopes: keys.find((k) => k.kind === 'scopes')?.key,
            },
          },
        },
      ],
    },
  ];
}

describe('PluginsConfig — schema-driven extension', () => {
  it('accepts manifest-declared plugin keys via createPluginsConfigSchema', () => {
    const keys: PluginConfigKeyDeclaration[] = [
      { key: 'newToolPackages', kind: 'packages' },
      { key: 'autoDiscoverNewTool', kind: 'autoDiscover' },
    ];
    const schema = createPluginsConfigSchema(keys);
    const parsed = schema.parse({
      fit: ['@acme/fit-pack'],
      newToolPackages: ['@acme/new-tool'],
      autoDiscoverNewTool: false,
    });
    expect(parsed).toEqual({
      fit: ['@acme/fit-pack'],
      newToolPackages: ['@acme/new-tool'],
      autoDiscoverNewTool: false,
    });
  });

  it('rejects unknown plugin keys when the composed schema is strict', () => {
    const keys: PluginConfigKeyDeclaration[] = [{ key: 'newToolPackages', kind: 'packages' }];
    const schema = composeConfigSchema(
      hostConfigDeclarations({ pluginConfigKeys: keys }).filter((d) => d.namespace === 'plugins'),
    );
    expect(() =>
      schema.parse({
        plugins: { mysteryKey: ['@acme/pkg'] },
      }),
    ).toThrow();
  });

  it('allows manifest-threaded keys through the composed plugins namespace', () => {
    const keys: PluginConfigKeyDeclaration[] = [
      { key: 'newToolPackages', kind: 'packages' },
      { key: 'autoDiscoverNewTool', kind: 'autoDiscover' },
    ];
    const schema = composeConfigSchema(
      hostConfigDeclarations({ pluginConfigKeys: keys }).filter((d) => d.namespace === 'plugins'),
    );
    const parsed = schema.parse({
      plugins: {
        newToolPackages: ['@acme/new-tool'],
        autoDiscoverNewTool: true,
      },
    }) as { plugins: PluginsConfig };
    expect(parsed.plugins.newToolPackages).toEqual(['@acme/new-tool']);
    expect(parsed.plugins.autoDiscoverNewTool).toBe(true);
  });

  it('threads keys collected from tool manifests into host declarations', () => {
    const manifests = manifestWithPluginKeys([
      { key: 'customPackages', kind: 'packages' },
      { key: 'autoDiscoverCustom', kind: 'autoDiscover' },
    ]);
    const keys = new Map<string, PluginConfigKeyDeclaration['kind']>();
    for (const manifest of manifests) {
      for (const capability of manifest.capabilities ?? []) {
        const configKeys = capability.discovery?.configKeys;
        if (configKeys?.packages !== undefined) keys.set(configKeys.packages, 'packages');
        if (configKeys?.autoDiscover !== undefined)
          keys.set(configKeys.autoDiscover, 'autoDiscover');
      }
    }
    const declarations = hostConfigDeclarations({
      pluginConfigKeys: [...keys.entries()].map(([key, kind]) => ({ key, kind })),
    });
    const pluginsDecl = declarations.find((d) => d.namespace === 'plugins');
    expect(pluginsDecl).toBeDefined();
    const pluginsSchema = pluginsDecl!.schema as z.ZodObject<z.ZodRawShape>;
    const parsed = pluginsSchema.parse({
      customPackages: ['@acme/custom'],
      autoDiscoverCustom: false,
    });
    expect(parsed).toEqual({
      customPackages: ['@acme/custom'],
      autoDiscoverCustom: false,
    });
  });
});
