// @fitness-ignore-file fitness-check-architecture -- Helper module providing shared validation utilities; not a standalone check requiring defineCheck pattern
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Shared helpers for configuration validation checks
 */

import { logger } from '@opensip-tools/core'

// =============================================================================
// CHARACTER HELPERS
// =============================================================================

/**
 * Check if a character is a digit (0-9).
 */
export function isDigit(char: string | undefined): boolean {
  if (!char) return false
  const code = char.codePointAt(0) ?? 0
  return code >= 48 && code <= 57
}

/**
 * Check if a character is alphanumeric (0-9, A-Z, a-z).
 */
export function isAlphanumericChar(char: string | undefined): boolean {
  if (!char) return false
  const code = char.codePointAt(0) ?? 0
  const isDigitChar = code >= 48 && code <= 57 // 0-9
  const isUpperCase = code >= 65 && code <= 90 // A-Z
  const isLowerCase = code >= 97 && code <= 122 // a-z
  return isDigitChar || isUpperCase || isLowerCase
}

/**
 * Skip whitespace in a string from a given position.
 * @param str - The string to scan
 * @param startPos - The starting position in the string
 * @returns The position of the first non-whitespace character
 */
export function skipWhitespace(str: string, startPos: number): number {
  let i = startPos
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    i++
  }
  return i
}

/**
 * Parse digits from a string starting at a given position.
 */
export function parseDigits(
  str: string,
  startPos: number,
): { endPos: number; value: number; digitCount: number } {
  logger.debug({
    evt: 'fitness.checks.config_validation_helpers.parse_digits',
    msg: 'Parsing digit sequence from string at given position',
  })
  let i = startPos
  while (i < str.length && isDigit(str[i])) {
    i++
  }
  const digitCount = i - startPos
  // @fitness-ignore-next-line numeric-validation -- substring is guaranteed digit-only by isDigit loop above
  const value = digitCount > 0 ? Number.parseInt(str.slice(startPos, i), 10) : 0
  return { endPos: i, value, digitCount }
}
