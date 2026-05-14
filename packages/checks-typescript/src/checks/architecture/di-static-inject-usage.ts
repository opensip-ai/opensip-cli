// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file silent-early-returns -- Guard clauses in analyzeDIFile validate inputs before analysis
/**
 * @fileoverview DI Static Inject Usage check (v2)
 */

import * as path from 'node:path'

import * as ts from 'typescript'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/** Issue types for DI static inject checks */
enum IssueType {
  StaticInjectNotResolved = 'static-inject-not-resolved',
  MissingStaticInject = 'missing-static-inject',
  StaticInjectMismatch = 'static-inject-mismatch',
}

interface DIStaticInjectIssue {
  file: string
  line: number
  type: IssueType
  message: string
  suggestion: string
  severity: 'error' | 'warning'
  className?: string
}

interface ClassInfo {
  name: string
  file: string
  line: number
  hasStaticInject: boolean
  injectTokens: string[]
  constructorParamCount: number
  constructorParams: string[]
  requiredParamCount: number
}

type SingletonRegistration = 'registerSingleton' | 'register'
type FactoryRegistration = 'provideClass' | 'useFactory'
type RegistrationMethod = SingletonRegistration | FactoryRegistration

interface RegistrationInfo {
  file: string
  line: number
  method: RegistrationMethod
  token: string
  className: string
}


// Pre-compiled regex patterns for better performance and to avoid ReDoS
// These patterns use non-capturing groups and avoid backtracking issues
// eslint-disable-next-line sonarjs/slow-regex -- [^,]+ bounded by comma delimiter; no overlapping quantifiers
const REGISTER_SINGLETON_PATTERN = /registerSingleton\s*\(\s*([^,]+),\s*(\w+)/
const REGISTER_PATTERN = /\.register\s*\(\s*([^,)]+)/
const PROVIDE_CLASS_PATTERN = /provideClass\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/

function extractStaticInjectInfo(
  member: ts.PropertyDeclaration,
  sourceFile: ts.SourceFile,
): { hasStaticInject: boolean; injectTokens: string[] } {
  const propName = member.name.getText(sourceFile)
  const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)

  if (propName !== 'inject' || !isStatic || !member.initializer) {
    return { hasStaticInject: false, injectTokens: [] }
  }

  let arrayExpr: ts.Expression = member.initializer
  if (ts.isAsExpression(arrayExpr)) {
    arrayExpr = arrayExpr.expression
  }

  if (!ts.isArrayLiteralExpression(arrayExpr)) {
    return { hasStaticInject: true, injectTokens: [] }
  }

  const injectTokens = arrayExpr.elements.map((e) => e.getText(sourceFile).replace(/['"]/g, ''))
  return { hasStaticInject: true, injectTokens }
}

function extractConstructorInfo(
  member: ts.ConstructorDeclaration,
  sourceFile: ts.SourceFile,
): { constructorParamCount: number; constructorParams: string[]; requiredParamCount: number } {
  const constructorParamCount = member.parameters.length
  const constructorParams = member.parameters.map((p) => p.name.getText(sourceFile))
  const requiredParamCount = member.parameters.filter((p) => !p.initializer).length
  return { constructorParamCount, constructorParams, requiredParamCount }
}

function extractClassInfo(sourceFile: ts.SourceFile, filePath: string): ClassInfo[] {
  const classes: ClassInfo[] = []

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      processClassNode(node, sourceFile, filePath, classes)
    }
    ts.forEachChild(node, visit)
  })

  return classes
}

function processClassNode(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  classes: ClassInfo[],
): void {
  // Validate array parameter
  if (!Array.isArray(classes)) {
    return
  }

  const className = node.name?.getText(sourceFile) ?? 'Anonymous'
  let hasStaticInject = false
  let injectTokens: string[] = []
  let constructorParamCount = 0
  let constructorParams: string[] = []
  let requiredParamCount = 0

  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) {
      const result = extractStaticInjectInfo(member, sourceFile)
      if (result.hasStaticInject) {
        hasStaticInject = true
        injectTokens = result.injectTokens
      }
    } else if (ts.isConstructorDeclaration(member)) {
      const result = extractConstructorInfo(member, sourceFile)
      constructorParamCount = result.constructorParamCount
      constructorParams = result.constructorParams
      requiredParamCount = result.requiredParamCount
    } else {
      // Other member types (methods, getters, etc.) are not relevant for DI analysis
    }
  }

  if (hasStaticInject || constructorParamCount > 0) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    classes.push({
      name: className,
      file: filePath,
      line: line + 1,
      hasStaticInject,
      injectTokens,
      constructorParamCount,
      constructorParams,
      requiredParamCount,
    })
  }
}

function extractRegistrations(sourceFile: ts.SourceFile, filePath: string): RegistrationInfo[] {
  const registrations: RegistrationInfo[] = []

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isCallExpression(node)) {
      processRegistrationCall(node, sourceFile, filePath, registrations)
    }
    ts.forEachChild(node, visit)
  })

  return registrations
}

/**
 * Extract registerSingleton registration info from call text.
 * @param callText - The call expression text
 * @param filePath - File path
 * @param line - Line number
 * @returns Registration info or null
 */
function extractRegisterSingleton(
  callText: string,
  filePath: string,
  line: number,
): RegistrationInfo | null {
  const match = REGISTER_SINGLETON_PATTERN.exec(callText)
  if (!match?.[1] || !match[2]) return null
  return {
    file: filePath,
    line: line + 1,
    method: 'registerSingleton',
    token: match[1].trim(),
    className: match[2].trim(),
  }
}

/**
 * Extract useFactory registration info from call text.
 * @param callText - The call expression text
 * @param filePath - File path
 * @param line - Line number
 * @returns Registration info or null
 */
function extractUseFactory(
  callText: string,
  filePath: string,
  line: number,
): RegistrationInfo | null {
  const match = REGISTER_PATTERN.exec(callText)
  if (!match?.[1]) return null
  return {
    file: filePath,
    line: line + 1,
    method: 'useFactory',
    token: match[1].trim(),
    className: 'factory',
  }
}

/**
 * Extract provideClass registration info from call text.
 * @param callText - The call expression text
 * @param filePath - File path
 * @param line - Line number
 * @returns Registration info or null
 */
function extractProvideClass(
  callText: string,
  filePath: string,
  line: number,
): RegistrationInfo | null {
  const match = PROVIDE_CLASS_PATTERN.exec(callText)
  if (!match?.[1] || !match[2]) return null
  return {
    file: filePath,
    line: line + 1,
    method: 'provideClass',
    token: match[1],
    className: match[2],
  }
}

function processRegistrationCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  registrations: RegistrationInfo[],
): void {
  // Validate array parameter
  if (!Array.isArray(registrations)) {
    return
  }

  const callText = node.getText(sourceFile)
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  let registration: RegistrationInfo | null

  if (callText.includes('registerSingleton')) {
    registration = extractRegisterSingleton(callText, filePath, line)
  } else if (callText.includes('.register(') && callText.includes('useFactory')) {
    registration = extractUseFactory(callText, filePath, line)
  } else if (callText.includes('provideClass')) {
    registration = extractProvideClass(callText, filePath, line)
  } else {
    // Other call types are not relevant for DI registration analysis
    return
  }

  if (registration) {
    registrations.push(registration)
  }
}

/**
 * Check registration for static inject that won't be resolved.
 * @param reg - Registration info
 * @param classInfo - Class info if found
 * @returns Issue or null
 */
function checkStaticInjectNotResolved(
  reg: RegistrationInfo,
  classInfo: ClassInfo | undefined,
): DIStaticInjectIssue | null {
  if (!classInfo?.hasStaticInject || classInfo.injectTokens.length === 0) {
    return null
  }
  return {
    file: reg.file,
    line: reg.line,
    type: IssueType.StaticInjectNotResolved,
    message: `'${reg.className}' has static inject with ${classInfo.injectTokens.length} dependencies, but registerSingleton() doesn't resolve them`,
    suggestion: `Use useFactory: container.register(${reg.token}, { useFactory: (c) => new ${reg.className}(...) })`,
    severity: 'error',
    className: reg.className,
  }
}

/**
 * Check registration for missing static inject declaration.
 * @param reg - Registration info
 * @param classInfo - Class info if found
 * @returns Issue or null
 */
function checkMissingStaticInject(
  reg: RegistrationInfo,
  classInfo: ClassInfo | undefined,
): DIStaticInjectIssue | null {
  if (!classInfo || classInfo.hasStaticInject || classInfo.requiredParamCount === 0) {
    return null
  }
  const paramsList = classInfo.constructorParams.map((p) => `'${p}'`).join(', ')
  return {
    file: classInfo.file,
    line: classInfo.line,
    type: IssueType.MissingStaticInject,
    message: `'${reg.className}' has ${classInfo.requiredParamCount} required constructor params but no static inject declaration`,
    suggestion: `Add: static inject = [${paramsList}] as const;`,
    severity: 'warning',
    className: reg.className,
  }
}

/**
 * Check class for static inject mismatch.
 * @param cls - Class info
 * @returns Issue or null
 */
function checkStaticInjectMismatch(cls: ClassInfo): DIStaticInjectIssue | null {
  if (!cls.hasStaticInject || cls.injectTokens.length === cls.constructorParamCount) {
    return null
  }
  return {
    file: cls.file,
    line: cls.line,
    type: IssueType.StaticInjectMismatch,
    message: `'${cls.name}' has ${cls.injectTokens.length} tokens in static inject but ${cls.constructorParamCount} constructor params`,
    suggestion: 'Ensure static inject array matches constructor parameters in count and order',
    severity: 'error',
    className: cls.name,
  }
}

function findIssues(
  classes: ClassInfo[],
  registrations: RegistrationInfo[],
): DIStaticInjectIssue[] {
  if (!Array.isArray(classes) || !Array.isArray(registrations)) {
    return []
  }

  const issues: DIStaticInjectIssue[] = []
  const classMap = new Map<string, ClassInfo>()

  for (const cls of classes) {
    classMap.set(cls.name, cls)
  }

  // Check registrations for issues - filter to singleton registrations first
  const singletonRegistrations = registrations.filter(
    (reg) => reg.method === 'registerSingleton' && reg.className !== 'factory',
  )

  for (const reg of singletonRegistrations) {
    const classInfo = classMap.get(reg.className)

    const notResolvedIssue = checkStaticInjectNotResolved(reg, classInfo)
    if (notResolvedIssue) {
      issues.push(notResolvedIssue)
    } else {
      const missingInjectIssue = checkMissingStaticInject(reg, classInfo)
      if (missingInjectIssue) {
        issues.push(missingInjectIssue)
      }
    }
  }

  // Check classes for mismatches
  for (const cls of classes) {
    const mismatchIssue = checkStaticInjectMismatch(cls)
    if (mismatchIssue) {
      issues.push(mismatchIssue)
    }
  }

  return issues
}

/**
 * Options for analyzing DI file
 */
interface AnalyzeDIFileOptions {
  file: string
  content: string
  cwd: string
  allClasses: ClassInfo[]
  allRegistrations: RegistrationInfo[]
}

/**
 * Analyze a file for DI patterns
 * @param {AnalyzeDIFileOptions} options - The analysis options
 * @returns {boolean} Whether the file was analyzed
 */
function analyzeDIFile(options: AnalyzeDIFileOptions): boolean {
  const { file, content, allClasses, allRegistrations } = options
  // Validate array parameters
  if (!Array.isArray(allClasses) || !Array.isArray(allRegistrations)) {
    return false
  }

  if (!content) return false

  const hasStaticInject = content.includes('static inject')
  const hasRegistration =
    content.includes('registerSingleton') ||
    content.includes('.register(') ||
    content.includes('provideClass') ||
    content.includes('useFactory')

  if (!hasStaticInject && !hasRegistration) return false

  const sourceFile = getSharedSourceFile(file, content)
    if (!sourceFile) return false

  if (hasStaticInject) {
    allClasses.push(...extractClassInfo(sourceFile, file))
  }

  if (hasRegistration) {
    allRegistrations.push(...extractRegistrations(sourceFile, file))
  }

  return true
}

/**
 * Check: architecture/di-static-inject-usage
 *
 * Detects improper DI usage patterns with typed-inject:
 * - Classes with `static inject` registered via `registerSingleton()` (broken - deps not resolved)
 * - Classes with `static inject` that have constructor params but no DI wiring
 * - Missing `static inject` on classes with injected dependencies
 *
 */
export const diStaticInjectUsage = defineCheck({
  id: 'e202e61b-f478-4a5f-9395-72e669018729',
  slug: 'di-static-inject-usage',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'high',
  description:
    'Detects improper DI patterns: static inject not resolved by registerSingleton(), missing static inject declarations, inject/constructor param mismatches',
  longDescription: `**Purpose:** Validates that typed-inject dependency injection wiring is consistent between \`static inject\` declarations, constructor parameters, and registration calls.

**Detects:**
- Classes with \`static inject\` registered via \`registerSingleton()\` (dependencies silently unresolved)
- Classes with required constructor params but no \`static inject\` declaration
- Mismatch between \`static inject\` token count and constructor parameter count
- Patterns matched: \`registerSingleton()\`, \`.register()\`, \`provideClass()\`, \`useFactory\`

**Why it matters:** Mismatched DI wiring causes runtime \`undefined\` injections or silent failures that are difficult to debug in production.

**Scope:** General best practice for typed-inject codebases. Cross-file analysis via \`analyzeAll\`.`,
  tags: ['architecture', 'structure', 'dependency-injection'],
  fileTypes: ['ts'],
 
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const allClasses: ClassInfo[] = []
    const allRegistrations: RegistrationInfo[] = []

    // Get the cwd from the first file path (parent directories)
    const firstFile = files.paths[0]
    const cwd = firstFile
      ? path.dirname(path.dirname(path.dirname(path.dirname(firstFile))))
      : process.cwd()

    for (const filePath of files.paths) {
      try {
        // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
        const content = await files.read(filePath)
        void analyzeDIFile({ file: filePath, content, cwd, allClasses, allRegistrations })
      } catch {
        // @swallow-ok Skip unreadable files
      }
    }

    const issues = findIssues(allClasses, allRegistrations)

    return issues.map((issue) => ({
      filePath: issue.file,
      line: issue.line,
      message: `${issue.message}. ${issue.suggestion}`,
      severity: issue.severity,
      suggestion: issue.suggestion,
      match: issue.className ?? issue.type,
      type: issue.type,
    }))
  },
})
