// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file concurrency-safety -- Single-threaded Node.js; Map-based caches are safe without synchronization
/**
 * @fileoverview Ignore directive processing for fitness checks
 *
 * Filters signals via the shared core suppression primitive (ADR-0014), then
 * builds fitness-specific outputs on top: the `ignoredCount`, the
 * `DirectiveEntry` audit list (with weak-reason classification), and the
 * rebuilt `CheckResult`. The matching algorithm (file/line directives,
 * anti-recursion: a finding pointing at a directive line is never suppressed)
 * lives once in `@opensip-tools/core`.
 */

import { filterSignalsBySuppressions, logger } from '@opensip-tools/core';

import { countErrors, countWarnings } from '../types/severity.js';

import { extractGroup, isWeakReason, parseDirectiveLine } from './directive-inventory.js';
import { FITNESS_KEYWORDS } from './directive-parsing.js';
import { fileCache } from './file-cache.js';

import type { DirectiveEntry } from './directive-inventory.js';
import type { CheckResult } from '../types/findings.js';
import type { Signal } from '@opensip-tools/core';

// =============================================================================
// SIGNAL FILTERING
// =============================================================================

/**
 * Filter a check's signals by `@fitness-ignore` directives.
 *
 * Delegates matching to the core primitive with the fitness keywords and
 * `ruleIdOf: () => checkId` (every signal in this call belongs to one check, so
 * the directive must name that check's slug — the historical per-check
 * semantics). The core primitive owns the anti-recursion guard: a finding that
 * points at a directive line is never suppressed by a line-level directive,
 * which prevents directive-auditing checks from suppressing their own findings.
 *
 * The suppressed matches are reduced back into the file/line buckets the
 * `DirectiveEntry` audit collection expects.
 */
export async function filterSignalsByDirectives(
  signals: readonly Signal[],
  checkId: string,
  initialIgnoredCount: number,
): Promise<{
  filteredSignals: Signal[];
  ignoredCount: number;
  appliedDirectives: DirectiveEntry[];
}> {
  const { kept, suppressed } = await filterSignalsBySuppressions({
    signals,
    keywords: FITNESS_KEYWORDS,
    readFile: (filePath) => fileCache.get(filePath),
    ruleIdOf: () => checkId,
  });

  const appliedFileIgnores = new Set<string>();
  const appliedLineIgnores = new Map<string, Set<number>>();
  for (const match of suppressed) {
    if (match.line === 'file') {
      appliedFileIgnores.add(match.file);
    } else {
      let lineSet = appliedLineIgnores.get(match.file);
      if (!lineSet) {
        lineSet = new Set();
        appliedLineIgnores.set(match.file, lineSet);
      }
      lineSet.add(match.line);
    }
  }

  const appliedDirectives = await collectAppliedDirectives(
    checkId,
    appliedFileIgnores,
    appliedLineIgnores,
  );

  return {
    filteredSignals: [...kept],
    ignoredCount: initialIgnoredCount + suppressed.length,
    appliedDirectives,
  };
}

// =============================================================================
// APPLIED DIRECTIVE COLLECTION
// =============================================================================

function toDirectiveEntry(
  filePath: string,
  lineNumber: number,
  parsed: { type: 'file' | 'next-line'; checkId: string; reason: string | null },
): DirectiveEntry {
  return {
    filePath,
    lineNumber,
    type: parsed.type,
    checkId: parsed.checkId,
    group: extractGroup(parsed.checkId),
    reason: parsed.reason,
    weakReason: isWeakReason(parsed.reason),
  };
}

async function collectFileIgnoreDirectives(
  checkId: string,
  appliedFileIgnores: Set<string>,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedFileIgnores].map(async (filePath): Promise<DirectiveEntry | null> => {
      try {
        const content = await fileCache.get(filePath);
        const lines = content.split('\n');
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const parsed = parseDirectiveLine(lines[i] ?? '');
          if (parsed?.type === 'file' && parsed.checkId === checkId) {
            return toDirectiveEntry(filePath, i + 1, parsed);
          }
        }
      } catch (error) {
        logger.warn('fitness.ignore.directive_read.failed', {
          evt: 'fitness.ignore.directive_read.failed',
          module: 'fitness:ignore-processing',
          err: error,
        });
      }
      return null;
    }),
  );
  return results.filter((d): d is DirectiveEntry => d !== null);
}

async function collectLineIgnoreDirectives(
  checkId: string,
  appliedLineIgnores: Map<string, Set<number>>,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedLineIgnores.entries()].map(
      async ([filePath, suppressedLines]): Promise<DirectiveEntry[]> => {
        const found: DirectiveEntry[] = [];
        try {
          const content = await fileCache.get(filePath);
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const parsed = parseDirectiveLine(lines[i] ?? '');
            if (parsed?.type !== 'next-line' || parsed.checkId !== checkId) continue;
            let targetLine = i + 1;
            while (
              targetLine < lines.length &&
              (lines[targetLine] ?? '').trimStart().startsWith('//')
            ) {
              targetLine++;
            }
            if (suppressedLines.has(targetLine + 1)) {
              found.push(toDirectiveEntry(filePath, i + 1, parsed));
            }
          }
        } catch (error) {
          logger.warn('fitness.ignore.directive_read.failed', {
            evt: 'fitness.ignore.directive_read.failed',
            module: 'fitness:ignore-processing',
            err: error,
          });
        }
        return found;
      },
    ),
  );
  const directives: DirectiveEntry[] = [];
  for (const batch of results) {
    for (const d of batch) {
      directives.push(d);
    }
  }
  return directives;
}

async function collectAppliedDirectives(
  checkId: string,
  appliedFileIgnores: Set<string>,
  appliedLineIgnores: Map<string, Set<number>>,
): Promise<DirectiveEntry[]> {
  const [fileDirectives, lineDirectives] = await Promise.all([
    collectFileIgnoreDirectives(checkId, appliedFileIgnores),
    collectLineIgnoreDirectives(checkId, appliedLineIgnores),
  ]);
  return [...fileDirectives, ...lineDirectives];
}

// =============================================================================
// RESULT BUILDING
// =============================================================================

/**
 * Builds the filtered result from the original result and filtered signals.
 */
export function buildFilteredResult(
  result: CheckResult,
  filteredSignals: Signal[],
  ignoredCount: number,
  start: number,
): CheckResult {
  if (!Array.isArray(filteredSignals)) {
    return result;
  }

  const durationMs = result.metadata.durationMs ?? Date.now() - start;
  const filteredErrors = countErrors(filteredSignals);
  const filteredWarnings = countWarnings(filteredSignals);

  const filteredResult: CheckResult = {
    ...result,
    passed: filteredErrors === 0,
    errors: filteredErrors,
    warnings: filteredWarnings,
    signals: filteredSignals,
    metadata: {
      ...result.metadata,
      durationMs,
      signals: filteredSignals,
    },
    ...(ignoredCount > 0 ? { ignoredCount } : {}),
  };

  return filteredResult;
}
