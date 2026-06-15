/**
 * @fileoverview Java import-specifier → dependency-edge resolution.
 *
 * Extracted from `resolve.ts` so the call-site resolver and dependency
 * resolver each live in a focused module. This file owns the Java-
 * specific FQN lookup logic (source-root prefix stripping, package vs.
 * type indexing, stdlib short-circuit, static-import + wildcard handling).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */

import type {
  Catalog,
  DependencyEdge,
  DependencySiteRecord,
  FunctionOccurrence,
} from '@opensip-cli/graph';

/**
 * Resolve each Java dependency site to one or more catalog bodyHashes.
 *
 * Strategy:
 *   1. Build two FQN indexes from the catalog's module-init occurrences:
 *      - `type → bodyHash` (e.g. `com.example.Foo` → '<hash>')
 *      - `package → [bodyHash]` (e.g. `com.example` → ['<Foo-hash>', '<Bar-hash>'])
 *      Source roots are stripped from filePath in a fixed priority
 *      order, using the first prefix that strictly contains the file path.
 *   2. For each site, classify the specifier and look up the target(s):
 *      - `<pkg>.*`     → all types in package.
 *      - `static X.*`  → that type's module-init.
 *      - `static X.m`  → X's module-init (m is a member).
 *      - `X` or `X.Y`  → direct type lookup with one-level outer-class fallback.
 *
 * Out of scope: non-default Gradle `sourceSets`, multi-module Maven
 * layouts, and generated-source dirs (`target/generated-sources/...`).
 * Files outside the four canonical roots fall back to project-root and
 * may produce inflated FQNs that miss the lookup (those imports
 * surface as `to: []`, which is the correct unresolved behavior).
 *
 * Stdlib classes (`java.*`, `javax.*`, `jakarta.*`) are treated as
 * external — they're never in the project catalog so we short-circuit
 * to `to: []` without attempting lookup.
 */
export function resolveDependencies(
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
    if (existing === undefined) {
      out.set(site.ownerHash, [edge]);
    } else {
      existing.push(edge);
    }
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
      indexModuleInitOccurrence(o, typeFQN, packageFQN);
    }
  }
  return { typeFQN, packageFQN };
}

/**
 * Index a single catalog occurrence into the FQN maps. No-op for any
 * occurrence that isn't a `module-init` or whose filePath doesn't
 * resolve to a Java type FQN.
 */
function indexModuleInitOccurrence(
  o: FunctionOccurrence,
  typeFQN: Map<string, string>,
  packageFQN: Map<string, string[]>,
): void {
  if (o.kind !== 'module-init') return;
  const fqn = filePathToJavaTypeFQN(o.filePath);
  if (fqn === null) return;
  typeFQN.set(fqn, o.bodyHash);
  const lastDot = fqn.lastIndexOf('.');
  const pkg = lastDot === -1 ? '' : fqn.slice(0, lastDot);
  const bucket = packageFQN.get(pkg);
  if (bucket === undefined) packageFQN.set(pkg, [o.bodyHash]);
  else bucket.push(o.bodyHash);
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
  const { raw, isStatic } = parseStaticPrefix(specifier);

  // Stdlib short-circuit. These never reside in a project catalog.
  if (isJavaStdlibSpecifier(raw)) return [];

  if (raw.endsWith('.*')) {
    return resolveWildcardImport(raw.slice(0, -'.*'.length), isStatic, typeFQN, packageFQN);
  }
  return resolveSingleTargetImport(raw, isStatic, typeFQN);
}

/** Strip a leading `static ` keyword, returning the remainder and the flag. */
function parseStaticPrefix(specifier: string): {
  readonly raw: string;
  readonly isStatic: boolean;
} {
  if (specifier.startsWith('static ')) {
    return { raw: specifier.slice('static '.length), isStatic: true };
  }
  return { raw: specifier, isStatic: false };
}

function isJavaStdlibSpecifier(raw: string): boolean {
  return raw.startsWith('java.') || raw.startsWith('javax.') || raw.startsWith('jakarta.');
}

/**
 * Wildcard imports come in two flavors:
 *   - `<pkg>.*` (non-static) → all types in the package.
 *   - `<type>.*` (static)    → all static members of the type, which
 *                              resolves to that type's module-init.
 */
function resolveWildcardImport(
  head: string,
  isStatic: boolean,
  typeFQN: ReadonlyMap<string, string>,
  packageFQN: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (isStatic) {
    const hash = typeFQN.get(head);
    return hash === undefined ? [] : [hash];
  }
  const bucket = packageFQN.get(head);
  return bucket === undefined ? [] : [...bucket];
}

/**
 * Non-wildcard imports target exactly one type's module-init.
 *
 *   - Static (`static com.foo.Bar.method`) — strip the trailing member
 *     identifier; the remainder is the owning type's FQN.
 *   - Plain (`com.foo.Bar`) — direct FQN lookup, with a one-level
 *     inner-class fallback for `Outer.Inner`-shaped imports (a
 *     heuristic, since `Outer.Inner` and `package.Type` are
 *     structurally indistinguishable without declaring-file resolution).
 */
function resolveSingleTargetImport(
  raw: string,
  isStatic: boolean,
  typeFQN: ReadonlyMap<string, string>,
): readonly string[] {
  if (isStatic) {
    const lastDot = raw.lastIndexOf('.');
    if (lastDot === -1) return [];
    const hash = typeFQN.get(raw.slice(0, lastDot));
    return hash === undefined ? [] : [hash];
  }

  const direct = typeFQN.get(raw);
  if (direct !== undefined) return [direct];
  const lastDot = raw.lastIndexOf('.');
  if (lastDot === -1) return [];
  const outer = typeFQN.get(raw.slice(0, lastDot));
  return outer === undefined ? [] : [outer];
}
