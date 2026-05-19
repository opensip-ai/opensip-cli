/**
 * hashFunctionBody tests (DRY-4).
 *
 * Per spec §2.2:
 *  - Same body in two files → same hash
 *  - Whitespace-only difference → same hash
 *  - Comment-only difference → same hash (stripComments runs first)
 *  - One-character body change → different hash
 */

import { describe, expect, it } from 'vitest';

import { hashSyntheticBody } from '../../../lang-typescript/inventory-helpers/hash-body.js';

describe('hashFunctionBody (DRY-4)', () => {
  it('produces identical hashes for identical bodies', () => {
    const a = hashSyntheticBody('function foo() { return 1; }');
    const b = hashSyntheticBody('function foo() { return 1; }');
    expect(a).toBe(b);
  });

  it('ignores whitespace-only differences', () => {
    const a = hashSyntheticBody('function foo() { return 1; }');
    const b = hashSyntheticBody('function foo()  {  return  1;  }');
    expect(a).toBe(b);
  });

  it('ignores comment-only differences', () => {
    const a = hashSyntheticBody('function foo() { return 1; }');
    const b = hashSyntheticBody('function foo() { /* hi */ return 1; }');
    expect(a).toBe(b);
  });

  it('reflects one-character body changes', () => {
    const a = hashSyntheticBody('function foo() { return 1; }');
    const b = hashSyntheticBody('function foo() { return 2; }');
    expect(a).not.toBe(b);
  });
});
