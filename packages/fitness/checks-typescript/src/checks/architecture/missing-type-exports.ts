// @fitness-ignore-file fitness-check-standards -- Uses fs for workspace-wide package.json exports map resolution
/**
 * @fileoverview Missing type exports detection
 * @module checks-builtin/checks/architecture/missing-type-exports
 *
 * Detects imports via deep internal paths that are not publicly exposed
 * through the importee's package.json "exports" map or its barrel file.
 *
 * Public entries declared in "exports" (e.g. `@opensip/core/logger` with
 * `"./logger"` in the exports map) are NOT flagged — those are legitimate
 * subpath entry points, not deep internal imports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  defineCheck,
  isTestFile,
  type CheckViolation,
  type FileAccessor,
} from '@opensip-cli/fitness';

const IMPORT_PATTERN = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const NAMED_EXPORT_BLOCK = /export\s+(?:type\s+)?\{([^}]+)\}/g;
const NAMED_EXPORT_DECL =
  /export\s+(?:type\s+)?(?:interface|type|class|enum|function|const)\s+(\w+)/g;

const TRAVERSAL_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.git',
  'coverage',
  'build',
  '.worktrees',
]);

interface PackageExportsInfo {
  /** Exact subpath strings declared in the exports map, e.g. "." or "./errors". */
  readonly subpaths: Set<string>;
  /** Wildcard patterns (prefix before "*"), e.g. "./plugins/" for "./plugins/*". */
  readonly wildcardPrefixes: string[];
}

function extractNames(block: string): string[] {
  return block
    .split(',')
    .map((n) => {
      const trimmed = n.trim();
      const asMatch = /^(\w+)\s+as\s+/.exec(trimmed);
      return asMatch ? asMatch[1] : trimmed;
    })
    .filter((n) => n.length > 0 && /^\w+$/.test(n));
}

function findPackageJsonFiles(root: string, depth = 0): string[] {
  if (depth > 5) return [];
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (TRAVERSAL_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        results.push(...findPackageJsonFiles(full, depth + 1));
      } else if (entry.name === 'package.json') {
        results.push(full);
      }
    }
    /* v8 ignore next 1 -- defensive catch: parse failures already handled */
  } catch {
    // @swallow-ok directory may be unreadable; skip silently
  }
  return results;
}

/**
 * Walk the `exports` field of a package.json and collect every declared
 * subpath (including wildcards). Handles both string and object forms,
 * including conditional exports like `{ "import": "...", "default": "..." }`.
 */
function collectExportSubpaths(exportsField: unknown): PackageExportsInfo {
  const subpaths = new Set<string>();
  const wildcardPrefixes: string[] = [];

  /* v8 ignore next -- defensive guard */
  if (exportsField == null) {
    return { subpaths, wildcardPrefixes };
  }

  // Shorthand: `"exports": "./dist/index.js"` — only root "." is public
  /* v8 ignore next -- defensive guard */
  if (typeof exportsField === 'string') {
    subpaths.add('.');
    return { subpaths, wildcardPrefixes };
  }

  /* v8 ignore next -- defensive guard */
  if (typeof exportsField !== 'object') {
    return { subpaths, wildcardPrefixes };
  }

  const record = exportsField as Record<string, unknown>;
  const keys = Object.keys(record);

  // Conditional-only shorthand (no subpath keys, just conditions) — root is public
  const looksLikeConditionalOnly = keys.length > 0 && keys.every((k) => !k.startsWith('.'));
  if (looksLikeConditionalOnly) {
    subpaths.add('.');
    return { subpaths, wildcardPrefixes };
  }

  for (const key of keys) {
    if (!key.startsWith('.')) continue;
    if (key.includes('*')) {
      const starIdx = key.indexOf('*');
      wildcardPrefixes.push(key.slice(0, starIdx));
    } else {
      subpaths.add(key);
    }
  }

  return { subpaths, wildcardPrefixes };
}

/** Match an import subpath (e.g. "./errors") against a package's exports map. */
function isDeclaredExport(subpath: string, info: PackageExportsInfo): boolean {
  if (info.subpaths.has(subpath)) return true;
  for (const prefix of info.wildcardPrefixes) {
    if (subpath.startsWith(prefix)) return true;
  }
  return false;
}

/** Split "@scope/pkg/some/subpath" into { pkg: "@scope/pkg", subpath: "./some/subpath" }. */
function splitImportPath(importPath: string): { pkg: string; subpath: string } | null {
  if (!importPath.startsWith('@')) return null;
  const segments = importPath.split('/');
  /* v8 ignore next -- defensive AST/type guard */
  if (segments.length < 2) return null;
  const pkg = `${segments[0]}/${segments[1]}`;
  if (segments.length === 2) return { pkg, subpath: '.' };
  const rest = segments.slice(2).join('/');
  return { pkg, subpath: `./${rest}` };
}

export const missingTypeExports = defineCheck({
  id: '8d36209b-5aeb-4ab0-8255-3134a20fdfd5',
  slug: 'missing-type-exports',
  contentFilter: 'strip-strings',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend'] },
  confidence: 'medium',
  description:
    'Detects types imported via deep internal paths not declared in the package exports map or barrel',
  tags: ['architecture', 'api-surface', 'monorepo'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- cross-file analyzer: discovers packages, parses imports, and cross-references declared exports against deep-path usage
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // ---------------------------------------------------------------------
    // Step 1: Discover workspace packages and their declared exports maps.
    // This is a workspace-wide concern — the target's glob can't express
    // it — so we reach outside the FileAccessor using node:fs.
    // ---------------------------------------------------------------------
    const projectRoot = process.cwd();
    const exportsByPackage = new Map<string, PackageExportsInfo>();

    for (const pkgJsonPath of findPackageJsonFiles(projectRoot)) {
      let parsed: { name?: string; exports?: unknown };
      try {
        const stats = fs.statSync(pkgJsonPath);
        /* v8 ignore next -- defensive guard */
        if (stats.size > 1_000_000) continue;
        parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
          name?: string;
          exports?: unknown;
        };
        /* v8 ignore next 1 -- defensive catch: parse failures already handled */
      } catch {
        continue;
      }
      const name = parsed.name;
      if (!name?.startsWith('@')) continue;
      if (parsed.exports !== undefined) {
        exportsByPackage.set(name, collectExportSubpaths(parsed.exports));
      }
    }

    // ---------------------------------------------------------------------
    // Step 2: Build set of exported names from all package barrels.
    // Fallback precision signal for packages without an exports map:
    // if the imported name appears in SOME barrel, treat as public.
    // ---------------------------------------------------------------------
    const barrelFiles = files.paths.filter(
      (p) =>
        (/^packages\/[^/]+\/src\/index\.ts$/.test(p) ||
          /^services\/[^/]+\/src\/index\.ts$/.test(p)) &&
        !p.includes('node_modules'),
    );

    const allExportedNames = new Set<string>();
    for (const barrelPath of barrelFiles) {
      const content = await files.read(barrelPath);
      /* v8 ignore next -- defensive guard */
      if (!content) continue;

      for (const match of content.matchAll(NAMED_EXPORT_BLOCK)) {
        for (const name of extractNames(match[1])) allExportedNames.add(name);
      }
      for (const match of content.matchAll(NAMED_EXPORT_DECL)) {
        if (match[1]) allExportedNames.add(match[1]);
      }
    }

    // ---------------------------------------------------------------------
    // Step 3: Scan source files for deep imports that are NOT declared in
    // the target package's exports map (and not surfaced via any barrel).
    // ---------------------------------------------------------------------
    for (const filePath of files.paths) {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue;
      if (filePath.includes('node_modules') || filePath.includes('/dist/')) continue;
      if (isTestFile(filePath)) continue;

      const content = await files.read(filePath);
      /* v8 ignore next -- defensive guard */
      if (!content) continue;

      for (const importMatch of content.matchAll(IMPORT_PATTERN)) {
        const importPath = importMatch[2];
        const parts = splitImportPath(importPath);
        if (!parts) continue;
        // Root imports (`@scope/pkg`) are never deep — skip.
        if (parts.subpath === '.') continue;

        // If this package declares an exports map and the subpath is
        // explicitly listed (or matches a wildcard), the import is a
        // legitimate public entry point. Skip without examining names.
        const exportsInfo = exportsByPackage.get(parts.pkg);
        if (exportsInfo && isDeclaredExport(parts.subpath, exportsInfo)) continue;

        // If the package has an exports map but this subpath is NOT
        // declared, it's a genuine violation (Node would refuse to
        // resolve it at runtime). If the package has no exports map,
        // fall back to the barrel name check for precision.
        const packageHasExportsMap = exportsInfo !== undefined;
        const names = extractNames(importMatch[1]);
        /* v8 ignore next -- defensive nullish fallback */
        const matchIndex = importMatch.index ?? 0;
        for (const name of names) {
          if (!packageHasExportsMap && allExportedNames.has(name)) continue;
          const lineNum = content.slice(0, matchIndex).split('\n').length;
          violations.push({
            filePath,
            line: lineNum,
            message: `'${name}' imported from deep path '${importPath}' which is not declared in '${parts.pkg}' package.json "exports" map.`,
            severity: 'warning',
            suggestion: `Either add "${parts.subpath}" to '${parts.pkg}' package.json "exports", or re-export '${name}' from the barrel and import from '${parts.pkg}'.`,
            type: 'MISSING_TYPE_EXPORT',
            match: name,
          });
        }
      }
    }

    return violations;
  },
});
