// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview In-Memory Repository Detection Check
 *
 * Detects repository classes using Map or in-memory storage in production code.
 * These are often placeholders that should be replaced with DynamoDB implementations.
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Patterns that indicate intentional in-memory usage
 */
const ALLOWED_PATTERNS = [/cache/i, /Cache/, /InMemory/, /Mock/, /Stub/, /Fake/, /Test/]

/**
 * Repository class name patterns
 */
const REPOSITORY_PATTERNS = [/Repository$/, /Store$/, /Storage$/, /DAO$/, /DataAccess$/]

/**
 * Quick filter keywords
 */
const QUICK_FILTER_STORAGE = ['new Map', 'new Set', '= []', '= {}']

/**
 * Repeated suggestion message for in-memory storage violations
 */
const IN_MEMORY_STORAGE_SUGGESTION =
  'Replace with DynamoDB/PostgreSQL persistent storage implementation. In-memory storage is lost on restart and does not scale.'

interface StorageViolationInfo {
  type: string
  storageType: string
  match: string
}

/**
 * Detect in-memory storage type from initializer text
 * @param initText - Initializer text to analyze
 * @returns Storage violation info if detected, null otherwise
 */
function detectStorageType(initText: string): StorageViolationInfo | null {
  if (initText.includes('new Map')) {
    return { type: 'map-storage', storageType: 'Map', match: 'new Map' }
  }
  if (initText.includes('new Set')) {
    return { type: 'set-storage', storageType: 'Set', match: 'new Set' }
  }
  if (initText === '[]' || initText.startsWith('[')) {
    return { type: 'array-storage', storageType: 'Array', match: '[]' }
  }
  if (initText === '{}' || initText.startsWith('{')) {
    return { type: 'object-storage', storageType: 'Object', match: '{}' }
  }
  return null
}

interface CheckPropertyContext {
  member: ts.PropertyDeclaration
  className: string
  sourceFile: ts.SourceFile
}

/**
 * Check a class property for in-memory storage patterns
 * @param ctx - Context for property checking
 * @returns CheckViolation if found, null otherwise
 */
function checkPropertyForStorage(ctx: CheckPropertyContext): CheckViolation | null {
  const { member, className, sourceFile } = ctx
  const initializer = member.initializer

  if (!initializer) {
    return null
  }

  const initText = initializer.getText(sourceFile)
  const storageInfo = detectStorageType(initText)

  if (!storageInfo) {
    return null
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart())
  const lineNum = line + 1

  return {
    line: lineNum,
    column: 0,
    message: `Repository ${className} uses in-memory ${storageInfo.storageType} storage`,
    severity: 'error',
    type: storageInfo.type,
    suggestion: IN_MEMORY_STORAGE_SUGGESTION,
    match: storageInfo.match,
  }
}

/**
 * Analyze a file for in-memory repository patterns
 * @param content - File content to analyze
 * @param filePath - Path to the file
 * @returns Array of violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: must have repository pattern AND in-memory storage pattern
  const hasRepository = REPOSITORY_PATTERNS.some((p) => p.test(content))
  const hasStorage = QUICK_FILTER_STORAGE.some((kw) => content.includes(kw))
  if (!hasRepository || !hasStorage) {
    return violations
  }

  // Check if file has allowed patterns
  if (ALLOWED_PATTERNS.some((pattern) => pattern.test(content))) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.getText(sourceFile)

        // Check if this is a repository class
        const isRepository = REPOSITORY_PATTERNS.some((p) => p.test(className))
        if (!isRepository) {
          ts.forEachChild(node, visit)
          return
        }

        // Check class properties for in-memory storage
        node.members.forEach((member) => {
          if (ts.isPropertyDeclaration(member)) {
            const violation = checkPropertyForStorage({
              member,
              className,
              sourceFile,
            })
            if (violation) {
              violations.push(violation)
            }
          }
        })
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  /* v8 ignore next 1 -- defensive catch: parse failures already handled */
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/in-memory-repository-detection
 *
 * Detects repository classes using Map or in-memory storage instead of
 * proper persistence.
 */
export const inMemoryRepositoryDetection = defineCheck({
  id: 'e44c8f1a-c63f-4583-8f64-a652d240865a',
  slug: 'in-memory-repository-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description:
    'Detect repository classes using Map or in-memory storage instead of proper persistence',
  longDescription: `**Purpose:** Detects repository classes that use in-memory data structures instead of persistent database storage, flagging placeholder implementations that should be replaced.

**Detects:**
- Classes named \`*Repository\`, \`*Store\`, \`*Storage\`, \`*DAO\`, or \`*DataAccess\` with properties initialized to \`new Map\`, \`new Set\`, \`[]\`, or \`{}\`
- Skips files containing allowed patterns: \`Cache\`, \`InMemory\`, \`Mock\`, \`Stub\`, \`Fake\`, \`Test\` (intentional in-memory usage)
- Quick-filters on both repository class name patterns and storage initialization keywords

**Why it matters:** In-memory storage is lost on restart, does not scale across instances, and is a common placeholder that gets accidentally shipped to production.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'architecture', 'best-practices'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
