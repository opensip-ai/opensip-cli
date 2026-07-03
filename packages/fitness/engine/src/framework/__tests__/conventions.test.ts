import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { TargetRegistry } from '../../targets/target-registry.js';
import { matchConventionAlwaysUsed, matchConventionUsedExport } from '../conventions.js';

import type { Target } from '../../targets/types.js';

function target(config: Target['config']): Target {
  return { config };
}

describe('target convention matching', () => {
  it('matches always-used files and used exports from the scoped target registry', () => {
    const targets = new TargetRegistry();
    targets.register(
      target({
        name: 'app',
        description: 'Application',
        include: ['src/**'],
        exclude: [],
        conventions: {
          alwaysUsed: ['src/runtime/**/*.ts'],
          usedExports: [{ file: 'src/routes/**/*.ts', names: ['loader', 'action'] }],
        },
      }),
    );
    const scope = Object.assign(new RunScope(), { targets });

    runWithScopeSync(scope, () => {
      expect(matchConventionAlwaysUsed('/repo/src/runtime/config.ts', '/repo')).toEqual({
        kind: 'alwaysUsed',
        targetName: 'app',
        pattern: 'src/runtime/**/*.ts',
      });
      expect(matchConventionUsedExport('/repo/src/routes/page.ts', 'loader', '/repo')).toEqual({
        kind: 'usedExport',
        targetName: 'app',
        pattern: 'src/routes/**/*.ts',
      });
      expect(
        matchConventionUsedExport('/repo/src/routes/page.ts', 'component', '/repo'),
      ).toBeUndefined();
    });
  });

  it('returns undefined when no scope, conventions, or patterns match', () => {
    expect(matchConventionAlwaysUsed('/repo/src/runtime/config.ts', '/repo')).toBeUndefined();

    const targets = new TargetRegistry();
    targets.register(
      target({
        name: 'plain',
        description: 'Plain',
        include: ['src/**'],
        exclude: [],
      }),
    );

    runWithScopeSync(Object.assign(new RunScope(), { targets }), () => {
      expect(matchConventionAlwaysUsed('/repo/src/runtime/config.ts', '/repo')).toBeUndefined();
    });
  });
});
