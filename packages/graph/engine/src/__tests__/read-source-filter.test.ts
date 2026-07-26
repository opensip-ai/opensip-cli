import { describe, expect, it } from 'vitest';

import {
  compileSourceRoleMatcher,
  effectiveTestSource,
  GRAPH_SYMBOL_NAME_MAX,
  GRAPH_SYMBOL_PATH_MAX,
  matchesFilePrefix,
  matchesGraphSourceFilterWithRoles,
  MAX_AUDIT_SOURCE_ROLE_FILES,
  toGraphSymbolRef,
  type AuditSourceRolePolicy,
  type GraphSourceFilter,
  type SourceRoleMatcher,
} from '../read/index.js';

import type { FunctionOccurrence } from '../types.js';

const policy = (testGlobs: readonly string[]): AuditSourceRolePolicy => ({
  testGlobs,
  mode: 'audit-test-globs-v1',
});

// The matcher-less overload was deleted in Task 1.6; these scope/narrowing tests
// exercise the canonical role-aware filter with an empty (no-op) matcher.
const emptyMatcher: SourceRoleMatcher = { matches: () => false };
function matchesGraphSourceFilter(
  row: Parameters<typeof matchesGraphSourceFilterWithRoles>[0],
  filter: GraphSourceFilter,
): boolean {
  return matchesGraphSourceFilterWithRoles(row, filter, emptyMatcher);
}

function unwrapMatcher(result: ReturnType<typeof compileSourceRoleMatcher>): SourceRoleMatcher {
  if (!result.ok) throw new Error(`expected ok matcher, got ${result.error.code}`);
  return result.value;
}

function occ(
  partial: Partial<FunctionOccurrence> & Pick<FunctionOccurrence, 'filePath'>,
): FunctionOccurrence {
  return {
    bodyHash: 'hash',
    simpleName: 'fn',
    qualifiedName: 'pkg.fn',
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    package: 'pkg',
    ...partial,
  };
}

const baseFilter = (): GraphSourceFilter => ({
  sourceScope: 'all',
  generated: 'include',
});

describe('matchesFilePrefix', () => {
  it('matches exact path and descendants, not sibling prefixes', () => {
    expect(matchesFilePrefix('src/api', 'src/api')).toBe(true);
    expect(matchesFilePrefix('src/api/x.ts', 'src/api')).toBe(true);
    expect(matchesFilePrefix('src/api-old/x.ts', 'src/api')).toBe(false);
    expect(matchesFilePrefix('src/apix.ts', 'src/api')).toBe(false);
  });
});

describe('matchesGraphSourceFilter', () => {
  it('filters by source scope', () => {
    const production = occ({ filePath: 'src/a.ts', inTestFile: false });
    const test = occ({ filePath: 'src/a.test.ts', inTestFile: true });
    expect(
      matchesGraphSourceFilter(production, { ...baseFilter(), sourceScope: 'production' }),
    ).toBe(true);
    expect(matchesGraphSourceFilter(test, { ...baseFilter(), sourceScope: 'production' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(test, { ...baseFilter(), sourceScope: 'test' })).toBe(true);
    expect(matchesGraphSourceFilter(production, { ...baseFilter(), sourceScope: 'test' })).toBe(
      false,
    );
  });

  it('filters by generated policy', () => {
    const generated = occ({ filePath: 'gen/a.ts', definedInGenerated: true });
    const source = occ({ filePath: 'src/a.ts', definedInGenerated: false });
    expect(matchesGraphSourceFilter(generated, { ...baseFilter(), generated: 'exclude' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(source, { ...baseFilter(), generated: 'exclude' })).toBe(true);
    expect(matchesGraphSourceFilter(generated, { ...baseFilter(), generated: 'only' })).toBe(true);
    expect(matchesGraphSourceFilter(source, { ...baseFilter(), generated: 'only' })).toBe(false);
  });

  it('filters by package, kind, visibility, exact path, and prefix', () => {
    const row = occ({
      filePath: 'src/api/handler.ts',
      package: '@opensip-cli/api',
      kind: 'method',
      visibility: 'exported',
    });
    expect(
      matchesGraphSourceFilter(row, {
        ...baseFilter(),
        packages: ['@opensip-cli/api'],
        kinds: ['method'],
        visibilities: ['exported'],
        filePath: 'src/api/handler.ts',
        filePrefix: 'src/api',
      }),
    ).toBe(true);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), packages: ['other'] })).toBe(false);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), kinds: ['arrow'] })).toBe(false);
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), visibilities: ['private'] })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), filePath: 'src/other.ts' })).toBe(
      false,
    );
    expect(matchesGraphSourceFilter(row, { ...baseFilter(), filePrefix: 'src/api-old' })).toBe(
      false,
    );
  });

  it('requires both exact path and prefix when both are set', () => {
    const row = occ({ filePath: 'src/api/handler.ts' });
    expect(
      matchesGraphSourceFilter(row, {
        ...baseFilter(),
        filePath: 'src/api/handler.ts',
        filePrefix: 'src/other',
      }),
    ).toBe(false);
  });
});

describe('toGraphSymbolRef', () => {
  it('projects a well-formed occurrence with package/test/generated metadata', () => {
    const ref = toGraphSymbolRef(
      occ({
        filePath: 'src/a.ts',
        simpleName: 'save',
        qualifiedName: 'pkg.save',
        package: 'pkg',
        inTestFile: true,
        definedInGenerated: false,
        line: 10,
        endLine: 12,
        column: 2,
      }),
    );
    expect(ref).toEqual({
      symbolId: 'src/a.ts:10:2',
      bodyHash: 'hash',
      simpleName: 'save',
      qualifiedName: 'pkg.save',
      filePath: 'src/a.ts',
      line: 10,
      column: 2,
      kind: 'function-declaration',
      visibility: 'module-local',
      package: 'pkg',
      inTestFile: true,
      definedInGenerated: false,
    });
  });

  it('omits oversized or control-containing identity fields instead of truncating', () => {
    expect(
      toGraphSymbolRef(occ({ filePath: 'x'.repeat(GRAPH_SYMBOL_PATH_MAX + 1) })),
    ).toBeUndefined();
    expect(toGraphSymbolRef(occ({ filePath: 'src/a.ts', simpleName: 'a\u0000b' }))).toBeUndefined();
    expect(
      toGraphSymbolRef(
        occ({ filePath: 'src/a.ts', qualifiedName: 'n'.repeat(GRAPH_SYMBOL_NAME_MAX + 1) }),
      ),
    ).toBeUndefined();
    expect(toGraphSymbolRef(occ({ filePath: 'src/a.ts', line: 10, endLine: 9 }))).toBeUndefined();
  });
});

describe('compileSourceRoleMatcher (P2 Phase 1.4)', () => {
  const limit = (maxFiles: number) => ({ maxFiles });

  it('returns a no-op matcher when no policy or empty globs are configured', () => {
    const files = ['packages/test-support/src/harness.ts', 'src/index.ts'];
    for (const p of [undefined, policy([])]) {
      const matcher = unwrapMatcher(compileSourceRoleMatcher(p, files, limit(10)));
      expect(matcher.matches('packages/test-support/src/harness.ts')).toBe(false);
    }
  });

  it('classifies only the matching catalog paths, once, into the matched set', () => {
    const files = [
      'packages/test-support/src/harness.ts',
      'packages/test-support/src/harness.ts', // duplicate — classified once
      'packages/core/src/index.ts',
    ];
    const matcher = unwrapMatcher(
      compileSourceRoleMatcher(policy(['packages/test-support/**']), files, limit(10)),
    );
    expect(matcher.matches('packages/test-support/src/harness.ts')).toBe(true);
    expect(matcher.matches('packages/core/src/index.ts')).toBe(false);
    // A path never seen at compile time is not in the matched set (classify-once).
    expect(matcher.matches('packages/test-support/src/late.ts')).toBe(false);
  });

  it('fails closed with a typed resource-limit error past maxFiles', () => {
    const globs = policy(['packages/**']);
    // 2/3/4 injected-file limits instead of allocating 250,001 paths.
    const files3 = ['packages/a.ts', 'packages/b.ts', 'packages/c.ts'];
    expect(compileSourceRoleMatcher(globs, files3, limit(3)).ok).toBe(true);
    const over = compileSourceRoleMatcher(globs, files3, limit(2));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('GRAPH.READ.QUERY_INVALID');
    const files4 = ['packages/a.ts', 'packages/b.ts', 'packages/c.ts', 'packages/d.ts'];
    expect(compileSourceRoleMatcher(globs, files4, limit(4)).ok).toBe(true);
    expect(compileSourceRoleMatcher(globs, files4, limit(3)).ok).toBe(false);
  });

  it('pins the production file-classification limit constant', () => {
    expect(MAX_AUDIT_SOURCE_ROLE_FILES).toBe(250_000);
  });

  it('keeps the policy JSON-safe and the compiled matcher out of any DTO', () => {
    const p = policy(['packages/test-support/**']);
    // The plain policy is round-trippable through JSON (a deliberate
    // serialization proof, not a clone — the matcher must never be a DTO).
    // eslint-disable-next-line unicorn/prefer-structured-clone
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    // …while the matcher is a live object carrying a function (never serialized).
    const matcher = unwrapMatcher(compileSourceRoleMatcher(p, ['x.ts'], limit(10)));
    expect(typeof matcher.matches).toBe('function');
  });
});

describe('matchesGraphSourceFilterWithRoles (P2 Phase 1.4)', () => {
  const supportFile = occ({
    filePath: 'packages/test-support/src/harness.ts',
    inTestFile: false,
    package: 'test-support',
  });

  it('reclassifies a glob-matched non-test file as a test source', () => {
    const matcher = unwrapMatcher(
      compileSourceRoleMatcher(policy(['packages/test-support/**']), [supportFile.filePath], {
        maxFiles: 10,
      }),
    );
    expect(effectiveTestSource(supportFile, matcher)).toBe(true);
    // production scope now EXCLUDES the reclassified support file…
    expect(
      matchesGraphSourceFilterWithRoles(
        supportFile,
        { ...baseFilter(), sourceScope: 'production' },
        matcher,
      ),
    ).toBe(false);
    // …and test scope INCLUDES it.
    expect(
      matchesGraphSourceFilterWithRoles(
        supportFile,
        { ...baseFilter(), sourceScope: 'test' },
        matcher,
      ),
    ).toBe(true);
  });

  it('is exactly the matcher-less filter when the policy is empty', () => {
    const matcher = unwrapMatcher(
      compileSourceRoleMatcher(policy([]), [supportFile.filePath], { maxFiles: 10 }),
    );
    for (const scope of ['all', 'production', 'test'] as const) {
      const filter: GraphSourceFilter = { ...baseFilter(), sourceScope: scope };
      expect(matchesGraphSourceFilterWithRoles(supportFile, filter, matcher)).toBe(
        matchesGraphSourceFilter(supportFile, filter),
      );
    }
  });
});
