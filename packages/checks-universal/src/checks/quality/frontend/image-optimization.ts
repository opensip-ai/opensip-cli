/**
 * @fileoverview Image Optimization Check
 *
 * Detects unoptimized image imports and usage patterns in React Native code.
 * Recommends using Expo Image or optimized image loading strategies.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/**
 * Check if content contains a react-native Image import.
 * Uses simple string search instead of regex for ReDoS safety.
 *
 * @param content - File content to check
 * @returns True if react-native Image import is found
 */
function hasReactNativeImageImport(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    const isImportStatement = line.includes('import') && line.includes('Image')
    const isFromReactNative = line.includes('react-native')
    const isNamedImport = line.includes('{') && line.includes('}')

    if (isImportStatement && isFromReactNative && isNamedImport) {
      return true
    }
  }
  return false
}

/**
 * Check if content contains an expo-image import.
 *
 * @param content - File content to check
 * @returns True if expo-image import is found
 */
function hasExpoImageImport(content: string): boolean {
  return content.includes("from 'expo-image'") || content.includes('from "expo-image"')
}

/**
 * Find the line number of a react-native Image import.
 *
 * @param content - File content to search
 * @returns Line number (1-based) and snippet, or null if not found
 */
function findReactNativeImageLine(content: string): { line: number; snippet: string } | null {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) {
      continue
    }
    const isImportStatement = line.includes('import') && line.includes('Image')
    const isFromReactNative = line.includes('react-native')
    const isNamedImport = line.includes('{') && line.includes('}')

    if (isImportStatement && isFromReactNative && isNamedImport) {
      return { line: i + 1, snippet: line.trim() }
    }
  }
  return null
}

/**
 * Find Image components without placeholder prop.
 * Uses line-by-line analysis instead of regex for ReDoS safety.
 *
 * @param content - File content to search
 * @returns Array of violations with line numbers
 */
function findImagesWithoutPlaceholder(content: string): Array<{ line: number; snippet: string }> {
  const results: Array<{ line: number; snippet: string }> = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) {
      continue
    }
    // Look for <Image with source prop but without placeholder
    if (line.includes('<Image') && line.includes('source=')) {
      // Check this line and surrounding context for placeholder
      const contextStart = Math.max(0, i - 2)
      const contextEnd = Math.min(lines.length, i + 3)
      const context = lines.slice(contextStart, contextEnd).join('\n')

      if (!context.includes('placeholder')) {
        results.push({ line: i + 1, snippet: line.trim().slice(0, 100) })
      }
    }
  }

  return results
}

/**
 * Analyzes a single file for image optimization issues
 *
 * @param content - File content to analyze
 * @param filePath - Path to the file being analyzed
 * @returns Array of violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  // Quick filter: skip files without Image
  if (!content.includes('Image')) {
    return []
  }

  const violations: CheckViolation[] = []

  // Check for react-native Image without expo-image
  const hasRNImage = hasReactNativeImageImport(content)
  const hasExpoImage = hasExpoImageImport(content)

  if (hasRNImage && !hasExpoImage) {
    const importInfo = findReactNativeImageLine(content)
    if (importInfo) {
      violations.push({
        filePath,
        line: importInfo.line,
        column: 0,
        message: 'Using react-native Image instead of expo-image',
        severity: 'warning',
        type: 'use-expo-image',
        suggestion:
          "Replace with expo-image for better performance and caching: import { Image } from 'expo-image'. Expo Image provides automatic caching, better memory management, and supports modern image formats.",
        match: 'react-native Image',
      })
    }
  }

  // Check for Image without placeholder prop (for expo-image)
  if (hasExpoImage) {
    const imagesWithoutPlaceholder = findImagesWithoutPlaceholder(content)
    for (const img of imagesWithoutPlaceholder) {
      violations.push({
        filePath,
        line: img.line,
        column: 0,
        message: 'Image missing placeholder for loading state',
        severity: 'warning',
        type: 'no-placeholder',
        suggestion:
          'Add placeholder prop for better UX during loading. Use a low-resolution placeholder or blurhash for smooth loading transitions.',
        match: '<Image',
      })
    }
  }

  return violations
}

/**
 * Check: quality/image-optimization
 *
 * Detects unoptimized image usage and recommends best practices.
 */
export const imageOptimization = defineCheck({
  id: 'fe256cba-e891-466b-9361-c71b5af216d9',
  slug: 'image-optimization',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'medium',
  description: 'Detect unoptimized image usage and recommend best practices',
  longDescription: `**Purpose:** Detects unoptimized image loading patterns and enforces usage of \`expo-image\` over React Native's built-in \`Image\` component.

**Detects:** Analyzes each file individually using line-by-line string matching.
- \`Image\` imported from \`react-native\` (named import with curly braces) when \`expo-image\` is not also imported
- \`<Image>\` elements using \`expo-image\` that have a \`source=\` prop but no \`placeholder\` prop within a 5-line context window
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** React Native's \`Image\` lacks caching, modern format support, and memory management. Missing placeholders cause layout shifts during loading.

**Scope:** Codebase-specific convention`,
  tags: ['quality', 'performance', 'best-practices', 'react-native', 'images'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
