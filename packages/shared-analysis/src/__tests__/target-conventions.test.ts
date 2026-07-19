import { describe, expect, it } from 'vitest';

import { summarizeTargetConventions } from '../target-conventions.js';

import type { TargetResolver } from '@opensip-cli/core';

function resolver(targets: readonly unknown[]): TargetResolver {
  return {
    getAll: () => targets,
  } as TargetResolver;
}

describe('summarizeTargetConventions', () => {
  it('returns an empty summary when no target resolver is available', () => {
    expect(summarizeTargetConventions(undefined)).toEqual([]);
  });

  it('summarizes configured target conventions without expanding globs', () => {
    expect(
      summarizeTargetConventions(
        resolver([
          {
            config: {
              name: 'api',
              conventions: {
                entrypoints: ['src/routes/**', 'src/jobs/**'],
                alwaysUsed: ['src/config/runtime.ts'],
                usedExports: [
                  { file: 'src/routes/page.ts', names: ['loader', 'action'] },
                  { file: 'src/routes/meta.ts', names: ['meta'] },
                ],
              },
            },
          },
          {
            config: {
              name: 'empty',
              conventions: {
                entrypoints: [],
                alwaysUsed: [],
                usedExports: [],
              },
            },
          },
          {
            config: {
              name: 'plain',
            },
          },
        ]),
      ),
    ).toEqual([
      {
        target: 'api',
        entrypointCount: 2,
        alwaysUsedCount: 1,
        usedExportCount: 3,
      },
    ]);
  });
});
