/**
 * @fileoverview Batch operation limits check
 */

import { logger } from '@opensip-cli/core';
import {
  defineCheck,
  isCheckAuthoringSource,
  isTestFile,
  type CheckViolation,
  getLineNumber,
} from '@opensip-cli/fitness';

interface UnboundedBatchPattern {
  pattern: string;
  type: 'async' | 'forOf';
}

const UNBOUNDED_BATCH_PATTERNS: UnboundedBatchPattern[] = [
  { pattern: '.map', type: 'async' },
  { pattern: '.forEach', type: 'async' },
  { pattern: 'for', type: 'forOf' },
];

function findUnboundedBatchMatch(
  content: string,
  patternDef: UnboundedBatchPattern,
  startIndex: number,
): { index: number; match: string } | null {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_unbounded_batch_match',
    msg: 'Finding unbounded batch pattern match at position in content',
  });
  const idx = content.indexOf(patternDef.pattern, startIndex);
  if (idx === -1) return null;

  if (patternDef.type === 'async') {
    const afterPattern = content.slice(
      idx + patternDef.pattern.length,
      idx + patternDef.pattern.length + 20,
    );
    const asyncMatch = /^\s*\(\s*async/.exec(afterPattern);
    if (asyncMatch) {
      return { index: idx, match: patternDef.pattern + asyncMatch[0] };
    }
  } else {
    const afterFor = content.slice(idx, idx + 50);
    const forOfMatch = /^for\s*\(\s*const\s+\w+\s+of/.exec(afterFor);
    if (forOfMatch) {
      return { index: idx, match: forOfMatch[0] };
    }
  }

  return null;
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
] as const;

/** In-memory registry/catalog reads that are bounded per run, not DB fanout. */
const BOUNDED_REGISTRY_MARKERS = [
  'registry',
  'catalog',
  'rules',
  'targets',
  'scenarios',
  'checks',
  'adapters',
  'signals',
  'recipes',
  'languages',
  'tools',
  'signaler',
  'descriptors',
  'entries',
  'columns',
  'ruleDescriptors',
  'fromtools',
  'targetregistry',
  'checkregistry',
  'scenarioregistry',
  'languageregistry',
  'toolregistry',
] as const;

function hasBoundedKeyword(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return BOUNDED_KEYWORDS.some((keyword) => lowerContent.includes(keyword));
}

function isBoundedRegistryQuery(content: string, queryIndex: number): boolean {
  const start = Math.max(0, queryIndex - 200);
  const context = content.slice(start, queryIndex).toLowerCase();
  return BOUNDED_REGISTRY_MARKERS.some((marker) => context.includes(marker));
}

/** `for (const x of …)` loops that never await are pure in-memory scans, not async batch fanout. */
function forOfLoopBodyMayAwait(content: string, forIndex: number): boolean {
  const snippet = content.slice(forIndex, Math.min(content.length, forIndex + 600));
  return /\bawait\b/.test(snippet);
}

function findUnboundedQueryCalls(
  content: string,
): { index: number; methodName: string; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_unbounded_query_calls',
    msg: 'Finding unbounded query calls like findAll, getAll, findMany with empty args',
  });
  const results: { index: number; methodName: string; match: string }[] = [];
  const methods = ['findAll', 'getAll', 'findMany'];

  for (const method of methods) {
    const pattern = `.${method}`;
    let searchStart = 0;

    while (searchStart < content.length) {
      const idx = content.indexOf(pattern, searchStart);
      if (idx === -1) break;

      const afterMethod = content.slice(idx + pattern.length, idx + pattern.length + 10);
      const emptyArgsMatch = /^\s*\(\s*\)/.exec(afterMethod);

      if (emptyArgsMatch) {
        results.push({
          index: idx,
          methodName: method,
          match: pattern + emptyArgsMatch[0],
        });
      }

      searchStart = idx + pattern.length;
    }
  }

  return results;
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
- Unbounded query calls: \`.findAll()\`, \`.getAll()\`, \`.findMany()\` with empty parentheses (skips registry/catalog reads)
- Async callbacks in \`.map(\` and \`.forEach(\` without nearby batching keywords
- \`for (const x of\` loops whose body contains \`await\` without pagination indicators (pure synchronous scans are skipped)
- Skips files containing bounded keywords: \`batch\`, \`chunk\`, \`page\`, \`limit\`, \`take\`, \`skip\`, \`offset\`, \`slice\`

**Why it matters:** Processing unbounded datasets can exhaust memory and starve other operations of resources.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'performance', 'memory'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return [];
    if (isCheckAuthoringSource(filePath)) return [];

    logger.debug({
      evt: 'fitness.checks.batch_operations.analyze_unbounded_batch',
      msg: 'Analyzing file for unbounded batch operations that may process excessive data',
    });
    const violations: CheckViolation[] = [];

    if (hasBoundedKeyword(content)) {
      return violations;
    }

    const unboundedQueries = findUnboundedQueryCalls(content);
    for (const query of unboundedQueries) {
      if (isBoundedRegistryQuery(content, query.index)) {
        continue;
      }
      const lineNumber = getLineNumber(content, query.index);
      violations.push({
        line: lineNumber,
        column: 0,
        message: `Unbounded ${query.methodName}() call may load excessive data`,
        severity: 'warning',
        suggestion: `Add pagination with limit/offset or use cursor-based pagination. Example: ${query.methodName}({ take: 100, skip: offset }) or use a cursor-based approach for large datasets.`,
        match: query.match,
        type: 'unbounded-query',
        filePath,
      });
    }

    for (const patternDef of UNBOUNDED_BATCH_PATTERNS) {
      let searchStart = 0;
      while (searchStart < content.length) {
        const matchResult = findUnboundedBatchMatch(content, patternDef, searchStart);
        if (!matchResult) break;

        const start = Math.max(0, matchResult.index - 300);
        const end = Math.min(content.length, matchResult.index + 300);
        const context = content.slice(start, end);

        const isForOf = /^for\s*\(\s*const\s+\w+\s+of/.test(matchResult.match);
        if (isForOf && !forOfLoopBodyMayAwait(content, matchResult.index)) {
          searchStart = matchResult.index + 1;
          continue;
        }

        if (!hasBoundedKeyword(context)) {
          const lineNumber = getLineNumber(content, matchResult.index);
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
          });
        }

        searchStart = matchResult.index + 1;
      }
    }

    return violations;
  },
});
