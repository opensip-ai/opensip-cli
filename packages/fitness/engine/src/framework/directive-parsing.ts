// @fitness-ignore-file semgrep-justifications -- References nosemgrep patterns for directive parsing
/**
 * @fileoverview Ignore directive parsing utilities for fitness checks
 *
 * Provides utilities for parsing suppression directives:
 * - @fitness-ignore-file, @fitness-ignore-next-line
 * - eslint-disable-next-line, eslint-disable-line
 * - @ts-expect-error, @ts-ignore
 * - nosemgrep
 */

import { COMMENT_OPENERS } from './comment-openers.js'

// =============================================================================
// CONSTANTS
// =============================================================================

const KNOWN_DIRECTIVE_KEYWORDS = [
  'eslint-disable-next-line',
  'eslint-disable-line',
  '@ts-expect-error',
  '@ts-ignore',
  '@ts-nocheck',
  'prettier-ignore',
  'biome-ignore',
  '@fitness-ignore-next-line',
  '@fitness-ignore-file',
] as const

const MAX_DIRECTIVE_SKIP = 3

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function isKnownDirectiveLine(line: string): boolean {
  const trimmed = line.trimStart()

  if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
    return false
  }

  const commentContent = trimmed.slice(2).trimStart()

  return KNOWN_DIRECTIVE_KEYWORDS.some((keyword) => {
    if (!commentContent.startsWith(keyword)) return false
    const nextChar = commentContent[keyword.length]
    return nextChar === undefined || nextChar === ' ' || nextChar === '\t' || nextChar === ':'
  })
}

function isCheckIdChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  const isLowerCase = code >= 97 && code <= 122
  const isUpperCase = code >= 65 && code <= 90
  const isDigit = code >= 48 && code <= 57
  const isSpecialChar = code === 95 || code === 45 || code === 47
  return isLowerCase || isUpperCase || isDigit || isSpecialChar
}

function extractCheckIdFromDirective(line: string, directiveKeyword: string): string | null {
  let commentIndex = -1
  let sliceLen = 0
  for (const [opener, length] of COMMENT_OPENERS) {
    const idx = line.indexOf(opener)
    if (idx !== -1) {
      commentIndex = idx
      sliceLen = length
      break
    }
  }
  if (commentIndex === -1) return null

  const afterComment = line.slice(commentIndex + sliceLen).trimStart()
  if (!afterComment.startsWith(directiveKeyword)) return null

  const afterDirective = afterComment.slice(directiveKeyword.length)
  if (
    afterDirective.length === 0 ||
    (!afterDirective.startsWith(' ') && !afterDirective.startsWith('\t'))
  ) {
    return null
  }

  const checkIdStart = afterDirective.trimStart()
  let checkId = ''
  for (const char of checkIdStart) {
    if (isCheckIdChar(char)) {
      checkId += char
    } else {
      break
    }
  }

  return checkId.length > 0 ? checkId : null
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Parse file-level ignore directive from file content.
 * Returns true if the file should be entirely ignored for that check.
 */
export function parseFileIgnoreDirective(
  content: string,
  checkId: string | readonly string[],
): boolean {
  const lines = content.split('\n').slice(0, 50)
  const checkIds = Array.isArray(checkId) ? checkId : [checkId]

  for (const line of lines) {
    const extractedId = extractCheckIdFromDirective(line, '@fitness-ignore-file')
    if (extractedId !== null && checkIds.includes(extractedId)) {
      return true
    }
  }

  return false
}

/**
 * Parse next-line ignore directives from file content.
 * Returns a set of line numbers that should be ignored.
 */
export function parseIgnoreDirectives(
  content: string,
  checkId: string | readonly string[],
): Set<number> {
  const ignoredLines = new Set<number>()
  const lines = content.split('\n')
  const checkIds = Array.isArray(checkId) ? checkId : [checkId]

  for (let i = 0; i < lines.length; i++) {
    const extractedId = extractCheckIdFromDirective(lines[i] ?? '', '@fitness-ignore-next-line')
    if (extractedId !== null && checkIds.includes(extractedId)) {
      let targetLine = i + 1
      let skipped = 0

      while (
        targetLine < lines.length &&
        skipped < MAX_DIRECTIVE_SKIP &&
        isKnownDirectiveLine(lines[targetLine] ?? '')
      ) {
        targetLine++
        skipped++
      }

      ignoredLines.add(targetLine + 1)
    }
  }

  return ignoredLines
}



