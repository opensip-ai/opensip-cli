// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Detects mock, stub, or fake implementations in production code
 *
 * Mock implementations should only exist in test files, not production code.
 */

import { logger } from '@opensip-tools/core/logger'
import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Pre-compiled regex patterns for detecting mock implementations.
 * These patterns are intentional and safe for static code analysis.
 * Using explicit anchors and bounded quantifiers to prevent ReDoS.
 */
// Pattern: MockXxx or XxxMock class names (grouped for proper anchor precedence)
const MOCK_CLASS_PATTERN =
  /^(?:(?:Mock|Fake|Stub|Dummy)[A-Z]|[A-Z]\w{0,100}(?:Mock|Fake|Stub|Dummy))$/
// Pattern: mock/fake/stub/dummy method names
const MOCK_METHOD_PATTERN = /^(?:mock|fake|stub|dummy)/i
// Pattern: mock function names (grouped for proper anchor precedence)
const MOCK_FUNCTION_PATTERN = /^(?:(?:mock|fake|stub|dummy)[A-Z]|create(?:Mock|Fake|Stub|Dummy))/i
// Pattern: stub implementations that throw "Not implemented" errors
const STUB_IMPL_PATTERN = /throw new Error\(['"]Not implemented['"]\)/i
// Pattern: mock/test data returns - using bounded quantifier to prevent backtracking
const MOCK_DATA_PATTERN = /return\s{0,10}\{[^}]{0,500}\b(?:mock|test|fake)\s{0,10}:/i

/**
 * Check if a file should be analyzed for mock implementations
 * @param filePath - Path to check
 * @returns True if the file should be analyzed
 */
function shouldAnalyzeFile(filePath: string): boolean {
  logger.debug({
    evt: 'fitness.checks.mock_in_production.should_analyze_file',
    msg: 'Checking if file should be analyzed for mock implementations',
  })
  // Skip test files and test directories (mocks are allowed in tests)
  if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('__tests__/')) {
    return false
  }

  // Skip type definition files
  if (filePath.endsWith('.d.ts')) {
    return false
  }

  // Only check TypeScript files
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx')
}

/**
 * Analyze a file for mock implementations
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.mock_in_production.analyze_file',
    msg: 'Analyzing file for mock implementations',
  })
  const violations: CheckViolation[] = []

  if (!shouldAnalyzeFile(filePath)) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const checkClassForMock = (node: ts.ClassDeclaration): void => {
      logger.debug({
        evt: 'fitness.checks.mock_in_production.check_class_for_mock',
        msg: 'Checking class declaration for mock patterns',
      })
      if (!node.name) return

      const className = node.name.text

      // Check class name patterns
      if (MOCK_CLASS_PATTERN.test(className)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        violations.push({
          line: line + 1,
          message: `Mock class '${className}' found in production code (should be in test files only)`,
          severity: 'error',
          type: 'mock-class',
          suggestion: `Move '${className}' to a test file (e.g., __tests__/unit/) or test utilities directory`,
          match: className,
        })
        return
      }

      // Check if class has methods that return mock data
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          checkMethodForMock(member, className, sourceFile)
        }
      }
    }

    const checkMethodForMock = (
      member: ts.MethodDeclaration,
      className: string,
      sf: ts.SourceFile,
    ): void => {
      logger.debug({
        evt: 'fitness.checks.mock_in_production.check_method_for_mock',
        msg: 'Checking method declaration for mock patterns',
      })
      const methodName = (member.name as ts.Identifier).text

      // Check for mock/stub methods
      if (MOCK_METHOD_PATTERN.test(methodName)) {
        const { line } = sf.getLineAndCharacterOfPosition(member.getStart())
        violations.push({
          line: line + 1,
          message: `Mock method '${className}.${methodName}' found in production code`,
          severity: 'error',
          type: 'mock-function',
          suggestion: `Move '${methodName}' method to a test file or rename it to not use mock/fake/stub/dummy prefix`,
          match: methodName,
        })
      }

      // Check method body for stub implementations
      if (member.body) {
        const bodyText = member.body.getText(sf)

        // Check for "Not implemented" stub patterns
        if (STUB_IMPL_PATTERN.test(bodyText)) {
          const { line } = sf.getLineAndCharacterOfPosition(member.getStart())
          violations.push({
            line: line + 1,
            message: `Stub implementation in '${className}.${methodName}' (throws "Not implemented")`,
            severity: 'error',
            type: 'stub-implementation',
            suggestion: `Implement the method '${methodName}' properly or move stub to test files if it's for testing only`,
            match: `${className}.${methodName}`,
          })
        }

        // Check for methods that always return mock data
        if (MOCK_DATA_PATTERN.test(bodyText)) {
          const { line } = sf.getLineAndCharacterOfPosition(member.getStart())
          violations.push({
            line: line + 1,
            message: `Method '${className}.${methodName}' returns hardcoded mock/test data`,
            severity: 'error',
            type: 'fake-data',
            suggestion: `Replace hardcoded mock/test data in '${methodName}' with real implementation or move to test files`,
            match: `${className}.${methodName}`,
          })
        }
      }
    }

    const checkFunctionForMock = (node: ts.FunctionDeclaration): void => {
      logger.debug({
        evt: 'fitness.checks.mock_in_production.check_function_for_mock',
        msg: 'Checking function declaration for mock patterns',
      })
      if (!node.name) return

      const functionName = node.name.text

      // Check function name patterns
      if (MOCK_FUNCTION_PATTERN.test(functionName)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        violations.push({
          line: line + 1,
          message: `Mock function '${functionName}' found in production code (should be in test utilities only)`,
          severity: 'error',
          type: 'mock-function',
          suggestion: `Move '${functionName}' to a test file (e.g., __tests__/unit/) or test utilities directory`,
          match: functionName,
        })
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        checkClassForMock(node)
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        checkFunctionForMock(node)
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok If AST parsing fails, skip this file
  }

  return violations
}

/**
 * Check: testing/mock-implementations-in-production
 *
 * Detects mock, stub, or fake implementations in production code.
 */
export const mockImplementationsInProduction = defineCheck({
  id: 'f7507280-993b-4dde-9270-52b30478cca8',
  slug: 'mock-implementations-in-production',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects mock, stub, or fake implementations in production code',
  longDescription: `**Purpose:** Ensures mock, stub, fake, and dummy implementations exist only in test files, not in production source code.

**Detects:**
- Classes named with Mock/Fake/Stub/Dummy prefixes or suffixes via \`/^(?:(?:Mock|Fake|Stub|Dummy)[A-Z]|[A-Z]\\w{0,100}(?:Mock|Fake|Stub|Dummy))$/\`
- Methods prefixed with mock/fake/stub/dummy via \`/^(?:mock|fake|stub|dummy)/i\`
- Functions named \`mockXxx\`, \`fakeXxx\`, \`createMock\`, \`createFake\`, etc. via \`/^(?:(?:mock|fake|stub|dummy)[A-Z]|create(?:Mock|Fake|Stub|Dummy))/i\`
- Stub methods that \`throw new Error('Not implemented')\`
- Methods returning hardcoded objects with \`mock\`, \`test\`, or \`fake\` keys

**Why it matters:** Mock implementations in production code indicate incomplete refactoring or testing artifacts leaking into shipped code, leading to unreliable runtime behavior.

**Scope:** General best practice. Analyzes each file individually via TypeScript AST parsing, skipping test files, \`.d.ts\` files, and excluded test directories.`,
  tags: ['testing', 'code-quality'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
