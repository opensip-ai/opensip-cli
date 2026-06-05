/**
 * Targeted branch-coverage tests for graph-java edge cases that the
 * end-to-end fixture suites don't reach.
 *
 * These exercise:
 *   - body-digest: `//` line-comment stripping inside a method body.
 *   - walk.ts: the per-file try/catch (walkFile throws → parseError) and
 *     the defensive `if (!file) continue` guard.
 *   - walk-metadata: varargs (`spread_parameter`) param extraction, where
 *     the name lives in a `variable_declarator` (no `name` field, no bare
 *     `identifier` child) so the param is skipped; and the empty-arg
 *     lambda path.
 *   - resolve.ts: a `creation` call-site with no `childHash` (skipped),
 *     and the name-index skipping falsy occurrence lists.
 *   - resolve-dependencies.ts: no-dot static and plain imports, the
 *     non-module-init occurrence early-return, and the falsy occs guard.
 */

import { parseJava } from '@opensip-tools/lang-java';
import { describe, expect, it } from 'vitest';


import { digestJavaBody } from '../body-digest.js';
import { resolveDependencies } from '../resolve-dependencies.js';
import { resolveCallSites } from '../resolve.js';
import { extractLambdaParams, extractParams } from '../walk-metadata.js';
import { walkProject } from '../walk.js';

import type { JavaParsedFile, JavaParsedProject } from '../parse.js';
import type {
  CallSiteRecord,
  Catalog,
  DependencySiteRecord,
  FunctionOccurrence,
  ResolveInput,
} from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

// ADR-0010: parse via the canonical lang-java substrate (which owns the
// grammar) rather than constructing a web-tree-sitter parser here.
function parseRoot(src: string): Node {
  const parsed = parseJava(src, 'fixture.java');
  if (parsed === null) throw new Error('parse returned no tree');
  return parsed.tree.rootNode;
}

function findNode(node: Node, type: string): Node | null {
  if (node.type === type) return node;
  for (const child of node.children) {
    if (!child) continue;
    const found = findNode(child, type);
    if (found) return found;
  }
  return null;
}

function occurrence(partial: Partial<FunctionOccurrence>): FunctionOccurrence {
  return {
    bodyHash: 'h',
    bodySize: 1,
    simpleName: 's',
    qualifiedName: 'q',
    filePath: 'F.java',
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'module-init',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...partial,
  };
}

function depSite(specifier: string): DependencySiteRecord {
  return {
    nodeRef: {},
    sourceFileRef: {},
    ownerHash: 'owner',
    specifier,
    line: 1,
    column: 0,
  } satisfies DependencySiteRecord;
}

function catalogWith(functions: Catalog['functions']): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'java',
    builtAt: 'x',
    cacheKey: 'k',
    functions,
  };
}

describe('graph-java body-digest line comments', () => {
  it('strips `//` line comments inside a method body but keeps the code', () => {
    const withComment = digestJavaBody('int m() {\n  // discard me\n  return 1;\n}');
    const withoutComment = digestJavaBody('int m() {\n  return 1;\n}');
    // The line comment is normalized away, so the two bodies hash equal.
    expect(withComment.hash).toBe(withoutComment.hash);
  });
});

describe('graph-java walk.ts defensive paths', () => {
  it('records a parseError when walking a file throws', () => {
    // A file whose tree.rootNode getter throws drives the per-file
    // try/catch in walkProject (the catch records a ParseError and the
    // walk stays total over the file set).
    const badFile = {
      source: 'class X {}',
      tree: {
        get rootNode(): never {
          throw new Error('boom-tree');
        },
      },
    } as unknown as JavaParsedFile;
    const project: JavaParsedProject = { files: new Map([['/abs/Bad.java', badFile]]) };

    const out = walkProject({ project, projectDirAbs: '/abs', files: ['/abs/Bad.java'] });

    expect(out.parseErrors).toHaveLength(1);
    expect(out.parseErrors[0]?.filePath).toBe('Bad.java');
    expect(out.parseErrors[0]?.message).toBe('boom-tree');
    expect(Object.keys(out.occurrences)).toHaveLength(0);
  });

  it('skips a path whose project lookup yields undefined', () => {
    // `files.has(p)` returns true (so the path survives the filter) but
    // `files.get(p)` returns undefined — the `if (!file) continue` guard.
    const project = {
      files: {
        has: (): boolean => true,
        get: (): JavaParsedFile | undefined => undefined,
      } as unknown as ReadonlyMap<string, JavaParsedFile>,
    } as JavaParsedProject;

    const out = walkProject({ project, projectDirAbs: '/abs', files: ['/abs/Phantom.java'] });

    expect(Object.keys(out.occurrences)).toHaveLength(0);
    expect(out.parseErrors).toHaveLength(0);
  });
});

describe('graph-java walk-metadata param extraction', () => {
  it('skips a varargs parameter whose name lives in a variable_declarator', () => {
    // tree-sitter-java models `String... xs` as a `spread_parameter`
    // with `type_identifier` + `variable_declarator` named children and
    // no `name` field — so findIdentifierChild returns null and the
    // param is skipped.
    const root = parseRoot('class A { void f(String... xs) {} }');
    const method = findNode(root, 'method_declaration');
    expect(method).not.toBeNull();
    expect(extractParams(method!)).toEqual([]);
  });

  it('extracts plain formal parameter names', () => {
    const root = parseRoot('class A { void f(int a, String b) {} }');
    const method = findNode(root, 'method_declaration');
    expect(extractParams(method!).map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('returns no params for an empty-arg lambda (() -> {})', () => {
    // The parameter list is an empty `formal_parameters` node, which
    // falls through to extractParams and yields [].
    const root = parseRoot('class A { Runnable r = () -> {}; }');
    const lambda = findNode(root, 'lambda_expression');
    expect(lambda).not.toBeNull();
    expect(extractLambdaParams(lambda!)).toEqual([]);
  });

  it('extractParams returns [] for a node with no `parameters` field', () => {
    // A `block` node has no `parameters` field → the `if (!params)`
    // early-return arm.
    const root = parseRoot('class A { void m() { foo(); } }');
    const block = findNode(root, 'block');
    expect(block).not.toBeNull();
    expect(extractParams(block!)).toEqual([]);
  });

  it('extractLambdaParams returns [] for a node with no `parameters` field', () => {
    // Same `block` node drives extractLambdaParams' `if (!params)` arm.
    const root = parseRoot('class A { void m() { foo(); } }');
    const block = findNode(root, 'block');
    expect(block).not.toBeNull();
    expect(extractLambdaParams(block!)).toEqual([]);
  });
});

describe('graph-java resolve.ts edge cases', () => {
  it('skips a creation call-site that carries no childHash', () => {
    const callSites: CallSiteRecord[] = [
      {
        nodeRef: {} as unknown,
        sourceFileRef: {} as unknown,
        ownerHash: 'owner',
        kind: 'creation',
        // childHash deliberately omitted → the resolver skips it.
      } as unknown as CallSiteRecord,
    ];
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'java',
      builtAt: 'x',
      cacheKey: 'k',
      functions: {},
    };
    const input: ResolveInput<JavaParsedProject> = {
      project: { files: new Map() },
      catalog,
      callSites,
      projectDirAbs: '/abs',
      resolutionMode: 'exact',
    };

    const out = resolveCallSites(input);
    expect(out.edgesByOwner.size).toBe(0);
    expect(out.stats.totalCallSites).toBe(0);
  });

  it('skips falsy occurrence lists when building the name index', () => {
    // A function name mapping to an undefined list must not crash the
    // name-index builder (the `if (!occs) continue` guard).
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'java',
      builtAt: 'x',
      cacheKey: 'k',
      functions: {
        ghost: undefined as unknown as readonly FunctionOccurrence[],
        real: [occurrence({ simpleName: 'real', kind: 'method', bodyHash: 'rh' })],
      },
    };
    const callSites: CallSiteRecord[] = [];
    const input: ResolveInput<JavaParsedProject> = {
      project: { files: new Map() },
      catalog,
      callSites,
      projectDirAbs: '/abs',
      resolutionMode: 'exact',
    };

    const out = resolveCallSites(input);
    expect(out.edgesByOwner.size).toBe(0);
  });
});

describe('graph-java resolve-dependencies edge cases', () => {
  it('returns [] for a static import with no dot in its target', () => {
    const out = resolveDependencies(
      [depSite('static Nodot')],
      catalogWith({
        '<module-init:Foo.java>': [occurrence({ filePath: 'Foo.java', bodyHash: 'fh' })],
      }),
    );
    expect(out.get('owner')?.[0]?.to).toEqual([]);
  });

  it('returns [] for a plain default-package import absent from the catalog', () => {
    const out = resolveDependencies([depSite('Bare')], catalogWith({}));
    expect(out.get('owner')?.[0]?.to).toEqual([]);
  });

  it('ignores non-module-init occurrences when building the FQN index', () => {
    // A `method` occurrence must not be indexed as a type FQN — so a
    // plain import that names its file resolves to nothing.
    const out = resolveDependencies(
      [depSite('Foo')],
      catalogWith({
        m: [occurrence({ kind: 'method', filePath: 'Foo.java', bodyHash: 'mh' })],
      }),
    );
    expect(out.get('owner')?.[0]?.to).toEqual([]);
  });

  it('skips falsy occurrence lists when building the FQN index', () => {
    const out = resolveDependencies(
      [depSite('com.example.Foo')],
      catalogWith({
        ghost: undefined as unknown as readonly FunctionOccurrence[],
        '<module-init:com/example/Foo.java>': [
          occurrence({ filePath: 'com/example/Foo.java', bodyHash: 'fh' }),
        ],
      }),
    );
    expect(out.get('owner')?.[0]?.to).toEqual(['fh']);
  });
});
