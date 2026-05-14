// @fitness-ignore-file transaction-boundary-validation -- Transaction boundaries appropriate for this use case
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Transaction handling resilience checks
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/fitness'

// =============================================================================
// TRANSACTION BOUNDARY VALIDATION
// =============================================================================

/**
 * Patterns indicating transaction usage.
 * Uses `g` flag for patterns used in while(exec()) loops.
 * Note: Patterns must be specific enough to avoid false positives on
 * unrelated uses of similar words (e.g., "Transactional" SMS type in AWS SNS).
 */
const TRANSACTION_PATTERNS = [
  /\.transaction\s*\(/g,
  /\.beginTransaction\s*\(/g,
  /\.startTransaction\s*\(/g,
  /BEGIN\s+TRANSACTION/gi,
  /@Transaction\b/g,
  /@Transactional\b/g, // Match decorator only, not SMS type configurations
  /queryRunner\.startTransaction/g,
]

/**
 * Patterns indicating proper transaction handling
 */
const PROPER_TRANSACTION_PATTERNS = [/\.commit\s*\(\)/, /\.rollback\s*\(\)/, /COMMIT/i, /ROLLBACK/i]

/**
 * Patterns indicating async operations inside transactions (risky).
 * Uses `g` flag for patterns used in while(exec()) loops.
 */
const ASYNC_IN_TRANSACTION_PATTERNS = [
  /await.*?fetch\s*\(/g,
  /await.*?http/gi,
  /await.*?request\s*\(/g,
  /await.*?\.publish\s*\(/g, // Event publishing
  /await.*?\.send\s*\(/g, // Message sending
]

/**
 * Patterns indicating transaction timeout configuration
 */
const TIMEOUT_PATTERNS = [
  /transactionTimeout/i,
  /queryTimeout/i,
  /statementTimeout/i,
  /lockTimeout/i,
]

/**
 * Check if a line is a simple delegation pattern like:
 * return this.repository.transaction(work);
 * These delegate transaction management to another layer.
 */
function isTransactionDelegation(content: string, matchIndex: number): boolean {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.is_transaction_delegation',
    msg: 'Checking if transaction usage is a delegation pattern',
  })
  // Find the start of the line containing the match
  let lineStart = content.lastIndexOf('\n', matchIndex)
  if (lineStart === -1) lineStart = 0
  else lineStart++ // Move past the newline

  // Find the end of the line
  let lineEnd = content.indexOf('\n', matchIndex)
  if (lineEnd === -1) lineEnd = content.length

  const line = content.slice(lineStart, lineEnd).trim()

  // Simple delegation pattern: return (await?) this.something.transaction(...);
  // or: return (await?) something.transaction(...);
  return /^\s*return\s+(await\s+)?(?:this\.)?\w+\.transaction\s*\(/.test(line)
}

function findUncommittedTransactionViolations(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.find_uncommitted_transaction_violations',
    msg: 'Searching for uncommitted transaction violations',
  })
  const violations: CheckViolation[] = []

  for (const pattern of TRANSACTION_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const isSkippable = match[0].includes('@') || isTransactionDelegation(content, match.index)
      if (isSkippable) {
        continue
      }

      violations.push({
        line: getLineNumber(content, match.index),
        column: 0,
        message: 'Transaction may not be properly committed or rolled back',
        severity: 'warning',
        suggestion:
          'Ensure all code paths commit or rollback the transaction. Use try/finally: try { await queryRunner.commitTransaction(); } catch { await queryRunner.rollbackTransaction(); } finally { await queryRunner.release(); }',
        match: match[0],
        type: 'uncommitted-transaction',
        filePath,
      })
    }
  }

  return violations
}

function findAsyncInTransactionViolations(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.find_async_in_transaction_violations',
    msg: 'Searching for async operations inside transactions',
  })
  const violations: CheckViolation[] = []

  for (const pattern of ASYNC_IN_TRANSACTION_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const beforeMatch = content.slice(0, Math.max(0, match.index))
      const hasOpenTransaction = TRANSACTION_PATTERNS.some((p) => p.test(beforeMatch.slice(-500)))

      if (!hasOpenTransaction) {
        continue
      }

      violations.push({
        line: getLineNumber(content, match.index),
        column: 0,
        message: 'Async operation inside transaction may cause long locks',
        severity: 'warning',
        suggestion:
          'Move network/external calls outside transaction boundary. Collect data first, then start transaction for DB writes only. Publish events after commit.',
        match: match[0],
        type: 'async-in-transaction',
        filePath,
      })
    }
  }

  return violations
}

/**
 * Check: resilience/transaction-boundary-validation
 *
 * Validates transaction boundaries are properly managed:
 * - Transactions are committed or rolled back
 * - No async operations inside transactions that could cause long locks
 * - Proper error handling in transaction blocks
 */
export const transactionBoundaryValidation = defineCheck({
  id: '77c69adc-7ccd-4f83-98d1-fb9599d3e16f',
  slug: 'transaction-boundary-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate transaction boundaries are properly managed',
  longDescription: `**Purpose:** Ensures database transactions are properly committed/rolled back and do not contain risky async operations that hold locks.

**Detects:**
- Transaction starts (\`.transaction(\`, \`.beginTransaction(\`, \`.startTransaction(\`, \`BEGIN TRANSACTION\`, \`@Transaction\`, \`@Transactional\`, \`queryRunner.startTransaction\`) without corresponding \`.commit()\` or \`.rollback()\`
- Async operations inside open transactions: \`await...fetch(\`, \`await...http\`, \`await...request(\`, \`await...publish(\`, \`await...send(\` preceded by a transaction start within 500 chars
- Skips decorator-based transactions and delegation patterns (\`return this.repository.transaction(...)\`)

**Why it matters:** Uncommitted transactions leak connections; async calls inside transactions hold database locks and cause deadlocks or timeouts.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'database', 'transactions'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const usesTransactions = TRANSACTION_PATTERNS.some((p) => p.test(content))
    if (!usesTransactions) {
      return []
    }

    const hasProperHandling = PROPER_TRANSACTION_PATTERNS.some((p) => p.test(content))
    const uncommittedViolations = hasProperHandling
      ? []
      : findUncommittedTransactionViolations(content, filePath)

    const asyncViolations = findAsyncInTransactionViolations(content, filePath)

    return [...uncommittedViolations, ...asyncViolations]
  },
})

// =============================================================================
// TRANSACTION TIMEOUT
// =============================================================================

/**
 * Check: resilience/transaction-timeout
 *
 * Validates transactions have timeout configurations:
 * - Statement timeouts to prevent long-running queries
 * - Lock timeouts to prevent deadlocks
 */
export const transactionTimeout = defineCheck({
  id: 'd53a49fd-a3e2-4c35-b07a-81b48e8e0325',
  slug: 'transaction-timeout',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  description: 'Validate transactions have timeout configurations',
  longDescription: `**Purpose:** Ensures manually managed transactions include timeout configurations to prevent indefinite lock holding.

**Detects:**
- Files using manual transaction management (\`.beginTransaction\`, \`.startTransaction\`, \`queryRunner\`) without timeout keywords (\`transactionTimeout\`, \`queryTimeout\`, \`statementTimeout\`, \`lockTimeout\`)
- Only flags manual transactions, not ORM decorator-based transactions

**Why it matters:** Transactions without timeouts can hold database locks indefinitely during network partitions or slow queries, causing cascading connection pool exhaustion.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'database', 'timeout'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Check if this file uses transactions
    const usesTransactions = TRANSACTION_PATTERNS.some((p) => p.test(content))
    if (!usesTransactions) {
      return violations
    }

    // Check for timeout configuration
    const hasTimeout = TIMEOUT_PATTERNS.some((p) => p.test(content))

    // Only flag if using manual transaction management (not ORM decorators)
    const usesManualTransactions =
      content.includes('.beginTransaction') ||
      content.includes('.startTransaction') ||
      content.includes('queryRunner')

    if (usesManualTransactions && !hasTimeout) {
      // Find the transaction usage for line number
      for (const pattern of TRANSACTION_PATTERNS) {
        pattern.lastIndex = 0
        const match = pattern.exec(content)
        if (match) {
          const lineNumber = getLineNumber(content, match.index)
          violations.push({
            line: lineNumber,
            column: 0,
            message: 'Transaction without timeout configuration may hang indefinitely',
            severity: 'warning',
            suggestion:
              'Configure transactionTimeout or statementTimeout. Example: SET statement_timeout = 30000; or configure in TypeORM: { extra: { statement_timeout: 30000 } }',
            match: match[0],
            type: 'missing-transaction-timeout',
            filePath,
          })
          break
        }
      }
    }

    return violations
  },
})
