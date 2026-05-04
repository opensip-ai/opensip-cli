/**
 * @fileoverview Memo List Items Check
 *
 * Warns when components rendered in .map() calls might benefit from memoization.
 * Detects patterns like: items.map(item => <ComponentName ... />)
 * Suggests using React.memo or migrating to FlashList for better list performance.
 *
 * Smart exclusions (false-positive reduction):
 * - Components already wrapped in React.memo in the same file
 * - Components whose name starts with "Memoized" (naming convention)
 * - .map() called on a static array literal (no re-render concern)
 * - JSX inside a React.useMemo callback (already optimized)
 */

import * as ts from 'typescript'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/**
 * Built-in React Native components that don't need memoization warnings
 */
const BUILTIN_COMPONENTS = new Set([
  'View',
  'Text',
  'Image',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  'Pressable',
  'ScrollView',
  'SafeAreaView',
  'KeyboardAvoidingView',
  'FlatList',
  'SectionList',
  'TextInput',
  'Button',
  'Switch',
  'ActivityIndicator',
  'Modal',
  'StatusBar',
  'RefreshControl',
  'ImageBackground',
  'VirtualizedList',
])

/**
 * Check if a name is a custom component (PascalCase, not built-in)
 */
function isCustomComponent(name: string): boolean {
  // Must start with uppercase letter (PascalCase)
  if (!/^[A-Z]/.test(name)) {
    return false
  }
  // Exclude built-in components
  return !BUILTIN_COMPONENTS.has(name)
}

/**
 * Check if a node is a JSX element with a custom component
 */
function getCustomComponentName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) {
    const openingElement = node.openingElement
    if (ts.isIdentifier(openingElement.tagName)) {
      const name = openingElement.tagName.text
      if (isCustomComponent(name)) {
        return name
      }
    }
  } else if (ts.isJsxSelfClosingElement(node) && ts.isIdentifier(node.tagName)) {
    const name = node.tagName.text
    if (isCustomComponent(name)) {
      return name
    }
  }
  return null
}

/**
 * Collect all component names that are wrapped in React.memo within the source file.
 * Detects patterns:
 * - `const Foo = React.memo(function Foo(...) { ... })`
 * - `const Foo = React.memo(function Bar(...) { ... })`  (variable name wins)
 * - `const Foo = memo(function Foo(...) { ... })`
 * - `React.memo(function Foo(...) { ... })` (named function form)
 * - `Object.assign(SomeComponent, ...)` where SomeComponent is memo-wrapped
 */
function collectMemoizedComponents(sourceFile: ts.SourceFile): Set<string> {
  const memoized = new Set<string>()

  const visit = (node: ts.Node): void => {
    // Pattern: const Foo = React.memo(...) or const Foo = memo(...)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isMemoCallExpression(node.initializer)
    ) {
      memoized.add(node.name.text)
      // Also capture the inner function name if it differs
      const innerName = getMemoInnerFunctionName(node.initializer)
      if (innerName) {
        memoized.add(innerName)
      }
    }

    // Pattern: export const Foo = React.memo(...)
    // Already covered by variable declaration above since export is on the statement

    // Pattern: Object.assign(MemoComponent, ...) re-export — track the assigned variable
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callExpr = node.initializer
      if (
        ts.isPropertyAccessExpression(callExpr.expression) &&
        ts.isIdentifier(callExpr.expression.expression) &&
        callExpr.expression.expression.text === 'Object' &&
        callExpr.expression.name.text === 'assign' &&
        callExpr.arguments.length >= 1
      ) {
        const firstArg = callExpr.arguments[0]
        if (firstArg && ts.isIdentifier(firstArg) && memoized.has(firstArg.text)) {
          memoized.add(node.name.text)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return memoized
}

/**
 * Check if an expression is a React.memo(...) or memo(...) call
 */
function isMemoCallExpression(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) {
    return false
  }
  const expr = node.expression
  // React.memo(...)
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'React' &&
    expr.name.text === 'memo'
  ) {
    return true
  }
  // memo(...)
  if (ts.isIdentifier(expr) && expr.text === 'memo') {
    return true
  }
  return false
}

/**
 * Extract the inner function name from React.memo(function Foo(...) { ... })
 */
function getMemoInnerFunctionName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) {
    return null
  }
  const firstArg = node.arguments[0]
  if (firstArg && ts.isFunctionExpression(firstArg) && firstArg.name) {
    return firstArg.name.text
  }
  return null
}

/**
 * Check if a node is inside a .map() call and return the map CallExpression
 */
function findEnclosingMapCall(node: ts.Node): ts.CallExpression | null {
  let parent = node.parent
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: ts.Node.parent is undefined at root despite TS typing
  while (parent) {
    if (ts.isCallExpression(parent)) {
      const expression = parent.expression
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'map') {
        return parent
      }
    }
    parent = parent.parent
  }
  return null
}

/**
 * Check if a .map() call is on a static array literal, e.g. [{...}, {...}].map(...)
 * Static array literals don't cause re-render issues since the array identity is
 * created fresh each render regardless of memoization.
 */
function isStaticArrayMap(mapCall: ts.CallExpression): boolean {
  const expression = mapCall.expression
  if (!ts.isPropertyAccessExpression(expression)) {
    return false
  }
  const receiver = expression.expression
  // Direct array literal: [{...}].map(...)
  if (ts.isArrayLiteralExpression(receiver)) {
    return true
  }
  // Array.from({...}).map(...)
  if (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === 'Array' &&
    receiver.expression.name.text === 'from'
  ) {
    return true
  }
  return false
}

/**
 * Check if a node is inside a React.useMemo callback.
 * Components inside useMemo are already optimized and don't need additional memo wrapping.
 */
function isInsideUseMemo(node: ts.Node): boolean {
  let parent = node.parent
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: ts.Node.parent is undefined at root despite TS typing
  while (parent) {
    if (ts.isCallExpression(parent)) {
      const expr = parent.expression
      // React.useMemo(...)
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'React' &&
        expr.name.text === 'useMemo'
      ) {
        return true
      }
      // useMemo(...)
      if (ts.isIdentifier(expr) && expr.text === 'useMemo') {
        return true
      }
    }
    parent = parent.parent
  }
  return false
}

/**
 * Find custom components rendered inside .map() calls that are NOT already memoized.
 */
function findMapRenderedComponents(
  sourceFile: ts.SourceFile,
  filePath: string,
  memoizedNames: Set<string>,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  const visit = (node: ts.Node): void => {
    const componentName = getCustomComponentName(node)
    if (componentName) {
      const mapCall = findEnclosingMapCall(node)
      if (mapCall) {
        // Skip if the component is already wrapped in React.memo (same-file detection)
        if (memoizedNames.has(componentName)) {
          ts.forEachChild(node, visit)
          return
        }
        // Skip if the component name starts with "Memoized" (naming convention)
        if (componentName.startsWith('Memoized')) {
          ts.forEachChild(node, visit)
          return
        }
        // Skip if .map() is called on a static array literal
        if (isStaticArrayMap(mapCall)) {
          ts.forEachChild(node, visit)
          return
        }
        // Skip if the JSX is inside a React.useMemo callback
        if (isInsideUseMemo(node)) {
          ts.forEachChild(node, visit)
          return
        }
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        violations.push({
          filePath,
          line: line + 1,
          column: character + 1,
          message: `Component <${componentName}> rendered in .map() may cause unnecessary re-renders`,
          severity: 'warning',
          type: 'unmemoized-list-item',
          suggestion:
            'Consider wrapping component with React.memo() or use FlashList with renderItem prop for better list performance',
          match: componentName,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Analyze a TSX file for unmemoized list items
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  // Quick filter: skip files without .map(
  if (!content.includes('.map(')) {
    return []
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    // Collect all components wrapped in React.memo within this file
    const memoizedNames = collectMemoizedComponents(sourceFile)

    return findMapRenderedComponents(sourceFile, filePath, memoizedNames)
  } catch {
    // @swallow-ok Skip files that fail to parse
    return []
  }
}

/**
 * Check: quality/memo-list-items
 *
 * Warns when components rendered in .map() calls might benefit from memoization.
 * Detects custom components (PascalCase names, not built-in) rendered inside .map() calls.
 *
 * Smart exclusions to reduce false positives:
 * - Components wrapped in React.memo in the same file (AST-detected)
 * - Components with "Memoized" prefix (naming convention)
 * - .map() on static array literals (no re-render concern)
 * - JSX inside React.useMemo callbacks (already optimized)
 */
export const memoListItems = defineCheck({
  id: '515913c6-0076-4f53-9612-2adbd1b7d0d8',
  slug: 'memo-list-items',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Warn when components rendered in .map() calls might benefit from memoization',
  longDescription: `**Purpose:** Warns when custom components rendered inside \`.map()\` calls are not memoized, which can cause unnecessary re-renders in lists.

**Detects:** Analyzes each file individually using TypeScript AST traversal.
- PascalCase JSX components (excluding built-in React Native components like \`View\`, \`Text\`, \`Image\`, \`Pressable\`, etc.) that appear inside a \`.map()\` call expression
- Walks parent nodes to determine if a JSX element is nested within a \`.map()\` callback
- Uses a quick-filter optimization: skips files not containing \`.map(\`

**Smart exclusions (false-positive reduction):**
- Components wrapped in \`React.memo\` within the same file (detected via AST)
- Components whose name starts with \`Memoized\` (naming convention)
- \`.map()\` called on static array literals (e.g. \`[{...}].map(...)\` or \`Array.from({...}).map(...)\`)
- JSX inside \`React.useMemo\` callbacks (already render-optimized)

**Why it matters:** Unmemoized components in list renders re-create on every parent render, causing performance degradation especially in long scrollable lists.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'react-native', 'memoization'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
