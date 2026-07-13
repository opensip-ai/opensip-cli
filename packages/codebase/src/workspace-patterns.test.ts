import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_WORKSPACE_PATTERNS } from './types.js';
import {
  MAX_WORKSPACE_AUTHORED_PATTERNS,
  MAX_WORKSPACE_BRACE_EXPANSIONS,
  MAX_WORKSPACE_TOTAL_EXPANDED_ALTERNATIVES,
  compileWorkspacePatterns,
  projectWorkspacePatterns,
} from './workspace-patterns.js';

import type { braceExpand as BraceExpandFunction } from 'minimatch';

type MinimatchModule = Record<string, unknown> & {
  readonly braceExpand: typeof BraceExpandFunction;
};

const braceExpandCall = vi.hoisted(() => vi.fn());

vi.mock('minimatch', async (importOriginal) => {
  const actual = await importOriginal<MinimatchModule>();
  return {
    ...actual,
    braceExpand: (...args: Parameters<typeof actual.braceExpand>) => {
      braceExpandCall();
      return actual.braceExpand(...args);
    },
  };
});

describe('workspace pattern security boundary', () => {
  beforeEach(() => {
    braceExpandCall.mockClear();
  });

  it('caps authored entries before touching the truncated tail', () => {
    const patterns = Array.from(
      { length: MAX_WORKSPACE_AUTHORED_PATTERNS + 1 },
      () => 'packages/{app,worker}',
    );
    Object.defineProperty(patterns, MAX_WORKSPACE_AUTHORED_PATTERNS, {
      configurable: true,
      get: () => {
        throw new Error('the truncated tail must not be read');
      },
    });

    expect(projectWorkspacePatterns(patterns)).toEqual({
      values: ['packages/{app,worker}'],
      capped: true,
      invalid: false,
    });
    expect(braceExpandCall).toHaveBeenCalledOnce();
  });

  it('deduplicates canonical valid and invalid patterns before brace expansion', () => {
    const invalidBomb = `packages/{1..${String(MAX_WORKSPACE_BRACE_EXPANSIONS + 1)}}`;
    const patterns = Array.from({ length: MAX_WORKSPACE_AUTHORED_PATTERNS }, (_, index) => {
      if (index % 4 === 0) return 'packages/{app,worker}';
      if (index % 4 === 1) return './packages/{app,worker}/';
      if (index % 4 === 2) return invalidBomb;
      return `./${invalidBomb}/`;
    });

    expect(projectWorkspacePatterns(patterns)).toEqual({
      values: ['packages/{app,worker}'],
      capped: false,
      invalid: true,
    });
    expect(braceExpandCall).toHaveBeenCalledTimes(2);
  });

  it('does not let a caller raise the retained-pattern hard ceiling', () => {
    const patterns = Array.from(
      { length: MAX_WORKSPACE_PATTERNS + 1 },
      (_, index) => `packages/${String(index).padStart(3, '0')}`,
    );

    const projected = projectWorkspacePatterns(patterns, Number.MAX_SAFE_INTEGER);

    expect(projected.values).toHaveLength(MAX_WORKSPACE_PATTERNS);
    expect(projected.capped).toBe(true);
    expect(projected.invalid).toBe(false);
  });

  it('never invokes hostile slice or iterator overrides while compiling bounded inputs', () => {
    const patterns: string[] = [];
    Object.defineProperties(patterns, {
      slice: {
        value: () => Array.from({ length: 1000 }, (_, index) => `injected/${index}`),
      },
      [Symbol.iterator]: {
        value: () => {
          throw new Error('hostile workspace iterator');
        },
      },
    });

    const compiled = compileWorkspacePatterns(patterns);

    expect(compiled.matcherCount).toBe(0);
    expect(compiled.patterns).toEqual([]);
    expect(compiled.reasonCodes).toEqual([]);
  });

  it('does not coerce a proxy length into an unbounded workspace allocation', () => {
    let coercions = 0;
    const hostileLength = {
      valueOf: () => {
        coercions += 1;
        return coercions === 1 ? 0 : 1000;
      },
    };
    const patterns = new Proxy(['packages/*'], {
      get: (values, property, receiver) =>
        property === 'length' ? hostileLength : Reflect.get(values, property, receiver),
    });

    const compiled = compileWorkspacePatterns(patterns);

    expect(compiled.matcherCount).toBe(0);
    expect(compiled.reasonCodes).toEqual(['workspace-pattern-invalid']);
    expect(coercions).toBe(0);
  });

  it('canonicalizes safe values and rejects every lexical root escape form', () => {
    const projected = projectWorkspacePatterns([
      './packages/*/',
      '!packages/fixtures/**',
      '../../outside/**',
      '/outside/**',
      'C:/outside/**',
      String.raw`packages\*`,
      '{packages,../outside}/**',
      'packages/{safe,../../outside}/**',
    ]);

    expect(projected).toEqual({
      values: ['!packages/fixtures/**', 'packages/*'],
      capped: false,
      invalid: true,
    });
  });

  it('rejects numeric and Cartesian brace bombs before matcher construction', () => {
    const numeric = projectWorkspacePatterns([
      `packages/{1..${String(MAX_WORKSPACE_BRACE_EXPANSIONS + 1)}}`,
    ]);
    const cartesian = projectWorkspacePatterns([
      'packages/{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}/{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}',
    ]);

    expect(numeric).toEqual({ values: [], capped: false, invalid: true });
    expect(cartesian).toEqual({ values: [], capped: false, invalid: true });
  });

  it('enforces the aggregate expansion budget and compiles once per authored pattern', () => {
    const alternatives = Array.from({ length: MAX_WORKSPACE_BRACE_EXPANSIONS }, (_, index) =>
      String(index).padStart(3, '0'),
    ).join(',');
    const patterns = Array.from(
      {
        length: Math.floor(MAX_WORKSPACE_TOTAL_EXPANDED_ALTERNATIVES / 128) + 1,
      },
      (_, index) => `group-${String(index).padStart(2, '0')}/{${alternatives}}`,
    );
    const compiled = compileWorkspacePatterns(patterns);

    expect(compiled.patterns).toHaveLength(MAX_WORKSPACE_TOTAL_EXPANDED_ALTERNATIVES / 128);
    expect(compiled.matcherCount).toBe(compiled.patterns.length);
    expect(compiled.reasonCodes).toEqual(['manifest-workspace-cap-reached']);
    for (let index = 0; index < 1000; index += 1) {
      expect(compiled.matches(`group-00/${String(index % 128).padStart(3, '0')}`)).toBe(true);
    }
    expect(compiled.matcherCount).toBe(compiled.patterns.length);
  });

  it('preserves positive and negative workspace membership semantics', () => {
    const compiled = compileWorkspacePatterns([
      '!packages/fixtures/**',
      'packages/*',
      'packages/**',
    ]);

    expect(compiled.matches('packages/app')).toBe(true);
    expect(compiled.matches('packages/app/nested')).toBe(true);
    expect(compiled.matches('packages/fixtures/demo')).toBe(false);
    expect(compiled.matches('.hidden/app')).toBe(false);
  });

  it('prunes only directories that cannot contain a brace, extglob, or class match', () => {
    const compiled = compileWorkspacePatterns([
      '{apps,packages}/*',
      'libs/[ab]',
      'modules/@(core|util)',
    ]);

    expect(compiled.couldMatchDescendant('apps')).toBe(true);
    expect(compiled.couldMatchDescendant('packages/example')).toBe(true);
    expect(compiled.couldMatchDescendant('libs')).toBe(true);
    expect(compiled.couldMatchDescendant('modules')).toBe(true);
    expect(compiled.couldMatchDescendant('vendor')).toBe(false);
    expect(compiled.couldMatchDescendant('.hidden')).toBe(false);
  });
});
