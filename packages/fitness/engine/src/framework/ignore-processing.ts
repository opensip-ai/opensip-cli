// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file concurrency-safety -- Single-threaded Node.js; Map-based caches are safe without synchronization
/**
 * @fileoverview Ignore directive processing for fitness checks
 *
 * Filters signals based on file-level and line-level ignore directives.
 * Signals pointing at lines that contain @fitness-ignore directives are
 * never suppressed — this prevents recursive suppression loops where
 * directive-auditing checks would otherwise flag their own suppressions.
 */

import { logger } from '@opensip-tools/core'


import { countErrors, countWarnings } from '../types/severity.js'

import { extractGroup, isWeakReason, parseDirectiveLine } from './directive-inventory.js'
import { parseFileIgnoreDirective, parseIgnoreDirectives } from './directive-parsing.js'
import { fileCache } from './file-cache.js'

import type { DirectiveEntry } from './directive-inventory.js'
import type { CheckResult } from '../types/findings.js'
import type { Signal } from '@opensip-tools/core'

// =============================================================================
// DIRECTIVE LINE DETECTION
// =============================================================================

/**
 * Scan file content and return the set of 1-based line numbers that contain
 * @fitness-ignore directives. These lines are framework infrastructure and
 * must never be suppressed by other directives (prevents recursive loops).
 */
function findDirectiveLines(content: string): Set<number> {
  const directiveLines = new Set<number>()
  const lines = content.split('\n')
  for (const [i, line] of lines.entries()) {
    const trimmed = (line ?? '').trimStart()
    if (
      (trimmed.startsWith('//') || trimmed.startsWith('/*')) &&
      trimmed.includes('@fitness-ignore')
    ) {
      directiveLines.add(i + 1)
    }
  }
  return directiveLines
}

// =============================================================================
// FILE IGNORE STATUS PROCESSING
// =============================================================================

/** Cached per-file results from directive scanning. */
interface FileIgnoreInfo {
  fileIgnored: boolean
  ignoredLines: Set<number> | null
  directiveLines: Set<number>
}

/**
 * Processes file ignore status and caches the result.
 */
async function processFileIgnoreStatus(
  filePath: string,
  checkId: string,
  fileIgnoreCache: Map<string, boolean>,
  lineIgnoreCache: Map<string, Set<number>>,
  directiveLineCache?: Map<string, Set<number>>,
): Promise<FileIgnoreInfo> {
  // in-memory: single-threaded Node.js access pattern
  const fileIgnored = fileIgnoreCache.get(filePath)

  if (fileIgnored !== undefined) {
    return {
      fileIgnored,
      ignoredLines: lineIgnoreCache.get(filePath) ?? null,
      directiveLines: directiveLineCache?.get(filePath) ?? new Set(),
    }
  }

  try {
    const content = await fileCache.get(filePath)
    const isIgnored = parseFileIgnoreDirective(content, checkId)
    fileIgnoreCache.set(filePath, isIgnored)

    // Always scan for directive lines (needed for recursive loop prevention)
    const dirLines = findDirectiveLines(content)
    directiveLineCache?.set(filePath, dirLines)

    let ignoredLines: Set<number> | null = null
    if (!isIgnored) {
      ignoredLines = parseIgnoreDirectives(content, checkId)
      lineIgnoreCache.set(filePath, ignoredLines)
    }

    return { fileIgnored: isIgnored, ignoredLines, directiveLines: dirLines }
  } catch (error) {
    logger.warn('fitness.ignore.file_read.failed', { evt: 'fitness.ignore.file_read.failed', module: 'fitness:ignore-processing', filePath, err: error });
    fileIgnoreCache.set(filePath, false)
    return { fileIgnored: false, ignoredLines: null, directiveLines: new Set() }
  }
}

// =============================================================================
// SIGNAL FILTERING
// =============================================================================

/**
 * Filters signals based on ignore directives.
 *
 * Signals pointing at lines that contain `@fitness-ignore` directives are
 * never suppressed. This is a structural guarantee that prevents recursive
 * loops: a check that audits directives cannot have its findings suppressed
 * by the very directives it reports on.
 */
interface FilterResult {
  filteredSignals: Signal[]
  ignoredCount: number
  appliedFileIgnores: Set<string>
  appliedLineIgnores: Map<string, Set<number>>
}

function classifySignals(
  signals: readonly Signal[],
  initialIgnoredCount: number,
  fileIgnoreCache: Map<string, boolean>,
  lineIgnoreCache: Map<string, Set<number>>,
  directiveLineCache: Map<string, Set<number>>,
): FilterResult {
  const filteredSignals: Signal[] = []
  let ignoredCount = initialIgnoredCount
  const appliedFileIgnores = new Set<string>()
  const appliedLineIgnores = new Map<string, Set<number>>()

  for (const signal of signals) {
    if (!isSignalIgnored(signal, fileIgnoreCache, lineIgnoreCache, directiveLineCache)) {
      filteredSignals.push(signal)
      continue
    }
    ignoredCount++
    const filePath = signal.code?.file
    if (!filePath) continue

    if (fileIgnoreCache.get(filePath)) {
      appliedFileIgnores.add(filePath)
    } else {
      const line = signal.code?.line
      if (line) {
        let lineSet = appliedLineIgnores.get(filePath)
        if (!lineSet) {
          lineSet = new Set()
          appliedLineIgnores.set(filePath, lineSet)
        }
        lineSet.add(line)
      }
    }
  }

  return { filteredSignals, ignoredCount, appliedFileIgnores, appliedLineIgnores }
}

/** Filter signals based on file-level and line-level @fitness-ignore directives */
export async function filterSignalsByDirectives(
  signals: readonly Signal[],
  checkId: string,
  initialIgnoredCount: number,
): Promise<{ filteredSignals: Signal[]; ignoredCount: number; appliedDirectives: DirectiveEntry[] }> {
  const fileIgnoreCache = new Map<string, boolean>()
  const lineIgnoreCache = new Map<string, Set<number>>()
  const directiveLineCache = new Map<string, Set<number>>()

  // Pre-populate file ignore status for all unique file paths in parallel
  const uniqueFiles = new Set<string>()
  for (const signal of signals) {
    const filePath = signal.code?.file
    if (filePath) uniqueFiles.add(filePath)
  }
  await Promise.all(
    [...uniqueFiles].map((filePath) =>
      processFileIgnoreStatus(filePath, checkId, fileIgnoreCache, lineIgnoreCache, directiveLineCache),
    ),
  )

  const { filteredSignals, ignoredCount, appliedFileIgnores, appliedLineIgnores } =
    classifySignals(signals, initialIgnoredCount, fileIgnoreCache, lineIgnoreCache, directiveLineCache)

  const appliedDirectives = await collectAppliedDirectives(checkId, appliedFileIgnores, appliedLineIgnores)

  return { filteredSignals, ignoredCount, appliedDirectives }
}

/**
 * Determines whether a single signal should be ignored based on cached directive data.
 *
 * File-level ignores always apply (the entire file is suppressed).
 * Line-level ignores apply unless the signal points at a directive line itself
 * (prevents recursive loops where directive-auditing checks suppress their own findings).
 */
function isSignalIgnored(
  signal: Signal,
  fileIgnoreCache: Map<string, boolean>,
  lineIgnoreCache: Map<string, Set<number>>,
  directiveLineCache: Map<string, Set<number>>,
): boolean {
  const filePath = signal.code?.file
  if (!filePath) return false

  // File-level ignores always apply — no anti-recursion needed
  if (fileIgnoreCache.get(filePath)) return true

  const signalLine = signal.code?.line
  const dirLines = directiveLineCache.get(filePath)
  // For line-level ignores: never suppress signals pointing at directive lines (anti-recursion)
  if (signalLine && dirLines?.has(signalLine)) return false

  const ignoredLines = lineIgnoreCache.get(filePath)
  if (signalLine && ignoredLines?.has(signalLine)) return true

  return false
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
  }
}

async function collectFileIgnoreDirectives(
  checkId: string,
  appliedFileIgnores: Set<string>,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedFileIgnores].map(async (filePath): Promise<DirectiveEntry | null> => {
      try {
        const content = await fileCache.get(filePath)
        const lines = content.split('\n')
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const parsed = parseDirectiveLine(lines[i] ?? '')
          if (parsed?.type === 'file' && parsed.checkId === checkId) {
            return toDirectiveEntry(filePath, i + 1, parsed)
          }
        }
      } catch (error) {
        logger.warn('fitness.ignore.directive_read.failed', { evt: 'fitness.ignore.directive_read.failed', module: 'fitness:ignore-processing', err: error });
      }
      return null
    }),
  )
  return results.filter((d): d is DirectiveEntry => d !== null)
}

async function collectLineIgnoreDirectives(
  checkId: string,
  appliedLineIgnores: Map<string, Set<number>>,
): Promise<DirectiveEntry[]> {
  const results = await Promise.all(
    [...appliedLineIgnores.entries()].map(async ([filePath, suppressedLines]): Promise<DirectiveEntry[]> => {
      const found: DirectiveEntry[] = []
      try {
        const content = await fileCache.get(filePath)
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseDirectiveLine(lines[i] ?? '')
          if (parsed?.type !== 'next-line' || parsed.checkId !== checkId) continue
          let targetLine = i + 1
          while (targetLine < lines.length && (lines[targetLine] ?? '').trimStart().startsWith('//')) {
            targetLine++
          }
          if (suppressedLines.has(targetLine + 1)) {
            found.push(toDirectiveEntry(filePath, i + 1, parsed))
          }
        }
      } catch (error) {
        logger.warn('fitness.ignore.directive_read.failed', { evt: 'fitness.ignore.directive_read.failed', module: 'fitness:ignore-processing', err: error });
      }
      return found
    }),
  )
  const directives: DirectiveEntry[] = []
  for (const batch of results) {
    for (const d of batch) {
      directives.push(d)
    }
  }
  return directives
}

async function collectAppliedDirectives(
  checkId: string,
  appliedFileIgnores: Set<string>,
  appliedLineIgnores: Map<string, Set<number>>,
): Promise<DirectiveEntry[]> {
  const [fileDirectives, lineDirectives] = await Promise.all([
    collectFileIgnoreDirectives(checkId, appliedFileIgnores),
    collectLineIgnoreDirectives(checkId, appliedLineIgnores),
  ])
  return [...fileDirectives, ...lineDirectives]
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
    return result
  }

  const durationMs = result.metadata.durationMs ?? Date.now() - start
  const filteredErrors = countErrors(filteredSignals)
  const filteredWarnings = countWarnings(filteredSignals)

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
  }

  return filteredResult
}
