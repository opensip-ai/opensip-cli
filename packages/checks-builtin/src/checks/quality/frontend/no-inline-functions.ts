// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview No Inline Functions Check
 *
 * Detects inline function definitions in JSX props which cause unnecessary re-renders.
 * Arrow functions and function expressions created during render should be memoized.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * High-impact callback props that definitely should not have inline functions
 * (used in lists/virtualization - cause significant re-render issues)
 */
const HIGH_IMPACT_PROPS = [
  'renderItem',
  'keyExtractor',
  'ListHeaderComponent',
  'ListFooterComponent',
  'ListEmptyComponent',
  'getItemLayout',
]

/**
 * Low-impact callback props where inline functions are less critical
 * (simple event handlers - warning only)
 */
const LOW_IMPACT_PROPS = [
  'onPress',
  'onPressIn',
  'onPressOut',
  'onLongPress',
  'onChange',
  'onChangeText',
  'onSubmit',
  'onFocus',
  'onBlur',
  'onScroll',
]

/**
 * Combined list for backwards compatibility
 */
const CALLBACK_PROPS = [...HIGH_IMPACT_PROPS, ...LOW_IMPACT_PROPS]

/**
 * Check if an expression is a trivial callback (single return/call)
 * Trivial callbacks have minimal performance impact
 */
function isTrivialCallback(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const body = node.body

  // Arrow function with expression body: () => value, () => fn()
  if (ts.isArrowFunction(node) && !ts.isBlock(body)) {
    // () => identifier
    if (ts.isIdentifier(body)) return true
    // () => fn()
    if (ts.isCallExpression(body) && ts.isIdentifier(body.expression)) return true
    // () => !value
    if (ts.isPrefixUnaryExpression(body)) return true
  }

  return false
}

/**
 * Analyze a TSX file for inline functions in JSX props
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  // Quick filter: skip files without callback props
  if (!CALLBACK_PROPS.some((prop) => content.includes(prop))) {
    return []
  }

  const violations: CheckViolation[] = []

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return violations

    const visit = (node: ts.Node): void => {
      if (!ts.isJsxAttribute(node)) {
        ts.forEachChild(node, visit)
        return
      }

      if (!ts.isIdentifier(node.name)) {
        ts.forEachChild(node, visit)
        return
      }

      const propName = node.name.text
      if (!CALLBACK_PROPS.includes(propName)) {
        ts.forEachChild(node, visit)
        return
      }

      const initializer = node.initializer
      if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
        ts.forEachChild(node, visit)
        return
      }

      const expr = initializer.expression
      if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        // Skip trivial callbacks (single expression/call) - minimal performance impact
        if (isTrivialCallback(expr)) {
          ts.forEachChild(node, visit)
          return
        }

        // Determine severity based on prop type
        const isHighImpact = HIGH_IMPACT_PROPS.includes(propName)
        const severity = isHighImpact ? 'error' : 'warning'

        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        violations.push({
          filePath,
          line: line + 1,
          column: character + 1,
          message: `Inline function in ${propName} prop causes re-renders`,
          severity,
          type: 'inline-function',
          suggestion: `Extract to useCallback: const handle${propName.replace('on', '')} = useCallback(() => { ... }, [deps]);`,
          match: propName,
        })
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/no-inline-functions
 *
 * Detects inline arrow functions in JSX callback props that cause re-renders.
 */
export const noInlineFunctions = defineCheck({
  id: '2220f07d-8051-4a8e-a97b-96e75cd2b481',
  slug: 'no-inline-functions',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description: 'Detect inline arrow functions in JSX callback props that cause re-renders',
  longDescription: `**Purpose:** Detects inline arrow functions and function expressions in JSX callback props, which create new references on every render and defeat memoization.

**Detects:** Analyzes each file individually using TypeScript AST traversal of JSX attributes.
- Arrow functions or function expressions passed to high-impact props (\`renderItem\`, \`keyExtractor\`, \`ListHeaderComponent\`, etc.) -- reported as errors
- Arrow functions or function expressions passed to event handler props (\`onPress\`, \`onChange\`, \`onScroll\`, etc.) -- reported as warnings
- Trivial callbacks are excluded: single-expression arrow functions like \`() => value\`, \`() => fn()\`, or \`() => !flag\`
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Inline functions in render props create new references each render cycle, causing child components and list items to re-render unnecessarily.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'best-practices', 'react-native'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
