import { testSelectionSnapshotSchema, type ProjectInventorySnapshot } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildComputeImpactIndex,
  buildGraphReadIndexes,
  buildImpactView,
  catalogGenerationKey,
  MAX_IMPACT_VIEW_ROWS,
  projectEntityDetail,
  selectStaticTests,
} from '../read/index.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

function occurrence(
  bodyHash: string,
  filePath: string,
  over: Partial<FunctionOccurrence> = {},
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName: bodyHash,
    qualifiedName: bodyHash,
    filePath,
    line: 1,
    column: 0,
    endLine: 4,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function catalog(): Catalog {
  const production = occurrence('production', 'src/work.ts', {
    params: [{ name: 'input', optional: false, rest: false }],
    returnType: 'string',
    decorators: ['trace'],
  });
  const caller = occurrence('caller', 'src/caller.ts', {
    calls: [
      {
        to: ['production'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'high',
        text: 'work()',
      },
    ],
  });
  const test = occurrence('test', 'src/work.test.ts', {
    inTestFile: true,
    calls: [
      {
        to: ['production'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'high',
        text: 'work()',
      },
    ],
  });
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-13T00:00:00.000Z',
    cacheKey: 'cache',
    filesFingerprint: 'fingerprint',
    functions: { production: [production], caller: [caller], test: [test] },
    features: {
      function: {
        production: { bodyLines: 4, testReachable: true },
      },
    },
  };
}

function inventory(): ProjectInventorySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: `i1:${'1'.repeat(64)}`,
    metadataIdentity: `m1:${'2'.repeat(64)}`,
    project: {
      workspacePatterns: ['packages/*'],
      languages: ['typescript'],
      fileCount: 2,
      packageCount: 1,
      configIdentity: 'config-1',
    },
    packages: [
      {
        name: 'app',
        root: '.',
        private: true,
        exports: [],
        bins: [],
        verificationCommands: [
          {
            tier: 'focused',
            cwd: '.',
            argv: ['vitest', 'run'],
            basis: 'manifest:test',
          },
        ],
        provenance: [{ source: 'manifest', detail: 'package.json' }],
      },
    ],
    files: [
      {
        path: 'src/work.ts',
        size: 10,
        modifiedMs: 1,
        roles: ['production'],
        targets: ['source'],
        languages: ['typescript'],
        evidenceSupport: {
          callable: 'supported',
          declaration: 'supported',
          reference: 'supported',
        },
        packageName: 'app',
        provenance: [{ source: 'target', detail: 'source' }],
      },
      {
        path: 'src/work.test.ts',
        size: 10,
        modifiedMs: 1,
        roles: ['test'],
        targets: ['tests'],
        languages: ['typescript'],
        evidenceSupport: {
          callable: 'supported',
          declaration: 'supported',
          reference: 'supported',
        },
        packageName: 'app',
        provenance: [{ source: 'convention', detail: '*.test.ts' }],
      },
    ],
    coverage: { status: 'complete', reasonCodes: [], observed: 2, total: 2 },
  };
}

describe('task-context graph read views', () => {
  it('builds canonical impact with explicit inventory/projection coverage', async () => {
    const result = await buildImpactView(catalog(), ['src/work.ts']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changedFunctions.map((row) => row.qualifiedName)).toEqual(['production']);
    expect(result.value.impactedFunctions.map((row) => row.qualifiedName)).toEqual(
      expect.arrayContaining(['caller', 'test']),
    );
    expect(result.value.coverage.complete).toBe(true);
  });

  it('rejects an impact index from another immutable generation', async () => {
    const first = catalog();
    const second: Catalog = {
      ...catalog(),
      filesFingerprint: 'other-generation',
    };
    await expect(
      buildImpactView(second, ['src/work.ts'], {
        index: await buildComputeImpactIndex(first),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.IMPACT_INDEX_GENERATION_MISMATCH',
        operation: 'analysis',
        message: 'Impact index belongs to a different graph catalog generation',
      },
    });
  });

  it('applies the stable public impact row cap before response projection', async () => {
    const value: Catalog = {
      ...catalog(),
      functions: {
        wide: Array.from({ length: MAX_IMPACT_VIEW_ROWS + 100 }, (_, index) =>
          occurrence(`wide-${String(index)}`, 'src/wide.ts'),
        ),
      },
    };
    for (const top of [undefined, MAX_IMPACT_VIEW_ROWS + 100]) {
      const result = await buildImpactView(
        value,
        ['src/wide.ts'],
        top === undefined ? {} : { top },
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          truncated: true,
          trust: { fullyVerified: false },
          coverage: {
            complete: false,
            projection: { reasons: ['impact-projection-cap'] },
          },
        },
      });
      if (!result.ok) continue;
      expect(result.value.changedFunctions).toHaveLength(MAX_IMPACT_VIEW_ROWS);
      expect(result.value.changedFunctions.length + result.value.impactedFunctions.length).toBe(
        MAX_IMPACT_VIEW_ROWS,
      );
    }
  });

  it('marks malformed impact rows as omitted at the public projection boundary', async () => {
    const value = catalog();
    const malformed = occurrence('malformed', 'src/malformed.ts', {
      qualifiedName: 'unsafe\nname',
      calls: [
        {
          to: ['production'],
          line: 1,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const result = await buildImpactView(
      { ...value, functions: { ...value.functions, malformed: [malformed] } },
      ['src/work.ts'],
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        impactedFunctions: expect.not.arrayContaining([
          expect.objectContaining({ qualifiedName: 'unsafe\nname' }),
        ]),
        coverage: {
          complete: false,
          projection: { reasons: ['impact-malformed-row-omitted'] },
        },
      },
    });
  });

  it('projects exact entity details without source text', () => {
    const value = catalog();
    const result = projectEntityDetail(value, buildGraphReadIndexes(value), 'src/work.ts:1:0');
    expect(result).toMatchObject({
      ok: true,
      value: {
        endLine: 4,
        parameters: [{ name: 'input', optional: false, rest: false }],
        returnType: 'string',
        decorators: ['trace'],
        testReachability: { testReachable: true },
      },
    });
  });

  it('projects cross-language decorator names without argument source or literals', () => {
    const value = catalog();
    const secret = 'customer-secret-token';
    const decorated = occurrence('decorated', 'src/decorated.py', {
      decorators: [
        `route(token="${secret}")`,
        `@org.junit.Route(token="${secret}")`,
        `#[route(token = "${secret}")]`,
        `#![cfg_attr(feature = "${secret}", route)]`,
        `malformed value="${secret}"`,
      ],
    });
    const decoratedCatalog: Catalog = {
      ...value,
      functions: { ...value.functions, decorated: [decorated] },
    };
    const result = projectEntityDetail(
      decoratedCatalog,
      buildGraphReadIndexes(decoratedCatalog),
      'src/decorated.py:1:0',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        decorators: ['route', 'org.junit.Route', 'route', 'cfg_attr'],
        coverage: {
          evidence: { reasons: ['entity-detail-malformed-decorator'] },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('redacts literal return types and source-shaped parameter patterns', () => {
    const value = catalog();
    const secret = 'sk-customer-secret';
    const privateTypes = occurrence('private-types', 'src/private.ts', {
      params: [
        { name: 'safeName', optional: false, rest: false },
        { name: `{ token = "${secret}" }`, optional: true, rest: false },
      ],
      returnType: `{ token: "${secret}" }`,
      enclosingClass: `Private "${secret}"`,
    });
    const privateCatalog: Catalog = {
      ...value,
      functions: { ...value.functions, 'private-types': [privateTypes] },
    };
    const result = projectEntityDetail(
      privateCatalog,
      buildGraphReadIndexes(privateCatalog),
      'src/private.ts:1:0',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        parameters: [{ name: 'safeName' }],
        returnType: null,
        enclosingClass: null,
        coverage: {
          evidence: {
            reasons: expect.arrayContaining([
              'entity-detail-malformed-parameter',
              'entity-detail-literal-type-redacted',
              'entity-detail-malformed-class-name',
            ]),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('bounds entity arrays and omits malformed or oversized text with partial coverage', () => {
    const value = catalog();
    const source = value.functions.production[0];
    const boundedName = 'n'.repeat(512);
    const malformed = occurrence('bounded', 'src/bounded.ts', {
      params: [
        { name: boundedName, optional: false, rest: false },
        { name: 'x'.repeat(513), optional: false, rest: false },
      ],
      returnType: 'r'.repeat(513),
      enclosingClass: 'bad\u0000class',
      decorators: [
        'd'.repeat(513),
        ...Array.from({ length: 31 }, (_, index) => `decorator${String(index)}`),
        'overflow',
      ],
    });
    const boundedCatalog: Catalog = {
      ...value,
      functions: { production: [source], bounded: [malformed] },
    };
    const result = projectEntityDetail(
      boundedCatalog,
      buildGraphReadIndexes(boundedCatalog),
      'src/bounded.ts:1:0',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        parameters: [{ name: boundedName }],
        returnType: null,
        enclosingClass: null,
        coverage: {
          complete: false,
          evidence: {
            reasons: expect.arrayContaining([
              'entity-detail-malformed-parameter',
              'entity-detail-malformed-text',
              'entity-decorator-cap',
            ]),
          },
        },
      },
    });
    if (!result.ok || result.value === null) return;
    expect(result.value.decorators).toHaveLength(31);
  });

  it('omits malformed entity booleans and source-bearing scalar values', () => {
    const value = catalog();
    const secret = 'customer-source-secret';
    const malformed = occurrence('malformed-scalars', 'src/malformed-scalars.ts', {
      params: [
        {
          name: 'unsafe',
          optional: secret as unknown as boolean,
          rest: false,
        },
      ],
      returnType: `{ token: "${secret}" }`,
      decorators: secret as unknown as readonly string[],
    });
    const malformedCatalog: Catalog = {
      ...value,
      functions: { malformed: [malformed] },
      features: {
        function: {
          'malformed-scalars': {
            bodyLines: 4,
            testReachable: secret as unknown as boolean,
            reachableOnlyFromTests: secret as unknown as boolean,
          },
        },
      },
    };
    const result = projectEntityDetail(
      malformedCatalog,
      buildGraphReadIndexes(malformedCatalog),
      'src/malformed-scalars.ts:1:0',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        parameters: [],
        returnType: null,
        decorators: [],
        testReachability: {},
        coverage: {
          complete: false,
          evidence: {
            reasons: expect.arrayContaining([
              'entity-detail-malformed-parameter',
              'entity-detail-literal-type-redacted',
              'entity-detail-malformed-decorator',
              'entity-detail-malformed-feature',
            ]),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('selects direct static tests, bounded proof, and safe manifest commands', async () => {
    const value = catalog();
    const result = await selectStaticTests(
      value,
      buildGraphReadIndexes(value),
      inventory(),
      ['src/work.ts'],
      { maxProofNodes: 1 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshot).toMatchObject({
      inventoryIdentity: inventory().snapshotId,
      tests: [
        {
          path: 'src/work.test.ts',
          basis: 'direct-call',
          confidence: 'high',
          observed: false,
        },
      ],
      commands: [{ argv: ['vitest', 'run'] }],
    });
    expect(result.value.snapshot.tests[0]?.proof).toHaveLength(1);
  });

  it('keeps equal-depth occurrence proof coverage for every requested source file', async () => {
    const first = occurrence('first-production', 'src/first.ts');
    const second = occurrence('second-production', 'src/second.ts');
    const test = occurrence('shared-test', 'src/shared.test.ts', {
      inTestFile: true,
      calls: [
        {
          to: ['first-production', 'second-production'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'shared()',
        },
      ],
    });
    const value: Catalog = {
      ...catalog(),
      functions: { first: [first], second: [second], test: [test] },
    };
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      project: { ...inventory().project, fileCount: 3 },
      files: [
        { ...inventory().files[0], path: 'src/first.ts' },
        { ...inventory().files[0], path: 'src/second.ts' },
        { ...inventory().files[1], path: 'src/shared.test.ts' },
      ],
      coverage: { status: 'complete', reasonCodes: [], observed: 3, total: 3 },
    };
    const result = await selectStaticTests(value, buildGraphReadIndexes(value), facts, [
      'src/first.ts',
      'src/second.ts',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          tests: [{ path: 'src/shared.test.ts' }],
          uncoveredFiles: [],
          trust: { status: 'complete' },
        },
      },
    });
  });

  it('does not claim direct proof when a body-hash target has ambiguous twins', async () => {
    const first = occurrence('shared-production', 'src/first.ts');
    const second = occurrence('shared-production', 'src/second.ts');
    const unrelatedTwinTest = occurrence('shared-test', 'src/unrelated.test.ts', {
      inTestFile: true,
      calls: [
        {
          to: ['shared-production'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'otherTwin()',
        },
      ],
    });
    const value: Catalog = {
      ...catalog(),
      functions: { shared: [first, second], test: [unrelatedTwinTest] },
    };
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      project: { ...inventory().project, fileCount: 3 },
      files: [
        { ...inventory().files[0], path: 'src/first.ts' },
        { ...inventory().files[0], path: 'src/second.ts' },
        { ...inventory().files[1], path: 'src/unrelated.test.ts' },
      ],
      coverage: { status: 'complete', reasonCodes: [], observed: 3, total: 3 },
    };
    const result = await selectStaticTests(value, buildGraphReadIndexes(value), facts, [
      'src/first.ts',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          tests: [],
          uncoveredFiles: ['src/first.ts'],
          trust: {
            status: 'fallback',
            reasonCodes: expect.arrayContaining([
              'test-selection-body-twin-ambiguous',
              'test-selection-uncovered-files',
            ]),
          },
        },
      },
    });
  });

  it('does not invent a Python verification command when the inventory has none', async () => {
    const production = occurrence('python-production', 'ledger/core.py');
    const test = occurrence('python-test', 'tests/test_core.py', {
      inTestFile: true,
      calls: [],
    });
    const value: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'python',
      builtAt: '2026-07-13T00:00:00.000Z',
      cacheKey: 'python-cache',
      filesFingerprint: 'python-fingerprint',
      functions: { work: [production], test_work: [test] },
    };
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      snapshotId: `i1:${'3'.repeat(64)}`,
      project: { ...inventory().project, languages: ['python'] },
      packages: [{ ...inventory().packages[0], verificationCommands: [] }],
      files: [
        {
          ...inventory().files[0],
          path: 'ledger/core.py',
          languages: ['python'],
          evidenceSupport: {
            callable: 'supported',
            declaration: 'unsupported',
            reference: 'unsupported',
          },
        },
        {
          ...inventory().files[1],
          path: 'tests/test_core.py',
          languages: ['python'],
          evidenceSupport: {
            callable: 'supported',
            declaration: 'unsupported',
            reference: 'unsupported',
          },
          provenance: [{ source: 'convention', detail: 'test_*.py' }],
        },
      ],
    };
    const result = await selectStaticTests(value, buildGraphReadIndexes(value), facts, [
      'ledger/core.py',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          commands: [],
          tests: [expect.objectContaining({ path: 'tests/test_core.py', basis: 'co-located' })],
          uncoveredFiles: [],
          trust: {
            status: 'partial',
            fallbackTier: 'full',
            reasonCodes: expect.arrayContaining(['test-selection-verification-command-missing']),
          },
        },
      },
    });
    if (!result.ok) return;
    expect(testSelectionSnapshotSchema.safeParse(result.value.snapshot).success).toBe(true);
  });

  it('caps merged trust reasons while retaining selector degradation evidence', async () => {
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      coverage: {
        status: 'partial',
        reasonCodes: Array.from(
          { length: 32 },
          (_value, index) => `inventory-fixture-reason-${String(index).padStart(2, '0')}`,
        ),
        observed: 2,
        total: 3,
      },
    };
    const result = await selectStaticTests(catalog(), buildGraphReadIndexes(catalog()), facts, [
      'src/missing.ts',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshot.trust.reasonCodes).toHaveLength(32);
    expect(result.value.snapshot.trust.reasonCodes).toEqual(
      expect.arrayContaining([
        'test-selection-reason-cap',
        'test-selection-graph-unmatched',
        'test-selection-uncovered-files',
      ]),
    );
    expect(testSelectionSnapshotSchema.safeParse(result.value.snapshot).success).toBe(true);
  });

  it.each([
    'graph:' + 'a'.repeat(64),
    'g1:' + 'a'.repeat(63),
    'g1:' + 'A'.repeat(64),
    'g1:not-a-generation-hash',
    42,
  ])('rejects a non-canonical graph identity override: %s', async (graphIdentity) => {
    const value = catalog();
    const result = await selectStaticTests(
      value,
      buildGraphReadIndexes(value),
      inventory(),
      ['src/work.ts'],
      { graphIdentity: graphIdentity as string },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.TEST_SELECTION_GRAPH_IDENTITY_INVALID',
        operation: 'analysis',
        message: 'Test selection graph identity must be an exact bounded generation identity',
      },
    });
  });

  it('retains the root full command as a fallback for a commandless workspace leaf', async () => {
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      project: { ...inventory().project, packageCount: 2 },
      packages: [
        {
          ...inventory().packages[0],
          name: 'workspace-root',
          verificationCommands: [
            {
              tier: 'full',
              cwd: '.',
              argv: ['vitest', 'run'],
              basis: 'manifest-script:test',
            },
          ],
        },
        {
          ...inventory().packages[0],
          name: 'leaf',
          root: 'packages/leaf',
          verificationCommands: [],
        },
      ],
      files: inventory().files.map((file) => ({
        ...file,
        packageName: 'leaf',
      })),
    };

    const value = catalog();
    const result = await selectStaticTests(value, buildGraphReadIndexes(value), facts, [
      'src/work.ts',
    ]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          commands: [
            {
              tier: 'full',
              cwd: '.',
              argv: ['vitest', 'run'],
            },
          ],
          trust: { fallbackTier: 'full' },
        },
      },
    });
  });

  it('returns a typed cancellation when selection is already aborted', async () => {
    const value = catalog();
    const controller = new AbortController();
    controller.abort();
    const result = await selectStaticTests(
      value,
      buildGraphReadIndexes(value),
      inventory(),
      ['src/work.ts'],
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'GRAPH.READ.TEST_SELECTION_CANCELLED',
      },
    });
  });

  it('cancels reverse evidence construction after selection has started', async () => {
    const value = catalog();
    const test = occurrence('wide-test', 'src/wide.test.ts', {
      inTestFile: true,
      calls: [
        {
          to: Array.from({ length: 100_001 }, () => 'production'),
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const large: Catalog = {
      ...value,
      functions: { ...value.functions, test: [test] },
    };
    const controller = new AbortController();
    const pending = selectStaticTests(
      large,
      buildGraphReadIndexes(large),
      inventory(),
      ['src/work.ts'],
      { signal: controller.signal },
    );
    setImmediate(() => controller.abort());
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'GRAPH.READ.TEST_SELECTION_CANCELLED' },
    });
  });

  it('caps reverse evidence before materializing more than 100k edges', async () => {
    const value = catalog();
    const test = occurrence('wide-test', 'src/wide.test.ts', {
      inTestFile: true,
      calls: [
        {
          to: Array.from({ length: 100_001 }, () => 'production'),
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const large: Catalog = {
      ...value,
      functions: { ...value.functions, test: [test] },
    };
    const result = await selectStaticTests(large, buildGraphReadIndexes(large), inventory(), [
      'src/work.ts',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        reasonCodes: expect.arrayContaining(['test-selection-edge-cap']),
        coverage: { complete: false },
      },
    });
  });

  it('omits oversized test occurrence, call, and dependency proofs before traversal', async () => {
    const value = catalog();
    const longPrefix = `src/${'x'.repeat(1005)}`;
    const unsafeTest = occurrence('unsafe-test', `src/${'t'.repeat(1021)}`, {
      inTestFile: true,
      calls: [
        {
          to: ['production'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const unsafeCall = occurrence('unsafe-call', `${longPrefix}-call`, {
      inTestFile: true,
      calls: [
        {
          to: ['production'],
          line: Number.MAX_SAFE_INTEGER,
          column: Number.MAX_SAFE_INTEGER,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const unsafeDependency = occurrence('unsafe-dependency', `${longPrefix}-dependency`, {
      inTestFile: true,
      dependencies: [
        {
          to: ['production'],
          line: Number.MAX_SAFE_INTEGER,
          column: Number.MAX_SAFE_INTEGER,
          specifier: './work.js',
        },
      ],
    });
    const malformed: Catalog = {
      ...value,
      functions: {
        production: value.functions.production,
        unsafe: [unsafeTest, unsafeCall, unsafeDependency],
      },
    };
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      project: { ...inventory().project, fileCount: 1 },
      files: [inventory().files[0]],
    };
    const result = await selectStaticTests(malformed, buildGraphReadIndexes(malformed), facts, [
      'src/work.ts',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          tests: [],
          trust: {
            reasonCodes: expect.arrayContaining(['test-selection-malformed-evidence-omitted']),
          },
        },
      },
    });
    if (!result.ok) return;
    expect(testSelectionSnapshotSchema.safeParse(result.value.snapshot).success).toBe(true);
  });

  it('omits hostile occurrence and edge scalars without serializing source text', async () => {
    const value = catalog();
    const secret = 'customer-source-secret';
    const invalidOccurrence = occurrence('invalid-occurrence', 'src/invalid.test.ts', {
      inTestFile: secret as unknown as boolean,
      line: secret as unknown as number,
      calls: [
        {
          to: ['production'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const invalidCall = occurrence('invalid-call', 'src/invalid-call.test.ts', {
      inTestFile: true,
      calls: [
        {
          to: ['production'],
          line: secret as unknown as number,
          column: secret as unknown as number,
          resolution: 'static',
          confidence: secret as unknown as 'high',
          text: 'work()',
        },
        {
          to: secret as unknown as readonly string[],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const invalidDependency = occurrence('invalid-dependency', 'src/invalid-dep.test.ts', {
      inTestFile: true,
      dependencies: [
        {
          to: ['production'],
          line: secret as unknown as number,
          column: 1,
          specifier: './work.js',
        },
      ],
    });
    const malformed: Catalog = {
      ...value,
      functions: {
        production: value.functions.production,
        invalid: [invalidOccurrence, invalidCall, invalidDependency],
      },
    };
    const facts: ProjectInventorySnapshot = {
      ...inventory(),
      project: { ...inventory().project, fileCount: 1 },
      files: [inventory().files[0]],
    };
    const result = await selectStaticTests(malformed, buildGraphReadIndexes(malformed), facts, [
      'src/work.ts',
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          tests: [],
          trust: {
            reasonCodes: expect.arrayContaining(['test-selection-malformed-evidence-omitted']),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('uses the configured source-role matcher to classify custom test roots', async () => {
    const value = catalog();
    const customTest = occurrence('custom-test', 'quality/custom-check.ts', {
      calls: [
        {
          to: ['production'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'work()',
        },
      ],
    });
    const custom: Catalog = {
      ...value,
      functions: {
        production: value.functions.production,
        custom: [customTest],
      },
    };
    const result = await selectStaticTests(
      custom,
      buildGraphReadIndexes(custom),
      inventory(),
      ['src/work.ts'],
      {
        sourceRoleMatcher: {
          matches: (filePath) => filePath.startsWith('quality/'),
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        snapshot: {
          tests: expect.arrayContaining([
            expect.objectContaining({ path: 'quality/custom-check.ts' }),
          ]),
        },
      },
    });
  });

  it('keeps the historical MCP generation-key algorithm', () => {
    expect(
      catalogGenerationKey({
        language: 'typescript',
        cacheKey: 'ck',
        filesFingerprint: 'fp',
        builtAt: '2026-07-09T00:00:00.000Z',
      }),
    ).toMatch(/^g1:[a-f0-9]{64}$/u);
  });
});
