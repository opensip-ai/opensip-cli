/**
 * @fileoverview Ignore directive processing for fitness checks
 *
 * Filters signals via the shared core suppression primitive (ADR-0014), then
 * builds fitness-specific outputs on top: the `ignoredCount`, the
 * `DirectiveEntry` audit list (with weak-reason classification), and the
 * rebuilt `CheckResult`. The matching algorithm (file/line directives,
 * anti-recursion: a finding pointing at a directive line is never suppressed)
 * lives once in `@opensip-cli/core`.
 */

import { readFile as readFileFromDisk } from 'node:fs/promises';

import { currentScope, filterSignalsBySuppressions, logger } from '@opensip-cli/core';

import { countErrors, countWarnings } from '../types/severity.js';

import { extractGroup, isWeakReason, parseDirectiveLine } from './directive-inventory.js';
import { FITNESS_KEYWORDS } from './directive-parsing.js';

import type { DirectiveEntry } from './directive-inventory.js';
import type { FileCache } from './file-cache.js';
import type { CheckResult } from '../types/findings.js';
import type { Signal } from '@opensip-cli/core';

/**
 * Read file content for directive collection from the per-run scope cache when
 * present (`scope.fitness.fileCache`), else directly from disk. The module
 * singleton is no longer read here (parallel-tool-invocations Phase 1) — the
 * no-scope direct single-check path legitimately has no scope cache and falls
 * through to a disk read, preserving prior single-check behaviour.
 */
async function readViaCacheOrDisk(fc: FileCache | undefined, filePath: string): Promise<string> {
  if (fc) return fc.get(filePath);
  return readFileFromDisk(filePath, 'utf8');
}

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
  // Resolve the per-run cache once; runs inside the run's scope on the
  // production path. The same instance is threaded into directive re-reads below.
  const fc = currentScope()?.fitness?.fileCache;

  const { kept, suppressed } = await filterSignalsBySuppressions({
    signals,
    keywords: FITNESS_KEYWORDS,
    readFile: (filePath) => readViaCacheOrDisk(fc, filePath),
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
    fc,
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
  fc: FileCache | undefined,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedFileIgnores].map(async (filePath): Promise<DirectiveEntry | null> => {
      try {
        const content = await readViaCacheOrDisk(fc, filePath);
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
  fc: FileCache | undefined,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedLineIgnores.entries()].map(
      async ([filePath, suppressedLines]): Promise<DirectiveEntry[]> => {
        const found: DirectiveEntry[] = [];
        try {
          const content = await readViaCacheOrDisk(fc, filePath);
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
  fc: FileCache | undefined,
): Promise<DirectiveEntry[]> {
  const [fileDirectives, lineDirectives] = await Promise.all([
    collectFileIgnoreDirectives(checkId, appliedFileIgnores, fc),
    collectLineIgnoreDirectives(checkId, appliedLineIgnores, fc),
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
