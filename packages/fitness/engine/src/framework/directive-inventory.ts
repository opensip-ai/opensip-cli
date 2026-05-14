// @fitness-ignore-file concurrency-safety -- single-threaded access pattern
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Directive Inventory - shared parsing logic and codebase scanner
 *
 * Provides shared parsing constants/functions for fitness-ignore directives,
 * and a codebase scanner that inventories all directives.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { DEFAULT_EXCLUSION_PATTERNS } from './constants.js'
import { PathMatcher } from './path-matcher.js'

// =============================================================================
// Types
// =============================================================================

/** A single fitness-ignore directive found in a source file. */
export interface DirectiveEntry {
  filePath: string
  lineNumber: number
  type: 'file' | 'next-line'
  checkId: string
  group: string
  reason: string | null
  weakReason: boolean
}

/** Aggregate inventory of all fitness-ignore directives in a codebase. */
export interface DirectiveInventory {
  totalDirectives: number
  byType: { file: number; nextLine: number }
  byGroup: Record<string, number>
  weakReasonCount: number
  directives: DirectiveEntry[]
}

// =============================================================================
// Shared Constants
// =============================================================================

/** Patterns that indicate a weak or generic ignore reason. */
export const WEAK_REASON_PATTERNS = Object.freeze<readonly RegExp[]>([
  /^ignore$/i,
  /^skip$/i,
  /^todo$/i,
  /^fixme$/i,
  /^temporary$/i,
  /^temp$/i,
  /^wip$/i,
  /^disable$/i,
  /^suppress$/i,
  /^\s*$/,
])

// =============================================================================
// Shared Parsing
// =============================================================================

/**
 * Parse a file-level or next-line directive from a comment line.
 * Accepts both `//` and `/*`-style comments for consistency with the
 * suppression parser in directive-parsing.ts — otherwise block-comment
 * directives suppress findings but vanish from inventory counts.
 */
export function parseDirectiveLine(line: string): {
  type: 'file' | 'next-line'
  checkId: string
  reason: string | null
} | null {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('// ') && !trimmed.startsWith('/* ')) return null

  const afterComment = trimmed.slice(3).trimStart()

  if (afterComment.startsWith('@fitness-ignore-file ')) {
    const rest = afterComment.slice('@fitness-ignore-file '.length)
    return parseDirectiveRest(rest, 'file')
  }

  if (afterComment.startsWith('@fitness-ignore-next-line ')) {
    const rest = afterComment.slice('@fitness-ignore-next-line '.length)
    return parseDirectiveRest(rest, 'next-line')
  }

  return null
}

function parseDirectiveRest(
  rest: string,
  type: 'file' | 'next-line',
): { type: 'file' | 'next-line'; checkId: string; reason: string | null } | null {
  // Strip trailing `*/` from block-comment directives (e.g. `foo */` → `foo`).
  // eslint-disable-next-line sonarjs/slow-regex -- anchored at end-of-string, bounded \s* runs; no ReDoS exposure
  const normalized = rest.replace(/\s*\*\/\s*$/, '').trimEnd()

  const separatorIndex = normalized.indexOf(' -- ')

  if (separatorIndex === -1) {
    const checkId = normalized.trim()
    if (!checkId || checkId.includes(' ')) return null
    return { type, checkId, reason: null }
  }

  const checkId = normalized.slice(0, separatorIndex).trim()
  const reason = normalized.slice(separatorIndex + 4).trim()

  if (!checkId || checkId.includes(' ')) return null
  return { type, checkId, reason: reason || null }
}

/**
 * Check if a reason is weak/generic. Missing reason (null) is considered weak.
 */
export function isWeakReason(reason: string | null): boolean {
  if (reason === null) return true
  return WEAK_REASON_PATTERNS.some((pattern) => pattern.test(reason.trim()))
}

/**
 * Extract the group prefix from a check ID (the directory name).
 */
export function extractGroup(checkId: string): string {
  const slashIndex = checkId.indexOf('/')
  return slashIndex > 0 ? checkId.slice(0, slashIndex) : 'other'
}

// =============================================================================
// Scanner
// =============================================================================

/** Default exclusion patterns for scanning (without tsbuildinfo since we scan source). */
const DEFAULT_SCAN_EXCLUDES = [...DEFAULT_EXCLUSION_PATTERNS].filter(p => p !== '**/*.tsbuildinfo')

/**
 * Internal: scan files for directives using a reader function.
 */
async function scanWithReader(
  cwd: string,
  readFn: (absolutePath: string) => Promise<string>,
): Promise<DirectiveInventory> {
  const matcher = PathMatcher.create({
    cwd,
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    exclude: DEFAULT_SCAN_EXCLUDES,
  })
  const files = await matcher.files()

  const directives: DirectiveEntry[] = []
  for (const absolutePath of files) {
    const relativePath = path.relative(cwd, absolutePath)
    // @fitness-ignore-next-line performance-anti-patterns -- sequential reads to limit memory: avoids loading all files concurrently
    const content = await readFn(absolutePath)

    if (!content.includes('@fitness-ignore')) continue

    const lines = content.split('\n')
    for (const [i, line] of lines.entries()) {
      const parsed = parseDirectiveLine(line ?? '')
      if (parsed) {
        directives.push({
          filePath: relativePath,
          lineNumber: i + 1,
          type: parsed.type,
          checkId: parsed.checkId,
          group: extractGroup(parsed.checkId),
          reason: parsed.reason,
          weakReason: isWeakReason(parsed.reason),
        })
      }
    }
  }

  return buildInventory(directives)
}

/**
 * Scan the codebase and return all @fitness-ignore directives with metadata.
 */
export async function scanDirectiveInventory(cwd: string): Promise<DirectiveInventory> {
  return scanWithReader(cwd, async (p) => {
    const fileStats = await fs.promises.stat(p)
    if (fileStats.size > 10_000_000) return ''
    return fs.promises.readFile(p, 'utf8')
  })
}

/**
 * Scan for directives using a provided file cache.
 */
export async function scanDirectiveInventoryFromCache(
  cwd: string,
  cache: { get(path: string): Promise<string>; stats: { prewarmed: boolean } },
): Promise<DirectiveInventory> {
  if (!cache.stats.prewarmed) {
    return scanDirectiveInventory(cwd)
  }
  return scanWithReader(cwd, (p) => cache.get(p))
}

function buildInventory(directives: DirectiveEntry[]): DirectiveInventory {
  const byGroup: Record<string, number> = {}
  let fileCount = 0
  let nextLineCount = 0
  let weakReasonCount = 0

  for (const dir of directives) {
    byGroup[dir.group] = (byGroup[dir.group] ?? 0) + 1
    if (dir.type === 'file') fileCount++
    else nextLineCount++
    if (dir.weakReason) weakReasonCount++
  }

  return {
    totalDirectives: directives.length,
    byType: { file: fileCount, nextLine: nextLineCount },
    byGroup,
    weakReasonCount,
    directives,
  }
}
