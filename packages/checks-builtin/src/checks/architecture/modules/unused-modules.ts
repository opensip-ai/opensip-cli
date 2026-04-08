// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Unused Modules check (v2)
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

interface UnusedModuleIssue {
  modulePath: string
  type: 'unused-module' | 'no-exports' | 'no-imports'
  message: string
  severity: 'error' | 'warning'
}

/**
 * Check if a node has export or default modifiers
 */
function hasExportOrDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const modifiers = ts.getModifiers(node)
  if (!modifiers) return false
  return modifiers.some(
    (m: ts.Modifier) =>
      m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
  )
}

/**
 * Check if a node is an export declaration or assignment
 */
function isExportNode(node: ts.Node): boolean {
  return ts.isExportDeclaration(node) || ts.isExportAssignment(node)
}

function hasExports(content: string, filePath: string): boolean {
  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return false

    let hasExport = false

    const visit = (node: ts.Node): void => {
      if (hasExport) return

      if (hasExportOrDefaultModifier(node) || isExportNode(node)) {
        hasExport = true
        return
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return hasExport
  } catch {
    return true
  }
}

/**
 * Extract import path from an import declaration
 */
function extractImportDeclarationPath(node: ts.ImportDeclaration): string | null {
  const moduleSpecifier = node.moduleSpecifier
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : null
}

/**
 * Extract import path from a dynamic import() call
 */
function extractDynamicImportPath(node: ts.CallExpression): string | null {
  const expression = node.expression
  if (expression.kind !== ts.SyntaxKind.ImportKeyword) return null
  const arg = node.arguments[0]
  return arg && ts.isStringLiteral(arg) ? arg.text : null
}

function extractImports(content: string, filePath: string): Set<string> {
  const imports = new Set<string>()

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return new Set<string>()

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const importPath = extractImportDeclarationPath(node)
        if (importPath) imports.add(importPath)
      }

      if (ts.isCallExpression(node)) {
        const importPath = extractDynamicImportPath(node)
        if (importPath) imports.add(importPath)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok If AST parsing fails, return empty set
  }

  return imports
}

/**
 * Process a single path part for path resolution
 */
function processPathPart(part: string, dirParts: string[]): void {
  if (!Array.isArray(dirParts)) {
    return
  }
  if (part === '..') {
    dirParts.pop()
  } else if (part !== '.') {
    dirParts.push(part)
  }
}

function resolveImportPath(importPath: string, importerDir: string): string | null {
  try {
    if (importPath.startsWith('@')) return null
    if (!importPath.startsWith('.')) return null

    const parts = importPath.split('/')
    const dirParts = importerDir.split('/')

    for (const part of parts) {
      processPathPart(part, dirParts)
    }

    return dirParts.join('/')
  } catch {
    // @swallow-ok -- path resolution errors are expected for invalid import paths, null signals unresolvable path
    return null
  }
}

/**
 * Check if an import path is a local or aliased import
 */
function isLocalOrAliasedImport(importPath: string): boolean {
  return importPath.startsWith('.') || importPath.startsWith('@')
}

const FILE_EXTENSION_PATTERN = /\.(ts|tsx|js|jsx)$/

interface ModulePathInfo {
  normalizedPath: string
  fileName: string
  dir: string
}

function getModulePathInfo(modulePath: string): ModulePathInfo {
  const normalizedPath = modulePath.replace(FILE_EXTENSION_PATTERN, '')
  const fileName = normalizedPath.split('/').pop() ?? ''
  const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
  return { normalizedPath, fileName, dir }
}

function doesResolvedImportMatch(
  resolvedImport: string | null,
  moduleInfo: ModulePathInfo,
): boolean {
  if (!resolvedImport) return false
  if (resolvedImport === moduleInfo.normalizedPath) return true
  if (moduleInfo.normalizedPath.endsWith('/index') && resolvedImport === moduleInfo.dir) return true
  return false
}

function doesImportFileNameMatch(importPath: string, moduleInfo: ModulePathInfo): boolean {
  const importFileName = importPath.split('/').pop() ?? ''
  if (moduleInfo.fileName === importFileName) return true
  if (moduleInfo.normalizedPath.endsWith(`/${importFileName}/index`)) return true
  return false
}

function checkImportsForModule(
  imports: Set<string>,
  importerDir: string,
  moduleInfo: ModulePathInfo,
): boolean {
  const relevantImports = Array.from(imports).filter(isLocalOrAliasedImport)

  for (const importPath of relevantImports) {
    const resolvedImport = resolveImportPath(importPath, importerDir)
    if (doesResolvedImportMatch(resolvedImport, moduleInfo)) return true
    if (doesImportFileNameMatch(importPath, moduleInfo)) return true
  }

  return false
}

function isModuleImported(modulePath: string, importMap: Map<string, Set<string>>): boolean {
  const moduleInfo = getModulePathInfo(modulePath)

  for (const [importerFile, imports] of importMap) {
    const importerDir = importerFile.substring(0, importerFile.lastIndexOf('/'))
    if (checkImportsForModule(imports, importerDir, moduleInfo)) {
      return true
    }
  }

  return false
}

function isIndexFile(file: string): boolean {
  return file.endsWith('/index.ts') || file.endsWith('/index.tsx')
}

const UNUSED_ANNOTATION_PATTERN = /\/\/\s{0,10}@unused|\/\*{1,2}\s{0,10}@unused/i

function hasUnusedAnnotation(content: string): boolean {
  return UNUSED_ANNOTATION_PATTERN.test(content)
}

/**
 * Check: architecture/unused-modules
 *
 * Detects modules with no exports or that are never imported anywhere.
 */
export const unusedModules = defineCheck({
  id: '8c826451-c3d8-43d2-a2e6-b85d9e685d8c',
  slug: 'unused-modules',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Detects modules with no exports or that are never imported anywhere',
  longDescription: `**Purpose:** Identifies dead code by finding modules that either export nothing or are never imported by any other file in the codebase.

**Detects:**
- **no-exports:** Files that contain no export statements (checked via TypeScript AST for \`export\` keyword modifiers, \`export\` declarations, and \`export\` assignments)
- **no-imports:** Files that are never referenced by any static \`import\` declaration or dynamic \`import()\` call across the scanned file set
- Skips index files and files annotated with \`// @unused\` or \`/** @unused */\`

**Why it matters:** Unused modules increase build times, clutter the codebase, and mislead developers into thinking dead code is active.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\`. Currently disabled by default due to high false-positive rate; run manually with \`--check architecture/unused-modules\`.`,
  disabled: true, // High false positive rate; run manually: pnpm sip fit --check architecture/unused-modules
  tags: ['architecture', 'maintainability'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    // in-memory: single-threaded Node.js access pattern
    // Build import and export maps
    const importMap = new Map<string, Set<string>>()
    const exportMap = new Map<string, boolean>()

    for (const file of files.paths) {
      // @lazy-ok
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(file)
      if (!content) continue

      exportMap.set(file, hasExports(content, file))
      importMap.set(file, extractImports(content, file))
    }

    const issues: UnusedModuleIssue[] = []
    const processableFiles = files.paths.filter((file) => !isIndexFile(file))

    for (const file of processableFiles) {
      // @lazy-ok
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(file)
      if (!content) continue

      // Skip explicitly documented as unused
      if (hasUnusedAnnotation(content)) continue

      // Check if module has no exports
      const fileHasExports = exportMap.get(file)
      if (fileHasExports === false) {
        issues.push({
          modulePath: file,
          type: 'no-exports',
          message: `Module has no exports (consider adding exports or removing if unused)`,
          severity: 'warning',
        })
        continue
      }

      // Check if module is never imported
      const isImported = isModuleImported(file, importMap)
      if (!isImported) {
        issues.push({
          modulePath: file,
          type: 'no-imports',
          message: `Module is never imported anywhere (consider removing or adding to index)`,
          severity: 'warning',
        })
      }
    }

    return issues.map((issue) => {
      const suggestion =
        issue.type === 'no-exports'
          ? `Add exports to the file or delete it if it's unused`
          : `Add an import to this module from an index.ts file, or delete the file if it's no longer needed`

      return {
        filePath: issue.modulePath,
        line: 1,
        message: `[${issue.type}] ${issue.message}`,
        severity: issue.severity,
        suggestion,
        match: issue.modulePath.split('/').pop() ?? '',
        type: issue.type,
      }
    })
  },
})
