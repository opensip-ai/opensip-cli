/**
 * ADR-0178 regression: occurrence-local rules must not skip a production twin
 * when a same-body test twin wins the `byBodyHash` last-writer slot.
 *
 * Index build walks catalog.functions in key order then occurrence order; the
 * last twin written for a body hash is the byBodyHash winner. Inserting the
 * test twin AFTER the production twin reproduces the gate-skip failure mode.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { highBlastUntestedRule } from '../../rules/high-blast-untested.js';
import { largeFunctionRule } from '../../rules/large-function.js';
import { wideFunctionRule } from '../../rules/wide-function.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FeatureTable, GraphConfig, Param } from '../../types.js';

function params(n: number): Param[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `p${String(i)}`,
    optional: false,
    rest: false,
  }));
}

/**
 * Production twin first, test twin second → test wins byBodyHash.
 * Under winner-only iteration + inTestFile skip, production is never evaluated.
 */
function prodThenTestTwins(over: {
  readonly bodyHash: string;
  readonly simpleName: string;
  readonly endLine?: number;
  readonly params?: Param[];
}) {
  const prod = occ({
    bodyHash: over.bodyHash,
    simpleName: over.simpleName,
    filePath: 'src/prod.ts',
    line: 1,
    endLine: over.endLine ?? 5,
    params: over.params ?? [],
    inTestFile: false,
    qualifiedName: `src/prod.${over.simpleName}`,
  });
  const testTwin = occ({
    bodyHash: over.bodyHash,
    simpleName: over.simpleName,
    filePath: 'src/prod.test.ts',
    line: 1,
    endLine: over.endLine ?? 5,
    params: over.params ?? [],
    inTestFile: true,
    qualifiedName: `src/prod.test.${over.simpleName}`,
  });
  // Catalog name-bucket order: test last so byBodyHash winner is the test twin.
  const catalog = makeCatalog([prod, testTwin]);
  const indexes = buildIndexes(catalog);
  expect(indexes.byBodyHash.get(over.bodyHash)?.inTestFile).toBe(true);
  expect(indexes.occurrencesByHash.get(over.bodyHash)).toHaveLength(2);
  return { catalog, indexes, prod, testTwin };
}

describe('ADR-0178 body-twin occurrence rules (test twin wins byBodyHash)', () => {
  it('large-function still flags the production twin when the test twin wins the hash slot', () => {
    const { catalog, indexes } = prodThenTestTwins({
      bodyHash: 'TWIN',
      simpleName: 'huge',
      endLine: 200,
    });
    const config: GraphConfig = {
      largeFunctionWarnLines: 80,
      largeFunctionErrorLines: 150,
    };
    const signals = largeFunctionRule.evaluate(catalog, indexes, config);
    expect(signals.map((s) => s.filePath)).toEqual(['src/prod.ts']);
    expect(signals[0]?.metadata.bodyLines).toBe(200);
  });

  it('wide-function still flags the production twin when the test twin wins the hash slot', () => {
    const { catalog, indexes } = prodThenTestTwins({
      bodyHash: 'WIDE',
      simpleName: 'wideFn',
      params: params(9),
    });
    const config: GraphConfig = {
      wideFunctionWarnParams: 4,
      wideFunctionErrorParams: 7,
    };
    const signals = wideFunctionRule.evaluate(catalog, indexes, config);
    expect(signals.map((s) => s.filePath)).toEqual(['src/prod.ts']);
    expect(signals[0]?.metadata.paramCount).toBe(9);
  });

  it('high-blast-untested still flags the production twin when the test twin wins the hash slot', () => {
    const { catalog, indexes } = prodThenTestTwins({
      bodyHash: 'BLAST',
      simpleName: 'hot',
    });
    const features: FeatureTable = {
      function: new Map([
        [
          'BLAST',
          {
            bodyLines: 5,
            blast: { direct: 25, transitive: 0, score: 25 },
            testReachable: false,
          },
        ],
      ]),
      package: new Map(),
      scc: [],
      edge: [],
    };
    const config: GraphConfig = {
      highBlastWarnThreshold: 8,
      highBlastErrorThreshold: 20,
    };
    const signals = highBlastUntestedRule.evaluate(
      catalog,
      indexes,
      config,
      undefined,
      features,
    );
    expect(signals.map((s) => s.filePath)).toEqual(['src/prod.ts']);
    expect(signals[0]?.severity).toBe('high');
  });
});
