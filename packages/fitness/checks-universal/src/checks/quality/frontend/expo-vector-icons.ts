/**
 * @fileoverview Expo Vector Icons Check
 *
 * Ensures consistent icon library usage across the frontend codebase.
 * Recommends using @expo/vector-icons for React Native compatibility.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

const PREFERRED_ICON_LIBRARY = '@expo/vector-icons'
const DISCOURAGED_LIBRARIES = [
  'react-native-vector-icons',
  'react-icons',
  '@fortawesome/react-native-fontawesome',
]

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  // @fitness-ignore-next-line fitness-check-standards -- Character class regex is safe from ReDoS, no backtracking
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Analyze a file for icon library issues
 * @param {string} content - File content to analyze
 * @param {string} filePath - Path to the file
 * @returns {CheckViolation[]} Array of violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Quick filter: skip if no discouraged library mentioned
  if (!DISCOURAGED_LIBRARIES.some((lib) => content.includes(lib))) {
    return []
  }

  const violations: CheckViolation[] = []

  for (const lib of DISCOURAGED_LIBRARIES) {
    const escapedLib = escapeRegExp(lib)
    const pattern = `import\\s+.*\\s+from\\s+['"]${escapedLib}['"]`
    const regex = new RegExp(pattern, 'g')
    let match
    while ((match = regex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length
      violations.push({
        filePath,
        line,
        column: 0,
        message: `Using ${lib} instead of ${PREFERRED_ICON_LIBRARY}`,
        severity: 'warning',
        type: 'discouraged-library',
        suggestion: `Replace import with: import { IconName } from '${PREFERRED_ICON_LIBRARY}/FontAwesome' or another icon family from @expo/vector-icons`,
        match: lib,
      })
    }
  }

  return violations
}

/**
 * Check: quality/expo-vector-icons
 *
 * Ensures consistent icon library usage with @expo/vector-icons.
 */
export const expoVectorIcons = defineCheck({
  id: 'dccf8b44-b1be-40b5-82e7-631daa8c0013',
  slug: 'expo-vector-icons',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Ensure consistent icon library usage with @expo/vector-icons',
  longDescription: `**Purpose:** Enforces consistent icon library usage by flagging imports from discouraged icon packages in favor of \`@expo/vector-icons\`.

**Detects:** Analyzes each file individually using regex-based import scanning.
- Import statements from \`react-native-vector-icons\`, \`react-icons\`, or \`@fortawesome/react-native-fontawesome\`
- Matches the pattern \`import ... from '<library>'\` for each discouraged library

**Why it matters:** Using multiple icon libraries increases bundle size and creates visual inconsistency. \`@expo/vector-icons\` is the standard for React Native/Expo compatibility.

**Scope:** Codebase-specific convention`,
  tags: ['quality', 'consistency', 'best-practices', 'react-native', 'icons'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
