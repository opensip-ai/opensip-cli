/**
 * synthesizeName tests (DRY-4).
 *
 * Per spec §2.2: angle-bracketed names cannot collide with valid TS
 * identifiers, so the catalog can mix synthesized + real names in
 * the same map.
 */

import { describe, expect, it } from 'vitest';

import {
  synthesizeArrowName,
  synthesizeFunctionExpressionName,
  synthesizeModuleInitName,
} from '../../../pipeline/inventory-helpers/synthesize-name.js';

describe('synthesizeName (DRY-4)', () => {
  it('arrow names are angle-bracketed with file:line:column', () => {
    const name = synthesizeArrowName({ filePath: 'src/foo.ts', line: 42, column: 7 });
    expect(name).toBe('<arrow:src/foo.ts:42:7>');
  });

  it('function-expression names are angle-bracketed', () => {
    const name = synthesizeFunctionExpressionName({ filePath: 'a.ts', line: 1, column: 0 });
    expect(name).toBe('<fn-expr:a.ts:1:0>');
  });

  it('module-init name is angle-bracketed with file', () => {
    const name = synthesizeModuleInitName('src/foo.ts');
    expect(name).toBe('<module-init:src/foo.ts>');
  });

  it('synthesized names cannot collide with valid TS identifiers', () => {
    // A valid TS identifier never contains '<' or '>'.
    expect(synthesizeArrowName({ filePath: 'a.ts', line: 1, column: 0 })).toMatch(/^<.+>$/);
    expect(synthesizeFunctionExpressionName({ filePath: 'a.ts', line: 1, column: 0 })).toMatch(
      /^<.+>$/,
    );
    expect(synthesizeModuleInitName('a.ts')).toMatch(/^<.+>$/);
  });
});
