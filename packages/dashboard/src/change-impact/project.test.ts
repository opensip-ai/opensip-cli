import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CATALOG_IDENTITY_DIGEST_VECTORS } from './__tests__/catalog-identity-digest-vectors.fixture.js';
import { boundChangeImpactRuns, projectChangeImpactRuns } from './project.js';

import type { DashboardRun } from '../generator.js';
import type {
  GraphCatalog,
  ReviewBrief,
  StoredRunStep,
  StoredSession,
} from '@opensip-cli/contracts';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('catalog identity digest vectors', () => {
  it.each(CATALOG_IDENTITY_DIGEST_VECTORS)(
    'matches frozen SHA-256 for $input',
    ({ input, digest: expected }) => {
      expect(digest(input)).toBe(expected);
    },
  );
});

const catalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-07-12T00:00:00.000Z',
  cacheKey: 'catalog-key',
  filesFingerprint: '1\nsrc/a.ts|1|1',
  resolutionMode: 'exact',
  functions: {
    changed: [
      {
        bodyHash: 'body-changed',
        simpleName: 'changed',
        qualifiedName: 'src.changed',
        filePath: 'src/a.ts',
        line: 1,
        column: 0,
        endLine: 2,
        kind: 'function-declaration',
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        visibility: 'exported',
        inTestFile: false,
        definedInGenerated: false,
        calls: [],
      },
    ],
  },
};

const brief: ReviewBrief = {
  version: 1,
  suite: 'audit',
  suiteRunId: 'suite-1',
  verdict: 'warn',
  changedFiles: 1,
  topRisks: [],
  newFindings: [],
  baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
  degraded: [],
  recommendedActions: [],
};

function step(overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-graph',
    runId: 'run-1',
    logicalStepKey: '1:graph:impact',
    ordinal: 1,
    attempt: 1,
    tool: 'graph',
    command: 'impact',
    stableId: 'graph',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 10,
    sessionId: 'session-graph',
    ...overrides,
  };
}

function run(overrides: Partial<DashboardRun> = {}): DashboardRun {
  return {
    id: 'run-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 1,
      passed: 1,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 1,
    },
    scope: { mode: 'changed', source: 'explicit', changedFiles: 1 },
    reviewBrief: brief,
    steps: [step()],
    ...overrides,
  };
}

function impact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog: {
      builtAt: catalog.builtAt,
      language: catalog.language,
      filesFingerprint: digest(catalog.filesFingerprint ?? ''),
      resolutionMode: catalog.resolutionMode,
      cacheKeyDigest: digest(catalog.cacheKey ?? ''),
    },
    basis: { type: 'files', warningCodes: [] },
    changedFiles: ['src/a.ts'],
    changedFunctions: [
      {
        qualifiedName: 'src.changed',
        filePath: 'src/a.ts',
        line: 1,
        package: 'src',
        reason: 'changed',
      },
    ],
    impactedFunctions: [],
    impactedFiles: [],
    impactedPackages: [],
    trust: {
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
      uncertainties: [],
    },
    recommendedCommands: ['opensip fit --changed'],
    truncated: false,
    omitted: {
      changedFiles: 0,
      changedFunctions: 0,
      impactedFunctions: 0,
      impactedFiles: 0,
      impactedPackages: 0,
      recommendedCommands: 0,
    },
    detailTruncated: false,
    metadataOmitted: false,
    ...overrides,
  };
}

function session(payload?: unknown): StoredSession {
  const sessionPayload =
    payload === undefined ? { __version: 1, impactStatus: 'available', impact: impact() } : payload;
  return {
    id: 'session-graph',
    tool: 'graph',
    cwd: '/repo',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:01.000Z',
    durationMs: 1000,
    score: 100,
    passed: true,
    payload: sessionPayload,
  };
}

describe('projectChangeImpactRuns', () => {
  it('joins only through the graph RunStep session ID and qualifies unique Code Paths handles', () => {
    const unrelatedLatest = session({
      __version: 1,
      impactStatus: 'omitted-overflow',
    });
    const result = projectChangeImpactRuns(
      [run()],
      [{ ...unrelatedLatest, id: 'newer-unlinked' }, session()],
      catalog,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      runId: 'run-1',
      availability: 'available',
      catalogMatch: 'matching',
      zeroImpact: true,
      evidence: {
        changedFunctions: [{ bodyHash: 'body-changed', navigation: 'available' }],
      },
    });
    expect(result[0]?.reviewBrief).toEqual(brief);
  });

  it('never infers PASS when the authoritative ReviewBrief is missing', () => {
    const models = projectChangeImpactRuns(
      [
        run({ id: 'run-success', reviewBrief: undefined }),
        run({ id: 'run-failed', exitCode: 1, reviewBrief: undefined }),
      ],
      [session()],
      catalog,
    );
    const successfulLegacy = models.find((model) => model.runId === 'run-success');
    const failedLegacy = models.find((model) => model.runId === 'run-failed');

    expect(successfulLegacy).toMatchObject({ reviewBriefState: 'missing', verdict: 'warn' });
    expect(failedLegacy).toMatchObject({ reviewBriefState: 'missing', verdict: 'fail' });
  });

  it.each([
    ['step-faulted', run({ steps: [step({ outcome: 'faulted', sessionId: undefined })] }), []],
    ['missing-session', run({ steps: [step({ sessionId: 'missing' })] }), []],
    ['legacy', run(), [session({ __version: 1 })]],
    ['projection-degraded', run(), [session({ __version: 1, impactStatus: 'omitted-overflow' })]],
    [
      'malformed',
      run(),
      [
        session({
          __version: 1,
          impactStatus: 'available',
          impact: { changedFiles: ['/escape'] },
        }),
      ],
    ],
  ] as const)('makes %s evidence explicit without throwing', (availability, auditRun, sessions) => {
    expect(projectChangeImpactRuns([auditRun], sessions, catalog)[0]?.availability).toBe(
      availability,
    );
  });

  it('keeps partial zero counts conservative and disables drilldown for catalog mismatch', () => {
    const partial = impact({
      trust: {
        coverage: 'partial',
        fallback: 'targeted',
        fullyVerified: false,
        uncertainties: [
          {
            code: 'changed-file-unmatched',
            source: 'files',
            message: 'One changed file was not represented in the catalog.',
            filePath: 'src/a.ts',
          },
        ],
      },
    });
    const otherCatalog = { ...catalog, cacheKey: 'different' };
    const [model] = projectChangeImpactRuns(
      [run()],
      [session({ __version: 1, impactStatus: 'available', impact: partial })],
      otherCatalog,
    );

    expect(model).toMatchObject({
      availability: 'available',
      zeroImpact: true,
      catalogMatch: 'mismatched',
      evidence: {
        trust: { coverage: 'partial', fullyVerified: false },
        changedFunctions: [{ navigation: 'catalog-unavailable' }],
      },
    });
  });

  it('requires the current catalog build identity to match the stored audit catalog', () => {
    const rebuiltCatalog = { ...catalog, builtAt: '2026-07-12T00:00:01.000Z' };
    const [model] = projectChangeImpactRuns([run()], [session()], rebuiltCatalog);

    expect(model).toMatchObject({
      availability: 'available',
      catalogMatch: 'mismatched',
      evidence: { changedFunctions: [{ navigation: 'catalog-unavailable' }] },
    });
  });

  it('rejects loose step identities, wrong-tool session links, and malformed catalog identity', () => {
    const looseStep = run({ steps: [step({ command: 'unrelated impact' })] });
    expect(projectChangeImpactRuns([looseStep], [session()], catalog)[0]?.availability).toBe(
      'missing-session',
    );

    expect(
      projectChangeImpactRuns([run()], [{ ...session(), tool: 'fit' }], catalog)[0]?.availability,
    ).toBe('malformed');

    const invalidCatalogIdentity = impact({
      catalog: {
        builtAt: 'not-a-date',
        language: 'typescript',
        filesFingerprint: digest('files'),
        resolutionMode: 'surprising',
        cacheKeyDigest: digest('key'),
      },
    });
    expect(
      projectChangeImpactRuns(
        [run()],
        [
          session({
            __version: 1,
            impactStatus: 'available',
            impact: invalidCatalogIdentity,
          }),
        ],
        catalog,
      )[0]?.availability,
    ).toBe('malformed');
  });

  it('marks a current-catalog tuple with multiple bodies as ambiguous', () => {
    const ambiguousCatalog: GraphCatalog = {
      ...catalog,
      functions: {
        ...catalog.functions,
        duplicate: [
          {
            ...catalog.functions.changed[0],
            bodyHash: 'second-body',
          },
        ],
      },
    };
    const [model] = projectChangeImpactRuns([run()], [session()], ambiguousCatalog);
    expect(model?.evidence?.changedFunctions[0]).toMatchObject({
      navigation: 'ambiguous',
    });
    expect(model?.evidence?.changedFunctions[0]?.bodyHash).toBeUndefined();
  });

  it('isolates malformed runs, orders deterministically, and bounds history while retaining selection', () => {
    const runs = Array.from({ length: 7 }, (_, index) =>
      run({
        id: `run-${String(index)}`,
        completedAt: `2026-07-12T00:00:0${String(index)}.000Z`,
        steps: [step({ runId: `run-${String(index)}` })],
      }),
    );
    const models = projectChangeImpactRuns(runs, [session()], catalog);
    const bounded = boundChangeImpactRuns(models, 'run-0');

    expect(models.map((model) => model.runId)).toEqual([
      'run-6',
      'run-5',
      'run-4',
      'run-3',
      'run-2',
      'run-1',
      'run-0',
    ]);
    expect(bounded.runs).toHaveLength(5);
    expect(bounded.runs.some((model) => model.runId === 'run-0')).toBe(true);
    expect(bounded.omittedRuns).toBe(2);
  });

  it('enforces the aggregate byte ceiling even for oversized stored review arrays', () => {
    const hugeRisk = {
      source: 'fit',
      ruleId: 'huge-risk',
      message: 'x'.repeat(3000),
      severity: 'high' as const,
      file: 'src/a.ts',
      isNew: true,
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite-1',
        stepIndex: 0,
        signalIndex: 0,
      },
    };
    const oversizedRun = run({
      reviewBrief: {
        ...brief,
        topRisks: Array.from({ length: 30 }, () => hugeRisk),
        newFindings: Array.from({ length: 30 }, () => hugeRisk),
      },
    });
    const models = projectChangeImpactRuns([oversizedRun], [session()], catalog);
    const bounded = boundChangeImpactRuns(models, 'run-1', 20_000);

    expect(Buffer.byteLength(JSON.stringify(bounded.runs), 'utf8')).toBeLessThanOrEqual(20_000);
    expect(bounded.runs[0]?.runId).toBe('run-1');
    expect(bounded.runs[0]?.verdict).toBe('warn');
    expect(bounded.runs[0]?.reportOmitted.risks).toBeGreaterThan(0);
    expect(bounded.runs[0]?.reportOmitted.newFindings).toBeGreaterThan(0);

    const impossible = boundChangeImpactRuns(models, 'run-1', 1);
    expect(impossible.runs).toEqual([]);
    expect(impossible.omittedRuns).toBe(1);
  });

  it('preserves a bounded audit placeholder when oversized scalar presentation text remains', () => {
    const oversizedNotice = 'scope notice '.repeat(20_000);
    const models = projectChangeImpactRuns(
      [
        run({
          scope: {
            mode: 'changed',
            source: 'fallback',
            changedFiles: 1,
            notice: oversizedNotice,
          },
        }),
      ],
      [session()],
      catalog,
    );
    const bounded = boundChangeImpactRuns(models, 'run-1', 5000);

    expect(Buffer.byteLength(JSON.stringify(bounded.runs), 'utf8')).toBeLessThanOrEqual(5000);
    expect(bounded.omittedRuns).toBe(0);
    expect(bounded.runs).toHaveLength(1);
    expect(bounded.runs[0]).toMatchObject({
      runId: 'run-1',
      availabilityReason:
        'Detailed Change Impact presentation was omitted by the report byte budget.',
      sourceTruncated: true,
      zeroImpact: false,
      evidence: {
        changedFiles: [],
        changedFunctions: [],
        recommendedCommands: [],
      },
      reportOmitted: {
        changedFiles: 1,
        changedFunctions: 1,
        recommendedCommands: 1,
      },
    });
    expect(bounded.runs[0]?.scope?.notice).toHaveLength(512);
    expect(bounded.runs[0]?.scope?.notice).toMatch(/…$/u);
    expect(models[0]?.scope?.notice).toBe(oversizedNotice);
  });

  it('drops malformed or oversized ReviewBrief data without discarding valid impact evidence', () => {
    const malformedBrief = {
      ...brief,
      topRisks: { blob: 'x'.repeat(600_000) },
    } as unknown as ReviewBrief;

    const [model] = projectChangeImpactRuns(
      [run({ reviewBrief: malformedBrief })],
      [session()],
      catalog,
    );

    expect(model).toMatchObject({
      availability: 'available',
      reviewBriefState: 'malformed',
      verdict: 'warn',
      evidence: { changedFiles: ['src/a.ts'] },
    });
    expect(model?.reviewBrief).toBeUndefined();
    expect(() => boundChangeImpactRuns(model ? [model] : [], 'run-1')).not.toThrow();
  });

  it('carries a valid brief above 512 KiB into the real 2 MiB deterministic trimmer', () => {
    const largeRisk = {
      source: 'fit',
      ruleId: 'large-risk',
      message: 'r'.repeat(12_000),
      severity: 'high' as const,
      file: 'src/a.ts',
      isNew: true,
      signalRef: {
        tool: 'fit',
        suiteRunId: 'suite-1',
        stepIndex: 0,
        signalIndex: 0,
      },
    };
    const largeBrief: ReviewBrief = {
      ...brief,
      topRisks: Array.from({ length: 100 }, () => largeRisk),
      newFindings: Array.from({ length: 100 }, () => largeRisk),
    };
    const models = projectChangeImpactRuns(
      [run({ reviewBrief: largeBrief })],
      [session()],
      catalog,
    );

    expect(Buffer.byteLength(JSON.stringify(models), 'utf8')).toBeGreaterThan(2_097_152);
    const bounded = boundChangeImpactRuns(models, 'run-1');
    expect(Buffer.byteLength(JSON.stringify(bounded.runs), 'utf8')).toBeLessThanOrEqual(2_097_152);
    expect(bounded.runs[0]?.reviewBriefState).toBe('available');
    expect(bounded.runs[0]?.reportOmitted.newFindings).toBeGreaterThan(0);
    expect(boundChangeImpactRuns(models, 'run-1')).toEqual(bounded);
    expect(largeBrief.topRisks).toHaveLength(100);
    expect(largeBrief.newFindings).toHaveLength(100);
  });
});
