/**
 * Java resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Three node kinds surface as calls:
 *      - `method_invocation`            — name from the `name` field.
 *        Covers `foo(...)`, `obj.foo(...)`, `Class.foo(...)`,
 *        `this.foo(...)`, `super.foo(...)` — all have the same shape.
 *      - `object_creation_expression`   — `new Foo(...)`. The target
 *        is the type name (`Foo`), which matches the constructor's
 *        `simpleName` since constructors carry their class name.
 *      - `explicit_constructor_invocation` — `super(...)` or
 *        `this(...)` inside a constructor body. We map `super` →
 *        unresolved (parent type unknown without full lookup) and
 *        `this` → unresolved (we can't tell which sibling ctor without
 *        argument-arity matching, which is out of scope).
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder mirrors graph-python/graph-go:
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'`
 *
 * Per I-4: this function does NOT mutate the input catalog.
 */

import { logger } from '@opensip-tools/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';

import type { JavaParsedFile, JavaParsedProject } from './parse.js';
import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  DependencySiteRecord,
  FunctionOccurrence,
  MutableStats,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

function javaPosition(node: Parser.SyntaxNode, file: JavaParsedFile): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    text: file.source.slice(node.startIndex, node.endIndex),
  };
}

export function resolveCallSites(input: ResolveInput<JavaParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:java' });
  const byName = buildNameIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as JavaParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats, javaPosition);
      continue;
    }
    pushCallEdge(node, file, r.ownerHash, byName, edgesByOwner, stats);
  }

  const finalStats: ResolutionStats = {
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  };
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:java', ...finalStats });

  // Phase 4 (DEC-498): resolve dependency sites if any. Mirrors the
  // other tree-sitter adapters' resolveDependencies pattern, adapted to
  // Java's package = directory-mirror convention.
  const dependenciesByOwner =
    input.dependencySites && input.dependencySites.length > 0
      ? resolveDependencies(input.dependencySites, input.catalog)
      : undefined;

  return dependenciesByOwner === undefined
    ? { edgesByOwner, stats: finalStats }
    : { edgesByOwner, dependenciesByOwner, stats: finalStats };
}

/**
 * Resolve Java `import` sites to target module-init bodyHashes.
 *
 * Java has a strict directory-mirrors-package convention: the package
 * `com.example.foo` lives at directory `com/example/foo/`. A type `Bar`
 * in that package lives in `com/example/foo/Bar.java`. We build two
 * lookup tables off this convention:
 *
 *   1. **By type FQN** — `com.example.foo.Bar` → bodyHash of the
 *      `Bar.java` module-init. Used for plain type imports.
 *   2. **By package FQN** — `com.example.foo` → bodyHash[] (one per
 *      `*.java` file in that package). Used for wildcard imports
 *      (`import com.example.foo.*;`).
 *
 * Source-root inference: source roots vary by build system. We check
 * the canonical Maven/Gradle layouts (`src/main/java/`, `src/test/java/`),
 * the plain `src/` layout, and the project-root layout (`''`) in that
 * order, using the first prefix that strictly contains the file path.
 * Non-default Gradle `sourceSets`, multi-module Maven layouts, and
 * generated-source dirs (`target/generated-sources/...`) are NOT handled
 * — files outside the four canonical roots fall back to project-root
 * and may produce inflated FQNs that miss the lookup (those imports
 * surface as `to: []`, which is the correct unresolved behavior).
 *
 * Stdlib classes (`java.*`, `javax.*`, `jakarta.*`) are treated as
 * external — they're never in the project catalog so we short-circuit
 * to `to: []` without attempting lookup.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function resolveDependencies(
  sites: readonly DependencySiteRecord[],
  catalog: Catalog,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const { typeFQN, packageFQN } = buildJavaFQNIndex(catalog);

  const out = new Map<string, DependencyEdge[]>();
  for (const site of sites) {
    const to = resolveJavaImportSpecifier(site.specifier, typeFQN, packageFQN);
    const edge: DependencyEdge = {
      to,
      line: site.line,
      column: site.column,
      specifier: site.specifier,
    };
    const existing = out.get(site.ownerHash);
    if (existing === undefined) {out.set(site.ownerHash, [edge]);}
    else {existing.push(edge);}
  }
  return out;
}

/** The canonical source-root prefixes we recognize, in priority order.
 *  First strict-prefix match on a catalog file's filePath wins. */
const JAVA_SOURCE_ROOT_PREFIXES = ['src/main/java/', 'src/test/java/', 'src/'] as const;

/**
 * Build both FQN lookup maps from the catalog's module-init occurrences.
 *
 * For each module-init occurrence:
 *   1. Strip a recognized source-root prefix (or `''` for project-root).
 *   2. Strip the `.java` extension.
 *   3. Slash-to-dot → that's the type FQN. The package is everything
 *      before the last dot.
 */
function buildJavaFQNIndex(catalog: Catalog): {
  readonly typeFQN: ReadonlyMap<string, string>;
  readonly packageFQN: ReadonlyMap<string, readonly string[]>;
} {
  const typeFQN = new Map<string, string>();
  const packageFQN = new Map<string, string[]>();

  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.kind !== 'module-init') continue;
      const fqn = filePathToJavaTypeFQN(o.filePath);
      if (fqn === null) continue;
      typeFQN.set(fqn, o.bodyHash);
      const lastDot = fqn.lastIndexOf('.');
      const pkg = lastDot === -1 ? '' : fqn.slice(0, lastDot);
      const bucket = packageFQN.get(pkg);
      if (bucket === undefined) {packageFQN.set(pkg, [o.bodyHash]);}
      else {bucket.push(o.bodyHash);}
    }
  }
  return { typeFQN, packageFQN };
}

/**
 * Map a project-relative POSIX filePath to its Java type FQN. Returns
 * `null` when the file doesn't end in `.java` (defensive — the discover
 * pass should already filter by extension, but module-init occurrences
 * could in principle carry any path).
 *
 * Examples:
 *   - `src/main/java/com/example/foo/Bar.java` → `com.example.foo.Bar`
 *   - `src/test/java/com/example/FooTest.java` → `com.example.FooTest`
 *   - `src/com/example/foo/Bar.java`           → `com.example.foo.Bar`
 *   - `com/example/foo/Bar.java`               → `com.example.foo.Bar`
 *   - `Bar.java`                               → `Bar` (default package)
 */
function filePathToJavaTypeFQN(filePath: string): string | null {
  if (!filePath.endsWith('.java')) /* v8 ignore next */ return null;
  let stripped = filePath;
  for (const prefix of JAVA_SOURCE_ROOT_PREFIXES) {
    if (filePath.startsWith(prefix)) {
      stripped = filePath.slice(prefix.length);
      break;
    }
  }
  const noExt = stripped.slice(0, -'.java'.length);
  return noExt.replaceAll('/', '.');
}

/**
 * Resolve one Java import-specifier string to its target module-init
 * bodyHash(es).
 *
 * Stdlib short-circuit: `java.*`, `javax.*`, `jakarta.*` are never in
 * the catalog. The `kotlin.*` and `scala.*` runtimes are similarly
 * external for Java projects, but we don't special-case them — they
 * fall through to the type-FQN lookup and miss naturally.
 *
 * Static imports always target a static MEMBER (method or field) of
 * a class. The class's module-init occurrence is the dependency target,
 * so we strip the trailing identifier before lookup. Static wildcards
 * (`static com.foo.Bar.*`) target all static members of one class — same
 * type lookup as plain static imports.
 */
function resolveJavaImportSpecifier(
  specifier: string,
  typeFQN: ReadonlyMap<string, string>,
  packageFQN: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  let raw = specifier;
  let isStatic = false;
  if (raw.startsWith('static ')) {
    isStatic = true;
    raw = raw.slice('static '.length);
  }

  // Stdlib short-circuit. These never reside in a project catalog.
  if (raw.startsWith('java.') || raw.startsWith('javax.') || raw.startsWith('jakarta.')) {
    return [];
  }

  // Wildcard: `<pkg>.*` (non-static) → all types in the package.
  //           `<type>.*` (static)    → all static members of the type
  //                                     → resolve to that type.
  if (raw.endsWith('.*')) {
    const head = raw.slice(0, -'.*'.length);
    if (isStatic) {
      // Static wildcard targets a TYPE's static members.
      const hash = typeFQN.get(head);
      return hash === undefined ? [] : [hash];
    }
    // Plain wildcard targets a PACKAGE.
    const bucket = packageFQN.get(head);
    return bucket === undefined ? [] : [...bucket];
  }

  if (isStatic) {
    // `static com.foo.Bar.method` — strip the trailing member to get
    // the owning type's FQN.
    const lastDot = raw.lastIndexOf('.');
    if (lastDot === -1) return [];
    const typeFqn = raw.slice(0, lastDot);
    const hash = typeFQN.get(typeFqn);
    return hash === undefined ? [] : [hash];
  }

  // Plain type import. Direct lookup; on miss, fall back to treating
  // the trailing segment as an inner-class name (one level only — for
  // multiply-nested inner classes the lookup will still miss). This is
  // a heuristic: Java's `Outer.Inner` import is structurally
  // indistinguishable from `package.Type` without resolving the type's
  // declaring file.
  const direct = typeFQN.get(raw);
  if (direct !== undefined) return [direct];
  const lastDot = raw.lastIndexOf('.');
  if (lastDot === -1) return [];
  const outerFqn = raw.slice(0, lastDot);
  const outer = typeFQN.get(outerFqn);
  return outer === undefined ? [] : [outer];
}

function buildNameIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    if (name.startsWith('<')) continue;
    const list: string[] = out.get(name) ?? [];
    for (const o of occs) list.push(o.bodyHash);
    if (list.length > 0) out.set(name, list);
  }
  return out;
}

function pushCallEdge(
  node: Parser.SyntaxNode,
  file: JavaParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = javaPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge = buildJavaCallEdge(target, byName, {
    line: pos.line,
    column: pos.column,
    text: truncated,
    discarded,
  });
  appendEdge(edgesByOwner, ownerHash, edge);
  stats.apply(edge);
}

interface CallEdgeLoc {
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly discarded: boolean;
}

function buildJavaCallEdge(
  target: string | null,
  byName: ReadonlyMap<string, readonly string[]>,
  loc: CallEdgeLoc,
): CallEdge {
  if (target === null) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  const matches = byName.get(target);
  if (!matches || matches.length === 0) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  if (matches.length === 1) {
    return { to: [...matches], ...loc, resolution: 'static', confidence: 'medium' };
  }
  return { to: [...matches], ...loc, resolution: 'method-dispatch', confidence: 'low' };
}

/**
 * Decode a Java call-site node's target into a simple name. Returns
 * null when the shape isn't one we recognize.
 */
function extractCallTargetName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'method_invocation') {
    const name = node.childForFieldName('name');
    return name ? name.text : null;
  }
  if (node.type === 'object_creation_expression') {
    // `new Foo(...)` — target is the type name. The `type` field holds
    // a type_identifier (`Foo`), generic_type (`Foo<T>`), or
    // scoped_type_identifier (`pkg.Foo`).
    const ty = node.childForFieldName('type');
    return ty ? decodeTypeName(ty) : null;
  }
  if (node.type === 'explicit_constructor_invocation') {
    // `super(...)` or `this(...)`. We can't disambiguate constructor
    // overloads without argument-arity matching against the catalog,
    // and `super` targets a parent class we may not have. Leave
    // unresolved (callers will see the edge with text but to=[]).
    return null;
  }
  /* v8 ignore next */
  return null;
}

function decodeTypeName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'generic_type') {
    const inner = node.childForFieldName('type') ?? node.namedChild(0);
    return inner ? decodeTypeName(inner) : null;
  }
  if (node.type === 'scoped_type_identifier') {
    // `pkg.Foo` — trailing identifier is the type.
    const last = node.namedChild(node.namedChildCount - 1);
    return last ? last.text : null;
  }
  /* v8 ignore next */
  return null;
}

/**
 * The call's return value is discarded when its parent is an
 * expression_statement.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  /* v8 ignore next */
  return false;
}
