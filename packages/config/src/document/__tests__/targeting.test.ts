import { describe, expect, it } from 'vitest';

import {
  checkOverridesSchema,
  createPluginsConfigSchema,
  findUnsafeTargetConventionPaths,
  freezeTargetConventions,
  globalExcludesSchema,
  isUnsafeTargetConventionPath,
  pluginsConfigSchema,
  targetDefinitionSchema,
  targetsRecordSchema,
} from '../targeting.js';

describe('targeting document helpers', () => {
  it('detects unsafe convention paths across entrypoints, always-used files, and used exports', () => {
    expect(isUnsafeTargetConventionPath('/abs/path.ts')).toBe(true);
    expect(isUnsafeTargetConventionPath('C:\\repo\\file.ts')).toBe(true);
    expect(isUnsafeTargetConventionPath('src/../secret.ts')).toBe(true);
    expect(isUnsafeTargetConventionPath('src/routes/**/*.ts')).toBe(false);

    expect(
      findUnsafeTargetConventionPaths({
        entrypoints: ['src/routes/**', '../outside.ts'],
        alwaysUsed: ['/runtime.ts'],
        usedExports: [
          { file: 'src/page.ts', names: ['loader'] },
          { file: 'src/../../escape.ts', names: ['secret'] },
        ],
      }),
    ).toEqual([
      { field: 'entrypoints', pattern: '../outside.ts' },
      { field: 'alwaysUsed', pattern: '/runtime.ts' },
      { field: 'usedExports.file', pattern: 'src/../../escape.ts' },
    ]);
  });

  it('freezes a defensive copy of target conventions', () => {
    const source = {
      entrypoints: ['src/routes/**'],
      alwaysUsed: ['src/config/runtime.ts'],
      usedExports: [{ file: 'src/page.ts', names: ['loader'] }],
    };

    const frozen = freezeTargetConventions(source);
    source.entrypoints.push('mutated');
    source.usedExports[0].names.push('mutated');

    expect(frozen).toEqual({
      entrypoints: ['src/routes/**'],
      alwaysUsed: ['src/config/runtime.ts'],
      usedExports: [{ file: 'src/page.ts', names: ['loader'] }],
    });
    expect(Object.isFrozen(frozen.entrypoints)).toBe(true);
    expect(Object.isFrozen(frozen.usedExports?.[0]?.names)).toBe(true);
  });

  it('validates target, global exclude, override, and plugin schema shapes', () => {
    expect(
      targetDefinitionSchema.parse({
        description: 'Backend',
        include: ['src/**'],
        exclude: ['dist/**'],
        tags: ['server'],
        languages: ['typescript'],
        concerns: ['backend'],
        conventions: {
          usedExports: [{ file: 'src/page.ts', names: ['loader'] }],
        },
      }),
    ).toMatchObject({ description: 'Backend' });
    expect(() => targetDefinitionSchema.parse({ description: '', include: [] })).toThrow();
    expect(
      targetsRecordSchema.parse({ 'api-server': { description: 'API', include: ['src'] } }),
    ).toMatchObject({ 'api-server': { description: 'API' } });
    expect(() =>
      targetsRecordSchema.parse({ ApiServer: { description: 'API', include: ['src'] } }),
    ).toThrow();
    expect(globalExcludesSchema.parse(['dist/**'])).toEqual(['dist/**']);
    expect(checkOverridesSchema.parse({ 'no-console': ['api-server'] })).toEqual({
      'no-console': ['api-server'],
    });
    expect(() => checkOverridesSchema.parse({ 'no-console': [] })).toThrow();
    expect(pluginsConfigSchema.parse({ autoDiscoverGraphAdapters: false })).toEqual({
      autoDiscoverGraphAdapters: false,
    });
  });

  it('creates plugin schemas for package, scope, and auto-discovery preference keys', () => {
    const schema = createPluginsConfigSchema([
      { key: 'toolPackages', kind: 'packages' },
      { key: 'toolScopes', kind: 'scopes' },
      { key: 'autoDiscoverTool', kind: 'autoDiscover' },
    ]);

    expect(
      schema.parse({
        fit: ['@acme/fit-pack'],
        sim: ['@acme/sim-pack'],
        toolPackages: ['@acme/tool'],
        toolScopes: ['@acme'],
        autoDiscoverTool: true,
      }),
    ).toEqual({
      fit: ['@acme/fit-pack'],
      sim: ['@acme/sim-pack'],
      toolPackages: ['@acme/tool'],
      toolScopes: ['@acme'],
      autoDiscoverTool: true,
    });
    expect(() => schema.parse({ autoDiscoverTool: ['nope'] })).toThrow();
    expect(() => schema.parse({ unknown: ['nope'] })).toThrow();
  });
});
