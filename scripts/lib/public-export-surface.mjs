/**
 * public-export-surface — shared TypeScript-AST public-export walker (ADR-0151).
 *
 * Generalizes the ADR-0055 core-only export guard into a reusable library that
 * locks the exact VALUE and TYPE export namespaces of a package entry barrel.
 * A public export cannot be added, removed, or change kind (value ⇄ type ⇄
 * dual) without an explicit reviewed allowlist edit.
 *
 * This module is a PURE library: it never calls `process.exit`, never writes to
 * `console`, and performs read-only filesystem access bounded by explicit caps.
 * The caller (scripts/verify-core-exports.mjs) owns reporting and exit codes.
 *
 * Classification rules (value / type / both):
 *   - `export type { X }` and inline `export { type X }`  → type
 *   - `export interface` / `export type` declarations     → type
 *   - `export const` / `export function`                  → value
 *   - `export class` / `export enum`                      → both (a class or
 *      enum is simultaneously a runtime value and a type)
 *   - a plain `export { X }` re-export resolves by following the re-export
 *      target when it is a CONTAINED relative module: the ultimate declaration's
 *      kind wins (type-only decl → type, value → value, class/enum → both).
 *      An EXTERNAL (bare-specifier) re-export target is NOT followed — it is
 *      classified from local syntax alone (`export type {}` → type, else value).
 *
 * Wildcards: `export * from '...'` specifiers that form the public re-export
 * "barrel spine" (reachable by following `export *` chains from the entry) are
 * collected separately in `wildcards`, matching the legacy ADR-0055 barrel
 * semantics. `export *` statements buried inside a module that is reached only
 * via a NAMED re-export are that module's private business, not a public
 * barrel wildcard, and are not recorded. `export * as ns from` is a named
 * value export (the namespace object), not a spine wildcard.
 *
 * Only contained relative targets are followed (`./x.js` resolves to `./x.ts`).
 * Cycles are detected and terminated. All traversal is bounded by resource
 * caps; any breach throws a bounded, actionable Error.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath, sep as pathSep } from 'node:path';

import ts from 'typescript';

/**
 * @typedef {'value' | 'type' | 'both'} ExportKind
 * @typedef {Object} PublicExportSurface
 * @property {string[]} valueExports  Sorted, deduped value-space export names.
 * @property {string[]} typeExports   Sorted, deduped type-space export names.
 * @property {string[]} wildcards     Sorted, deduped barrel-spine `export *` specifiers.
 * @typedef {Object} SurfaceLimits
 * @property {number} maxSourceBytes  Per-source-file byte cap.
 * @property {number} maxFiles        Distinct files parsed per surface.
 * @property {number} maxDepth        Re-export recursion depth.
 * @property {number} maxNames        Names per single file surface.
 * @property {number} maxPathBytes    Resolved path length cap.
 */

/** @type {SurfaceLimits} */
export const DEFAULT_SURFACE_LIMITS = Object.freeze({
  maxSourceBytes: 1024 * 1024, // 1 MiB per source file
  maxFiles: 4096, // files traversed per surface
  maxDepth: 256, // re-export chain depth
  maxNames: 100_000, // names per surface
  maxPathBytes: 4096, // resolved path byte length
});

/** Bounded, actionable walker error (never leaks stack/source into reports). */
export class PublicExportSurfaceError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PublicExportSurfaceError';
  }
}

/** @param {string} spec */
function isRelativeSpecifier(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

/**
 * Resolve a relative module specifier to a concrete on-disk source file,
 * mapping emitted `.js`/`.mjs`/`.cjs` extensions back to their `.ts` sources.
 *
 * @param {string} fromFile Importing file (absolute).
 * @param {string} spec Relative specifier (e.g. `./x.js`).
 * @param {SurfaceLimits} limits
 * @returns {string | undefined} Absolute, symlink-resolved path, or undefined if none exists.
 */
function resolveRelativeTarget(fromFile, spec, limits) {
  const base = dirname(fromFile);
  /** @type {string[]} */
  const candidates = [];
  const extMap = [
    [/\.js$/, ['.ts', '.tsx']],
    [/\.mjs$/, ['.mts']],
    [/\.cjs$/, ['.cts']],
    [/\.jsx$/, ['.tsx']],
  ];
  let mapped = false;
  for (const [re, exts] of extMap) {
    if (re.test(spec)) {
      for (const ext of exts) candidates.push(spec.replace(re, ext));
      mapped = true;
      break;
    }
  }
  if (!mapped) {
    // extensionless or already a source extension
    candidates.push(spec, `${spec}.ts`, `${spec}.tsx`);
  }
  // directory index fallbacks
  const bare = spec.replace(/\.(js|mjs|cjs|jsx)$/, '');
  candidates.push(`${bare}/index.ts`, `${bare}/index.tsx`);

  for (const candidate of candidates) {
    const abs = resolvePath(base, candidate);
    if (Buffer.byteLength(abs, 'utf8') > limits.maxPathBytes) {
      throw new PublicExportSurfaceError(
        `resolved path exceeds ${limits.maxPathBytes}-byte cap while resolving '${spec}'`,
      );
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      return realpathSync(abs);
    } catch {
      continue;
    }
  }
}

/** @param {ts.Node} node @param {ts.SyntaxKind} kind */
function hasModifier(node, kind) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === kind));
}

/** @param {ts.Node} node */
function isExported(node) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/** @param {ts.Node} node */
function isDefaultExport(node) {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

/**
 * Collect identifier names bound by a variable declaration name (handles the
 * common `Identifier` case plus object/array binding patterns).
 * @param {ts.BindingName} name @param {string[]} out
 */
function collectBindingIdentifiers(name, out) {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBindingIdentifiers(element.name, out);
    }
  }
}

/**
 * @typedef {Object} WalkContext
 * @property {string} repoRoot Real (symlink-resolved) repo root, absolute.
 * @property {SurfaceLimits} limits
 * @property {Map<string, ts.SourceFile>} parsed Parsed-source cache (shared by both walks).
 * @property {Map<string, { names: Map<string, ExportKind> }>} completed Fully-resolved name surfaces.
 * @property {Set<string>} visiting Files currently on the name-resolution stack (cycle guard).
 * @property {Set<string>} wildcards Barrel-spine `export *` specifiers.
 * @property {{ count: number }} filesTraversed Distinct files parsed.
 */

/**
 * @param {string} file Absolute, real path.
 * @param {WalkContext} ctx
 * @returns {boolean}
 */
function isInsideRepo(file, ctx) {
  const root = ctx.repoRoot.endsWith(pathSep) ? ctx.repoRoot : ctx.repoRoot + pathSep;
  return file === ctx.repoRoot || file.startsWith(root);
}

/**
 * Read + parse a source file once (memoized), enforcing repo containment,
 * per-file size cap, parse-diagnostic rejection, and the distinct-file cap.
 * @param {string} file Absolute, symlink-resolved path (inside repoRoot).
 * @param {WalkContext} ctx
 * @returns {ts.SourceFile}
 */
function parseFile(file, ctx) {
  const cached = ctx.parsed.get(file);
  if (cached) return cached;

  if (!isInsideRepo(file, ctx)) {
    throw new PublicExportSurfaceError(`refusing to read file outside repo root: ${file}`);
  }
  const size = statSync(file).size;
  if (size > ctx.limits.maxSourceBytes) {
    throw new PublicExportSurfaceError(
      `source file exceeds ${ctx.limits.maxSourceBytes}-byte cap: ${file}`,
    );
  }
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > ctx.limits.maxSourceBytes) {
    throw new PublicExportSurfaceError(
      `source file exceeds ${ctx.limits.maxSourceBytes}-byte cap: ${file}`,
    );
  }

  ctx.filesTraversed.count += 1;
  if (ctx.filesTraversed.count > ctx.limits.maxFiles) {
    throw new PublicExportSurfaceError(
      `traversed more than ${ctx.limits.maxFiles} files (possible pathological re-export fan-out)`,
    );
  }

  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = /** @type {ts.Diagnostic[] | undefined} */ (
    /** @type {unknown} */ (sourceFile).parseDiagnostics
  );
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, ' ');
    throw new PublicExportSurfaceError(`parse error in ${file}: ${first}`);
  }
  ctx.parsed.set(file, sourceFile);
  return sourceFile;
}

/** @param {ts.ExportDeclaration} stmt */
function moduleSpecifierText(stmt) {
  return stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
    ? stmt.moduleSpecifier.text
    : undefined;
}

/**
 * Collect the public `export *` barrel-spine specifiers reachable from a file
 * by following ONLY bare `export * from` chains (contained targets recurse;
 * external targets are recorded but not followed). Mirrors the legacy ADR-0055
 * barrel walk so core's BARREL_WILDCARDS set is preserved exactly.
 *
 * @param {string} file Absolute, symlink-resolved path.
 * @param {WalkContext} ctx
 * @param {number} depth
 * @param {Set<string>} seen
 */
function collectSpineWildcards(file, ctx, depth, seen) {
  if (depth > ctx.limits.maxDepth) {
    throw new PublicExportSurfaceError(
      `re-export depth exceeded ${ctx.limits.maxDepth} while walking export * spine`,
    );
  }
  if (seen.has(file)) return;
  seen.add(file);

  const sourceFile = parseFile(file, ctx);
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    // Bare `export * from '...'` only (exportClause undefined). `export * as ns`
    // has a NamespaceExport clause and is a named value export, not a spine wildcard.
    if (stmt.exportClause) continue;
    const spec = moduleSpecifierText(stmt);
    if (spec === undefined) continue;
    ctx.wildcards.add(spec);
    if (isRelativeSpecifier(spec)) {
      const target = resolveRelativeTarget(file, spec, ctx.limits);
      if (!target) {
        throw new PublicExportSurfaceError(
          `missing relative export * target '${spec}' from ${file}`,
        );
      }
      collectSpineWildcards(target, ctx, depth + 1, seen);
    }
  }
}

/**
 * Compute the fully-resolved public export NAME surface of a single source
 * file (does not touch `ctx.wildcards` — the spine walk owns those).
 *
 * @param {string} file Absolute, symlink-resolved source path (inside repoRoot).
 * @param {WalkContext} ctx
 * @param {number} depth Current re-export recursion depth.
 * @returns {{ names: Map<string, ExportKind> }}
 */
function surfaceOfFile(file, ctx, depth) {
  if (depth > ctx.limits.maxDepth) {
    throw new PublicExportSurfaceError(
      `re-export depth exceeded ${ctx.limits.maxDepth} (possible pathological re-export chain)`,
    );
  }
  const cached = ctx.completed.get(file);
  if (cached) return cached;
  if (ctx.visiting.has(file)) {
    // Cycle back-edge: terminate with an empty contribution so the walk halts.
    return { names: new Map() };
  }

  const sourceFile = parseFile(file, ctx);
  ctx.visiting.add(file);

  // ── Pass 1: local declarations + import bindings ────────────────────
  /** @type {Map<string, ExportKind>} */
  const localDecls = new Map();
  /**
   * @type {Map<string, { module: string, imported: string, typeOnly: boolean,
   *   namespace: boolean, defaultImport: boolean }>}
   */
  const importBindings = new Map();

  // A name may be declared as both a type and a value in the same module — the
  // legal `interface Foo {}` + `const Foo` companion (declaration-merging)
  // pattern. Merge to 'both' rather than clobber, so the type aspect is not
  // silently dropped and the two direct exports do not later look conflicting.
  /** @param {string} name @param {ExportKind} kind */
  const setLocal = (name, kind) => {
    const existing = localDecls.get(name);
    localDecls.set(name, existing === undefined || existing === kind ? kind : 'both');
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        /** @type {string[]} */
        const ids = [];
        collectBindingIdentifiers(decl.name, ids);
        for (const id of ids) setLocal(id, 'value');
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      setLocal(stmt.name.text, 'value');
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      setLocal(stmt.name.text, 'both');
    } else if (ts.isEnumDeclaration(stmt)) {
      setLocal(stmt.name.text, 'both');
    } else if (ts.isInterfaceDeclaration(stmt)) {
      setLocal(stmt.name.text, 'type');
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      setLocal(stmt.name.text, 'type');
    } else if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
      // namespace/module declaration — treated as dual-space (value + type).
      setLocal(stmt.name.text, 'both');
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      const moduleSpecifier = ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : '';
      const stmtTypeOnly = clause.isTypeOnly;
      if (clause.name) {
        importBindings.set(clause.name.text, {
          module: moduleSpecifier,
          imported: 'default',
          typeOnly: stmtTypeOnly,
          namespace: false,
          defaultImport: true,
        });
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        importBindings.set(named.name.text, {
          module: moduleSpecifier,
          imported: '*',
          typeOnly: stmtTypeOnly,
          namespace: true,
          defaultImport: false,
        });
      } else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          importBindings.set(el.name.text, {
            module: moduleSpecifier,
            imported: (el.propertyName ?? el.name).text,
            typeOnly: stmtTypeOnly || el.isTypeOnly,
            namespace: false,
            defaultImport: false,
          });
        }
      }
    }
  }

  /**
   * Resolve the kind of a locally-visible binding (a local declaration or an
   * imported name). Returns undefined when the name is not locally visible.
   * @param {string} name
   * @returns {ExportKind | undefined}
   */
  function resolveLocalKind(name) {
    const local = localDecls.get(name);
    if (local) return local;
    const imported = importBindings.get(name);
    if (!imported) return;
    if (imported.typeOnly) return 'type';
    if (imported.namespace || imported.defaultImport) return 'value';
    if (isRelativeSpecifier(imported.module)) {
      const target = resolveRelativeTarget(file, imported.module, ctx.limits);
      if (!target) return 'value';
      return surfaceOfFile(target, ctx, depth + 1).names.get(imported.imported) ?? 'value';
    }
    return 'value';
  }

  // ── Pass 2: exports ─────────────────────────────────────────────────
  /** @type {Map<string, ExportKind>} strong (explicit / local) exports */
  const strong = new Map();
  /** @type {Map<string, ExportKind>} weak (`export *`) contributions */
  const weak = new Map();

  /** @param {string} name @param {ExportKind} kind */
  const addStrong = (name, kind) => {
    const existing = strong.get(name);
    if (existing && existing !== kind) {
      throw new PublicExportSurfaceError(
        `conflicting export '${name}' in ${file}: resolved as both '${existing}' and '${kind}' via different paths`,
      );
    }
    strong.set(name, kind);
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt)) {
      // `export =` / `export default <expr>` contribute no NAMED export. Reject
      // them only on the entry barrel (which must use named exports); on a
      // followed module they are irrelevant to the name we are resolving.
      if (depth === 0) {
        throw new PublicExportSurfaceError(
          `unsupported ${stmt.isExportEquals ? 'export = ' : 'export default '}assignment in ${file}`,
        );
      }
      continue;
    }

    // Exported declarations: export const/function/class/interface/type/enum ...
    if (
      ts.isVariableStatement(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      if (!isExported(stmt)) continue;
      if (isDefaultExport(stmt)) {
        // A default-exported declaration is not a named export. Reject only on
        // the entry barrel; skip it on a followed module.
        if (depth === 0) {
          throw new PublicExportSurfaceError(`unsupported export default declaration in ${file}`);
        }
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          /** @type {string[]} */
          const ids = [];
          collectBindingIdentifiers(decl.name, ids);
          // Use the merged local kind so a `const Foo` companion of an
          // `interface Foo` exports as 'both', not a conflicting 'value'.
          for (const id of ids) addStrong(id, localDecls.get(id) ?? 'value');
        }
      } else if (stmt.name && ts.isIdentifier(stmt.name)) {
        addStrong(stmt.name.text, localDecls.get(stmt.name.text) ?? 'value');
      }
      continue;
    }

    if (!ts.isExportDeclaration(stmt)) continue;

    const stmtTypeOnly = stmt.isTypeOnly;
    const moduleSpecifier = moduleSpecifierText(stmt);

    // export * from '...'  (bare star — merge names; wildcard recorded by spine walk)
    if (!stmt.exportClause) {
      if (moduleSpecifier === undefined) continue; // malformed
      if (isRelativeSpecifier(moduleSpecifier)) {
        const target = resolveRelativeTarget(file, moduleSpecifier, ctx.limits);
        if (!target) {
          throw new PublicExportSurfaceError(
            `missing relative export * target '${moduleSpecifier}' from ${file}`,
          );
        }
        for (const [name, kind] of surfaceOfFile(target, ctx, depth + 1).names) {
          const merged = stmtTypeOnly ? 'type' : kind;
          const existing = weak.get(name);
          if (existing && existing !== merged) {
            throw new PublicExportSurfaceError(
              `ambiguous \`export *\` re-export '${name}' in ${file}: '${existing}' vs '${merged}'`,
            );
          }
          weak.set(name, merged);
        }
      }
      // external `export *` — names are not statically enumerable; skip.
      continue;
    }

    // export * as ns from '...' → single value (namespace object) export
    if (ts.isNamespaceExport(stmt.exportClause)) {
      addStrong(stmt.exportClause.name.text, stmtTypeOnly ? 'type' : 'value');
      continue;
    }

    // export { ... } / export type { ... } / export { ..., type X } ...
    if (ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const exportedName = el.name.text;
        const localName = (el.propertyName ?? el.name).text;
        const elementTypeOnly = stmtTypeOnly || el.isTypeOnly;

        if (elementTypeOnly) {
          addStrong(exportedName, 'type');
          continue;
        }
        if (localName === 'default') {
          // re-exporting some module's default under a named export
          addStrong(exportedName, 'value');
          continue;
        }
        if (moduleSpecifier === undefined) {
          // local re-export: resolve against local scope
          addStrong(exportedName, resolveLocalKind(localName) ?? 'value');
          continue;
        }
        if (!isRelativeSpecifier(moduleSpecifier)) {
          // external re-export: classify from syntax only, do not follow
          addStrong(exportedName, 'value');
          continue;
        }
        const target = resolveRelativeTarget(file, moduleSpecifier, ctx.limits);
        if (!target) {
          throw new PublicExportSurfaceError(
            `missing relative re-export target '${moduleSpecifier}' from ${file}`,
          );
        }
        addStrong(
          exportedName,
          surfaceOfFile(target, ctx, depth + 1).names.get(localName) ?? 'value',
        );
      }
    }
  }

  // Merge: `export *` contributions are weak; explicit/local exports win.
  /** @type {Map<string, ExportKind>} */
  const names = new Map(weak);
  for (const [name, kind] of strong) names.set(name, kind);

  if (names.size > ctx.limits.maxNames) {
    throw new PublicExportSurfaceError(`surface of ${file} exceeds ${ctx.limits.maxNames} names`);
  }

  ctx.visiting.delete(file);
  const result = { names };
  ctx.completed.set(file, result);
  return result;
}

/**
 * Read the public export surface (value/type namespaces + barrel-spine
 * `export *` wildcard specifiers) reachable from an entry barrel.
 *
 * @param {string} entryFile Absolute or repo-relative path to the entry barrel.
 * @param {{ repoRoot: string, limits?: Partial<SurfaceLimits> }} options
 * @returns {PublicExportSurface}
 */
export function readPublicExportSurface(entryFile, options) {
  if (!options || typeof options.repoRoot !== 'string' || options.repoRoot.length === 0) {
    throw new PublicExportSurfaceError('readPublicExportSurface requires { repoRoot }');
  }
  /** @type {SurfaceLimits} */
  const limits = { ...DEFAULT_SURFACE_LIMITS, ...options.limits };

  let repoRootReal;
  try {
    repoRootReal = realpathSync(resolvePath(options.repoRoot));
  } catch {
    throw new PublicExportSurfaceError(`repoRoot does not exist: ${options.repoRoot}`);
  }

  const entryAbs = resolvePath(repoRootReal, entryFile);
  if (Buffer.byteLength(entryAbs, 'utf8') > limits.maxPathBytes) {
    throw new PublicExportSurfaceError(
      `entry path exceeds ${limits.maxPathBytes}-byte cap: ${entryAbs}`,
    );
  }
  let entryReal;
  try {
    const st = statSync(entryAbs);
    if (!st.isFile()) throw new Error('not a file');
    entryReal = realpathSync(entryAbs);
  } catch {
    throw new PublicExportSurfaceError(`entry file does not exist: ${entryFile}`);
  }

  /** @type {WalkContext} */
  const ctx = {
    repoRoot: repoRootReal,
    limits,
    parsed: new Map(),
    completed: new Map(),
    visiting: new Set(),
    wildcards: new Set(),
    filesTraversed: { count: 0 },
  };
  if (!isInsideRepo(entryReal, ctx)) {
    throw new PublicExportSurfaceError(`entry file escapes repo root: ${entryReal}`);
  }

  const surface = surfaceOfFile(entryReal, ctx, 0);
  collectSpineWildcards(entryReal, ctx, 0, new Set());

  const valueExports = [];
  const typeExports = [];
  for (const [name, kind] of surface.names) {
    if (kind === 'value' || kind === 'both') valueExports.push(name);
    if (kind === 'type' || kind === 'both') typeExports.push(name);
  }

  // Default Array#sort compares strings by UTF-16 code unit — the stable,
  // deterministic order the allowlists are stored in.
  const sortUnique = (arr) => [...new Set(arr)].sort();
  return {
    valueExports: sortUnique(valueExports),
    typeExports: sortUnique(typeExports),
    wildcards: sortUnique([...ctx.wildcards]),
  };
}

/**
 * Pure diff of an actual surface against an expected allowlist.
 *
 * `missing*` = names present in `actual` but absent from `expected` (a live
 * export the allowlist does not yet list — add it after review). `stale*` =
 * names present in `expected` but absent from `actual` (an allowlisted export
 * that no longer exists — remove it).
 *
 * @param {{ valueExports: string[], typeExports: string[] }} actual
 * @param {{ valueExports: string[], typeExports: string[] }} expected
 * @returns {{ missingValues: string[], staleValues: string[], missingTypes: string[], staleTypes: string[] }}
 */
export function comparePublicExportSurface(actual, expected) {
  const diff = (live, allow) => {
    const liveSet = new Set(live);
    const allowSet = new Set(allow);
    const missing = live.filter((n) => !allowSet.has(n)).sort();
    const stale = allow.filter((n) => !liveSet.has(n)).sort();
    return { missing, stale };
  };
  const values = diff(actual.valueExports ?? [], expected.valueExports ?? []);
  const types = diff(actual.typeExports ?? [], expected.typeExports ?? []);
  return {
    missingValues: values.missing,
    staleValues: values.stale,
    missingTypes: types.missing,
    staleTypes: types.stale,
  };
}
