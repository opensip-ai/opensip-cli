import { describe, expect, it } from 'vitest';

import { makeCatalog, occ } from '../../__tests__/rules/_helpers.js';
import {
  NEAR_DUP_SIGNATURE_K,
  bodySignature,
  estimateJaccard,
} from '../../lang-adapter/near-duplicate-signature.js';
import { buildIndexes } from '../../pipeline/indexes.js';
import { nearDuplicateFunctionBodyRule } from '../near-duplicate-function-body.js';

import type { FunctionOccurrence } from '../../types.js';

const PAYLOAD = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(12);
const BASE_BODY = `function work(items) { const payload = "${PAYLOAD}"; let total = 0; for (const item of items) { total += item.length + payload.length; } return total; }`;
const NEAR_BODY = `function work(items) { const payload = "${PAYLOAD}"; let total = 0; for (const item of items) { total += item.length + payload.length + 1; } return total; }`;
const UNRELATED =
  'export function validateConfig(cfg) { if (!cfg.apiKey) throw new Error("missing"); return cfg; }';

function withSignature(over: Parameters<typeof occ>[0], canonical: string): FunctionOccurrence {
  const signature = [...bodySignature(canonical)];
  return occ({ ...over, bodySignature: signature, bodySize: canonical.length });
}

function evaluateNear(
  catalog: ReturnType<typeof makeCatalog>,
  config: Parameters<typeof nearDuplicateFunctionBodyRule.evaluate>[2] = {},
) {
  return nearDuplicateFunctionBodyRule.evaluate(catalog, buildIndexes(catalog), config);
}

describe('near-duplicate-function-body', () => {
  it('flags near-clone pairs above the similarity threshold', () => {
    const sigA = bodySignature(BASE_BODY);
    const sigB = bodySignature(NEAR_BODY);
    expect(estimateJaccard(sigA, sigB)).toBeGreaterThanOrEqual(0.85);

    const a = withSignature(
      {
        bodyHash: 'hash-a',
        simpleName: 'processA',
        filePath: 'src/a.ts',
        line: 10,
      },
      BASE_BODY,
    );
    const b = withSignature(
      {
        bodyHash: 'hash-b',
        simpleName: 'processB',
        filePath: 'src/b.ts',
        line: 20,
        qualifiedName: 'src/b.processB',
      },
      NEAR_BODY,
    );
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals.length).toBe(1);
    expect(signals[0]?.ruleId).toBe('graph:near-duplicate-function-body');
    expect(signals[0]?.metadata?.nearMembers).toEqual(
      expect.arrayContaining(['src/a.processA', 'src/b.processB']),
    );
  });

  it('does not flag exact-duplicate pairs (duplicated-function-body owns those)', () => {
    const a = withSignature({ bodyHash: 'same', simpleName: 'dupA' }, BASE_BODY);
    const b = withSignature(
      {
        bodyHash: 'same',
        simpleName: 'dupB',
        filePath: 'src/b.ts',
        qualifiedName: 'src/b.dupB',
      },
      BASE_BODY,
    );
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals).toHaveLength(0);
  });

  it('skips test-file occurrences', () => {
    const a = withSignature({ bodyHash: 'a', simpleName: 'a', inTestFile: true }, BASE_BODY);
    const b = withSignature(
      {
        bodyHash: 'b',
        simpleName: 'b',
        filePath: 'src/b.ts',
        qualifiedName: 'src/b.b',
      },
      NEAR_BODY,
    );
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals).toHaveLength(0);
  });

  it('is graceful when bodySignature is absent', () => {
    const a = occ({ bodyHash: 'a', simpleName: 'a' });
    const b = occ({ bodyHash: 'b', simpleName: 'b', filePath: 'src/b.ts' });
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals).toHaveLength(0);
  });

  it('does not flag cross-language pairs (same-language gate)', () => {
    const a = withSignature(
      { bodyHash: 'go-hash', simpleName: 'work', filePath: 'main.go', line: 1 },
      BASE_BODY,
    );
    const b = withSignature(
      {
        bodyHash: 'ts-hash',
        simpleName: 'work',
        filePath: 'src/work.ts',
        line: 1,
        qualifiedName: 'src/work.work',
      },
      BASE_BODY,
    );
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals).toHaveLength(0);
  });

  it('merges transitive near pairs via union-find', () => {
    const body1 = BASE_BODY;
    const body2 = NEAR_BODY;
    const body3 = body2.replace('+ 1', '+ 2');

    const a = withSignature({ bodyHash: 'h1', simpleName: 'a', line: 1 }, body1);
    const b = withSignature(
      {
        bodyHash: 'h2',
        simpleName: 'b',
        filePath: 'src/b.ts',
        line: 2,
        qualifiedName: 'src/b.b',
      },
      body2,
    );
    const c = withSignature(
      {
        bodyHash: 'h3',
        simpleName: 'c',
        filePath: 'src/c.ts',
        line: 3,
        qualifiedName: 'src/c.c',
      },
      body3,
    );

    expect(estimateJaccard(bodySignature(body1), bodySignature(body2))).toBeGreaterThanOrEqual(
      0.85,
    );
    expect(estimateJaccard(bodySignature(body2), bodySignature(body3))).toBeGreaterThanOrEqual(
      0.85,
    );

    const signals = evaluateNear(makeCatalog([a, b, c]), {
      minNearDuplicateSimilarity: 0.85,
    });
    expect(signals.length).toBe(1);
    expect((signals[0]?.metadata?.nearMembers as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it('skips sub-threshold pairs', () => {
    const a = withSignature({ bodyHash: 'a', simpleName: 'a' }, BASE_BODY);
    const b = withSignature(
      {
        bodyHash: 'b',
        simpleName: 'b',
        filePath: 'src/b.ts',
        qualifiedName: 'src/b.b',
      },
      UNRELATED,
    );
    const signals = evaluateNear(makeCatalog([a, b]), {
      minNearDuplicateSimilarity: 0.85,
    });
    expect(signals).toHaveLength(0);
  });

  it('requires signature length === NEAR_DUP_SIGNATURE_K', () => {
    const a = occ({ bodyHash: 'a', simpleName: 'a', bodySignature: [1, 2, 3] });
    const b = occ({
      bodyHash: 'b',
      simpleName: 'b',
      filePath: 'src/b.ts',
      bodySignature: [1, 2, 3],
    });
    const signals = evaluateNear(makeCatalog([a, b]));
    expect(signals).toHaveLength(0);
    expect(NEAR_DUP_SIGNATURE_K).toBe(128);
  });

  it('emits nothing when nearDuplicateLshBands does not divide k (fractional rows)', () => {
    // 128 / 7 is fractional → band slicing would be misaligned. The integer guard
    // must reject it (the schema also refuses this value at config load).
    const a = withSignature(
      { bodyHash: 'hash-a', simpleName: 'pA', filePath: 'src/a.ts' },
      BASE_BODY,
    );
    const b = withSignature(
      { bodyHash: 'hash-b', simpleName: 'pB', filePath: 'src/b.ts', qualifiedName: 'src/b.pB' },
      NEAR_BODY,
    );
    expect(evaluateNear(makeCatalog([a, b]), { nearDuplicateLshBands: 7 })).toHaveLength(0);
    // ...but the same pair IS flagged with a valid divisor.
    expect(evaluateNear(makeCatalog([a, b]), { nearDuplicateLshBands: 16 })).toHaveLength(1);
  });
});
