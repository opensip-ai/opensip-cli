// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview A11y Semantic HTML Check
 *
 * Detects div-soup anti-patterns where View components have onPress handlers
 * without proper accessibility role definitions.
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Press handler props that indicate interactive behavior on View components.
 */
const PRESS_HANDLER_PROPS = new Set(['onPress', 'onPressIn', 'onPressOut', 'onLongPress'])

/**
 * Analyze a TSX file for View components with press handlers missing accessibilityRole
 * @param {string} content - The content of the file to analyze
 * @param {string} filePath - The absolute path of the TSX file
 * @returns {CheckViolation[]} Array of semantic HTML violations found
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

      if (tagName === 'View') {
        const attributes = node.attributes.properties

        // Check if View has any press handler props
        const hasPressHandler = attributes.some(
          (attr) => ts.isJsxAttribute(attr) && PRESS_HANDLER_PROPS.has(attr.name.getText()),
        )

        if (hasPressHandler) {
          // Check if View has accessibilityRole
          const hasAccessibilityRole = attributes.some(
            (attr) => ts.isJsxAttribute(attr) && attr.name.getText() === 'accessibilityRole',
          )

          if (!hasAccessibilityRole) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
            const lineNum = line + 1
            const matchText = node.getText(sourceFile).slice(0, 100)

            violations.push({
              filePath,
              line: lineNum,
              column: character + 1,
              message: `<View> with press handler missing accessibilityRole`,
              severity: 'warning',
              suggestion: `Use <Pressable> instead of <View onPress>, or add accessibilityRole="button" for screen reader support`,
              type: 'missing-accessibility-role',
              match: matchText,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/a11y-semantic-html
 *
 * Detects View components with press handlers that lack accessibilityRole.
 * This is a div-soup anti-pattern that hurts screen reader accessibility.
 */
export const a11ySemanticHtml = defineCheck({
  id: 'edccd88f-214d-4720-8843-2a94c2d5b729',
  slug: 'a11y-semantic-html',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description: 'Detect View components with press handlers missing accessibilityRole',
  longDescription: `**Purpose:** Detects the "div-soup" anti-pattern where \`<View>\` components act as interactive elements without declaring an accessibility role.

**Detects:** Analyzes each file individually using TypeScript AST traversal of JSX elements.
- \`<View>\` components that have any of \`onPress\`, \`onPressIn\`, \`onPressOut\`, \`onLongPress\` but lack an \`accessibilityRole\` prop
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Screen readers cannot announce interactive Views as buttons or links without an explicit \`accessibilityRole\`, making tap targets invisible to assistive technology.

**Scope:** General best practice`,
  tags: ['quality', 'accessibility', 'frontend', 'semantic'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
