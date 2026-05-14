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
  const code = char.charCodeAt(0)
  const isLowerCase = code >= 97 && code <= 122
  const isUpperCase = code >= 65 && code <= 90
  const isDigit = code >= 48 && code <= 57
  const isSpecialChar = code === 95 || code === 45 || code === 47
  return isLowerCase || isUpperCase || isDigit || isSpecialChar
}

function extractCheckIdFromDirective(line: string, directiveKeyword: string): string | null {
  let commentIndex = line.indexOf('//')
  let sliceLen = 2
  if (commentIndex === -1) {
    commentIndex = line.indexOf('/*')
    if (commentIndex === -1) return null
    sliceLen = 2
  }

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



// =============================================================================
// LINTER IGNORE DIRECTIVE PARSING
// =============================================================================

/** Options controlling which linter ignore directives to detect. */
export interface LinterIgnoreOptions {
  eslint?: boolean
  typescript?: boolean
  semgrep?: boolean
}

/** Result of parsing linter ignore directives with line numbers and counts. */
export interface LinterIgnoreResult {
  ignoredLines: Set<number>
  counts: {
    eslint: number
    typescript: number
    semgrep: number
  }
}

function isEslintIgnoreLine(line: string): boolean {
  if (line.includes('// eslint-disable-line') || line.includes('/* eslint-disable-line')) {
    return true
  }
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) return false
  const content = trimmed.slice(2).trimStart()
  return content.startsWith('eslint-disable-next-line') || content.startsWith('eslint-disable-line')
}

function isTypescriptIgnoreLine(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('//')) return false
  const content = trimmed.slice(2).trimStart()
  return content.startsWith('@ts-expect-error') || content.startsWith('@ts-ignore')
}

function isSemgrepIgnoreLine(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('//')) return false
  const content = trimmed.slice(2).trimStart()
  return content.startsWith('nosemgrep')
}

/**
 * Parse linter ignore directives from file content.
 */
export function parseLinterIgnoreDirectives(
  content: string,
  options: LinterIgnoreOptions = {},
): LinterIgnoreResult {
  const ignoredLines = new Set<number>()
  const counts = { eslint: 0, typescript: 0, semgrep: 0 }
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''

    if (options.eslint && isEslintIgnoreLine(line)) {
      counts.eslint++
      if (line.includes('eslint-disable-line')) {
        ignoredLines.add(i + 1)
      } else {
        ignoredLines.add(i + 2)
      }
    }

    if (options.typescript && isTypescriptIgnoreLine(line)) {
      counts.typescript++
      ignoredLines.add(i + 2)
    }

    if (options.semgrep && isSemgrepIgnoreLine(line)) {
      counts.semgrep++
      ignoredLines.add(i + 2)
    }
  }

  return { ignoredLines, counts }
}

/**
 * Count all ignore directives in file content.
 */
export function countAllIgnoreDirectives(content: string): {
  fitness: number
  eslint: number
  typescript: number
  semgrep: number
  total: number
} {
  const lines = content.split('\n')
  let fitness = 0
  let eslint = 0
  let typescript = 0
  let semgrep = 0

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) continue

    const lineContent = trimmed.slice(2).trimStart()

    if (lineContent.startsWith('@fitness-ignore')) {
      fitness++
    } else if (lineContent.startsWith('eslint-disable')) {
      eslint++
    } else if (lineContent.startsWith('@ts-expect-error') || lineContent.startsWith('@ts-ignore')) {
      typescript++
    } else if (lineContent.startsWith('nosemgrep')) {
      semgrep++
    }
  }

  return { fitness, eslint, typescript, semgrep, total: fitness + eslint + typescript + semgrep }
}
