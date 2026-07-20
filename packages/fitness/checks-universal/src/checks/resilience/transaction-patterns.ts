// @fitness-ignore-file transaction-boundary-validation -- Transaction boundaries appropriate for this use case
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Transaction handling resilience checks
 */

import { logger } from '@opensip-cli/core';
import { defineCheck, isTestFile, type CheckViolation, getLineNumber } from '@opensip-cli/fitness';

import {
  createCodeMask,
  decodeJavaScriptStaticText,
  findCodeMatches,
  findStaticStringLiterals,
  templateRawSpans,
} from '../code-aware-match.js';

// =============================================================================
// TRANSACTION BOUNDARY VALIDATION
// =============================================================================

/**
 * Patterns indicating transaction usage.
 * Uses `g` flag for patterns used in while(exec()) loops.
 * Note: Patterns must be specific enough to avoid false positives on
 * unrelated uses of similar words (e.g., "Transactional" SMS type in AWS SNS).
 */
const CODE_TRANSACTION_PATTERNS = [
  /\.transaction\s*\(/g,
  /\.beginTransaction\s*\(/g,
  /\.startTransaction\s*\(/g,
  /@Transaction\b/g,
  /@Transactional\b/g, // Match decorator only, not SMS type configurations
];

/**
 * Patterns indicating proper transaction handling
 */
const PROPER_CODE_TRANSACTION_PATTERNS = [
  /\.commit(?:Transaction)?\s*\(\)/g,
  /\.rollback(?:Transaction)?\s*\(\)/g,
];
const SQL_TAG_START_PATTERN = /\bsql\s*`/g;
const BEGIN_SQL_PATTERN = /\bBEGIN\s+TRANSACTION\b/i;
const COMPLETE_SQL_PATTERN = /\b(?:COMMIT|ROLLBACK)\b/i;

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
];

/**
 * Patterns indicating transaction timeout configuration
 */
const TIMEOUT_PATTERNS = [
  /transactionTimeout/i,
  /queryTimeout/i,
  /statementTimeout/i,
  /lockTimeout/i,
];

interface TransactionMatch {
  readonly index: number;
  readonly match: string;
}

function findStaticSqlCallMatches(
  filePath: string,
  content: string,
  codeMask: string,
  sqlPattern: RegExp,
): TransactionMatch[] {
  const matches: TransactionMatch[] = [];
  for (const literal of findStaticStringLiterals(filePath, content)) {
    const callPrefix = /\b(?:query|execute|exec)\s*\(\s*$/.exec(codeMask.slice(0, literal.start));
    if (!callPrefix) continue;
    sqlPattern.lastIndex = 0;
    const sqlMatch = sqlPattern.exec(literal.value);
    if (sqlMatch) {
      matches.push({
        index: literal.start,
        match: sqlMatch[0],
      });
    }
  }
  return matches;
}

function findTaggedSqlMatches(
  content: string,
  codeMask: string,
  sqlPattern: RegExp,
): TransactionMatch[] {
  const matches: TransactionMatch[] = [];
  for (const tag of findCodeMatches(SQL_TAG_START_PATTERN, content, codeMask)) {
    const backtick = tag.index + tag[0].lastIndexOf('`');
    for (const span of templateRawSpans(content, codeMask, backtick)) {
      const fragment = decodeJavaScriptStaticText(content.slice(span.start, span.end));
      sqlPattern.lastIndex = 0;
      const sqlMatch = sqlPattern.exec(fragment);
      if (sqlMatch) {
        matches.push({
          index: span.start + sqlMatch.index,
          match: sqlMatch[0],
        });
      }
    }
  }
  return matches;
}

function findTransactionStarts(
  filePath: string,
  content: string,
  codeMask: string,
): TransactionMatch[] {
  const byIndex = new Map<number, TransactionMatch>();
  for (const pattern of CODE_TRANSACTION_PATTERNS) {
    for (const match of findCodeMatches(pattern, codeMask, codeMask)) {
      byIndex.set(match.index, {
        index: match.index,
        match: content.slice(match.index, match.index + match[0].length),
      });
    }
  }
  for (const match of [
    ...findStaticSqlCallMatches(filePath, content, codeMask, BEGIN_SQL_PATTERN),
    ...findTaggedSqlMatches(content, codeMask, BEGIN_SQL_PATTERN),
  ]) {
    byIndex.set(match.index, match);
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

function findTransactionCompletions(
  filePath: string,
  content: string,
  codeMask: string,
): TransactionMatch[] {
  const completions = PROPER_CODE_TRANSACTION_PATTERNS.flatMap((pattern) =>
    findCodeMatches(pattern, codeMask, codeMask).map((match) => ({
      index: match.index,
      match: content.slice(match.index, match.index + match[0].length),
    })),
  );
  return [
    ...completions,
    ...findStaticSqlCallMatches(filePath, content, codeMask, COMPLETE_SQL_PATTERN),
    ...findTaggedSqlMatches(content, codeMask, COMPLETE_SQL_PATTERN),
  ].sort((left, right) => left.index - right.index);
}

/**
 * Check if a line is a simple delegation pattern like:
 * return this.repository.transaction(work);
 * These delegate transaction management to another layer.
 */
function isTransactionDelegation(content: string, matchIndex: number): boolean {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.is_transaction_delegation',
    msg: 'Checking if transaction usage is a delegation pattern',
  });
  // Find the start of the line containing the match
  let lineStart = content.lastIndexOf('\n', matchIndex);
  if (lineStart === -1) lineStart = 0;
  else lineStart++; // Move past the newline

  // Find the end of the line
  let lineEnd = content.indexOf('\n', matchIndex);
  if (lineEnd === -1) lineEnd = content.length;

  const line = content.slice(lineStart, lineEnd).trim();

  // Simple delegation pattern: return (await?) this.something.transaction(...);
  // or: return (await?) something.transaction(...);
  return /^\s*return\s+(await\s+)?(?:this\.)?\w+\.transaction\s*\(/.test(line);
}

/**
 * Detect managed transaction calls. A non-empty first argument is a callback
 * (inline or named) or an adapter-owned transaction configuration; those APIs
 * commit on normal return and roll back on throw. Bare `.transaction()` calls
 * remain manual and require an explicit completion.
 */
function isCallbackStyleTransaction(codeMask: string, matchIndex: number): boolean {
  const openingParen = codeMask.indexOf('(', matchIndex);
  if (openingParen === -1) return false;
  const firstArgumentOffset = codeMask.slice(openingParen + 1).search(/\S/);
  if (firstArgumentOffset === -1) return false;
  return codeMask[openingParen + 1 + firstArgumentOffset] !== ')';
}

function findUncommittedTransactionViolations(
  content: string,
  filePath: string,
  codeMask: string,
  transactionStarts: readonly TransactionMatch[],
  transactionCompletions: readonly TransactionMatch[],
): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.find_uncommitted_transaction_violations',
    msg: 'Searching for uncommitted transaction violations',
  });
  const violations: CheckViolation[] = [];
  for (const [startIndex, transaction] of transactionStarts.entries()) {
    const nextStart = transactionStarts[startIndex + 1]?.index ?? Number.POSITIVE_INFINITY;
    const hasFollowingCompletion = transactionCompletions.some(
      (completion) => completion.index > transaction.index && completion.index < nextStart,
    );
    const isSkippable =
      hasFollowingCompletion ||
      transaction.match.includes('@') ||
      isTransactionDelegation(content, transaction.index) ||
      isCallbackStyleTransaction(codeMask, transaction.index);
    if (isSkippable) {
      continue;
    }

    violations.push({
      line: getLineNumber(content, transaction.index),
      column: 0,
      message: 'Transaction may not be properly committed or rolled back',
      severity: 'warning',
      suggestion:
        'Ensure all code paths commit or rollback the transaction. Use try/finally: try { await queryRunner.commitTransaction(); } catch { await queryRunner.rollbackTransaction(); } finally { await queryRunner.release(); }',
      match: transaction.match,
      type: 'uncommitted-transaction',
      filePath,
    });
  }

  return violations;
}

function findAsyncInTransactionViolations(
  content: string,
  filePath: string,
  codeMask: string,
  transactionStarts: readonly TransactionMatch[],
  transactionCompletions: readonly TransactionMatch[],
): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.transaction_patterns.find_async_in_transaction_violations',
    msg: 'Searching for async operations inside transactions',
  });
  const violations: CheckViolation[] = [];
  for (const pattern of ASYNC_IN_TRANSACTION_PATTERNS) {
    for (const match of findCodeMatches(pattern, codeMask, codeMask)) {
      const windowStart = Math.max(0, match.index - 500);
      const events = [
        ...transactionStarts.map((transaction) => ({
          index: transaction.index,
          delta: 1,
        })),
        ...transactionCompletions.map((completion) => ({
          index: completion.index,
          delta: -1,
        })),
      ]
        .filter((event) => event.index >= windowStart && event.index < match.index)
        .sort((left, right) => left.index - right.index);
      let openTransactions = 0;
      for (const event of events) {
        openTransactions = Math.max(0, openTransactions + event.delta);
      }
      const hasOpenTransaction = openTransactions > 0;

      if (!hasOpenTransaction) {
        continue;
      }

      violations.push({
        line: getLineNumber(content, match.index),
        column: 0,
        message: 'Async operation inside transaction may cause long locks',
        severity: 'warning',
        suggestion:
          'Move network/external calls outside transaction boundary. Collect data first, then start transaction for DB writes only. Publish events after commit.',
        match: content.slice(match.index, match.index + match[0].length),
        type: 'async-in-transaction',
        filePath,
      });
    }
  }

  return violations;
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
  contentFilter: 'raw',

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
    // Test fixtures intentionally exercise transaction boundaries (no
    // commit/rollback, callback throws, etc.) to verify detection logic.
    if (isTestFile(filePath)) return [];

    const codeMask = createCodeMask(filePath, content);
    const transactionStarts = findTransactionStarts(filePath, content, codeMask);
    if (transactionStarts.length === 0) {
      return [];
    }

    const transactionCompletions = findTransactionCompletions(filePath, content, codeMask);
    const uncommittedViolations = findUncommittedTransactionViolations(
      content,
      filePath,
      codeMask,
      transactionStarts,
      transactionCompletions,
    );

    const asyncViolations = findAsyncInTransactionViolations(
      content,
      filePath,
      codeMask,
      transactionStarts,
      transactionCompletions,
    );

    return [...uncommittedViolations, ...asyncViolations];
  },
});

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
    const violations: CheckViolation[] = [];
    const codeMask = createCodeMask(filePath, content);
    const manualPattern = /(?:\.beginTransaction|\.startTransaction|queryRunner)/g;
    const manualMatch = findCodeMatches(manualPattern, codeMask, codeMask)[0];
    const hasTimeout = TIMEOUT_PATTERNS.some(
      (pattern) => findCodeMatches(pattern, codeMask, codeMask).length > 0,
    );

    if (manualMatch && !hasTimeout) {
      violations.push({
        line: getLineNumber(content, manualMatch.index),
        column: 0,
        message: 'Transaction without timeout configuration may hang indefinitely',
        severity: 'warning',
        suggestion:
          'Configure transactionTimeout or statementTimeout. Example: SET statement_timeout = 30000; or configure in TypeORM: { extra: { statement_timeout: 30000 } }',
        match: content.slice(manualMatch.index, manualMatch.index + manualMatch[0].length),
        type: 'missing-transaction-timeout',
        filePath,
      });
    }

    return violations;
  },
});
