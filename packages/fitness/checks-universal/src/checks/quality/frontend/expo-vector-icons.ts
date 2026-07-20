/**
 * @fileoverview Expo Vector Icons Check
 *
 * Ensures consistent icon library usage across the frontend codebase.
 * Recommends using @expo/vector-icons for React Native compatibility.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import { findStaticModuleReferences } from '../../code-aware-match.js';

const PREFERRED_ICON_LIBRARY = '@expo/vector-icons';
const DISCOURAGED_LIBRARIES = [
  'react-native-vector-icons',
  'react-icons',
  '@fortawesome/react-native-fontawesome',
];

/**
 * Analyze a file for icon library issues
 * @param {string} content - File content to analyze
 * @param {string} filePath - Path to the file
 * @returns {CheckViolation[]} Array of violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const imports = findStaticModuleReferences(filePath, content).filter(
    (reference) => reference.keyword === 'import' && reference.runtimeImport,
  );
  for (const reference of imports) {
    for (const lib of DISCOURAGED_LIBRARIES) {
      if (reference.moduleSpecifier !== lib && !reference.moduleSpecifier.startsWith(`${lib}/`)) {
        continue;
      }
      const line = content.slice(0, reference.index).split('\n').length;
      violations.push({
        filePath,
        line,
        column: 0,
        message: `Using ${lib} instead of ${PREFERRED_ICON_LIBRARY}`,
        severity: 'warning',
        type: 'discouraged-library',
        suggestion: `Replace import with: import { IconName } from '${PREFERRED_ICON_LIBRARY}/FontAwesome' or another icon family from @expo/vector-icons`,
        match: lib,
      });
    }
  }

  return violations;
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
  contentFilter: 'raw',

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
});
