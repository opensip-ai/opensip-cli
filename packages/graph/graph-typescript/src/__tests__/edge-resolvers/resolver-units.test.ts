/**
 * Direct unit tests for the individual edge resolvers, driven against a
 * real `ts.Program` built from in-memory fixtures.
 *
 * The acceptance + branches fixtures exercise the happy paths via the
 * full pipeline; this file targets the per-resolver SHORT-CIRCUIT
 * branches that are hard to hit end-to-end: the `!isIdentifier`,
 * `!symbol`, `!declNode`, and `hash === null` returns, plus the
 * single-vs-multi confidence split in the polymorphic resolver and the
 * `findCatalogEntry`-miss fall-through.
 *
 * Each test parses a tiny program, walks it to build the SAME catalog
 * the production pipeline would, finds the target node, assembles a
 * ResolverContext, and asserts the resolver's verdict.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { buildCrossPackageContext } from '../../edge-helpers/cross-package-context.js';
import { resolveDirectCall } from '../../edge-resolvers/direct-call.js';
import { resolveJsxElement } from '../../edge-resolvers/jsx-element.js';
import { resolveNewExpression } from '../../edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from '../../edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from '../../edge-resolvers/property-access.js';
import { buildImportSpecifierIndex } from '../../edge-resolvers/syntactic.js';
import { walkProgram } from '../../walk.js';

import type { ResolverContext } from '../../edge-resolvers/types.js';
import type { Catalog } from '@opensip-tools/graph';

const PROJECT_DIR = '/proj';

/** Project-relative name → absolute path under the synthetic project root. */
function abs(rel: string): string {
  return `${PROJECT_DIR}/${rel}`;
}

/** Build an in-memory ts.Program from a name→source map. */
function buildProgram(files: Readonly<Record<string, string>>): {
  program: ts.Program;
  typeChecker: ts.TypeChecker;
  fileNames: string[];
} {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    jsx: ts.JsxEmit.Preserve,
    lib: ['lib.es2022.d.ts'],
    skipLibCheck: true,
    noLib: true,
  };
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [rel, src] of Object.entries(files)) {
    sourceFiles.set(
      abs(rel),
      ts.createSourceFile(abs(rel), src, ts.ScriptTarget.ES2022, true, scriptKind(rel)),
    );
  }
  const defaultHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (fileName) => sourceFiles.get(fileName),
    fileExists: (fileName) => sourceFiles.has(fileName),
    readFile: (fileName) => files[fileName.replace(`${PROJECT_DIR}/`, '')],
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {
      // No emit in tests.
    },
  };
  const fileNames = [...sourceFiles.keys()];
  const program = ts.createProgram({ rootNames: fileNames, options, host });
  const typeChecker = program.getTypeChecker();
  return { program, typeChecker, fileNames };
}

function scriptKind(rel: string): ts.ScriptKind {
  if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/** Build the production catalog for a program by walking it. */
function catalogFor(program: ts.Program, fileNames: string[]): Catalog {
  const walked = walkProgram({
    sourceFiles: program.getSourceFiles(),
    files: fileNames,
    projectDirAbs: PROJECT_DIR,
  });
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    functions: walked.functions,
  };
}

function ctxFor(
  program: ts.Program,
  typeChecker: ts.TypeChecker,
  catalog: Catalog,
  sourceFile: ts.SourceFile,
): ResolverContext {
  return {
    catalog,
    program,
    typeChecker,
    sourceFile,
    projectDirAbs: PROJECT_DIR,
    crossPackage: buildCrossPackageContext(catalog, PROJECT_DIR),
    importSpecifiers: buildImportSpecifierIndex(sourceFile),
  };
}

/** Find the first node matching `pred` in a source file. */
function findNode<T extends ts.Node>(
  sf: ts.SourceFile,
  pred: (n: ts.Node) => n is T,
): T {
  let found: T | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (pred(n)) { found = n; return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error('node not found');
  return found;
}

describe('resolveDirectCall — branches', () => {
  it('returns UNRESOLVED when the call expression is NOT a bare identifier', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'export function f(): void { (() => 1)(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    // The first call expression is `(() => 1)()` — a parenthesized arrow,
    // not an identifier.
    const call = findNode(sf, ts.isCallExpression);
    const v = resolveDirectCall(call, ctxFor(program, typeChecker, catalog, sf));
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
  });

  it('resolves a bare identifier call to its declaration at high confidence', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'function target(): number { return 1; }\nexport function caller(): number { return target(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    // The `target()` call is the call whose callee identifier text is 'target'.
    let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'target'
      ) {
        call = n;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const v = resolveDirectCall(call!, ctxFor(program, typeChecker, catalog, sf));
    expect(v.confidence).toBe('high');
    expect(v.resolution).toBe('static');
    expect(v.to.length).toBe(1);
  });

  it('returns UNRESOLVED when the identifier has no resolvable symbol', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'export function caller(): unknown { return undeclaredName(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    const call = findNode(sf, ts.isCallExpression);
    const v = resolveDirectCall(call, ctxFor(program, typeChecker, catalog, sf));
    // No symbol for `undeclaredName` → UNRESOLVED.
    expect(v.to).toEqual([]);
  });
});

describe('resolvePropertyAccessCall — branches', () => {
  it('returns UNRESOLVED when the call is NOT a property access', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'function f(): number { return 1; }\nexport function g(): number { return f(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    const call = findNode(sf, ts.isCallExpression); // f() — bare identifier
    const v = resolvePropertyAccessCall(call, ctxFor(program, typeChecker, catalog, sf));
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
  });

  it('resolves a method call on a class instance at high confidence', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': [
        'export class Svc { method(): number { return 1; } }',
        'export function call(s: Svc): number { return s.method(); }',
      ].join('\n'),
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) call = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const v = resolvePropertyAccessCall(call!, ctxFor(program, typeChecker, catalog, sf));
    expect(v.confidence).toBe('high');
    expect(v.resolution).toBe('method-dispatch');
    expect(v.to.length).toBe(1);
  });
});

describe('resolvePolymorphicCall — confidence split', () => {
  it('returns high confidence for a single-implementation method call', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': [
        'class Only { run(): void {} }',
        'export function dispatch(o: Only): void { o.run(); }',
      ].join('\n'),
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) call = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const v = resolvePolymorphicCall(call!, ctxFor(program, typeChecker, catalog, sf));
    expect(v.to.length).toBe(1);
    expect(v.confidence).toBe('high');
  });

  it('returns UNRESOLVED when the call is not a property access', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'function f(): number { return 1; }\nexport function g(): number { return f(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    const call = findNode(sf, ts.isCallExpression);
    const v = resolvePolymorphicCall(call, ctxFor(program, typeChecker, catalog, sf));
    expect(v.to).toEqual([]);
  });

  it('returns UNRESOLVED when no implementation of the method exists in the catalog', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': 'export function g(o: { toString(): string }): string { return o.toString(); }',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    let call: ts.CallExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) call = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const v = resolvePolymorphicCall(call!, ctxFor(program, typeChecker, catalog, sf));
    // `toString` has no catalog occurrence → no candidate hashes.
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
  });
});

describe('resolveNewExpression — branches', () => {
  it('resolves new ClassName() to the constructor at high confidence', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'm.ts': [
        'export class Widget { constructor() {} }',
        'export function make(): Widget { return new Widget(); }',
      ].join('\n'),
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/m.ts`)!;
    const newExpr = findNode(sf, ts.isNewExpression);
    const v = resolveNewExpression(newExpr, ctxFor(program, typeChecker, catalog, sf));
    expect(v.confidence).toBe('high');
    expect(v.resolution).toBe('constructor');
    expect(v.to.length).toBe(1);
  });
});

describe('resolveJsxElement — branches', () => {
  it('ignores intrinsic lower-case elements (UNRESOLVED)', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'v.tsx': 'export const V = () => (<div />);',
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/v.tsx`)!;
    const jsx = findNode(sf, ts.isJsxSelfClosingElement);
    const v = resolveJsxElement(jsx, ctxFor(program, typeChecker, catalog, sf));
    expect(v.to).toEqual([]);
    expect(v.resolution).toBe('unknown');
  });

  it('resolves a component element to its function declaration at high confidence', () => {
    const { program, typeChecker, fileNames } = buildProgram({
      'v.tsx': [
        'function Comp() { return null; }',
        'export const V = () => (<Comp />);',
      ].join('\n'),
    });
    const catalog = catalogFor(program, fileNames);
    const sf = program.getSourceFile(`${PROJECT_DIR}/v.tsx`)!;
    const jsx = findNode(sf, ts.isJsxSelfClosingElement);
    const v = resolveJsxElement(jsx, ctxFor(program, typeChecker, catalog, sf));
    expect(v.confidence).toBe('high');
    expect(v.resolution).toBe('jsx');
    expect(v.to.length).toBe(1);
  });
});
