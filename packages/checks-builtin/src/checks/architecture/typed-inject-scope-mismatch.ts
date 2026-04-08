/**
 * @fileoverview Typed-Inject Scope Mismatch check (v2)
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

interface ScopeMismatchIssue {
  file: string
  line: number
  type: 'singleton-depends-on-request' | 'scope-leak' | 'transient-with-state'
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  className?: string
  dependencyName?: string
}

/**
 * Options for checking singleton dependencies
 */
interface CheckSingletonDependenciesOptions {
  node: ts.ClassDeclaration
  sourceFile: ts.SourceFile
  filePath: string
  className: string
  issues: ScopeMismatchIssue[]
}

/**
 * Options for checking transient state
 */
interface CheckTransientStateOptions {
  node: ts.ClassDeclaration
  sourceFile: ts.SourceFile
  filePath: string
  className: string
  issues: ScopeMismatchIssue[]
}

/**
 * Patterns indicating singleton scope
 */
const SINGLETON_PATTERNS = [
  /@Singleton/,
  /@scope\s+singleton/i,
  /scope:\s*['"]singleton['"]/,
  /Scope\.Singleton/,
  /\.singleton\s*\(/,
]

/**
 * Patterns indicating request scope
 */
const REQUEST_SCOPE_PATTERNS = [
  /@RequestScoped/,
  /scope:\s*['"]request['"]/,
  /Scope\.Request/,
  /\.requestScoped\s*\(/,
]

/**
 * Known request-scoped service patterns
 */
const REQUEST_SCOPED_SERVICES = [
  /RequestContext/,
  /UserContext/,
  /SessionService/,
  /CurrentUser/,
  /TenantContext/,
]

/**
 * Check if a property is a mutable non-logger property (indicates state)
 * @param propText - The text of the property declaration
 * @returns True if the property is mutable and not a logger
 */
function isMutableNonLoggerProperty(propText: string): boolean {
  const isReadonly = propText.includes('readonly')
  const isStatic = propText.includes('static')
  const isPrivateOrProtected = propText.includes('private') || propText.includes('protected')
  const isLoggerType = propText.includes(': Logger') || propText.includes(': ILogger')

  return !isReadonly && !isStatic && isPrivateOrProtected && !isLoggerType
}

/**
 * Check singleton dependencies for scope mismatches
 * @param {CheckSingletonDependenciesOptions} options - The check options
 */
function checkSingletonDependencies(options: CheckSingletonDependenciesOptions): void {
  const { node, sourceFile, filePath, className, issues } = options

  // Validate array parameter
  if (!Array.isArray(issues)) {
    return
  }

  const classConstructor = node.members.find((m): m is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(m),
  )

  if (!classConstructor?.parameters) return

  for (const param of classConstructor.parameters) {
    const paramType = param.type?.getText(sourceFile) ?? ''
    const paramName = param.name.getText(sourceFile)

    const isRequestScopedDep = REQUEST_SCOPED_SERVICES.some((p) => p.test(paramType))

    if (isRequestScopedDep) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(param.getStart())
      issues.push({
        file: filePath,
        line: line + 1,
        type: 'singleton-depends-on-request',
        message: `Singleton '${className}' depends on request-scoped '${paramType}'`,
        suggestion:
          'Inject a factory or provider instead of the service directly, or change scope to request',
        severity: 'error',
        className,
        dependencyName: paramName,
      })
    }
  }
}

/**
 * Check transient state in services
 * @param {CheckTransientStateOptions} options - The check options
 */
function checkTransientState(options: CheckTransientStateOptions): void {
  const { node, sourceFile, filePath, className, issues } = options

  // Validate array parameter
  if (!Array.isArray(issues)) {
    return
  }

  const hasState = node.members.some((member) => {
    if (!ts.isPropertyDeclaration(member)) {
      return false
    }
    const propText = member.getText(sourceFile)
    return isMutableNonLoggerProperty(propText)
  })

  if (hasState && className.includes('Service')) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    issues.push({
      file: filePath,
      line: line + 1,
      type: 'transient-with-state',
      message: `Service '${className}' has mutable state but no scope defined`,
      suggestion: 'Add @Singleton decorator if state should persist, or make properties readonly',
      severity: 'warning',
      className,
    })
  }
}

/**
 * Quick check if file has any DI-related patterns
 * @param content - File content
 * @returns True if file appears to use typed-inject DI
 */
function hasDIPatterns(content: string): boolean {
  // Check for typed-inject imports or usage
  return (
    content.includes('typed-inject') ||
    content.includes('createInjector') ||
    content.includes('Scope.Singleton') ||
    content.includes('Scope.Transient') ||
    content.includes('provideClass') ||
    content.includes('provideValue') ||
    content.includes('provideFactory') ||
    content.includes('injectClass') ||
    SINGLETON_PATTERNS.some((p) => p.test(content)) ||
    REQUEST_SCOPE_PATTERNS.some((p) => p.test(content))
  )
}

function analyzeFileForDI(filePath: string, content: string): ScopeMismatchIssue[] {
  const issues: ScopeMismatchIssue[] = []

  const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.getText(sourceFile)
      const classText = node.getText(sourceFile)

      const isSingleton = SINGLETON_PATTERNS.some((p) => p.test(classText))
      const isRequestScoped = REQUEST_SCOPE_PATTERNS.some((p) => p.test(classText))

      if (isSingleton) {
        checkSingletonDependencies({ node, sourceFile, filePath, className, issues })
      }

      if (!isSingleton && !isRequestScoped) {
        checkTransientState({ node, sourceFile, filePath, className, issues })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return issues
}

/**
 * Check: architecture/typed-inject-scope-mismatch
 *
 * Detects dependency injection scope mismatches:
 * - Singleton depending on request-scoped
 * - Scope lifecycle violations
 */
export const typedInjectScopeMismatch = defineCheck({
  id: '343236c2-0585-449d-829c-fac0bc8966a1',
  slug: 'typed-inject-scope-mismatch',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'high',
  description:
    'Detects DI scope mismatches: singletons depending on request-scoped services, and transient services with mutable state',
  longDescription: `**Purpose:** Detects dependency injection scope lifecycle violations in typed-inject wiring that cause subtle runtime bugs.

**Detects:**
- Singleton classes depending on request-scoped types (\`RequestContext\`, \`UserContext\`, \`SessionService\`, \`CurrentUser\`, \`TenantContext\`)
- Service classes with mutable (non-readonly, non-static) private/protected properties but no scope decorator
- Scope patterns recognized: \`@Singleton\`, \`Scope.Singleton\`, \`scope: 'singleton'\`, \`.singleton()\`, and corresponding request-scoped variants

**Why it matters:** A singleton holding a reference to a request-scoped service gets a stale instance after the first request, causing data leaks between users.

**Scope:** Codebase-specific convention. Analyzes each file individually.`,
  tags: ['architecture', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip if no DI patterns
    if (!hasDIPatterns(content)) {
      return []
    }

    const issues = analyzeFileForDI(filePath, content)

    return issues.map((issue) => ({
      line: issue.line,
      message: `[${issue.type}] ${issue.message}. ${issue.suggestion}`,
      severity: issue.severity,
      suggestion: issue.suggestion,
      match: issue.className ?? issue.dependencyName ?? issue.type,
      type: issue.type,
    }))
  },
})
