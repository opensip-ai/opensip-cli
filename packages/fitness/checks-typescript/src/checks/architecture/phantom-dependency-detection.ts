// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file fitness-check-standards -- Check requires direct fs access for package.json parsing outside of standard file scanning pipeline
// @fitness-ignore-file unbounded-memory -- reads workspace package.json files; bounded by standard package metadata size
// @fitness-ignore-file performance-anti-patterns -- sequential package.json reads keep peak memory bounded; small N per workspace
/**
 * @fileoverview Detect phantom dependencies - packages used in code but not declared in package.json (v3, AST-based)
 * @invariants
 * - Only checks external npm packages, not workspace packages or relative imports
 * - Distinguishes between dependencies, devDependencies, and peerDependencies
 * - Respects pnpm's strict node_modules isolation
 * - Extracts imports from the TypeScript AST, so import-like text inside string
 *   literals (detection patterns, docs, fixtures) is never mistaken for a real import
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';
import { getSharedSourceFile, walkNodes } from '@opensip-tools/lang-typescript';
import * as ts from 'typescript';

/**
 * Packages that are always available (Node.js built-ins)
 */
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/promises',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

/**
 * Patterns that indicate test-only imports (should check devDependencies)
 */
const TEST_FILE_PATTERNS = [
  /__tests__\//,
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /test\//,
  /tests\//,
];

/**
 * Build/tooling config files (e.g. `vitest.config.ts`, `drizzle.config.ts`,
 * `eslint.config.mjs`). Like test files, these run only at dev/build time and
 * are never part of the published package, so importing a `devDependency` from
 * them is legitimate — a genuinely undeclared import is still flagged.
 */
const TOOLING_FILE_PATTERN = /(?:^|\/)[^/]+\.config\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface ExtractedImport {
  specifier: string;
  line: number;
}

/**
 * Extract package name from an import specifier.
 * Handles scoped packages (@org/pkg) and subpath imports (@org/pkg/subpath).
 */
function extractPackageName(importSpecifier: string): string | null {
  // Skip relative imports
  if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
    return null;
  }

  // Strip the node: prefix before built-in / package detection
  const bare = importSpecifier.startsWith('node:') ? importSpecifier.slice(5) : importSpecifier;

  // Skip Node.js built-ins (with or without the node: prefix, and subpaths like fs/promises)
  if (NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(bare.split('/')[0] ?? '')) {
    return null;
  }

  // Handle scoped packages (@org/pkg or @org/pkg/subpath)
  if (importSpecifier.startsWith('@')) {
    const parts = importSpecifier.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  // Handle regular packages (pkg or pkg/subpath)
  return importSpecifier.split('/')[0] ?? null;
}

/**
 * Extract real module imports from a TypeScript/JavaScript source file using the
 * AST. Covers static `import`/`export ... from`, `import x = require()`, dynamic
 * `import()`, and `require()` call expressions. Because these are structural AST
 * nodes, import-like text appearing inside string literals is never matched.
 */
function extractImports(filePath: string, content: string): ExtractedImport[] {
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return [];

  const imports: ExtractedImport[] = [];
  const push = (node: ts.Node, specifier: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    imports.push({ specifier, line: line + 1 });
  };

  walkNodes(sourceFile, (node) => {
    // import ... from 'x'  /  export ... from 'x'
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node, node.moduleSpecifier.text);
      return;
    }

    // import x = require('x')
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      push(node, node.moduleReference.expression.text);
      return;
    }

    // dynamic import('x') and require('x')
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg)) {
        push(node, arg.text);
      }
    }
  });

  return imports;
}

/**
 * Find the nearest package.json for a file.
 */
function findNearestPackageJson(filePath: string): string | null {
  let dir = path.dirname(filePath);
  // @fitness-ignore-next-line null-safety -- path.parse() always returns object with .root per Node.js API
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return pkgPath;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Read and parse package.json.
 */
function readPackageJson(pkgPath: string): PackageJson | null {
  try {
    const content = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(content) as PackageJson;
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null;
  }
}

/**
 * Whether a file may legitimately import `devDependencies`: test files and
 * build/tooling config files, which run only at dev/build time and never ship.
 */
function allowsDevDependencies(filePath: string): boolean {
  return (
    TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath)) ||
    TOOLING_FILE_PATTERN.test(filePath)
  );
}

/**
 * Check if a package is declared in any dependency section.
 */
function isDeclaredDependency(
  pkg: PackageJson,
  packageName: string,
  allowDevDeps: boolean,
): { declared: boolean; section?: string } {
  if (pkg.dependencies?.[packageName]) {
    return { declared: true, section: 'dependencies' };
  }
  if (pkg.peerDependencies?.[packageName]) {
    return { declared: true, section: 'peerDependencies' };
  }
  if (pkg.optionalDependencies?.[packageName]) {
    return { declared: true, section: 'optionalDependencies' };
  }
  // In dev-only files (tests, build/tooling configs), devDependencies are valid.
  if (allowDevDeps && pkg.devDependencies?.[packageName]) {
    return { declared: true, section: 'devDependencies' };
  }
  // In shipped source, importing a devDependency is a problem (won't ship in prod).
  if (!allowDevDeps && pkg.devDependencies?.[packageName]) {
    return { declared: false, section: 'devDependencies' };
  }
  return { declared: false };
}

/** Read + cache a package.json by its resolved path. */
function getCachedPackageJson(
  cache: Map<string, PackageJson | null>,
  pkgJsonPath: string,
): PackageJson | null {
  let pkgJson = cache.get(pkgJsonPath);
  if (pkgJson === undefined) {
    pkgJson = readPackageJson(pkgJsonPath);
    cache.set(pkgJsonPath, pkgJson);
  }
  return pkgJson;
}

/**
 * Per-file dependency context: everything `violationForImport` needs that is
 * constant across the imports of a single source file. Computed once in
 * `collectFileViolations` and threaded as one value (only `imp` varies per call).
 */
interface FileDepContext {
  pkgJson: PackageJson;
  allDeps: Record<string, string>;
  allowDevDeps: boolean;
  filePath: string;
  pkgJsonPath: string;
}

/** Build the violation for a single import, or null when it's fine. */
function violationForImport(imp: ExtractedImport, ctx: FileDepContext): CheckViolation | null {
  const { pkgJson, allDeps, allowDevDeps, filePath, pkgJsonPath } = ctx;
  const packageName = extractPackageName(imp.specifier);
  if (!packageName) return null;

  // Skip workspace packages (declared via the workspace: protocol)
  if (allDeps[packageName]?.startsWith('workspace:')) return null;

  const { declared, section } = isDeclaredDependency(pkgJson, packageName, allowDevDeps);
  if (declared) return null;

  const isDevDep = section === 'devDependencies';
  const message = isDevDep
    ? `Source file imports "${packageName}" which is only in devDependencies`
    : `Phantom dependency: "${packageName}" is used but not declared in package.json`;
  const suggestion = isDevDep
    ? `Move "${packageName}" from devDependencies to dependencies in ${path.basename(pkgJsonPath)}`
    : `Add "${packageName}" to dependencies in ${path.basename(pkgJsonPath)}`;

  return {
    filePath,
    line: imp.line,
    message,
    severity: 'error',
    suggestion,
    match: packageName,
    type: 'phantom-dependency',
  };
}

/** Collect all phantom/devDep violations for one already-read source file. */
function collectFileViolations(
  filePath: string,
  content: string,
  cache: Map<string, PackageJson | null>,
): CheckViolation[] {
  const imports = extractImports(filePath, content);
  if (imports.length === 0) return [];

  const pkgJsonPath = findNearestPackageJson(filePath);
  if (!pkgJsonPath) return [];

  const pkgJson = getCachedPackageJson(cache, pkgJsonPath);
  if (!pkgJson) return [];

  const allDeps: Record<string, string> = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
    ...pkgJson.peerDependencies,
    ...pkgJson.optionalDependencies,
  };
  const allowDevDeps = allowsDevDependencies(filePath);

  const ctx: FileDepContext = { pkgJson, allDeps, allowDevDeps, filePath, pkgJsonPath };
  const out: CheckViolation[] = [];
  for (const imp of imports) {
    const violation = violationForImport(imp, ctx);
    if (violation) out.push(violation);
  }
  return out;
}

/**
 * Check: architecture/phantom-dependency-detection
 *
 * Detects packages that are imported in code but not declared in package.json.
 * This is critical for pnpm which uses strict node_modules isolation.
 *
 * Phantom dependencies can cause:
 * - Runtime failures in pnpm projects (strict node_modules)
 * - Inconsistent behavior between development and production
 * - Version conflicts when the hoisted dependency changes
 */
export const phantomDependencyDetection = defineCheck({
  id: '67284374-69b8-4711-9c66-33d2ad44ef79',
  slug: 'phantom-dependency-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  // AST-based: needs the real source (string stripping would blank module specifiers).
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detect phantom dependencies (used but not declared in package.json)',
  longDescription: `**Purpose:** Detects packages imported in source code that are not declared in the nearest \`package.json\`, which is critical under pnpm's strict \`node_modules\` isolation.

**Detects:**
- ES imports (\`import ... from\`), re-exports (\`export ... from\`), \`import x = require()\`, dynamic imports (\`import()\`), and \`require()\` calls referencing external npm packages not listed in \`dependencies\`, \`peerDependencies\`, or \`optionalDependencies\`
- Shipped source files importing packages only declared in \`devDependencies\` (test files and build/tooling \`*.config.*\` files are exempt — they run only at dev/build time and never ship)
- Imports are extracted from the TypeScript AST, so import-like text inside string literals, comments, or documentation is never mistaken for a real import; skips Node.js built-ins and workspace packages (detected via \`workspace:*\` protocol)

**Why it matters:** Phantom dependencies cause runtime failures in pnpm projects, create inconsistent behavior between dev and production, and introduce fragile version coupling via hoisting.

**Scope:** General best practice. Cross-file analysis: extracts imports from each file and resolves them against the nearest \`package.json\`.`,
  timeout: 120_000,
  tags: ['architecture', 'dependencies', 'pnpm'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Cache for package.json contents, keyed by resolved package.json path
    const pkgJsonCache = new Map<string, PackageJson | null>();

    // @lazy-ok -- validations inside loop depend on file content from await
    for (const filePath of files.paths) {
      try {
        // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
        const content = await files.read(filePath);
        if (!content) continue;
        violations.push(...collectFileViolations(filePath, content, pkgJsonCache));
      } catch {
        // @swallow-ok Skip files that can't be read
        continue;
      }
    }

    return violations;
  },
});
