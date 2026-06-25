/**
 * Entry-point inference (shared by orphan-subtree, test-only-reachable).
 *
 * A function is an entry point if:
 *  1. It's the bin entry (declared in package.json `bin`).
 *  2. It's a Tool registration's commands handler.
 *  3. Its name matches a heuristic list (main, start, register, init, etc.).
 *  4. Its `<module-init>` is reachable (top-level statements always run).
 *  5. It's exported AND has no *external* in-project caller (someone
 *     outside the project might call it). A self-recursive edge does not
 *     count as a caller here: an exported public function whose only
 *     in-project caller is itself (e.g. a recursive renderer consumed
 *     only across a package boundary, where the cross-package call edge
 *     does not resolve) is still an external entry point — counting its
 *     own recursion as a "caller" would wrongly hide it (and its whole
 *     file-local helper subtree) as an orphan.
 *  6. It's an EXPORTED symbol of a module reached via a dynamic
 *     `import('<spec>')` / `await import('<spec>')` expression (including
 *     the `const { x } = await import(...)` destructure form). The call
 *     graph's static resolver cannot trace a binding through a dynamic
 *     import, so a function reached only that way would otherwise look
 *     orphaned. We treat the dynamic-import target the same way a static
 *     import edge makes the imported module's exported surface reachable:
 *     resolve the relative specifier to the target file and seed its
 *     exported occurrences as entry points. This is conservative — it
 *     only adds reachability (never suppresses a genuine orphan), and it
 *     fires solely on exported symbols of an actually-imported file.
 *
 * v0.2 ships heuristics 3, 4, 5; 1 and 2 are project-specific and
 * deferred until cross-package call resolution is reliable. Heuristic 6
 * (dynamic-import reachability) was added to fix a verified false
 * positive: a CLI command reached only via
 * `const { runReplay } = await import('../commands/.../replay.js')`.
 */

import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';

const NAME_HEURISTICS = new Set([
  'main',
  'run',
  'start',
  'register',
  'initialize',
  'init',
  'bootstrap',
]);

export interface EntryPoint {
  readonly bodyHash: string;
  readonly reason: 'module-init' | 'name-match' | 'no-callers-exported' | 'dynamic-import';
}

export function inferEntryPoints(catalog: Catalog, indexes: Indexes): readonly EntryPoint[] {
  const out: EntryPoint[] = [];
  const seen = new Set<string>();
  for (const occ of indexes.byBodyHash.values()) {
    const reason = classify(occ, indexes);
    if (reason !== null) {
      out.push({ bodyHash: occ.bodyHash, reason });
      seen.add(occ.bodyHash);
    }
  }
  // Heuristic 6: exported symbols of any dynamically-imported module are
  // entry points (the static call resolver cannot trace a binding through
  // `import(...)`). Deduped against the heuristics above so a function is
  // never emitted twice.
  for (const hash of dynamicImportEntryHashes(indexes)) {
    if (!seen.has(hash)) {
      out.push({ bodyHash: hash, reason: 'dynamic-import' });
      seen.add(hash);
    }
  }
  // Honor caller-supplied override at the rule level via GraphConfig
  // (handled by the consuming rule). This module returns the inferred
  // set; rules merge it with config.entryPointHashes.
  void catalog;
  return out;
}

function classify(occ: FunctionOccurrence, indexes: Indexes): EntryPoint['reason'] | null {
  // Every <module-init> is an entry point. Top-level statements run
  // whenever the file is part of the import closure of a real
  // entry point. We don't track import edges, so a conservative
  // approximation is "every file's module-init is alive." Combined
  // with creation edges (parent-function → nested-function), this
  // gives transitive reachability for everything except top-level
  // function declarations that are never named-called and never
  // referenced as values.
  if (occ.kind === 'module-init') return 'module-init';
  if (NAME_HEURISTICS.has(occ.simpleName)) return 'name-match';
  if (occ.visibility === 'exported' && !hasExternalCaller(occ, indexes)) {
    // Exported but no *external* in-project caller — likely an external
    // entry point (consumed cross-package, where the call edge may not
    // resolve). Self-recursion does not count as an external caller.
    return 'no-callers-exported';
  }
  return null;
}

/**
 * True iff some in-project occurrence other than `occ` itself calls it.
 * A self-recursive edge (`callers` contains `occ.bodyHash`) is excluded:
 * recursion does not make a function reachable, so an otherwise-uncalled
 * exported function must still be treated as an external entry point.
 */
function hasExternalCaller(occ: FunctionOccurrence, indexes: Indexes): boolean {
  const callers = indexes.callers.get(occ.bodyHash);
  if (callers === undefined) return false;
  for (const caller of callers) {
    if (caller !== occ.bodyHash) return true;
  }
  return false;
}

/**
 * Matches a dynamic-import call expression and captures its specifier:
 * `import('./x.js')`, `await import("./x")`, and the
 * `const { y } = await import('./x.js')` destructure form all surface in
 * the catalog as a call edge whose `text` begins with `import(` followed
 * by the string-literal specifier. We capture the specifier verbatim.
 */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/;

/**
 * Body hashes of every EXPORTED occurrence that lives in a file targeted
 * by a dynamic `import('<spec>')` anywhere in the project. Built by:
 *  1. collecting every relative dynamic-import specifier (from call-edge
 *     text), resolved to a project-relative target path against the
 *     importing occurrence's directory;
 *  2. mapping those target paths to the catalog's actual file paths
 *     (tolerating the `.js → .ts/.tsx` ESM extension rewrite and
 *     `index` directory imports);
 *  3. emitting the exported occurrences declared in each matched file.
 *
 * Bare/workspace specifiers (`@scope/pkg`, `node:fs`) are ignored — they
 * resolve outside the catalog and the exported-no-caller heuristic
 * already covers cross-package surface.
 */
function dynamicImportEntryHashes(indexes: Indexes): readonly string[] {
  const targetFiles = collectDynamicImportTargetFiles(indexes);
  if (targetFiles.size === 0) return [];

  const exportedByFile = buildExportedByFile(indexes);
  const out: string[] = [];
  for (const target of targetFiles) {
    for (const candidate of candidateFilePaths(target)) {
      const occs = exportedByFile.get(candidate);
      if (occs) {
        for (const o of occs) out.push(o.bodyHash);
      }
    }
  }
  return out;
}

/** Resolve every relative dynamic-import specifier to a project-relative
 *  (extension-bearing) target path, keyed off the importing occurrence's
 *  directory. */
function collectDynamicImportTargetFiles(indexes: Indexes): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const occ of indexes.byBodyHash.values()) {
    for (const call of occ.calls) {
      const match = DYNAMIC_IMPORT_RE.exec(call.text);
      if (!match) continue;
      const specifier = match[1];
      // Only relative specifiers resolve into the catalog.
      if (!specifier.startsWith('.')) continue;
      targets.add(resolveRelative(dirOf(occ.filePath), specifier));
    }
  }
  return targets;
}

/** filePath → exported function occurrences declared in that file. */
function buildExportedByFile(indexes: Indexes): ReadonlyMap<string, FunctionOccurrence[]> {
  const byFile = new Map<string, FunctionOccurrence[]>();
  for (const occ of indexes.byBodyHash.values()) {
    if (occ.visibility !== 'exported') continue;
    if (!occ.filePath) continue;
    const bucket = byFile.get(occ.filePath);
    if (bucket) bucket.push(occ);
    else byFile.set(occ.filePath, [occ]);
  }
  return byFile;
}

/** Project-relative posix directory of a file ('' for a root-level file). */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

/** Resolve a relative specifier against a posix directory, collapsing
 *  `.` / `..` segments. Returns a project-relative posix path. */
function resolveRelative(dir: string, specifier: string): string {
  const segments = dir.length > 0 ? dir.split('/') : [];
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

/** Candidate catalog file paths a resolved specifier may map to —
 *  tolerating the ESM `.js → .ts/.tsx` rewrite and `index` imports.
 *  Order is irrelevant; lookups are exact-match against real files. */
function candidateFilePaths(target: string): readonly string[] {
  const base = stripKnownExtension(target);
  return [
    target,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
}

/** Drop a trailing JS/TS module extension so the `.js → .ts` ESM rewrite
 *  can be re-applied as candidates. Leaves an extensionless path intact. */
function stripKnownExtension(path: string): string {
  const match = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.exec(path);
  return match ? path.slice(0, path.length - match[0].length) : path;
}
