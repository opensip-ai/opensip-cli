/**
 * Public root-surface lock for `@opensip-cli/yagni` (ADR-0151).
 *
 * The repository-wide TypeScript export parser (`scripts/verify-core-exports.mjs`
 * + `.config/package-export-allowlists.cjs`) is the exhaustive contract gate;
 * this package-local test is a fast load/type smoke that fails in-package the
 * moment the root barrel grows or drops a symbol. `executeYagni` and the
 * executor-only option/result types are deliberately NOT root exports — they are
 * reached only through the Tool command path (see run-plane host wiring).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as yagni from '../index.js';

/** The complete, intended root VALUE surface. Keep alphabetised. */
const EXPECTED_VALUE_EXPORTS = [
  'YAGNI_CONTRACT_VERSION',
  'YAGNI_STABLE_ID',
  'tool',
  'yagniTool',
].sort();

describe('@opensip-cli/yagni root surface', () => {
  it('exposes exactly the locked value surface', () => {
    const actual = Object.keys(yagni)
      .filter((key) => yagni[key as keyof typeof yagni] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it('publishes `tool` as the generic alias of the same descriptor as `yagniTool`', () => {
    expect(yagni.tool).toBe(yagni.yagniTool);
  });

  it('locks the public config and finding-metadata types', () => {
    expectTypeOf<yagni.YagniConfig>().toHaveProperty('defaultMinConfidence');
    expectTypeOf<yagni.YagniFindingMetadata>().toHaveProperty('detector');
  });

  it('does not expose executeYagni or executor-only types from the root', () => {
    expect(yagni).not.toHaveProperty('executeYagni');
    // @ts-expect-error executeYagni is reached only through the Tool command path.
    expectTypeOf(yagni.executeYagni).toBeFunction();
    // @ts-expect-error ExecuteYagniOptions is executor-internal, not a root type.
    expectTypeOf<yagni.ExecuteYagniOptions>();
    // @ts-expect-error ExecuteYagniResult is executor-internal, not a root type.
    expectTypeOf<yagni.ExecuteYagniResult>();
  });
});
