import { describe, expect, it, vi } from 'vitest';

import { compileWorkspacePatterns, projectWorkspacePatterns } from './workspace-patterns.js';

import type { braceExpand as BraceExpandFunction, Minimatch as MinimatchClass } from 'minimatch';

type MinimatchModule = Record<string, unknown> & {
  readonly braceExpand: typeof BraceExpandFunction;
  readonly Minimatch: typeof MinimatchClass;
};

const failures = vi.hoisted(() => ({ braceExpand: false, minimatch: false }));

vi.mock('minimatch', async (importOriginal) => {
  const actual = await importOriginal<MinimatchModule>();
  class GuardedMinimatch extends actual.Minimatch {
    constructor(pattern: string, options?: ConstructorParameters<typeof actual.Minimatch>[1]) {
      if (failures.minimatch) throw new Error('fixture matcher compilation failure');
      super(pattern, options);
    }
  }
  return {
    ...actual,
    braceExpand: (...args: Parameters<typeof actual.braceExpand>) => {
      if (failures.braceExpand) throw new Error('fixture brace expansion failure');
      return actual.braceExpand(...args);
    },
    Minimatch: GuardedMinimatch,
  };
});

describe('third-party glob machinery is guarded', () => {
  it('reports an unexpandable pattern instead of aborting the surrounding build', () => {
    failures.braceExpand = true;
    try {
      // `braceExpand` is untrusted third-party code reached from an authored workspace
      // array. An unguarded rejection would abort the whole inventory build over one bad
      // line in a package.json.
      expect(projectWorkspacePatterns(['packages/*'])).toEqual({
        values: [],
        capped: false,
        invalid: true,
      });
      expect(compileWorkspacePatterns(['packages/*']).reasonCodes).toEqual([
        'workspace-pattern-invalid',
      ]);
    } finally {
      failures.braceExpand = false;
    }
  });

  it('reports an uncompilable pattern instead of aborting the surrounding build', () => {
    failures.minimatch = true;
    try {
      const compiled = compileWorkspacePatterns(['packages/*']);

      expect(compiled.reasonCodes).toEqual(['workspace-pattern-invalid']);
      expect(compiled.matcherCount).toBe(0);
      expect(compiled.hasPositivePatterns).toBe(false);
      // A pattern that never compiled must not be reported as retained: it would claim
      // discovery coverage that nothing enforces.
      expect(compiled.patterns).toEqual([]);
      expect(compiled.matches('packages/app')).toBe(false);
    } finally {
      failures.minimatch = false;
    }
  });

  it('compiles and retains a usable pattern when the machinery behaves', () => {
    const compiled = compileWorkspacePatterns(['packages/*']);

    expect(compiled.reasonCodes).toEqual([]);
    expect(compiled.patterns).toEqual(['packages/*']);
    expect(compiled.matches('packages/app')).toBe(true);
  });
});
