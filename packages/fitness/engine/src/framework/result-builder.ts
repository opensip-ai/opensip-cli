/**
 * @fileoverview ResultBuilder - Builder pattern for check results
 *
 * Provides a fluent API for constructing check results with signals,
 * metadata, and display information.
 */

import type { Signal } from '@opensip-tools/core'

import type {
  CheckResult,
  CheckInfo,
  ItemType,
  FindingSeverity,
} from '../types/findings.js'
import {
  CheckInfoFactory,
  createResultWithSignals,
  createErrorResult,
  getItemTypeLabel,
} from '../types/findings.js'
import { countErrors, countWarnings, isErrorSeverity, isWarningSeverity } from '../types/severity.js'

/**
 * Options for building results.
 */
export interface ResultBuilderOptions {
  /** Check ID */
  readonly checkId: string
  /** Item type for display (files, modules, etc.) */
  readonly itemType: ItemType
  /** Custom unit label (overrides itemType) */
  readonly unit?: string | undefined
}

/**
 * Builder for constructing check results.
 *
 * @example
 * ```typescript
 * const result = ResultBuilder.create({ checkId: 'my-check', itemType: 'files' })
 *   .totalItems(100)
 *   .addSignal(signal1)
 *   .build();
 * ```
 */
export class ResultBuilder {
  private _totalItems: number = 0
  private readonly _signals: Signal[] = []
  private _ignoredCount: number = 0
  private _durationMs?: number
  private _filesScanned?: number
  private _extra?: Record<string, unknown>

  private constructor(private readonly options: ResultBuilderOptions) {}

  static create(
    options: ResultBuilderOptions,
  ): ResultBuilder {
    return new ResultBuilder(options)
  }

  totalItems(count: number): this {
    this._totalItems = count
    return this
  }

  filesScanned(count: number): this {
    this._filesScanned = count
    return this
  }

  addSignal(signal: Signal): this {
    this._signals.push(signal)
    return this
  }

  addSignals(signals: readonly Signal[]): this {
    if (!Array.isArray(signals) || signals.length === 0) {
      return this
    }
    this._signals.push(...signals)
    return this
  }

  ignoredCount(count: number): this {
    this._ignoredCount = count
    return this
  }

  incrementIgnored(by: number = 1): this {
    this._ignoredCount += by
    return this
  }

  duration(ms: number): this {
    this._durationMs = ms
    return this
  }

  extra(data: Record<string, unknown>): this {
    this._extra = { ...this._extra, ...data }
    return this
  }

  build(): CheckResult {
    const unit = this.options.unit ?? this.options.itemType
    const errors = countErrors(this._signals)
    const warnings = countWarnings(this._signals)

    const info = this.buildInfo(errors, warnings, unit)

    const buildOptions: {
      ignoredCount?: number
      durationMs?: number
      filesScanned?: number
      itemType?: string
      extra?: Record<string, unknown>
    } = {}

    if (this._ignoredCount > 0) {
      buildOptions.ignoredCount = this._ignoredCount
    }
    if (this._durationMs !== undefined) {
      buildOptions.durationMs = this._durationMs
    }
    if (this._filesScanned !== undefined) {
      buildOptions.filesScanned = this._filesScanned
    }
    buildOptions.itemType = this.options.itemType
    if (this._extra !== undefined) {
      buildOptions.extra = this._extra
    }

    return createResultWithSignals(
      info,
      this._signals,
      this._totalItems,
      Object.keys(buildOptions).length > 0 ? buildOptions : undefined,
    )
  }

  buildError(message: string, error?: Error): CheckResult {
    return createErrorResult(message, error)
  }

  private buildInfo(errors: number, warnings: number, unit: string): CheckInfo {
    if (this._totalItems > 0) {
      // Clamp to 0: analyzeAll-mode checks can surface violations against
      // files outside the scanned set, which would otherwise produce a
      // negative "-N/M compliant" label.
      const compliantItems = Math.max(0, this._totalItems - this.getUniqueFileCount())
      return CheckInfoFactory.compliance(compliantItems, this._totalItems, unit)
    }

    const total = errors + warnings
    return CheckInfoFactory.violations(total, getItemTypeLabel('violations', total))
  }

  private getUniqueFileCount(): number {
    const files = new Set(this._signals.map((s) => s.code?.file).filter(Boolean))
    return files.size
  }

  get signalCount(): number {
    return this._signals.length
  }

  get errorCount(): number {
    return countErrors(this._signals)
  }

  get warningCount(): number {
    return countWarnings(this._signals)
  }

  get hasSignals(): boolean {
    return this._signals.length > 0
  }

  get willPass(): boolean {
    return this.errorCount === 0
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Aggregate multiple check results into one.
 */
export function aggregateResults(
  results: readonly CheckResult[],
  options: { checkId: string; itemType: ItemType },
): CheckResult {
  if (results.length === 0) {
    return ResultBuilder.create(options).build()
  }

  const builder = ResultBuilder.create(options)

  let totalItems = 0
  let totalIgnored = 0
  let totalDuration = 0

  for (const result of results) {
    totalItems += result.metadata.totalItems
    totalIgnored += result.ignoredCount ?? 0
    if (result.metadata.durationMs) {
      totalDuration += result.metadata.durationMs
    }
    builder.addSignals(result.signals)
  }

  builder.totalItems(totalItems).ignoredCount(totalIgnored)

  if (totalDuration > 0) {
    builder.duration(totalDuration)
  }

  return builder.build()
}

/**
 * Create a passing result quickly.
 */
export function passResult(
  options: ResultBuilderOptions,
  totalItems: number,
  durationMs?: number,
): CheckResult {
  const builder = ResultBuilder.create(options).totalItems(totalItems)

  if (durationMs !== undefined) {
    builder.duration(durationMs)
  }

  return builder.build()
}

/**
 * Filter signals by severity.
 */
export function filterSignals(
  signals: readonly Signal[],
  severity: FindingSeverity,
): Signal[] {
  if (!Array.isArray(signals)) {
    return []
  }
  return signals.filter((s) =>
    severity === 'error' ? isErrorSeverity(s.severity) : isWarningSeverity(s.severity),
  )
}

/**
 * Group signals by file.
 */
export function groupByFile(signals: readonly Signal[]): Map<string, Signal[]> {
  // in-memory: single-threaded Node.js access pattern
  if (!Array.isArray(signals)) {
    return new Map()
  }

  const groups = new Map<string, Signal[]>()

  for (const signal of signals) {
    const file = signal.code?.file ?? ''
    const existing = groups.get(file)
    if (existing) {
      existing.push(signal)
    } else {
      groups.set(file, [signal])
    }
  }

  return groups
}

/**
 * Sort signals by file, then line.
 */
export function sortSignals(signals: readonly Signal[]): Signal[] {
  if (!Array.isArray(signals)) {
    return []
  }
  return [...signals].sort((a, b) => {
    const fileA = a.code?.file ?? ''
    const fileB = b.code?.file ?? ''
    const fileCompare = fileA.localeCompare(fileB)
    if (fileCompare !== 0) return fileCompare
    return (a.code?.line ?? 0) - (b.code?.line ?? 0)
  })
}

// =============================================================================
// SNIPPET UTILITIES
// =============================================================================

/**
 * Extract a code snippet with context lines around a target line.
 */
export function extractSnippet(
  content: string,
  line: number,
  contextLines: number = 2,
): { snippet: string; contextLines: number } {
  const lines = content.split('\n')
  const startLine = Math.max(0, line - 1 - contextLines)
  const endLine = Math.min(lines.length, line + contextLines)
  const snippetLines = lines.slice(startLine, endLine)
  const snippet = snippetLines.map((l, i) => `${startLine + i + 1} | ${l}`).join('\n')
  return { snippet, contextLines }
}

/**
 * Get line number from content string and character index.
 */
export function getLineNumber(content: string, index: number): number {
  return content.substring(0, index).split('\n').length
}

/**
 * Default patterns for identifying API-related files.
 */
export const DEFAULT_API_FILE_PATTERNS = ['/api/', '/routes/', '-handler.ts', '.handler.ts'] as const

/**
 * Check if a file path matches API file patterns.
 */
export function isAPIFile(filePath: string): boolean {
  return DEFAULT_API_FILE_PATTERNS.some((pattern) =>
    pattern.startsWith('/') ? filePath.includes(pattern) : filePath.endsWith(pattern),
  )
}
