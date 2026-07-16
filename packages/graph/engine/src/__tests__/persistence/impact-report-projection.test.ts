import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  fitProjectionToByteBudget,
  projectImpactForReport,
} from '../../persistence/impact-report-projection.js';
import { CATALOG_IDENTITY_DIGEST_VECTORS } from '../catalog-identity-digest-vectors.fixture.js';

import type { GraphImpactResult, ImpactFunction } from '@opensip-cli/contracts';

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

function fn(index: number, over: Partial<ImpactFunction> = {}): ImpactFunction {
  return {
    qualifiedName: `function_${String(index).padStart(4, '0')}`,
    filePath: `src/file_${String(index).padStart(4, '0')}.ts`,
    line: index + 1,
    package: '@example/project',
    reason: 'caller',
    ...over,
  };
}

function result(over: Partial<GraphImpactResult> = {}): GraphImpactResult {
  return {
    type: 'graph-impact',
    catalog: {
      builtAt: '2026-07-12T00:00:00.000Z',
      language: 'typescript',
      filesFingerprint: digest('files'),
      resolutionMode: 'exact',
      cacheKeyDigest: digest('cache-key'),
    },
    basis: { type: 'files', files: ['src/a.ts'] },
    changedFiles: ['src/a.ts'],
    changedFunctions: [fn(0, { reason: 'changed' })],
    impactedFunctions: [fn(1)],
    impactedFiles: ['src/a.ts', 'src/file_0001.ts'],
    impactedPackages: [{ name: '@example/project', functionCount: 2 }],
    trust: {
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
      uncertainties: [],
    },
    recommendedCommands: ['opensip fit --changed'],
    truncated: false,
    ...over,
  };
}

describe('impact report projection', () => {
  it('sorts by raw code point, applies every collection cap, and records exact omissions', () => {
    const projection = projectImpactForReport(
      result({
        changedFiles: Array.from({ length: 205 }, (_, index) =>
          index === 0 ? 'src/Z.ts' : `src/a_${String(205 - index).padStart(3, '0')}.ts`,
        ),
        changedFunctions: Array.from({ length: 205 }, (_, index) => fn(205 - index)),
        impactedFunctions: Array.from({ length: 505 }, (_, index) => fn(505 - index)),
        impactedFiles: Array.from(
          { length: 505 },
          (_, index) => `src/impact_${String(505 - index).padStart(3, '0')}.ts`,
        ),
        impactedPackages: Array.from({ length: 105 }, (_, index) => ({
          name: `package_${String(105 - index).padStart(3, '0')}`,
          functionCount: index,
        })),
        recommendedCommands: Array.from(
          { length: 25 },
          (_, index) => `opensip command-${String(25 - index).padStart(2, '0')}`,
        ),
      }),
    );

    expect(projection.changedFiles).toHaveLength(200);
    expect(projection.changedFunctions).toHaveLength(200);
    expect(projection.impactedFunctions).toHaveLength(500);
    expect(projection.impactedFiles).toHaveLength(500);
    expect(projection.impactedPackages).toHaveLength(100);
    expect(projection.recommendedCommands).toHaveLength(20);
    expect(projection.omitted).toEqual({
      changedFiles: 5,
      changedFunctions: 5,
      impactedFunctions: 5,
      impactedFiles: 5,
      impactedPackages: 5,
      recommendedCommands: 5,
    });
    expect(projection.detailTruncated).toBe(true);
    expect(projection.changedFiles[0]).toBe('src/Z.ts');
    expect(projection.changedFunctions[0]?.filePath).toBe('src/file_0001.ts');
  });

  it('omits unsafe identities and bounds non-identity trust and basis detail', () => {
    const projection = projectImpactForReport(
      result({
        basis: {
          type: 'changed',
          source: 'git',
          ref: 'r'.repeat(513),
          mergeBase: 'main',
          warnings: [
            {
              code: 'git-shallow',
              message: 'details stay outside the projection',
            },
          ],
        },
        changedFiles: [
          'src/good.ts',
          '/absolute.ts',
          'C:/drive.ts',
          String.raw`src\windows.ts`,
          'src//empty.ts',
          'src/../escape.ts',
          'src/control\u0000.ts'.replace('\\u0000', '\u0000'),
        ],
        changedFunctions: [fn(1), fn(2, { filePath: '../../escape.ts' })],
        impactedPackages: [
          { name: '@safe/pkg', functionCount: 1 },
          { name: 'x'.repeat(513), functionCount: 1 },
        ],
        recommendedCommands: ['opensip fit', 'x'.repeat(513)],
        trust: {
          coverage: 'unknown',
          fallback: 'targeted',
          fullyVerified: false,
          uncertainties: [
            {
              code: 'changed-file-unmatched',
              source: 'files',
              message: `message\u0000${'x'.repeat(600)}`.replace('\\u0000', '\u0000'),
              filePath: '/private/project/file.ts',
            },
          ],
        },
      }),
    );

    expect(projection.changedFiles).toEqual(['src/good.ts']);
    expect(projection.changedFunctions).toHaveLength(1);
    expect(projection.impactedPackages).toEqual([{ name: '@safe/pkg', functionCount: 1 }]);
    expect(projection.recommendedCommands).toEqual(['opensip fit']);
    expect(projection.omitted.changedFiles).toBe(6);
    expect(projection.omitted.changedFunctions).toBe(1);
    expect(projection.omitted.impactedPackages).toBe(1);
    expect(projection.omitted.recommendedCommands).toBe(1);
    expect(projection.basis.ref).toBeUndefined();
    expect(projection.basis.mergeBase).toBe('main');
    expect(projection.trust.uncertainties[0]?.message).toBe(
      'Path-specific uncertainty detail omitted because the path is not project-relative.',
    );
    expect(projection.trust.uncertainties[0]?.message).not.toContain('/private/project');
    expect(projection.trust.uncertainties[0]?.filePath).toBeUndefined();
    expect(projection.detailTruncated).toBe(true);
    expect(projection.metadataOmitted).toBe(true);
  });

  it('bounds and sanitizes uncertainty messages when their project-relative path is safe', () => {
    const projection = projectImpactForReport(
      result({
        trust: {
          coverage: 'unknown',
          fallback: 'targeted',
          fullyVerified: false,
          uncertainties: [
            {
              code: 'changed-file-unmatched',
              source: 'files',
              message: `message\u0000${'x'.repeat(600)}`.replace('\\u0000', '\u0000'),
              filePath: 'src/safe.ts',
            },
          ],
        },
      }),
    );

    expect(projection.trust.uncertainties[0]?.message).toHaveLength(512);
    expect(projection.trust.uncertainties[0]?.message).not.toContain('\u0000');
    expect(projection.trust.uncertainties[0]?.filePath).toBe('src/safe.ts');
    expect(projection.detailTruncated).toBe(true);
  });

  it('trims deterministic collection tails to a UTF-8 byte budget and reports overflow', () => {
    const projection = projectImpactForReport(
      result({
        changedFiles: Array.from({ length: 20 }, (_, index) => `src/${String(index)}.ts`),
        changedFunctions: Array.from({ length: 20 }, (_, index) => fn(index)),
        impactedFunctions: Array.from({ length: 40 }, (_, index) => fn(index + 100)),
        impactedFiles: Array.from({ length: 40 }, (_, index) => `src/i-${String(index)}.ts`),
        impactedPackages: Array.from({ length: 10 }, (_, index) => ({
          name: `pkg-${String(index)}`,
          functionCount: index,
        })),
        recommendedCommands: Array.from(
          { length: 10 },
          (_, index) => `opensip command-${String(index)}`,
        ),
      }),
    );
    const maxBytes = 1800;
    const first = fitProjectionToByteBudget(projection, maxBytes);
    const second = fitProjectionToByteBudget(projection, maxBytes);

    expect(first).toEqual(second);
    expect(first).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(first?.detailTruncated).toBe(true);
    expect(
      Object.values(first?.omitted ?? {}).reduce((sum, value) => sum + value, 0),
    ).toBeGreaterThan(0);
    expect(fitProjectionToByteBudget(projection, 1)).toBeUndefined();
  });

  it('keeps legacy catalog absence explicit and drops malformed catalog identities', () => {
    const legacy = projectImpactForReport(result({ catalog: undefined }));
    expect(legacy.catalog).toBeUndefined();
    expect(legacy.metadataOmitted).toBe(false);

    const malformed = projectImpactForReport(
      result({
        catalog: {
          builtAt: '2026-07-12T00:00:00.000Z',
          language: 'typescript',
          filesFingerprint: '/private/project',
          cacheKeyDigest: 'not-a-digest',
        },
      }),
    );
    expect(malformed.catalog).toBeUndefined();
    expect(malformed.metadataOmitted).toBe(true);
  });
});
