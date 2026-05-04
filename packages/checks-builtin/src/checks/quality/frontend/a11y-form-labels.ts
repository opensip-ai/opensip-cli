/**
 * @fileoverview Form Input Accessibility Labels Check
 *
 * Verifies that form input components have associated labels for accessibility.
 * Supports React Native and Tamagui form components.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * Form input components that should have accessibility labels.
 * Includes React Native and common UI library form components.
 */
const FORM_INPUT_COMPONENTS = ['TextInput', 'Input', 'Select', 'Picker']

/**
 * Props that satisfy the accessibility label requirement.
 * Any one of these props being present is sufficient.
 */
const ACCESSIBILITY_LABEL_PROPS = [
  'accessibilityLabel',
  'accessibilityLabelledBy',
  'aria-label',
  'aria-labelledby',
]

/**
 * Analyze a TSX file for form accessibility issues
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

      if (FORM_INPUT_COMPONENTS.includes(tagName)) {
        const hasA11yLabel = node.attributes.properties.some(
          (attr) =>
            ts.isJsxAttribute(attr) && ACCESSIBILITY_LABEL_PROPS.includes(attr.name.getText()),
        )

        if (!hasA11yLabel) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const lineNum = line + 1
          const matchText = node.getText(sourceFile).slice(0, 100)

          violations.push({
            filePath,
            line: lineNum,
            column: character + 1,
            message: `<${tagName}> missing accessibility label`,
            severity: 'warning',
            suggestion: `Add accessibilityLabel="description" or link to a label with accessibilityLabelledBy`,
            type: 'missing-form-label',
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
 * Check: quality/a11y-form-labels
 *
 * Ensures form input components have associated labels for accessibility
 * compliance and screen reader support.
 */
export const a11yFormLabels = defineCheck({
  id: '67feb11a-bc57-45cf-94e0-5354795d2e3c',
  slug: 'a11y-form-labels',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description: 'Verify form inputs have associated labels for accessibility',
  longDescription: `**Purpose:** Ensures form input components have associated accessibility labels so screen readers can identify them.

**Detects:** Analyzes each file individually using TypeScript AST traversal of JSX elements.
- \`<TextInput>\`, \`<Input>\`, \`<Select>\`, and \`<Picker>\` components missing all of: \`accessibilityLabel\`, \`accessibilityLabelledBy\`, \`aria-label\`, \`aria-labelledby\`
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Form inputs without labels are invisible to screen readers, making forms unusable for visually impaired users.

**Scope:** General best practice`,
  tags: ['quality', 'accessibility', 'frontend', 'forms'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
