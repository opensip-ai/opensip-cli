import { describe, expect, it } from 'vitest';

import {
  fitProjectionToByteBudget,
  MAX_IMPACT_REPORT_PROJECTION_BYTES,
  projectImpactForReport,
  type GraphImpactReportProjection,
} from '../../persistence/impact-report-projection.js';

import type {
  GraphImpactResult,
  ImpactFunction,
  ImpactTrustCoverage,
  ImpactUncertaintyCode,
} from '@opensip-cli/contracts';

function impactFunction(index: number): ImpactFunction {
  return {
    qualifiedName: `function_${String(index).padStart(4, '0')}`,
    filePath: `src/file_${String(index).padStart(4, '0')}.ts`,
    line: index + 1,
    package: `package_${String(index % 10)}`,
    reason: index % 2 === 0 ? 'changed' : 'caller',
  };
}

function result(overrides: Partial<GraphImpactResult> = {}): GraphImpactResult {
  return {
    type: 'graph-impact',
    basis: { type: 'files', files: [] },
    changedFiles: [],
    changedFunctions: [],
    impactedFunctions: [],
    impactedFiles: [],
    impactedPackages: [],
    trust: {
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
      uncertainties: [],
    },
    recommendedCommands: [],
    truncated: false,
    ...overrides,
  };
}

interface CollectionBoundaryCase {
  readonly name: string;
  readonly cap: number;
  readonly override: (count: number) => Partial<GraphImpactResult>;
  readonly retained: (projection: GraphImpactReportProjection) => readonly unknown[];
  readonly omitted: (projection: GraphImpactReportProjection) => number;
}

const COLLECTION_BOUNDARIES: readonly CollectionBoundaryCase[] = [
  {
    name: 'changed files',
    cap: 200,
    override: (count) => ({
      changedFiles: Array.from({ length: count }, (_, index) => `src/changed-${String(index)}.ts`),
    }),
    retained: (projection) => projection.changedFiles,
    omitted: (projection) => projection.omitted.changedFiles,
  },
  {
    name: 'changed functions',
    cap: 200,
    override: (count) => ({
      changedFunctions: Array.from({ length: count }, (_, index) => impactFunction(index)),
    }),
    retained: (projection) => projection.changedFunctions,
    omitted: (projection) => projection.omitted.changedFunctions,
  },
  {
    name: 'impacted functions',
    cap: 500,
    override: (count) => ({
      impactedFunctions: Array.from({ length: count }, (_, index) => impactFunction(index)),
    }),
    retained: (projection) => projection.impactedFunctions,
    omitted: (projection) => projection.omitted.impactedFunctions,
  },
  {
    name: 'impacted files',
    cap: 500,
    override: (count) => ({
      impactedFiles: Array.from({ length: count }, (_, index) => `src/impact-${String(index)}.ts`),
    }),
    retained: (projection) => projection.impactedFiles,
    omitted: (projection) => projection.omitted.impactedFiles,
  },
  {
    name: 'impacted packages',
    cap: 100,
    override: (count) => ({
      impactedPackages: Array.from({ length: count }, (_, index) => ({
        name: `package-${String(index)}`,
        functionCount: index,
      })),
    }),
    retained: (projection) => projection.impactedPackages,
    omitted: (projection) => projection.omitted.impactedPackages,
  },
  {
    name: 'recommended commands',
    cap: 20,
    override: (count) => ({
      recommendedCommands: Array.from(
        { length: count },
        (_, index) => `opensip command-${String(index)}`,
      ),
    }),
    retained: (projection) => projection.recommendedCommands,
    omitted: (projection) => projection.omitted.recommendedCommands,
  },
];

function deepFreezeResult(value: GraphImpactResult): GraphImpactResult {
  const freezeRows = <T extends object>(rows: readonly T[]): readonly T[] =>
    Object.freeze(rows.map((row) => Object.freeze(row)));
  Object.freeze(value.basis);
  Object.freeze(value.changedFiles);
  freezeRows(value.changedFunctions);
  freezeRows(value.impactedFunctions);
  Object.freeze(value.impactedFiles);
  freezeRows(value.impactedPackages);
  freezeRows(value.trust.uncertainties);
  Object.freeze(value.trust);
  Object.freeze(value.recommendedCommands);
  return Object.freeze(value);
}

describe('impact report projection boundaries', () => {
  it('pins the production projection ceiling to exactly one MiB', () => {
    expect(MAX_IMPACT_REPORT_PROJECTION_BYTES).toBe(1024 * 1024);
    expect(MAX_IMPACT_REPORT_PROJECTION_BYTES).toBe(1_048_576);
  });

  it.each(COLLECTION_BOUNDARIES)('enforces zero/below/at/+1 for $name', (boundary) => {
    for (const count of [0, boundary.cap - 1, boundary.cap, boundary.cap + 1]) {
      const projection = projectImpactForReport(result(boundary.override(count)));
      expect(
        boundary.retained(projection),
        `${boundary.name} retained at ${String(count)}`,
      ).toHaveLength(Math.min(count, boundary.cap));
      expect(boundary.omitted(projection), `${boundary.name} omitted at ${String(count)}`).toBe(
        Math.max(0, count - boundary.cap),
      );
    }
  });

  it('is deterministic for shuffled duplicates and does not mutate frozen inputs', () => {
    const orderA = [3, 1, 2, 1, 0];
    const orderB = [1, 0, 3, 1, 2];
    const build = (order: readonly number[]): GraphImpactResult =>
      deepFreezeResult(
        result({
          changedFiles: Object.freeze(order.map((index) => `src/${String(index)}.ts`)),
          changedFunctions: Object.freeze(order.map(impactFunction)),
          impactedFunctions: Object.freeze(order.map(impactFunction)),
          impactedFiles: Object.freeze(order.map((index) => `src/i-${String(index)}.ts`)),
          impactedPackages: Object.freeze(
            order.map((index) => ({
              name: `package-${String(index)}`,
              functionCount: index,
            })),
          ),
          recommendedCommands: Object.freeze(
            order.map((index) => `opensip command-${String(index)}`),
          ),
        }),
      );
    const firstInput = build(orderA);
    const secondInput = build(orderB);
    const firstBefore = JSON.stringify(firstInput);
    const secondBefore = JSON.stringify(secondInput);

    const first = projectImpactForReport(firstInput);
    const second = projectImpactForReport(secondInput);

    expect(first).toEqual(second);
    expect(first.changedFiles).toEqual([
      'src/0.ts',
      'src/1.ts',
      'src/1.ts',
      'src/2.ts',
      'src/3.ts',
    ]);
    expect(JSON.stringify(firstInput)).toBe(firstBefore);
    expect(JSON.stringify(secondInput)).toBe(secondBefore);
    expect(Object.isFrozen(firstInput.changedFunctions)).toBe(true);
    expect(Object.isFrozen(firstInput.changedFunctions[0])).toBe(true);
  });

  it('measures an exact multibyte budget in UTF-8 bytes', () => {
    const projection = projectImpactForReport(
      result({
        recommendedCommands: [
          `opensip first-${'🧪'.repeat(100)}`,
          `opensip second-${'界'.repeat(100)}`,
        ],
      }),
    );
    const serialized = JSON.stringify(projection);
    const exactBytes = Buffer.byteLength(serialized, 'utf8');

    expect(exactBytes).toBeGreaterThan(serialized.length);
    expect(fitProjectionToByteBudget(projection, exactBytes)).toBe(projection);
    const below = fitProjectionToByteBudget(projection, exactBytes - 1);
    expect(below).toBeDefined();
    expect(below).not.toEqual(projection);
    expect(Buffer.byteLength(JSON.stringify(below), 'utf8')).toBeLessThanOrEqual(exactBytes - 1);
  });

  it('accepts exact 4096-path and 512-display boundaries and rejects +1', () => {
    const exactPath = `src/${'p'.repeat(4092)}`;
    const oversizedPath = `${exactPath}p`;
    const exactDisplay = 'c'.repeat(512);
    const oversizedDisplay = `${exactDisplay}c`;

    expect(exactPath).toHaveLength(4096);
    expect(exactDisplay).toHaveLength(512);
    const projection = projectImpactForReport(
      result({
        changedFiles: [oversizedPath, exactPath],
        recommendedCommands: [oversizedDisplay, exactDisplay],
      }),
    );

    expect(projection.changedFiles).toEqual([exactPath]);
    expect(projection.recommendedCommands).toEqual([exactDisplay]);
    expect(projection.omitted.changedFiles).toBe(1);
    expect(projection.omitted.recommendedCommands).toBe(1);
  });

  it.each([
    ['full', 'targeted', true],
    ['partial', 'full-run', false],
    ['unknown', 'targeted', false],
  ] as const)(
    'preserves %s trust coverage',
    (coverage: ImpactTrustCoverage, fallback, fullyVerified) => {
      const projection = projectImpactForReport(
        result({
          trust: { coverage, fallback, fullyVerified, uncertainties: [] },
        }),
      );

      expect(projection.trust).toMatchObject({
        coverage,
        fallback,
        fullyVerified,
      });
    },
  );

  it('preserves every uncertainty code through the bounded display projection', () => {
    const codes = [
      'git-shallow',
      'git-merge-base-unavailable',
      'changed-file-deleted',
      'changed-file-renamed',
      'changed-file-unmatched',
      'graph-catalog-unavailable',
      'graph-catalog-incomplete',
      'graph-catalog-approximate',
      'impact-uncertainty-truncated',
      'impact-truncated',
      'suite-step-unverified',
    ] as const satisfies readonly ImpactUncertaintyCode[];
    const projection = projectImpactForReport(
      result({
        trust: {
          coverage: 'unknown',
          fallback: 'targeted',
          fullyVerified: false,
          uncertainties: codes.map((code, index) => ({
            code,
            source: 'impact',
            message: `Bounded uncertainty ${code}`,
            filePath: `src/file-${String(index)}.ts`,
          })),
        },
      }),
    );

    expect(projection.trust.uncertainties.map((uncertainty) => uncertainty.code)).toEqual(codes);
    expect(projection.trust.uncertainties).toHaveLength(codes.length);
    expect(projection.metadataOmitted).toBe(false);
  });
});
