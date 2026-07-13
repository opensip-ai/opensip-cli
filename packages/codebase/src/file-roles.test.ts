import { describe, expect, it } from 'vitest';

import { classifyFileRoles } from './file-roles.js';

import type { TargetView } from '@opensip-cli/core';

function target(name: string, extra: Partial<TargetView['config']> = {}): TargetView {
  return {
    config: {
      name,
      description: name,
      include: ['**/*'],
      exclude: [],
      ...extra,
    },
  };
}

describe('classifyFileRoles', () => {
  it('uses explicit name, concern, and tag vocabulary without path guessing', () => {
    const result = classifyFileRoles('odd/location/value.bin', [
      target('unit-tests', {
        concerns: ['configuration'],
        tags: ['generated'],
      }),
    ]);
    expect(result.roles).toEqual(['configuration', 'generated', 'test']);
    expect(result.provenance).toContainEqual({
      source: 'target',
      detail: 'target:unit-tests',
    });
  });

  it('uses an explicit language as production fallback', () => {
    expect(
      classifyFileRoles('anything.data', [target('module', { languages: ['typescript'] })]).roles,
    ).toEqual(['production']);
  });

  it('classifies each overlapping target independently of target order', () => {
    const tests = target('aaa-tests');
    const runtime = target('neutral-runtime', { languages: ['typescript'] });

    expect(classifyFileRoles('src/shared.ts', [tests, runtime]).roles).toEqual([
      'production',
      'test',
    ]);
    expect(classifyFileRoles('src/shared.ts', [runtime, tests]).roles).toEqual([
      'production',
      'test',
    ]);
  });

  it('uses literal target conventions but does not guess wildcard matches', () => {
    const explicit = target('runtime', {
      conventions: {
        entrypoints: ['src/main.ts', 'src/*.ts'],
        usedExports: [{ file: 'src/export.ts', names: ['handler'] }],
      },
    });
    expect(classifyFileRoles('src/main.ts', [explicit])).toMatchObject({
      roles: ['production'],
      provenance: expect.arrayContaining([
        { source: 'convention', detail: 'target-convention:runtime' },
      ]),
    });
    expect(classifyFileRoles('src/other.ts', [explicit]).roles).toEqual(['unknown']);
    expect(classifyFileRoles('src/export.ts', [explicit]).roles).toEqual(['production']);
  });

  it('returns unknown with explicit provenance when no target supplies a basis', () => {
    const result = classifyFileRoles('tests/example.test.ts', [target('misc')]);
    expect(result.roles).toEqual(['unknown']);
    expect(result.provenance).toContainEqual({
      source: 'filesystem',
      detail: 'role-unclassified',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.roles)).toBe(true);
  });
});
