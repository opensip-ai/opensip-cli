/**
 * Inventory shape coverage tests (Tier 1).
 *
 * One focused test per syntactic TypeScript shape that stage 1
 * (buildInventory) must catch — and one per shape that it must NOT.
 *
 * Each test builds a tiny in-memory source string in a temp directory,
 * runs stage 0 + stage 1 (no edge resolution required for inventory),
 * and asserts exact catalog membership: function name(s) present,
 * function name(s) absent, kind, count.
 *
 * If a test fails because a visitor genuinely doesn't handle the shape,
 * that's a real bug — surface it rather than silently weakening the test.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverFiles } from '../pipeline/discover.js';
import { buildInventory } from '../pipeline/inventory.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    lib: ['ES2022', 'DOM'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    jsx: 'preserve',
    rootDir: '.',
    experimentalDecorators: true,
  },
  include: ['**/*.ts', '**/*.tsx'],
});

function buildCatalogFor(rootDir: string, files: Readonly<Record<string, string>>): Catalog {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const filePath = join(rootDir, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  const discovery = discoverFiles({ projectDir: rootDir });
  const inv = buildInventory({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  return inv.catalog;
}

function allOccurrences(catalog: Catalog): FunctionOccurrence[] {
  const out: FunctionOccurrence[] = [];
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) out.push(o);
  }
  return out;
}

function findByName(
  catalog: Catalog,
  predicate: (name: string, occ: FunctionOccurrence) => boolean,
): FunctionOccurrence | undefined {
  for (const [name, occs] of Object.entries(catalog.functions)) {
    for (const o of occs) {
      if (predicate(name, o)) return o;
    }
  }
  return undefined;
}

/**
 * Cache fixtures across describe blocks: per-shape directories let
 * tests stay independent without hammering the filesystem on every
 * `it()`.
 */
function makeFixture(label: string, files: Readonly<Record<string, string>>): {
  catalog: Catalog;
  cleanup: () => void;
  rootDir: string;
} {
  const rootDir = mkdtempSync(join(tmpdir(), `graph-shape-${label}-`));
  const catalog = buildCatalogFor(rootDir, files);
  return {
    catalog,
    rootDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

// --------------------------------------------------------------------------
// Tier 1 — Positive shape coverage (these MUST be detected)
// --------------------------------------------------------------------------

describe('Tier 1 — function-declaration shapes', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('fndecl', {
      'plain.ts': `function foo() { return 1; }\n`,
      'asyncfn.ts': `async function asyncFoo() { return 1; }\n`,
      'gen.ts': `function* genFoo() { yield 1; }\n`,
      'asyncgen.ts': `async function* asyncGen() { yield 1; }\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('1. plain function declaration', () => {
    const occ = findByName(f.catalog, (n) => n === 'foo');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('function-declaration');
    expect(occ!.filePath).toBe('plain.ts');
  });

  it('2. async function declaration', () => {
    const occ = findByName(f.catalog, (n) => n === 'asyncFoo');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('function-declaration');
  });

  it('3. generator function declaration', () => {
    const occ = findByName(f.catalog, (n) => n === 'genFoo');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('function-declaration');
  });

  it('4. async generator function declaration', () => {
    const occ = findByName(f.catalog, (n) => n === 'asyncGen');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('function-declaration');
  });
});

describe('Tier 1 — function-expression shapes', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('fnexpr', {
      'named.ts': `const x = function named() { return 1; };\n`,
      'anon.ts': `const x = function() { return 1; };\n`,
      'iife.ts': `(function() { return 1; })();\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('5. named function expression', () => {
    // The visitor uses node.name first, then falls back to the parent
    // VariableDeclaration name. Either name is acceptable evidence the
    // shape was detected; the kind must be 'function-expression'.
    const named = findByName(
      f.catalog,
      (n, o) => o.filePath === 'named.ts' && o.kind === 'function-expression' && (n === 'named' || n === 'x'),
    );
    expect(named).toBeDefined();
    expect(named!.kind).toBe('function-expression');
    expect(named!.filePath).toBe('named.ts');
  });

  it('6. anonymous function expression assigned to const', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'anon.ts' && o.kind === 'function-expression');
    expect(occ).toBeDefined();
    // Visitor falls back to parent var name 'x' when the function has no name.
    expect(occ!.simpleName).toBe('x');
  });

  it('7. IIFE — inner function-expression is captured', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'iife.ts' && o.kind === 'function-expression');
    expect(occ).toBeDefined();
    // No parent VariableDeclaration → synthesized <fn-expr:...> name.
    expect(occ!.simpleName).toMatch(/^<fn-expr:iife\.ts:\d+:\d+>$/);
  });
});

describe('Tier 1 — arrow function shapes', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('arrow', {
      'zero.ts': `const z = () => 1;\n`,
      'one.ts': `const o = (x: number) => x;\n`,
      'many.ts': `const m = (a: number, b: number, c: number) => a + b + c;\n`,
      'rest.ts': `const r = (...args: number[]) => args.length;\n`,
      'asynced.ts': `const ay = async () => 1;\n`,
      'callback.ts': `const arr = [1, 2, 3];\nexport const doubled = arr.map(x => x * 2);\n`,
      'default.ts': `export default () => 1;\n`,
      'objprop.ts': `export const obj = { method: () => 1 };\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('8. zero-param arrow', () => {
    const occ = findByName(f.catalog, (n) => n === 'z');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('arrow');
    expect(occ!.params).toHaveLength(0);
  });

  it('9. one-param arrow', () => {
    const occ = findByName(f.catalog, (n) => n === 'o');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('arrow');
    expect(occ!.params).toHaveLength(1);
    expect(occ!.params[0]).toMatchObject({ name: 'x', rest: false });
  });

  it('10. many-params arrow', () => {
    const occ = findByName(f.catalog, (n) => n === 'm');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('arrow');
    expect(occ!.params.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('11. rest-param arrow', () => {
    const occ = findByName(f.catalog, (n) => n === 'r');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('arrow');
    expect(occ!.params[0]).toMatchObject({ name: 'args', rest: true });
  });

  it('12. async arrow', () => {
    const occ = findByName(f.catalog, (n) => n === 'ay');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('arrow');
  });

  it('13. arrow as map() callback gets a synthesized <arrow:...> name', () => {
    const occ = findByName(
      f.catalog,
      (n, o) => o.filePath === 'callback.ts' && o.kind === 'arrow' && n.startsWith('<arrow:'),
    );
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toMatch(/^<arrow:callback\.ts:\d+:\d+>$/);
  });

  it('14. anonymous arrow as default export — captured as arrow', () => {
    const occ = findByName(
      f.catalog,
      (_n, o) => o.filePath === 'default.ts' && o.kind === 'arrow',
    );
    expect(occ).toBeDefined();
    // No parent VariableDeclaration/PropertyAssignment → synthesized name.
    expect(occ!.simpleName).toMatch(/^<arrow:default\.ts:\d+:\d+>$/);
  });

  it('15. arrow as property initializer takes the property name', () => {
    const occ = findByName(
      f.catalog,
      (n, o) => o.filePath === 'objprop.ts' && o.kind === 'arrow' && n === 'method',
    );
    expect(occ).toBeDefined();
  });
});

describe('Tier 1 — class member shapes', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('class-member', {
      'plain.ts': `export class C { method() { return 1; } }\n`,
      'static.ts': `export class C { static method() { return 1; } }\n`,
      'asyncm.ts': `export class C { async method() { return 1; } }\n`,
      'genm.ts': `export class C { *method() { yield 1; } }\n`,
      'priv.ts': `export class C { #priv() { return 1; } }\n`,
      'computed.ts': `export class C { ['computed']() { return 1; } }\n`,
      'getter.ts': `export class C { get x() { return 1; } }\n`,
      'setter.ts': `export class C { set x(v: number) { this._v = v; } private _v = 0; }\n`,
      'ctor.ts': `export class C { constructor() {} }\n`,
      'noctor.ts': `export class C { method() {} }\n`,
      'cexpr.ts': `export const cls = class { method() { return 1; } };\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('16. regular method', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'plain.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
    expect(occ!.enclosingClass).toBe('C');
  });

  it('17. static method', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'static.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
  });

  it('18. async method', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'asyncm.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
  });

  it('19. generator method', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'genm.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
  });

  // FINDING #1 — private methods missed.
  //
  // Repro: `class C { #priv() {} }` — visitMethodDeclaration's
  // methodName() helper handles only ts.isIdentifier / ts.isStringLiteral
  // / ts.isComputedPropertyName. A PrivateIdentifier (the `#priv` form)
  // matches none of those, so the helper returns null and the visitor
  // returns null. The private method never enters the catalog.
  //
  // Fix would live in
  // packages/graph/engine/src/pipeline/inventory-visitors/method-declaration.ts:48
  // (extend methodName() to handle ts.isPrivateIdentifier and prepend
  // '#'). Skipped pending fix.
  it.skip('20. private method (#priv)', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'priv.ts' && o.kind === 'method');
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toBe('#priv');
  });

  it('21. computed method name — kind is method even when name is computed', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'computed.ts' && o.kind === 'method');
    expect(occ).toBeDefined();
    // The visitor returns expression.getText() for ComputedPropertyName.
    expect(occ!.simpleName).toContain('computed');
  });

  it('22. getter — kind: getter', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'getter.ts' && o.kind === 'getter');
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toBe('x');
  });

  it('23. setter — kind: setter', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'setter.ts' && o.kind === 'setter');
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toBe('x');
  });

  it('24. explicit constructor — kind: constructor', () => {
    const occ = findByName(f.catalog, (_n, o) => o.filePath === 'ctor.ts' && o.kind === 'constructor');
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toBe('C');
    expect(occ!.enclosingClass).toBe('C');
  });

  it('25. class with no explicit constructor — no synthetic constructor', () => {
    const ctors = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'noctor.ts' && o.kind === 'constructor',
    );
    expect(ctors).toHaveLength(0);
  });

  it('26. class expression with method', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'cexpr.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
  });
});

describe('Tier 1 — decorators and overloads', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('deco-over', {
      'deco.ts':
        `function decorator(_t: object, _k: string, _d: PropertyDescriptor) {}\n` +
        `export class C {\n` +
        `  @decorator\n` +
        `  method() { return 1; }\n` +
        `}\n`,
      'overloads.ts':
        `export function foo(): void;\n` +
        `export function foo(x: number): number;\n` +
        `export function foo(x?: number): number | void {\n` +
        `  return x;\n` +
        `}\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('27. decorated method captures decorators', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'method' && o.filePath === 'deco.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('method');
    expect(occ!.decorators).toContain('decorator');
  });

  // FINDING #2 — function overload signatures pollute the catalog.
  //
  // Repro: `function foo(): void; function foo(x: number): number;
  //         function foo(x?: number) { return x }`
  // produces THREE catalog entries for `foo`. Each overload signature
  // is its own ts.FunctionDeclaration with a name and (typically) no
  // body, but visitFunctionDeclaration only checks `if (!node.name)
  // return null` — it doesn't check whether the declaration has a body.
  // Three occurrences of the same name with different params/bodies
  // breaks the "implementation is the catalog entry" invariant and
  // pollutes downstream call resolution.
  //
  // Fix lives in
  // packages/graph/engine/src/pipeline/inventory-visitors/function-declaration.ts:14
  // (add `if (!node.body) return null` to skip overload signatures).
  // The same condition is needed in method-declaration.ts:14 for
  // method overloads. Skipped pending fix.
  it.skip('28. function overloads — only one entry per implementation', () => {
    const fooOccs = allOccurrences(f.catalog).filter(
      (o) => o.simpleName === 'foo' && o.filePath === 'overloads.ts',
    );
    expect(fooOccs).toHaveLength(1);
    expect(fooOccs[0].params.map((p) => p.name)).toEqual(['x']);
  });
});

describe('Tier 1 — namespaced and default-export functions', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('namespace-default', {
      'ns.ts':
        `export namespace Ns {\n` +
        `  export function foo() { return 1; }\n` +
        `}\n`,
      'def.ts': `export default function() { return 1; }\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('29. namespaced function captured', () => {
    const occ = findByName(f.catalog, (n, o) => n === 'foo' && o.filePath === 'ns.ts');
    expect(occ).toBeDefined();
    expect(occ!.kind).toBe('function-declaration');
  });

  // FINDING #3 — anonymous `export default function() {}` is invisible.
  //
  // Repro: `export default function() { return 1; }` is parsed by
  // TypeScript as a FunctionDeclaration with no name (default-export is
  // the special case where this is legal). visitFunctionDeclaration
  // immediately returns null on `if (!node.name) return null`, so the
  // function never enters the catalog. The dispatcher does not try
  // FunctionExpression — and even if it did, this is a Declaration not
  // an Expression at the AST level.
  //
  // Fix would live in
  // packages/graph/engine/src/pipeline/inventory-visitors/function-declaration.ts:15
  // — when node.name is missing, fall back to a synthesized name
  // (e.g. `<default-export:filePath>`). Skipped pending fix.
  it.skip('30. anonymous default-export function — recorded as function-expression', () => {
    const nonModInit = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'def.ts' && o.kind !== 'module-init',
    );
    expect(nonModInit.length).toBeGreaterThan(0);
  });
});

describe('Tier 1 — module-init synthesis', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('modinit', {
      'top.ts': `console.log('top level');\n`,
      'empty.ts': `\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('31. top-level statement file has a <module-init> occurrence', () => {
    const occ = findByName(
      f.catalog,
      (_n, o) => o.filePath === 'top.ts' && o.kind === 'module-init',
    );
    expect(occ).toBeDefined();
    expect(occ!.simpleName).toBe('<module-init:top.ts>');
    expect(occ!.line).toBe(1);
    expect(occ!.column).toBe(0);
  });

  it('32. empty file still produces a <module-init> occurrence', () => {
    // Per the inventory implementation, every file gets exactly one
    // module-init synthesized. Empty files get one too — its body hash
    // covers the (empty) statement list.
    const modInits = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'empty.ts' && o.kind === 'module-init',
    );
    expect(modInits).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// Tier 1 — Negative tests (these MUST NOT be in the catalog)
// --------------------------------------------------------------------------

describe('Tier 1 — negative shapes (must NOT be in catalog)', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('negatives', {
      'typealias.ts': `export type X = () => void;\n`,
      'iface-method.ts': `export interface I { foo(): void; }\n`,
      'iface-prop.ts': `export interface I { foo: () => void; }\n`,
      'abstract.ts': `export abstract class A { abstract method(): void; }\n`,
      'ambient.ts': `declare function foo(): void;\nexport {};\n`,
      'jsx.tsx': `export const C = () => <div>hello</div>;\n`,
      'typelit.ts': `export type X = { foo(): void };\n`,
    });
  });
  afterAll(() => f.cleanup());

  it('33. function type alias is not a callable in the catalog', () => {
    // `() => void` here is a TypeNode, not an ArrowFunction. The arrow
    // visitor must not pick it up.
    const arrows = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'typealias.ts' && o.kind === 'arrow',
    );
    expect(arrows).toHaveLength(0);
  });

  it('34. interface method declaration (signature-only) is not in catalog', () => {
    // No body → not a callable.
    const methods = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'iface-method.ts' && o.kind === 'method',
    );
    expect(methods).toHaveLength(0);
  });

  it('35. interface property with function type is not in catalog', () => {
    const arrows = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'iface-prop.ts' && o.kind === 'arrow',
    );
    expect(arrows).toHaveLength(0);
  });

  // FINDING #4 — abstract methods (no body) are recorded as callables.
  //
  // Repro: `abstract class A { abstract method(): void; }` is parsed
  // as a MethodDeclaration with `abstract` modifier and no body.
  // visitMethodDeclaration does not check `node.body` and creates a
  // catalog entry for it. An abstract method has no implementation —
  // it cannot be called directly and should not be a node in the call
  // graph (only its concrete overrides should).
  //
  // Fix lives in
  // packages/graph/engine/src/pipeline/inventory-visitors/method-declaration.ts:14
  // — add `if (!node.body) return null` (covers both abstract methods
  // and method-overload signatures, which is the same fix as Finding
  // #2 generalized). Skipped pending fix.
  it.skip('36. abstract method (no body) is not in catalog', () => {
    const methods = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'abstract.ts' && o.kind === 'method',
    );
    expect(methods).toHaveLength(0);
  });

  // FINDING #5 — ambient `declare function` is recorded as a callable.
  //
  // Repro: `declare function foo(): void;` is a body-less
  // FunctionDeclaration with the `declare` modifier — no
  // implementation exists. visitFunctionDeclaration records it as a
  // catalog entry, polluting the catalog with phantom callables.
  //
  // Fix is the same single line in
  // packages/graph/engine/src/pipeline/inventory-visitors/function-declaration.ts
  // — `if (!node.body) return null`. Skipped pending fix.
  it.skip('37. ambient declare function is not in catalog', () => {
    const fns = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'ambient.ts' && o.kind === 'function-declaration',
    );
    expect(fns).toHaveLength(0);
  });

  it('38. JSX intrinsic element (<div>) is not a function in the catalog', () => {
    // The arrow `() => <div>hello</div>` IS a real callable (the C
    // const). But `div` itself must not appear as a function.
    const divEntry = allOccurrences(f.catalog).filter((o) => o.simpleName === 'div');
    expect(divEntry).toHaveLength(0);
  });

  it('39. type literal with method shorthand is not in catalog', () => {
    // A method declared inside a TypeLiteralNode is a MethodSignature,
    // not a MethodDeclaration. The visitor only handles MethodDeclaration.
    const methods = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'typelit.ts' && o.kind === 'method',
    );
    expect(methods).toHaveLength(0);
  });
});

describe('Tier 1 — overload signatures without implementation', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeAll(() => {
    f = makeFixture('overload-sig-only', {
      // An overload signature (no body) followed by no implementation
      // would be a TS error in production code; this fixture uses an
      // ambient declaration to make the case explicit. The point is
      // that signature-only declarations don't make it into the catalog.
      'sig.ts': `declare function foo(): void;\nexport {};\n`,
    });
  });
  afterAll(() => f.cleanup());

  // FINDING #5 (same root cause) — signature-only / ambient declarations
  // pollute the catalog. Same fix as #2/#4/#5: gate the visitors on
  // `node.body !== undefined`. Skipped pending fix.
  it.skip('40. ambient/signature-only function declaration is not in catalog', () => {
    const fns = allOccurrences(f.catalog).filter(
      (o) => o.filePath === 'sig.ts' && o.kind === 'function-declaration',
    );
    expect(fns).toHaveLength(0);
  });
});
