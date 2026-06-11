/**
 * Accuracy contract for the syntactic (fast-tier) resolver.
 *
 * - imported calls resolve to the right file at 'medium';
 * - same-named functions across files are disambiguated by the import graph;
 * - same-file definitions resolve at 'medium';
 * - unique unpinned names resolve at 'low'; ambiguous unpinned names decline;
 * - external imports decline rather than mis-guess;
 * - no verdict is ever 'high', and resolution is always 'syntactic'.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  buildImportIndex,
  buildImportSpecifierIndex,
  collectKnownFiles,
  resolveSyntactic,
  type ImportIndex,
} from '../syntactic.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

/** Build a minimal catalog occurrence for a named function in a file. */
function occ(simpleName: string, filePath: string, hash: string): FunctionOccurrence {
  return {
    bodyHash: hash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

function catalogOf(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode: 'fast',
    functions,
  };
}

/** Parse a snippet and return the first call expression's node. */
function firstCall(source: string): ts.CallExpression {
  const sf = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error('no call expression in snippet');
  return found;
}

const NO_IMPORTS: ImportIndex = new Map();

describe('resolveSyntactic', () => {
  it('resolves an imported call to the imported file at medium confidence', () => {
    const catalog = catalogOf(occ('helper', 'util.ts', 'h1'), occ('helper', 'other.ts', 'h2'));
    const importIndex: ImportIndex = new Map([['helper', 'util.ts']]);
    const node = firstCall('helper()');

    const v = resolveSyntactic(node, { catalog, currentFileRel: 'app.ts', importIndex });
    expect(v).not.toBeNull();
    expect(v!.resolution).toBe('syntactic');
    expect(v!.confidence).toBe('medium');
    expect(v!.to).toEqual(['h1']); // pinned to util.ts, NOT other.ts
  });

  it('disambiguates same-named functions across files via the import graph', () => {
    const catalog = catalogOf(occ('save', 'a.ts', 'A'), occ('save', 'b.ts', 'B'));
    const node = firstCall('save()');

    const fromA = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: new Map([['save', 'a.ts']]),
    });
    const fromB = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: new Map([['save', 'b.ts']]),
    });
    expect(fromA!.to).toEqual(['A']);
    expect(fromB!.to).toEqual(['B']);
  });

  it('pins a same-file definition at medium even without an import', () => {
    const catalog = catalogOf(occ('local', 'app.ts', 'L'), occ('local', 'far.ts', 'F'));
    const node = firstCall('local()');

    const v = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: NO_IMPORTS,
    });
    expect(v!.confidence).toBe('medium');
    expect(v!.to).toEqual(['L']);
  });

  it('resolves a unique unpinned name at low confidence', () => {
    const catalog = catalogOf(occ('only', 'somewhere.ts', 'O'));
    const node = firstCall('only()');

    const v = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: NO_IMPORTS,
    });
    expect(v!.confidence).toBe('low');
    expect(v!.to).toEqual(['O']);
  });

  it('declines an ambiguous unpinned name (multiple candidates, no pin)', () => {
    const catalog = catalogOf(occ('amb', 'a.ts', 'A'), occ('amb', 'b.ts', 'B'));
    const node = firstCall('amb()');

    const v = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: NO_IMPORTS,
    });
    expect(v!.to).toEqual([]); // declines rather than guessing
    expect(v!.confidence).toBe('low');
  });

  it('declines a call to a name imported from outside the catalog (external)', () => {
    const catalog = catalogOf(occ('chalk', 'local.ts', 'X'));
    // chalk imported from an external package → importIndex maps to null.
    const importIndex: ImportIndex = new Map([['chalk', null]]);
    const node = firstCall('chalk()');

    const v = resolveSyntactic(node, { catalog, currentFileRel: 'app.ts', importIndex });
    expect(v!.to).toEqual([]); // does NOT wrongly resolve to local.ts
  });

  it('never emits high confidence and always labels resolution syntactic', () => {
    const catalog = catalogOf(occ('helper', 'util.ts', 'h1'));
    const node = firstCall('helper()');
    for (const idx of [new Map([['helper', 'util.ts']]), NO_IMPORTS] as ImportIndex[]) {
      const v = resolveSyntactic(node, { catalog, currentFileRel: 'app.ts', importIndex: idx });
      expect(v!.resolution).toBe('syntactic');
      expect(v!.confidence).not.toBe('high');
    }
  });

  it('resolves the rightmost name of a property-access call', () => {
    const catalog = catalogOf(occ('method', 'svc.ts', 'M'));
    const node = firstCall('svc.method()');
    const v = resolveSyntactic(node, {
      catalog,
      currentFileRel: 'app.ts',
      importIndex: new Map([['svc', 'svc.ts']]),
    });
    // 'method' resolves by name; svc pins the file.
    expect(v!.to).toEqual(['M']);
  });
});

describe('buildImportIndex', () => {
  it('maps default, named, aliased, and namespace bindings to their target files', () => {
    const source = [
      "import def from './a.js';",
      "import { named, other as alias } from './b.js';",
      "import * as ns from './c.js';",
      "import ext from 'some-pkg';",
    ].join('\n');
    const sf = ts.createSourceFile('/proj/app.ts', source, ts.ScriptTarget.Latest, true);
    const known = collectKnownFiles(
      catalogOf(occ('x', 'a.ts', '1'), occ('y', 'b.ts', '2'), occ('z', 'c.ts', '3')),
    );

    const idx = buildImportIndex(sf, '/proj', known);
    expect(idx.get('def')).toBe('a.ts');
    expect(idx.get('named')).toBe('b.ts');
    expect(idx.get('alias')).toBe('b.ts');
    expect(idx.get('ns')).toBe('c.ts');
    // bare specifier → external (null)
    expect(idx.get('ext')).toBeNull();
  });

  it('maps a relative specifier that resolves to no known file to null', () => {
    // The import resolves to a file the catalog does not know about →
    // null (the resolveSpecifierToFile no-candidate-match fall-through).
    const sf = ts.createSourceFile(
      '/proj/app.ts',
      "import { missing } from './does-not-exist.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    const known = collectKnownFiles(catalogOf(occ('x', 'other.ts', '1')));
    const idx = buildImportIndex(sf, '/proj', known);
    expect(idx.get('missing')).toBeNull();
  });

  it('resolves an `import =` (ImportEqualsDeclaration) binding to its target file', () => {
    const sf = ts.createSourceFile(
      '/proj/app.ts',
      "import legacy = require('./legacy.js');",
      ts.ScriptTarget.Latest,
      true,
    );
    const known = collectKnownFiles(catalogOf(occ('fn', 'legacy.ts', 'L')));
    const idx = buildImportIndex(sf, '/proj', known);
    expect(idx.get('legacy')).toBe('legacy.ts');
  });
});

describe('buildImportSpecifierIndex', () => {
  it('maps binding names to their RAW import specifier (named + default + namespace)', () => {
    const source = [
      "import def from './a.js';",
      "import { named, other as alias } from '@scope/pkg';",
      "import * as ns from './c.js';",
    ].join('\n');
    const sf = ts.createSourceFile('/proj/app.ts', source, ts.ScriptTarget.Latest, true);

    const idx = buildImportSpecifierIndex(sf);
    expect(idx.get('def')).toBe('./a.js');
    expect(idx.get('named')).toBe('@scope/pkg');
    expect(idx.get('alias')).toBe('@scope/pkg');
    expect(idx.get('ns')).toBe('./c.js');
  });

  it('maps an `import =` binding to its raw require specifier', () => {
    const sf = ts.createSourceFile(
      '/proj/app.ts',
      "import legacy = require('./legacy.js');",
      ts.ScriptTarget.Latest,
      true,
    );
    const idx = buildImportSpecifierIndex(sf);
    expect(idx.get('legacy')).toBe('./legacy.js');
  });
});
