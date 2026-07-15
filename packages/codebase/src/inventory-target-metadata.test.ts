import { describe, expect, it } from 'vitest';

import { projectBoundedTargets } from './inventory-target-metadata.js';
import {
  MAX_FILE_LANGUAGES,
  MAX_INVENTORY_TARGETS,
  MAX_TARGET_CONVENTION_PATHS,
  MAX_TARGET_METADATA_TEXT,
  MAX_TARGET_METADATA_VALUES,
} from './types.js';

import type { BoundedTargetResolver, TargetView } from '@opensip-cli/core';

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

function resolver(targets: readonly unknown[]): BoundedTargetResolver {
  return {
    globalExcludes: [],
    getByName: () => undefined,
    getAll: () => targets as readonly TargetView[],
    getByTag: () => [],
    has: () => false,
    resolveTargets: () => [],
    resolveTargetsBounded: async () => ({ files: [], capped: false, cancelled: false }),
    applyGlobalExcludes: (files) => files,
    applyGlobalExcludesBounded: async () => ({ files: [], capped: false, cancelled: false }),
  };
}

describe('projectBoundedTargets', () => {
  it('projects valid metadata including convention paths', () => {
    const reasons = new Set<string>();
    const fatal = new Set<string>();
    const projection = projectBoundedTargets(
      resolver([
        target('app', {
          tags: ['backend'],
          concerns: ['server'],
          languages: ['typescript', 'typescript'],
          conventions: {
            entrypoints: ['src/main.ts'],
            alwaysUsed: ['src/runtime.ts'],
            usedExports: [{ file: 'src/api.ts', names: ['handler'] }],
          },
        }),
      ]),
      reasons,
      fatal,
    );

    expect(projection).toMatchObject({
      status: 'ok',
      targets: [
        {
          name: 'app',
          languages: ['typescript'],
        },
      ],
    });
    expect([...reasons]).toEqual([]);
    expect([...fatal]).toEqual([]);
  });

  it('rejects non-array and hostile target enumeration', () => {
    const cases: readonly { readonly name: string; readonly getAll: () => unknown }[] = [
      { name: 'object', getAll: () => ({}) },
      {
        name: 'throwing length',
        getAll: () => {
          throw new Error('getAll failed');
        },
      },
    ];

    for (const fixture of cases) {
      const reasons = new Set<string>();
      const fatal = new Set<string>();
      const projection = projectBoundedTargets(
        { ...resolver([]), getAll: fixture.getAll as () => readonly TargetView[] },
        reasons,
        fatal,
      );
      expect(projection, fixture.name).toEqual({ status: 'invalid' });
    }
  });

  it('reports the hard target count cap without retaining definitions', () => {
    const definitions = Array.from({ length: MAX_INVENTORY_TARGETS + 1 }, (_, index) =>
      target(`t-${String(index).padStart(3, '0')}`),
    );
    const projection = projectBoundedTargets(resolver(definitions), new Set(), new Set());
    expect(projection).toEqual({ status: 'capped' });
  });

  it('skips unsafe names and invalid language memberships while retaining safe targets', () => {
    const reasons = new Set<string>();
    const fatal = new Set<string>();
    const projection = projectBoundedTargets(
      resolver([
        target('', { languages: ['typescript'] }),
        target('safe', {
          languages: ['typescript', '', 'bad\nlanguage', 'go'],
        }),
      ]),
      reasons,
      fatal,
    );

    expect(projection).toMatchObject({
      status: 'ok',
      targets: [{ name: 'safe', languages: ['go', 'typescript'] }],
    });
    expect(reasons.has('target-name-invalid')).toBe(true);
    expect(reasons.has('target-language-invalid')).toBe(true);
    expect([...fatal]).toEqual([]);
  });

  it('rejects non-string and non-array target metadata values', () => {
    const cases: readonly Partial<TargetView['config']>[] = [
      { tags: 'test' as unknown as string[] },
      { concerns: 12 as unknown as string[] },
      { languages: null as unknown as string[] },
      { tags: [42 as unknown as string] },
      { conventions: 'nope' as unknown as TargetView['config']['conventions'] },
      {
        conventions: {
          entrypoints: 'src/main.ts' as unknown as string[],
        },
      },
      {
        conventions: {
          alwaysUsed: 1 as unknown as string[],
        },
      },
      {
        conventions: {
          usedExports: 'src/api.ts' as unknown as { file: string; names: string[] }[],
        },
      },
      {
        conventions: {
          usedExports: [{ file: 12 as unknown as string, names: ['x'] }],
        },
      },
      {
        conventions: {
          usedExports: [null as unknown as { file: string; names: string[] }],
        },
      },
    ];

    for (const [index, extra] of cases.entries()) {
      const fatal = new Set<string>();
      const projection = projectBoundedTargets(
        resolver([target('source', extra)]),
        new Set(),
        fatal,
      );
      expect(projection, `case ${String(index)}`).toEqual({ status: 'ok', targets: [] });
      expect([...fatal], `case ${String(index)}`).toContain('target-metadata-invalid');
    }
  });

  it('rejects oversized metadata value counts and text lengths', () => {
    const cases: readonly Partial<TargetView['config']>[] = [
      { tags: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'test') },
      { concerns: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'backend') },
      { languages: Array.from({ length: MAX_TARGET_METADATA_VALUES + 1 }, () => 'typescript') },
      { tags: ['x'.repeat(MAX_TARGET_METADATA_TEXT + 1)] },
      {
        conventions: {
          entrypoints: Array.from(
            { length: MAX_TARGET_CONVENTION_PATHS + 1 },
            (_, index) => `src/${index}.ts`,
          ),
        },
      },
      {
        conventions: {
          entrypoints: Array.from({ length: 80 }, (_, index) => `src/e-${index}.ts`),
          alwaysUsed: Array.from({ length: 80 }, (_, index) => `src/a-${index}.ts`),
        },
      },
    ];

    for (const [index, extra] of cases.entries()) {
      const fatal = new Set<string>();
      const projection = projectBoundedTargets(
        resolver([target('source', extra)]),
        new Set(),
        fatal,
      );
      expect(projection, `case ${String(index)}`).toEqual({ status: 'ok', targets: [] });
      expect([...fatal], `case ${String(index)}`).toContain('target-metadata-cap-reached');
    }
  });

  it('caps retained languages on one target and rejects duplicate target names', () => {
    const languages = Array.from(
      { length: MAX_FILE_LANGUAGES + 4 },
      (_, index) => `lang-${String(index).padStart(2, '0')}`,
    );
    const reasons = new Set<string>();
    const fatal = new Set<string>();
    const projection = projectBoundedTargets(
      resolver([target('source', { languages }), target('source', { languages: ['typescript'] })]),
      reasons,
      fatal,
    );

    expect(projection.status).toBe('ok');
    if (projection.status === 'ok') {
      expect(projection.targets).toHaveLength(1);
      expect(projection.targets[0]?.languages).toHaveLength(MAX_FILE_LANGUAGES);
    }
    expect(reasons.has('file-language-cap-reached')).toBe(true);
    expect([...fatal]).toContain('target-metadata-invalid');
  });
});
