// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Accessible Touchables Check
 *
 * Verifies that touchable/interactive components have accessibilityLabel prop for screen readers.
 * Supports both React Native touchables and Tamagui interactive components.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Interactive components that should have accessibility labels.
 * Includes React Native touchables and Tamagui interactive components.
 */
const TOUCHABLE_COMPONENTS = [
  // React Native touchables
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'TouchableNativeFeedback',
  'Pressable',
  // Tamagui interactive components (from UI library)
  'Button',
]

/**
 * Analyze a TSX file for accessibility issues
 * @param {string} content - The content of the file to analyze
 * @param {string} filePath - The absolute path of the TSX file
 * @returns {CheckViolation[]} Array of accessibility violations found
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  const violations: CheckViolation[] = []

  const sourceFile = getSharedSourceFile(filePath, content)
  if (!sourceFile) return violations

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isIdentifier(node.tagName) ? node.tagName.text : ''

      if (TOUCHABLE_COMPONENTS.includes(tagName)) {
        const hasA11yLabel = node.attributes.properties.some(
          (attr) =>
            ts.isJsxAttribute(attr) &&
            (attr.name.getText() === 'accessibilityLabel' || attr.name.getText() === 'accessible'),
        )

        const hasA11yRole = node.attributes.properties.some(
          (attr) => ts.isJsxAttribute(attr) && attr.name.getText() === 'accessibilityRole',
        )

        if (!hasA11yLabel) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const lineNum = line + 1
          const matchText = node.getText(sourceFile).slice(0, 100)

          violations.push({
            filePath,
            line: lineNum,
            column: character + 1,
            message: `<${tagName}> missing accessibilityLabel`,
            severity: 'warning',
            suggestion: `Add accessibilityLabel="descriptive text" prop to <${tagName}> for screen reader accessibility`,
            type: 'missing-accessibility-label',
            match: matchText,
          })
        } else if (!hasA11yRole) {
          // Has accessibilityLabel but missing accessibilityRole
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const lineNum = line + 1
          const matchText = node.getText(sourceFile).slice(0, 100)

          violations.push({
            filePath,
            line: lineNum,
            column: character + 1,
            message: `<${tagName}> has accessibilityLabel but missing accessibilityRole`,
            severity: 'warning',
            suggestion: `Add accessibilityRole="button" (or appropriate role) for better screen reader support`,
            type: 'missing-accessibility-role',
            match: matchText,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/accessible-touchables
 *
 * Ensures touchable/interactive components have accessibilityLabel prop
 * for screen readers and accessibility compliance.
 */
export const accessibleTouchables = defineCheck({
  id: 'da5b9da0-d943-4551-ac4d-91d94a89ddcf',
  slug: 'accessible-touchables',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description: 'Verify interactive components have accessibilityLabel for screen readers',
  longDescription: `**Purpose:** Ensures touchable and interactive components have both \`accessibilityLabel\` and \`accessibilityRole\` for full screen reader support.

**Detects:** Analyzes each file individually using TypeScript AST traversal of JSX elements.
- \`TouchableOpacity\`, \`TouchableHighlight\`, \`TouchableWithoutFeedback\`, \`TouchableNativeFeedback\`, \`Pressable\`, and \`Button\` missing \`accessibilityLabel\` or \`accessible\` prop
- Components that have \`accessibilityLabel\` but are missing \`accessibilityRole\`
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Interactive elements without accessibility labels are announced as generic "button" by screen readers, giving no context about what they do.

**Scope:** General best practice`,
  tags: ['quality', 'accessibility', 'frontend', 'best-practices'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
