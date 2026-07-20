// @fitness-ignore-file duplicate-implementation-detection -- intentionally co-located for check isolation
/**
 * @fileoverview Test-Only Frontend Modules Check
 *
 * Detects frontend code (hooks, stores, services, utils) that is only
 * imported by test files, indicating potentially dead code.
 */

import * as path from 'node:path';

import {
  defineCheck,
  isTestFile,
  type CheckViolation,
  type FileAccessor,
} from '@opensip-cli/fitness';
import { getSharedSourceFile, walkNodes } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Type guard to validate a Map with array values.
 * @param {unknown} value - Value to validate
 * @returns {value is Map<string, string[]>} True if value is a valid Map with array values
 */
function validateImportMap(value: unknown): value is Map<string, string[]> {
  return value instanceof Map;
}

/**
 * Extract import paths from file content
 * @param filePath - File path used to select the correct parser mode
 * @param content - File content
 * @returns Array of import paths
 */
// @fitness-ignore-next-line duplicate-implementation-detection -- import extraction is intentionally co-located with each check for isolation; shared utility would couple unrelated checks
function extractImportPaths(filePath: string, content: string): string[] {
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return [];

  const paths: string[] = [];
  const addPath = (importPath: string): void => {
    if (importPath.startsWith('.') || importPath.startsWith('@')) {
      paths.push(importPath);
    }
  };

  walkNodes(sourceFile, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addPath(node.moduleSpecifier.text);
      return;
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      addPath(node.moduleReference.expression.text);
      return;
    }

    if (!ts.isCallExpression(node)) return;
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const argument = node.arguments[0];
    if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
      addPath(argument.text);
    }
  });

  return paths;
}

/**
 * Build import map from files
 * @param files - FileAccessor for lazy file loading
 * @returns Map of import path to importer files
 */
async function buildImportMap(files: FileAccessor): Promise<Map<string, string[]>> {
  const importMap = new Map<string, string[]>();

  for (const fp of files.paths) {
    try {
      const content = await files.read(fp);
      const importPaths = extractImportPaths(fp, content);

      for (const importPath of importPaths) {
        /* v8 ignore next -- defensive nullish fallback */
        const importers = importMap.get(importPath) ?? [];
        importers.push(fp);
        importMap.set(importPath, importers);
      }
      /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return importMap;
}

/**
 * Find importers for a file
 * @param filePath - File to find importers for
 * @param importMap - Map of imports (Map iteration with .entries() provides safe access)
 * @returns Array of importer file paths
 */
function findImporters(filePath: string, importMap: Map<string, string[]>): string[] {
  // Map parameter validation: iteration via .entries() handles undefined/null safely
  if (!validateImportMap(importMap)) {
    return [];
  }
  // Validate Map size before iteration
  if (importMap.size === 0) {
    return [];
  }

  const basename = path.basename(filePath, path.extname(filePath));
  const dirname = path.dirname(filePath);
  const parentDir = path.basename(dirname);
  const importers: string[] = [];

  for (const [importPath, importerFiles] of importMap.entries()) {
    const matchesBasename =
      importPath.includes(basename) || importPath.includes(`${parentDir}/${basename}`);
    const hasValidImporters = Array.isArray(importerFiles) && importerFiles.length > 0;

    if (matchesBasename && hasValidImporters) {
      for (const importerFile of importerFiles) importers.push(importerFile);
    }
  }

  return importers;
}

/**
 * Check: quality/test-only-frontend-modules
 *
 * Detects frontend code only imported by test files.
 */
export const testOnlyFrontendModules = defineCheck({
  id: '78a085b3-55c4-42d3-a74c-8dfaad8123f1',
  slug: 'test-only-frontend-modules',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects frontend code only imported by test files',
  tags: ['quality', 'code-quality', 'maintainability'],
  fileTypes: ['ts', 'tsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Build import map
    const importMap = await buildImportMap(files);

    // Check each file to see if it's only imported by tests
    for (const filePath of files.paths) {
      // Skip files in test directories — they are test utilities by design
      if (isTestFile(filePath)) {
        continue;
      }

      const importers = findImporters(filePath, importMap);

      if (importers.length === 0) {
        continue;
      }

      const productionImporters = importers.filter((f) => !isTestFile(f));
      const testImporters = importers.filter((f) => isTestFile(f));

      if (productionImporters.length === 0 && testImporters.length > 0) {
        violations.push({
          filePath,
          line: 1,
          column: 0,
          message: `Only imported by test files (${testImporters.length} test imports, 0 production)`,
          severity: 'error',
          suggestion:
            'This module is only used in tests. Either add production usage, move it to a test utilities folder, or delete it if no longer needed',
          match: path.basename(filePath),
        });
      }
    }

    return violations;
  },
});
