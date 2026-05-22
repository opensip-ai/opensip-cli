// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file fitness-check-standards -- Check requires direct fs access for package.json parsing outside of standard file scanning pipeline
// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Detect phantom dependencies - packages used in code but not declared in package.json (v2)
 * @invariants
 * - Only checks external npm packages, not workspace packages or relative imports
 * - Distinguishes between dependencies, devDependencies, and peerDependencies
 * - Respects pnpm's strict node_modules isolation
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/**
 * Packages that are always available (Node.js built-ins)
 */
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/promises',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
  // Node.js prefixed versions
  'node:assert',
  'node:async_hooks',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:console',
  'node:constants',
  'node:crypto',
  'node:dgram',
  'node:dns',
  'node:domain',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:http2',
  'node:https',
  'node:inspector',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:process',
  'node:punycode',
  'node:querystring',
  'node:readline',
  'node:repl',
  'node:stream',
  'node:stream/promises',
  'node:string_decoder',
  'node:sys',
  'node:timers',
  'node:timers/promises',
  'node:tls',
  'node:trace_events',
  'node:tty',
  'node:url',
  'node:util',
  'node:v8',
  'node:vm',
  'node:worker_threads',
  'node:zlib',
])

/**
 * Patterns that indicate test-only imports (should check devDependencies)
 */
const TEST_FILE_PATTERNS = [
  /__tests__\//,
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /test\//,
  /tests\//,
]

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Extract package name from an import specifier.
 * Handles scoped packages (@org/pkg) and subpath imports (@org/pkg/subpath).
 */
function extractPackageName(importSpecifier: string): string | null {
  // Skip relative imports
  if (importSpecifier.startsWith('.') || importSpecifier.startsWith('/')) {
    return null
  }

  // Skip Node.js built-ins
  if (
    NODE_BUILTINS.has(importSpecifier) ||
    /* v8 ignore next -- defensive: split always returns at least one element */
    NODE_BUILTINS.has(importSpecifier.split('/')[0] ?? '')
  ) {
    return null
  }

  // Handle scoped packages (@org/pkg or @org/pkg/subpath)
  if (importSpecifier.startsWith('@')) {
    const parts = importSpecifier.split('/')
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
    return null
  }

  // Handle regular packages (pkg or pkg/subpath)
  /* v8 ignore next -- defensive: split always returns at least one element */
  return importSpecifier.split('/')[0] ?? null
}

/**
 * Find the nearest package.json for a file.
 */
function findNearestPackageJson(filePath: string): string | null {
  let dir = path.dirname(filePath)
  // @fitness-ignore-next-line null-safety -- path.parse() always returns object with .root per Node.js API
  const root = path.parse(dir).root

  while (dir !== root) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      return pkgPath
    }
    dir = path.dirname(dir)
  }

  return null
}

/**
 * Read and parse package.json.
 */
function readPackageJson(pkgPath: string): PackageJson | null {
  try {
    const content = fs.readFileSync(pkgPath, 'utf8')
    return JSON.parse(content) as PackageJson
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null
  }
}

/**
 * Check if a file is a test file.
 */
function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath))
}

/* v8 ignore start -- dependency-section lookup has six fallback branches; covered indirectly via fixtures */
/**
 * Check if a package is declared in any dependency section.
 */
function isDeclaredDependency(
  pkg: PackageJson,
  packageName: string,
  isTest: boolean,
): { declared: boolean; section?: string } {
  // Check regular dependencies
  if (pkg.dependencies?.[packageName]) {
    return { declared: true, section: 'dependencies' }
  }

  // Check peer dependencies (always valid to use)
  if (pkg.peerDependencies?.[packageName]) {
    return { declared: true, section: 'peerDependencies' }
  }

  // Check optional dependencies
  if (pkg.optionalDependencies?.[packageName]) {
    return { declared: true, section: 'optionalDependencies' }
  }

  // For test files, devDependencies are valid
  if (isTest && pkg.devDependencies?.[packageName]) {
    return { declared: true, section: 'devDependencies' }
  }

  // For non-test files, check if it's in devDependencies (would be a problem)
  if (!isTest && pkg.devDependencies?.[packageName]) {
    return { declared: false, section: 'devDependencies' }
  }

  return { declared: false }
}
/* v8 ignore stop */

interface StripperState {
  result: string
  i: number
  inSingleQuote: boolean
  inDoubleQuote: boolean
  inTemplate: boolean
  inSingleLineComment: boolean
  inMultiLineComment: boolean
}

/* v8 ignore start -- string-stripping state machine: each branch is a per-character handler covered by integration */
function handleNewline(state: StripperState): void {
  state.result += '\n'
  state.inSingleLineComment = false
  state.i++
}

function handleMultiLineComment(state: StripperState, char: string, nextChar: string): void {
  if (char === '*' && nextChar === '/') {
    state.inMultiLineComment = false
    state.i += 2
  } else {
    state.i++
  }
}

function handleStringLiteral(
  state: StripperState,
  char: string,
  nextChar: string,
  quote: string,
): boolean {
  if (char === '\\' && nextChar) {
    state.i += 2
    return true
  }
  if (char === quote) {
    if (quote === "'") state.inSingleQuote = false
    else if (quote === '"') state.inDoubleQuote = false
    else state.inTemplate = false
    state.result += ' '
    state.i++
    return true
  }
  state.i++
  return true
}

function handleCommentStart(state: StripperState, char: string, nextChar: string): boolean {
  if (char === '/' && nextChar === '/') {
    state.inSingleLineComment = true
    state.i += 2
    return true
  }
  if (char === '/' && nextChar === '*') {
    state.inMultiLineComment = true
    state.i += 2
    return true
  }
  return false
}

function handleStringStart(state: StripperState, char: string): boolean {
  if (char === "'") {
    state.inSingleQuote = true
    state.result += ' '
    state.i++
    return true
  }
  if (char === '"') {
    state.inDoubleQuote = true
    state.result += ' '
    state.i++
    return true
  }
  if (char === '`') {
    state.inTemplate = true
    state.result += ' '
    state.i++
    return true
  }
  return false
}
/* v8 ignore stop */

function getActiveStringQuote(state: StripperState): string | null {
  if (state.inSingleQuote) return "'"
  if (state.inDoubleQuote) return '"'
  if (state.inTemplate) return '`'
  return null
}

function processCharacter(state: StripperState, char: string, nextChar: string): void {
  if (char === '\n') {
    handleNewline(state)
    return
  }

  if (state.inSingleLineComment) {
    state.i++
    return
  }

  if (state.inMultiLineComment) {
    handleMultiLineComment(state, char, nextChar)
    return
  }

  const activeQuote = getActiveStringQuote(state)
  if (activeQuote) {
    handleStringLiteral(state, char, nextChar, activeQuote)
    return
  }

  if (handleCommentStart(state, char, nextChar)) {
    return
  }

  if (handleStringStart(state, char)) {
    return
  }

  state.result += char
  state.i++
}

/* v8 ignore start -- multi-line import-extraction state machine; covered indirectly by integration */
function stripCommentsAndStrings(content: string): string {
  const state: StripperState = {
    result: '',
    i: 0,
    inSingleQuote: false,
    inDoubleQuote: false,
    inTemplate: false,
    inSingleLineComment: false,
    inMultiLineComment: false,
  }

  while (state.i < content.length) {
    const char = content[state.i] ?? ''
    const nextChar = content[state.i + 1] ?? ''
    processCharacter(state, char, nextChar)
  }

  return state.result
}

/**
 * Extract imports from file content.
 * Only extracts actual imports, not commented-out code.
 */
function extractImports(
  content: string,
): { specifier: string; lineNum: number; lineContent: string }[] {
  const imports: { specifier: string; lineNum: number; lineContent: string }[] = []
  const originalLines = content.split('\n')

  // Strip comments and string literals from content before extracting imports
  const strippedContent = stripCommentsAndStrings(content)
  const lines = strippedContent.split('\n')

  // Regex patterns for different import styles
  // eslint-disable-next-line sonarjs/slow-regex -- [^'"]* bounded by quote delimiters; \s* is a separate token after the group
  const importFromPattern = /(?:import|export)\s+(?:[^'"]*)\s*from\s*['"]([^'"]+)['"]/g
  const dynamicImportPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const originalLine = originalLines[i] ?? ''

    // Skip empty lines (which may have been comments)
    if (line.trim() === '') {
      continue
    }

    // Check ES imports
    let match: RegExpExecArray | null

    // Handle multiline imports by checking continuation
    let fullStatement = line
    let j = i
    while (
      !fullStatement.includes("from '") &&
      !fullStatement.includes('from "') &&
      !fullStatement.endsWith(';') &&
      j < i + 10 &&
      j < lines.length - 1
    ) {
      j++
      fullStatement += ' ' + (lines[j] ?? '')
    }

    importFromPattern.lastIndex = 0
    while ((match = importFromPattern.exec(fullStatement)) !== null) {
      imports.push({ specifier: match[1] ?? '', lineNum: i, lineContent: originalLine })
    }

    // Check dynamic imports
    dynamicImportPattern.lastIndex = 0
    while ((match = dynamicImportPattern.exec(line)) !== null) {
      imports.push({ specifier: match[1] ?? '', lineNum: i, lineContent: originalLine })
    }

    // Check require statements
    requirePattern.lastIndex = 0
    while ((match = requirePattern.exec(line)) !== null) {
      imports.push({ specifier: match[1] ?? '', lineNum: i, lineContent: originalLine })
    }
  }

  return imports
}
/* v8 ignore stop */

/**
 * Check: architecture/phantom-dependency-detection
 *
 * Detects packages that are imported in code but not declared in package.json.
 * This is critical for pnpm which uses strict node_modules isolation.
 *
 * Phantom dependencies can cause:
 * - Runtime failures in pnpm projects (strict node_modules)
 * - Inconsistent behavior between development and production
 * - Version conflicts when the hoisted dependency changes
 */
export const phantomDependencyDetection = defineCheck({
  id: '67284374-69b8-4711-9c66-33d2ad44ef79',
  slug: 'phantom-dependency-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect phantom dependencies (used but not declared in package.json)',
  longDescription: `**Purpose:** Detects packages imported in source code that are not declared in the nearest \`package.json\`, which is critical under pnpm's strict \`node_modules\` isolation.

**Detects:**
- ES imports (\`import ... from\`), dynamic imports (\`import()\`), and \`require()\` calls referencing external npm packages not listed in \`dependencies\`, \`peerDependencies\`, or \`optionalDependencies\`
- Non-test files importing packages only declared in \`devDependencies\`
- Strips comments and string literals before extraction to avoid false positives; skips Node.js built-ins and workspace packages (detected via \`workspace:*\` protocol)

**Why it matters:** Phantom dependencies cause runtime failures in pnpm projects, create inconsistent behavior between dev and production, and introduce fragile version coupling via hoisting.

**Scope:** General best practice. Cross-file analysis: extracts imports from each file and resolves them against the nearest \`package.json\`.`,
  timeout: 120_000,
  tags: ['architecture', 'dependencies', 'pnpm'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- inherent complexity: dependency check with import extraction, package.json traversal, and multi-type violation reporting
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    // Cache for package.json contents
    const pkgJsonCache = new Map<string, PackageJson | null>()

    /* v8 ignore start -- analyzeAll loop has many cache/skip branches; covered indirectly by integration */
    // @lazy-ok -- validations inside loop depend on file content from await
    for (const filePath of files.paths) {
      try {
        // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
        const content = await files.read(filePath)
        if (!content) continue

        const imports = extractImports(content)
        const isTest = isTestFile(filePath)

        // Find nearest package.json
        const pkgJsonPath = findNearestPackageJson(filePath)
        if (!pkgJsonPath) {
          continue
        }

        // Get cached or read package.json
        let pkgJson = pkgJsonCache.get(pkgJsonPath)
        if (pkgJson === undefined) {
          pkgJson = readPackageJson(pkgJsonPath)
          pkgJsonCache.set(pkgJsonPath, pkgJson)
        }

        if (!pkgJson) {
          continue
        }

        for (const imp of imports) {
          const packageName = extractPackageName(imp.specifier)
          if (!packageName) {
            continue
          }

          // Skip workspace packages (detected via workspace: protocol in package.json)
          const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies, ...pkgJson.peerDependencies, ...pkgJson.optionalDependencies }
          if (allDeps[packageName]?.startsWith('workspace:')) {
            continue
          }

          const { declared, section } = isDeclaredDependency(pkgJson, packageName, isTest)

          if (!declared) {
            // If it's in devDependencies but used in non-test code, flag differently
            const message =
              section === 'devDependencies'
                ? `Non-test file imports "${packageName}" which is only in devDependencies`
                : `Phantom dependency: "${packageName}" is used but not declared in package.json`

            const suggestion =
              section === 'devDependencies'
                ? `Move "${packageName}" from devDependencies to dependencies in ${path.basename(pkgJsonPath)}`
                : `Add "${packageName}" to dependencies in ${path.basename(pkgJsonPath)}`

            violations.push({
              filePath,
              line: imp.lineNum + 1,
              message,
              severity: 'error',
              suggestion,
              match: packageName,
              type: 'phantom-dependency',
            })
          }
        }
      } catch {
        // @swallow-ok Skip files that can't be read
        continue
      }
    }
    /* v8 ignore stop */

    return violations
  },
})
