/**
 * Unit tests for the value-reference predicates + resolvers
 * (edges-value-reference.ts).
 *
 * `isValueReference` is a pure AST predicate: an Identifier is a value
 * reference unless it is a structural name (declaration/property/type/
 * import/export name) or a call/new/JSX target. These tests craft each
 * structural and call-target shape so every short-circuit branch is
 * exercised. `resolveValueReference` is then driven against a real
 * program for the no-symbol and class-constructor declaration branches.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { buildCrossPackageContext } from '../edge-helpers/cross-package-context.js';
import { buildImportSpecifierIndex } from '../edge-resolvers/syntactic.js';
import { isValueReference, resolveValueReference } from '../edges-value-reference.js';

import type { ResolverContext } from '../edge-resolvers/types.js';
import type { Catalog } from '@opensip-tools/graph';

/** Parse a snippet (parent pointers set) and return the source file. */
function parse(source: string, name = 'm.ts'): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
}

/** Find the first identifier whose text === `text`. */
function ident(sf: ts.SourceFile, text: string): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === text) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`identifier ${text} not found`);
  return found;
}

describe('isValueReference — structural-name branches', () => {
  it('treats a variable-declaration name as structural (not a value ref)', () => {
    const sf = parse('const myVar = 1;');
    expect(isValueReference(ident(sf, 'myVar'))).toBe(false);
  });

  it('treats a property-access property name as structural', () => {
    // In `obj.prop`, `prop` is the property name slot, not a value ref.
    const sf = parse('declare const obj: { prop: number }; obj.prop;');
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'prop') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const propName = refs.find(
      (id) => ts.isPropertyAccessExpression(id.parent) && id.parent.name === id,
    );
    expect(propName).toBeDefined();
    expect(isValueReference(propName!)).toBe(false);
  });

  it('treats a labeled-statement label as structural', () => {
    const sf = parse('loopLabel: for (;;) { break loopLabel; }');
    // The label declaration is the structural slot.
    const labels: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'loopLabel') labels.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const labelDecl = labels.find(
      (id) => ts.isLabeledStatement(id.parent) && id.parent.label === id,
    );
    expect(labelDecl).toBeDefined();
    expect(isValueReference(labelDecl!)).toBe(false);
  });

  it('treats a type-reference name as structural', () => {
    const sf = parse('type Alias = number; let v: Alias;');
    // `Alias` in the annotation is a TypeReferenceNode name.
    const aliasRefs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'Alias') aliasRefs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const inType = aliasRefs.find((id) => ts.isTypeReferenceNode(id.parent));
    expect(inType).toBeDefined();
    expect(isValueReference(inType!)).toBe(false);
  });

  it('treats an import-specifier name as structural', () => {
    const sf = parse("import { thing } from './x.js';");
    expect(isValueReference(ident(sf, 'thing'))).toBe(false);
  });

  it('classifies a bare value use (function argument) as a value reference', () => {
    const sf = parse(
      'declare function take(cb: unknown): void; declare const handler: unknown; take(handler);',
    );
    // `handler` inside `take(handler)` is a genuine value reference.
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'handler') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const argRef = refs.find(
      (id) => ts.isCallExpression(id.parent) && id.parent.arguments.includes(id),
    );
    expect(argRef).toBeDefined();
    expect(isValueReference(argRef!)).toBe(true);
  });
});

describe('isValueReference — call/new/JSX target branches', () => {
  it('treats a direct call target as a call-site target (not a value ref)', () => {
    const sf = parse('declare function fn(): void; fn();');
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'fn') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const callTarget = refs.find(
      (id) => ts.isCallExpression(id.parent) && id.parent.expression === id,
    );
    expect(callTarget).toBeDefined();
    expect(isValueReference(callTarget!)).toBe(false);
  });

  it('treats a new-expression target as a call-site target', () => {
    const sf = parse('declare class K {} new K();');
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'K') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const newTarget = refs.find(
      (id) => ts.isNewExpression(id.parent) && id.parent.expression === id,
    );
    expect(newTarget).toBeDefined();
    expect(isValueReference(newTarget!)).toBe(false);
  });

  it('treats a JSX self-closing tag name as a call-site target', () => {
    const sf = parse('const x = <Comp />;', 'v.tsx');
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'Comp') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const tag = refs.find(
      (id) => ts.isJsxSelfClosingElement(id.parent) && id.parent.tagName === id,
    );
    expect(tag).toBeDefined();
    expect(isValueReference(tag!)).toBe(false);
  });

  it('treats a JSX opening-element tag name as a call-site target', () => {
    const sf = parse('const x = <Comp>child</Comp>;', 'v.tsx');
    const refs: ts.Identifier[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'Comp') refs.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const tag = refs.find((id) => ts.isJsxOpeningElement(id.parent) && id.parent.tagName === id);
    expect(tag).toBeDefined();
    expect(isValueReference(tag!)).toBe(false);
  });
});

describe('resolveValueReference — symbol resolution branches', () => {
  const PROJECT_DIR = '/proj';

  function programCtx(source: string): { node: ts.Identifier; ctx: ResolverContext } {
    const fileAbs = `${PROJECT_DIR}/m.ts`;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      noLib: true,
      skipLibCheck: true,
    };
    const sf = ts.createSourceFile(fileAbs, source, ts.ScriptTarget.ES2022, true);
    const defaultHost = ts.createCompilerHost(options);
    const host: ts.CompilerHost = {
      ...defaultHost,
      getSourceFile: (fileName) => (fileName === fileAbs ? sf : undefined),
      fileExists: (fileName) => fileName === fileAbs,
      readFile: (fileName) => (fileName === fileAbs ? source : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {
        // No emit in tests.
      },
    };
    const program = ts.createProgram({ rootNames: [fileAbs], options, host });
    const typeChecker = program.getTypeChecker();
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey: 'k',
      functions: {},
    };
    const ctx: ResolverContext = {
      catalog,
      program,
      typeChecker,
      sourceFile: sf,
      projectDirAbs: PROJECT_DIR,
      crossPackage: buildCrossPackageContext(catalog, PROJECT_DIR),
      importSpecifiers: buildImportSpecifierIndex(sf),
    };
    // Re-read the program's copy of the source file so symbols bind.
    const boundSf = program.getSourceFile(fileAbs)!;
    let target: ts.Identifier | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'ref') target = n;
      ts.forEachChild(n, visit);
    };
    visit(boundSf);
    return { node: target!, ctx: { ...ctx, sourceFile: boundSf } };
  }

  it('returns UNRESOLVED (unknown) when the identifier has no symbol', () => {
    // `ref` is undeclared → getSymbolAtLocation returns undefined.
    const { node, ctx } = programCtx('function use(): unknown { return ref; }');
    const v = resolveValueReference(node, ctx);
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
    expect(v.confidence).toBe('low');
  });

  it('returns UNRESOLVED for a symbol whose declaration is not function-shaped', () => {
    // `ref` resolves to a plain number variable — no function-shaped
    // declaration → hashFromDeclaration returns null for every decl.
    const { node, ctx } = programCtx(
      'const num = 1; const ref = num; function use(): number { return ref; }',
    );
    const v = resolveValueReference(node, ctx);
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
  });
});
