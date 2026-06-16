/**
 * Self-match regression guard for the duplicated-function-body rule.
 *
 * The rule groups occurrences by body hash and reports N-1 duplicates per
 * group. A function can surface MORE THAN ONCE in the catalog index — keyed
 * under both its simple and qualified name, or (for a recursive function)
 * walked once more via its own self-reference. Those extra entries describe
 * the SAME physical function (same file + declaration position) and must
 * collapse to a single group member: a function never duplicates itself.
 *
 * Verified false-positives this guards:
 *   - `isPgliteUnsupported` (vitest.setup.ts:55) reported as duplicating
 *     itself — identical file AND line on both sides of the message.
 *   - `stripPollutionKeys`, a recursive function whose self-calls inflated
 *     its body-hash group to a phantom 2 members.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { duplicatedFunctionBodyRule } from '../../rules/duplicated-function-body.js';

import { makeCatalog, occ } from './_helpers.js';

import type { FunctionOccurrence } from '../../types.js';

const evaluate = duplicatedFunctionBodyRule.evaluate.bind(duplicatedFunctionBodyRule);

/** Clears the default per-instance floor (≥ 5 lines, ≥ 200 chars). */
const substantial: Partial<FunctionOccurrence> = { line: 55, endLine: 70, bodySize: 500 };

describe('duplicated-function-body self-match exclusion', () => {
  it('does NOT flag a single function that appears twice in the catalog index (same file + line)', () => {
    // Same physical function indexed twice (e.g. under both its simple and
    // fully-qualified name) — identical filePath/line/column/simpleName.
    const first = occ({
      bodyHash: 'h',
      simpleName: 'isPgliteUnsupported',
      filePath: 'vitest.setup.ts',
      qualifiedName: 'vitest.setup.isPgliteUnsupported',
      column: 0,
      ...substantial,
    });
    const second = occ({
      bodyHash: 'h',
      simpleName: 'isPgliteUnsupported',
      filePath: 'vitest.setup.ts',
      // The fully-qualified-name index entry — same physical declaration.
      qualifiedName: 'pkg/vitest.setup.isPgliteUnsupported',
      column: 0,
      ...substantial,
    });
    const catalog = makeCatalog([first, second]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(0);
  });

  it('does NOT flag a recursive function whose self-reference is walked twice', () => {
    // A recursive function may surface an extra catalog occurrence via its own
    // self-call. Both entries share the same physical identity → no phantom
    // duplicate.
    const decl = occ({
      bodyHash: 'rec',
      simpleName: 'stripPollutionKeys',
      filePath: 'src/strip.ts',
      qualifiedName: 'src/strip.stripPollutionKeys',
      column: 2,
      ...substantial,
    });
    const selfRef = occ({
      bodyHash: 'rec',
      simpleName: 'stripPollutionKeys',
      filePath: 'src/strip.ts',
      qualifiedName: 'src/strip.stripPollutionKeys',
      column: 2,
      ...substantial,
    });
    const catalog = makeCatalog([decl, selfRef]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(0);
  });

  it('does NOT inflate the aggregate occurrenceCount with self-matched copies', () => {
    // The same function in package `core` indexed three times, plus one genuine
    // copy in each of two other packages. Three distinct packages → the
    // aggregate path fires, but its occurrenceCount must reflect three REAL
    // functions, not the five raw catalog entries.
    const coreBase: Partial<FunctionOccurrence> = {
      filePath: 'packages/core/src/x.ts',
      qualifiedName: 'packages/core/src/x.helper',
      package: 'core',
      column: 4,
      ...substantial,
    };
    const core1 = occ({ bodyHash: 'agg', simpleName: 'helper', ...coreBase });
    const core2 = occ({ bodyHash: 'agg', simpleName: 'helper', ...coreBase });
    const core3 = occ({ bodyHash: 'agg', simpleName: 'helper', ...coreBase });
    const api = occ({
      bodyHash: 'agg',
      simpleName: 'helper',
      filePath: 'packages/api/src/x.ts',
      qualifiedName: 'packages/api/src/x.helper',
      package: 'api',
      column: 4,
      ...substantial,
    });
    const cli = occ({
      bodyHash: 'agg',
      simpleName: 'helper',
      filePath: 'packages/cli/src/x.ts',
      qualifiedName: 'packages/cli/src/x.helper',
      package: 'cli',
      column: 4,
      ...substantial,
    });
    const catalog = makeCatalog([core1, core2, core3, api, cli]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    const agg = signals.filter((s) => Array.isArray(s.metadata.packages));
    expect(agg).toHaveLength(1);
    expect(agg[0]?.metadata.packageCount).toBe(3);
    // Five raw entries, but only three real functions after self-match dedup.
    expect(agg[0]?.metadata.occurrenceCount).toBe(3);
  });

  it('STILL flags two distinct functions with identical bodies in different files', () => {
    // True-positive must survive: distinct identities (different file/line) with
    // the same body hash.
    const a = occ({
      bodyHash: 'dup',
      simpleName: 'a',
      filePath: 'src/a.ts',
      qualifiedName: 'src/a.a',
      ...substantial,
    });
    const b = occ({
      bodyHash: 'dup',
      simpleName: 'b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.b',
      ...substantial,
    });
    const catalog = makeCatalog([a, b]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata.primary).toBe('src/a.a');
    expect(signals[0]?.metadata.duplicate).toBe('src/b.b');
  });

  it('flags the genuine duplicate but not the self-match when both are present', () => {
    // One function appears twice (self-match) AND a genuinely distinct function
    // shares its body. Expect exactly ONE signal for the real duplicate.
    const selfA = occ({
      bodyHash: 'mix',
      simpleName: 'shared',
      filePath: 'src/a.ts',
      qualifiedName: 'src/a.shared',
      ...substantial,
    });
    const selfADup = occ({
      bodyHash: 'mix',
      simpleName: 'shared',
      filePath: 'src/a.ts',
      qualifiedName: 'src/a.shared',
      ...substantial,
    });
    const realB = occ({
      bodyHash: 'mix',
      simpleName: 'sharedTwin',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.sharedTwin',
      ...substantial,
    });
    const catalog = makeCatalog([selfA, selfADup, realB]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata.groupSize).toBe(2);
  });
});
