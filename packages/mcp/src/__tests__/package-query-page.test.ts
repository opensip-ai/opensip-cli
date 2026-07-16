import { describe, expect, it } from 'vitest';

import {
  pagePackageCycles,
  pagePackageDependencies,
  pageWhyDepends,
} from '../package-query-page.js';

import type {
  PackageCallEvidence,
  PackageCallEvidenceRow,
  PackageDependencyEvidence,
  PackageImportEvidence,
  PackageImportEvidenceRow,
} from '@opensip-cli/graph/read';

const LABELS = {
  sourceScope: 'production' as const,
  generated: 'exclude' as const,
  catalogResolutionMode: 'exact' as const,
};

const COVERAGE = {
  requested: true,
  complete: true,
  truncated: false,
  reasons: [] as const,
};

const FROM = {
  symbolId: 'src/a.ts:1:0',
  bodyHash: 'ha',
  simpleName: 'fn',
  qualifiedName: 'fn',
  filePath: 'src/a.ts',
  line: 1,
  column: 0,
  kind: 'function-declaration' as const,
  visibility: 'exported' as const,
  package: 'a',
  inTestFile: false,
  definedInGenerated: false,
};

const TO = {
  ...FROM,
  symbolId: 'src/b.ts:1:0',
  bodyHash: 'hb',
  simpleName: 'g',
  qualifiedName: 'g',
  filePath: 'src/b.ts',
  package: 'b',
};

function callEvidence(over: Partial<PackageCallEvidence> = {}): PackageCallEvidence {
  return {
    kind: 'call',
    fromPackage: 'a',
    toPackage: 'b',
    from: FROM,
    to: TO,
    source: { file: 'src/a.ts', line: 1, column: 0 },
    resolution: 'static',
    confidence: 'high',
    crossShard: false,
    ...over,
  };
}

function importEvidence(over: Partial<PackageImportEvidence> = {}): PackageImportEvidence {
  return {
    kind: 'import',
    fromPackage: 'a',
    toPackage: 'b',
    target: 'b',
    resolution: 'internal',
    specifier: './b',
    importSite: { filePath: 'src/a.ts', line: 1, column: 0 },
    ...over,
  };
}

function callRow(over: Partial<PackageCallEvidenceRow> = {}): PackageCallEvidenceRow {
  return {
    ...LABELS,
    fromPackage: 'a',
    toPackage: 'b',
    kind: 'call',
    count: 1,
    countUnit: 'resolved-targets',
    callSiteCount: 1,
    sample: [callEvidence()],
    sampleReturned: 1,
    sampleAvailable: 1,
    sampleLimit: 5,
    coverage: COVERAGE,
    ...over,
  };
}

function importRow(over: Partial<PackageImportEvidenceRow> = {}): PackageImportEvidenceRow {
  return {
    ...LABELS,
    fromPackage: 'a',
    toPackage: 'b',
    target: 'b',
    kind: 'import',
    resolution: 'internal',
    count: 1,
    countUnit: 'import-statements',
    sample: [importEvidence()],
    sampleReturned: 1,
    sampleAvailable: 1,
    sampleLimit: 5,
    coverage: COVERAGE,
    ...over,
  };
}

const PAGE = {
  projectKey: 'b'.repeat(24),
  generationKey: 'g1:test',
  queryDigest: 'c'.repeat(64),
} as const;

describe('package-query-page', () => {
  it('pages package dependencies with package and file grouping', () => {
    const rows = [callRow(), importRow(), callRow({ fromPackage: 'c', toPackage: 'd' })];
    const none = pagePackageDependencies(rows, { ...PAGE, limit: 2 }, 'none');
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.value.rows).toHaveLength(2);
    expect(none.value.nextCursor).toBeDefined();

    const byPkg = pagePackageDependencies(rows, { ...PAGE, limit: 10 }, 'package');
    expect(byPkg.ok).toBe(true);
    if (!byPkg.ok) return;
    expect(byPkg.value.groups?.length).toBeGreaterThan(0);

    const byFile = pagePackageDependencies([callRow()], { ...PAGE, limit: 10 }, 'file');
    expect(byFile.ok).toBe(true);

    const emptySample = pagePackageDependencies(
      [callRow({ sample: [] })],
      { ...PAGE, limit: 10 },
      'file',
    );
    expect(emptySample.ok).toBe(true);
  });

  it('pages why-depends call and import evidence', () => {
    const evidence: PackageDependencyEvidence[] = [
      callEvidence(),
      importEvidence({ importSite: { filePath: 'src/a.ts', line: 2, column: 0 } }),
    ];
    const paged = pageWhyDepends(evidence, { ...PAGE, limit: 10 }, 'file');
    expect(paged.ok).toBe(true);
    if (!paged.ok) return;
    expect(paged.value.rows).toHaveLength(2);

    const byPkg = pageWhyDepends([callEvidence()], { ...PAGE, limit: 10 }, 'package');
    expect(byPkg.ok).toBe(true);
  });

  it('pages package cycles with package grouping', () => {
    const paged = pagePackageCycles(
      [
        { packages: ['a', 'b'], proofEdges: [], totalProofEdges: 0 },
        { packages: ['x'], proofEdges: [], totalProofEdges: 0 },
      ],
      { ...PAGE, limit: 1 },
      'package',
    );
    expect(paged.ok).toBe(true);
    if (!paged.ok) return;
    expect(paged.value.rows).toHaveLength(1);
    expect(paged.value.nextCursor).toBeDefined();

    const byFile = pagePackageCycles(
      [{ packages: ['a'], proofEdges: [], totalProofEdges: 0 }],
      { ...PAGE, limit: 10 },
      'file',
    );
    expect(byFile.ok).toBe(true);
  });
});
