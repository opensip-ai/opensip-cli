// @fitness-ignore-file file-length-limit -- JSDoc documentation required for public API
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Batch operations and memory resilience checks
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, isTestFile, type CheckViolation, getLineNumber } from '@opensip-tools/fitness'
import { stripStringsAndCommentsPreservingPositions } from '@opensip-tools/fitness'

interface UnboundedBatchPattern {
  pattern: string
  type: 'async' | 'forOf'
}

const UNBOUNDED_BATCH_PATTERNS: UnboundedBatchPattern[] = [
  { pattern: '.map', type: 'async' },
  { pattern: '.forEach', type: 'async' },
  { pattern: 'for', type: 'forOf' },
]

function findUnboundedBatchMatch(
  content: string,
  patternDef: UnboundedBatchPattern,
  startIndex: number,
): { index: number; match: string } | null {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_unbounded_batch_match',
    msg: 'Finding unbounded batch pattern match at position in content',
  })
  const idx = content.indexOf(patternDef.pattern, startIndex)
  if (idx === -1) return null

  if (patternDef.type === 'async') {
    const afterPattern = content.slice(
      idx + patternDef.pattern.length,
      idx + patternDef.pattern.length + 20,
    )
    const asyncMatch = /^\s*\(\s*async/.exec(afterPattern)
    if (asyncMatch) {
      return { index: idx, match: patternDef.pattern + asyncMatch[0] }
    }
  } else {
    const afterFor = content.slice(idx, idx + 50)
    const forOfMatch = /^for\s*\(\s*const\s+\w+\s+of/.exec(afterFor)
    if (forOfMatch) {
      return { index: idx, match: forOfMatch[0] }
    }
  }

  return null
}

const BOUNDED_KEYWORDS = [
  'batch',
  'chunk',
  'page',
  'limit',
  'take',
  'skip',
  'offset',
  'slice',
] as const

function hasBoundedKeyword(content: string): boolean {
  const lowerContent = content.toLowerCase()
  return BOUNDED_KEYWORDS.some((keyword) => lowerContent.includes(keyword))
}

function findUnboundedQueryCalls(
  content: string,
): { index: number; methodName: string; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_unbounded_query_calls',
    msg: 'Finding unbounded query calls like findAll, getAll, findMany with empty args',
  })
  const results: { index: number; methodName: string; match: string }[] = []
  const methods = ['findAll', 'getAll', 'findMany']

  for (const method of methods) {
    const pattern = `.${method}`
    let searchStart = 0

    while (searchStart < content.length) {
      const idx = content.indexOf(pattern, searchStart)
      if (idx === -1) break

      const afterMethod = content.slice(idx + pattern.length, idx + pattern.length + 10)
      const emptyArgsMatch = /^\s*\(\s*\)/.exec(afterMethod)

      if (emptyArgsMatch) {
        results.push({
          index: idx,
          methodName: method,
          match: pattern + emptyArgsMatch[0],
        })
      }

      searchStart = idx + pattern.length
    }
  }

  return results
}

/**
 * Check: resilience/batch-operation-limits
 *
 * Detects batch operations that may process unbounded data:
 * - Array operations on potentially large datasets without pagination
 * - Async operations without concurrency limits
 * - Database queries without LIMIT clauses
 */
export const batchOperationLimits = defineCheck({
  id: 'c4d9b853-147e-4c29-9702-f392b1f51056',
  slug: 'batch-operation-limits',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect batch operations that may process unbounded data',
  longDescription: `**Purpose:** Prevents batch operations from processing arbitrarily large datasets without pagination or concurrency controls.

**Detects:**
- Unbounded query calls: \`.findAll()\`, \`.getAll()\`, \`.findMany()\` with empty parentheses
- Async callbacks in \`.map(\` and \`.forEach(\` without nearby batching keywords
- \`for (const x of\` loops without pagination indicators
- Skips files containing bounded keywords: \`batch\`, \`chunk\`, \`page\`, \`limit\`, \`take\`, \`skip\`, \`offset\`, \`slice\`

**Why it matters:** Processing unbounded datasets can exhaust memory and starve other operations of resources.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'performance', 'memory'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return []

    logger.debug({
      evt: 'fitness.checks.batch_operations.analyze_unbounded_batch',
      msg: 'Analyzing file for unbounded batch operations that may process excessive data',
    })
    const violations: CheckViolation[] = []

    if (hasBoundedKeyword(content)) {
      return violations
    }

    const unboundedQueries = findUnboundedQueryCalls(content)
    for (const query of unboundedQueries) {
      const lineNumber = getLineNumber(content, query.index)
      violations.push({
        line: lineNumber,
        column: 0,
        message: `Unbounded ${query.methodName}() call may load excessive data`,
        severity: 'warning',
        suggestion: `Add pagination with limit/offset or use cursor-based pagination. Example: ${query.methodName}({ take: 100, skip: offset }) or use a cursor-based approach for large datasets.`,
        match: query.match,
        type: 'unbounded-query',
        filePath,
      })
    }

    for (const patternDef of UNBOUNDED_BATCH_PATTERNS) {
      let searchStart = 0
      while (searchStart < content.length) {
        const matchResult = findUnboundedBatchMatch(content, patternDef, searchStart)
        if (!matchResult) break

        const start = Math.max(0, matchResult.index - 300)
        const end = Math.min(content.length, matchResult.index + 300)
        const context = content.slice(start, end)

        if (!hasBoundedKeyword(context)) {
          const lineNumber = getLineNumber(content, matchResult.index)
          violations.push({
            line: lineNumber,
            column: 0,
            message: 'Async operation in loop without batching may exhaust resources',
            severity: 'warning',
            suggestion:
              'Add batch processing or concurrency limits. Use chunk() to process in batches or pLimit() to limit concurrent operations.',
            match: matchResult.match,
            type: 'unbounded-async-loop',
            filePath,
          })
        }

        searchStart = matchResult.index + 1
      }
    }

    return violations
  },
})

const COLLECTION_TYPES = ['new Map(', 'new Set(', '= []', ': []'] as const

/** Patterns indicating a collection is bounded by design (static registries, constants, DI tokens). */
const BOUNDED_DECLARATION_PATTERNS = [
  'static readonly',
  'static ',
  'readonly ',
  'const ',
  '= Object.freeze',
  'as const',
  // DI injection tokens
  'INJECTION_TOKEN',
  'InjectionToken',
  'DI_TOKEN',
  'Symbol(',
  // Known bounded types
  'WeakMap',
  'WeakSet',
]

function isBoundedDeclaration(line: string): boolean {
  const trimmed = line.trim()
  return BOUNDED_DECLARATION_PATTERNS.some((pattern) => trimmed.includes(pattern))
}

function findCollectionDeclarations(content: string): { index: number; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_collection_declarations',
    msg: 'Finding private collection declarations that may grow without bounds',
  })
  const results: { index: number; match: string }[] = []
  const lines = content.split('\n')
  let charIndex = 0

  for (const line of lines) {
    const currentCharIndex = charIndex
    charIndex += line.length + 1 // +1 for newline

    const trimmed = line.trim()
    const isPrivateDeclaration = trimmed.startsWith('private')
    const collectionType = isPrivateDeclaration
      ? COLLECTION_TYPES.find((type) => line.includes(type))
      : undefined

    if (collectionType) {
      if (isBoundedDeclaration(line)) {
        continue
      }

      const matchStart = line.indexOf('private')
      const lineEnd = line.includes(';') ? line.indexOf(';') + 1 : line.length
      results.push({
        index: currentCharIndex + matchStart,
        match: line.slice(matchStart, lineEnd).trim(),
      })
    }
  }

  return results
}

const EVICTION_KEYWORDS = [
  '.delete(',
  '.clear(',
  '.splice(',
  '.shift(',
  '.pop(',
  '.length = 0',
  '.length=0',
  'maxsize',
  'max_size',
  'limit',
  'evict',
  'prune',
  'cleanup',
  'truncate',
  'lru',
  'overflow',
  '@bounded-collection',
] as const

function hasEvictionKeyword(content: string): boolean {
  const lowerContent = content.toLowerCase()
  return EVICTION_KEYWORDS.some((keyword) => lowerContent.includes(keyword.toLowerCase()))
}

/** String literals for pattern matching, not actual fs calls. */
// @fitness-ignore-next-line fitness-check-standards -- These are string literals for pattern matching, not actual fs calls
const FILE_READ_METHODS = ['readFileSync(', 'readFile('] as const

const FILE_SIZE_CHECK_KEYWORDS = [
  'statsync(',
  'stat(',
  '.size <',
  '.size >',
  '.size<',
  '.size>',
  'max_file_size',
  'maxfilesize',
] as const

function hasFileSizeCheck(content: string): boolean {
  const lowerContent = content.toLowerCase()
  return FILE_SIZE_CHECK_KEYWORDS.some((keyword) => lowerContent.includes(keyword))
}

/** Config files that are bounded by nature and don't need size validation. */
const KNOWN_SMALL_FILE_PATTERNS = [
  'package.json',
  'tsconfig',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.config',
  '.eslintrc',
  '.prettierrc',
]

function isReadingKnownSmallFile(content: string, readIndex: number): boolean {
  const start = Math.max(0, readIndex - 100)
  const end = Math.min(content.length, readIndex + 150)
  const context = content.slice(start, end).toLowerCase()
  return KNOWN_SMALL_FILE_PATTERNS.some((pattern) => context.includes(pattern))
}

function findFileReadCalls(content: string): { index: number; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_file_read_calls',
    msg: 'Finding file read calls that may cause OOM without size validation',
  })
  const results: { index: number; match: string }[] = []

  for (const method of FILE_READ_METHODS) {
    let searchStart = 0
    while (searchStart < content.length) {
      const idx = content.indexOf(method, searchStart)
      if (idx === -1) break
      results.push({ index: idx, match: method })
      searchStart = idx + method.length
    }
  }

  return results
}

function hasGrowthMethod(content: string): boolean {
  const methods = ['.set(', '.push(', '.add(']
  return methods.some((method) => content.includes(method))
}

/**
 * Check: resilience/unbounded-memory
 *
 * Detects potential memory leaks and OOM risks:
 * - Maps/Sets/Arrays in classes without eviction logic
 * - File reads without prior size checks
 * - Growing buffers without backpressure
 */
export const unboundedMemory = defineCheck({
  id: '1f3c347d-3511-4157-87e0-050fd57c28b3',
  slug: 'unbounded-memory',
  description: 'Detect unbounded collections and file reads that may cause OOM',
  longDescription: `**Purpose:** Identifies potential memory leaks from collections that grow without bounds and file reads without size validation.

**Detects:**
- Private class fields initialized with \`new Map(\`, \`new Set(\`, or empty arrays that have growth methods (\`.set\`, \`.push\`, \`.add\`) but no eviction keywords (\`.delete\`, \`.clear\`, \`maxsize\`, \`evict\`, \`prune\`, \`lru\`, etc.)
- \`readFileSync(\` and \`readFile(\` calls without a preceding \`stat()\` / \`.size\` check within 500 characters
- Skips \`static\`, \`readonly\`, \`const\`, \`WeakMap\`, and DI token declarations

**Why it matters:** Unbounded in-memory collections cause gradual OOM in long-running services; reading files without size guards risks instant OOM on large inputs.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  scope: { languages: ['typescript'], concerns: [] },
  tags: ['resilience', 'memory', 'performance'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return []
    // Fitness checks reference readFile/readFileSync as string literals, not actual calls
    if (filePath.includes('/fitness/src/checks/')) return []

    logger.debug({
      evt: 'fitness.checks.batch_operations.analyze_file_operations',
      msg: 'Analyzing file for unbounded memory usage and file read operations',
    })
    const violations: CheckViolation[] = []

    // Strip string literals + block / single-line comments BEFORE scanning
    // for `readFile(` matches. Doc prose like "// followed by readFile()
    // below" or `@module readFile` JSDoc previously yielded false positives
    // because the regex hit the comment text. Use the position-preserving
    // variant so match indexes map back to the original source line.
    //
    // Eviction-keyword and file-size-check detection intentionally run on
    // the ORIGINAL content so author-supplied hints in comments
    // ("// bounded by upstream cap", "// max-size enforced upstream")
    // continue to mark the file as bounded. Stripping them there would
    // surface previously-passing files as new positives every time we
    // tighten the regex.
    const codeOnly = stripStringsAndCommentsPreservingPositions(content)

    const collectionDeclarations = findCollectionDeclarations(codeOnly)
    for (const declaration of collectionDeclarations) {
      const hasEviction = hasEvictionKeyword(content)
      const hasGrowth = hasGrowthMethod(content)

      if (hasGrowth && !hasEviction) {
        const lineNumber = getLineNumber(content, declaration.index)
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'Unbounded collection that grows without eviction',
          severity: 'warning',
          suggestion:
            'Add maxSize limit and eviction logic (e.g., LRU). Use a shared cache utility for caching or implement periodic cleanup with .delete() or .clear().',
          match: declaration.match,
          type: 'unbounded-collection',
          filePath,
        })
      }
    }

    const fileReadCalls = findFileReadCalls(codeOnly)
    for (const readCall of fileReadCalls) {
      // Widen the look-back window to 1500 chars so a stat() guard placed
      // up to ~30 lines earlier in the same function still counts.
      // Real-world bundle/file readers interleave stat → branch → recover
      // → readFile, easily putting the guard >500 chars upstream.
      const start = Math.max(0, readCall.index - 1500)
      const context = content.slice(start, readCall.index)

      if (isReadingKnownSmallFile(content, readCall.index)) {
        continue
      }

      if (!hasFileSizeCheck(context)) {
        const lineNumber = getLineNumber(content, readCall.index)
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'File read without size validation may cause OOM',
          severity: 'warning',
          // @fitness-ignore-next-line performance-anti-patterns -- 'await' appears in suggestion string literal, not actual await expression
          suggestion:
            'Check fs.stat().size before reading to prevent OOM on large files. Example: const stats = await fs.stat(path); if (stats.size > MAX_FILE_SIZE) throw new Error("File too large");',
          match: readCall.match,
          type: 'unbounded-file-read',
          filePath,
        })
      }
    }

    return violations
  },
})
