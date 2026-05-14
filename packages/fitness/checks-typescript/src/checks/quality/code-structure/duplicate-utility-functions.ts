// @fitness-ignore-file throws-documentation -- Functions throw self-documenting typed errors
// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Duplicate Utility Functions check
 *
 * Detects duplicate utility functions that should be consolidated.
 * Flags TWO types of issues:
 * 1. Identical implementations - true duplicates that must be deduplicated
 * 2. Same-named functions with different implementations - consolidation opportunities
 */

import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'


import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Common utility function name patterns
 */
const UTILITY_PATTERNS = [
  /^format[A-Z]/, // formatDate, formatCurrency
  /^parse[A-Z]/, // parseJson, parseDate
  /^is[A-Z]/, // isValid, isEmpty
  /^has[A-Z]/, // hasValue, hasKey
  /^to[A-Z]/, // toString, toNumber
  /^get[A-Z]/, // getValue, getDefault
  /^validate[A-Z]/, // validateEmail, validatePhone
  /^sanitize[A-Z]/, // sanitizeInput, sanitizeHtml
  /^normalize[A-Z]/, // normalizeUrl, normalizeText
  /^debounce/,
  /^throttle/,
  /^sleep/,
  /^delay/,
  /^retry/,
  /^clamp/,
  /^range/,
  /^chunk/,
  /^unique/,
  /^flatten/,
]

/**
 * Minimum function body length (characters) to consider for duplicate detection.
 * Very short functions (1-2 lines) are often trivial and not worth flagging.
 */
const MIN_FUNCTION_BODY_LENGTH = 50

/**
 * Functions that are intentionally domain-specific and should NOT be flagged.
 * These have different implementations by design (configuration, factory, validation per domain).
 */
const DOMAIN_SPECIFIC_FUNCTIONS = new Set([
  // Config/factory pattern - each domain has its own configuration
  'getConfig',
  'getDefaultConfig',
  'getContainer',
  'getFactory',

  // Domain-specific getters for singletons/managers
  'getLogger',
  'getContextManager',
  'getPerformanceMonitor',
  'getObservabilitySystem',
  'getRecommendedProvider',

  // Registry/scenario patterns - domain-specific registries
  'getRegisteredScenarios',
  'getAllRecipes',
  'getScenario',
  'getScenariosByTag',

  // Validation functions that are domain-specific by design
  'validateClaims',
  'validateConfig',
  'validateProvider',
  'validateKey',
  'validateAssertions',
  'validateRequiredFields',
  'validateOptionalFields',
  'validateUserId',
  'validateCurrencyCode',

  // Domain-specific parsers/formatters
  'parseArgs',
  'parseToken',
  'parseEnvInteger',

  // Domain-specific helpers that have intentional differences
  'getSuggestion',
  'getSeverity',
  'getContext',
  'getDefaultLogDir',
  'getProjectRoot',
  'getIdPrefix',
  'getErrorMessage',

  // Security/crypto - intentionally different implementations
  'isDisposable',
  'isDangerousKey',

  // Validation - different validation rules per domain/context
  'isValidEmail',
  'isValidUserId',
  'validateEnvString',

  // File utilities - different patterns per context
  'isSourceFile',

  // Currency/formatting - domain-specific formatting rules
  'formatCurrency',

  // Fitness check selectors - each selector type has its own validation logic
  'validateCheckSelector',
  'validateExcludeField',
  'validateExplicitSelector',
  'validatePatternSelector',
  'validateCategorySelector',
  'validateAllSelector',
  'validateRecipe',
  'validateUserRecipe',

  // Schema/cache/config validation - domain-specific validation rules
  'validateSchema',
  'validateCacheConfig',
  'validateCacheTTL',
  'validateValueSize',
  'validateCorrelationId',
  'validateIdField',
  'validatePersona',
  'validateRampUp',

  // Simulation/fingerprint validation - scenario-specific validation
  'validateDuplicates',
  'validateScenarioConfig',
  'validateBucketParams',
  'validateBucketsArrayParams',
  'validateFingerprintsParams',
  'validateRegressionParams',

  // Tag validation - domain-specific tag/label rules
  'validateTags',
  'validateTagsAndLabels',

  // Presentation/format functions - each module formats its own domain objects
  // NOTE: formatDuration was removed from this list — it's a generic utility, not domain-specific
  'formatZodError',
  'formatResolutionInfo',
  'formatCancelInfo',
  'formatTicketBasicInfo',
  'formatCodeSnippet',
  'formatSingleFinding',
  'formatFindingsList',
  'formatAffectedFilesSummary',
  'formatFitnessDetails',
  'formatTicket',
  'formatDate',
  'formatTable',
  'formatUserRecipeWarnings',
  'formatTicketTitle',
  'formatTicketStatus',
  'formatTicketSeverity',
  'formatTicketId',
  'formatTicketAsMarkdown',
  'formatTicketFitnessInfo',
  'formatTicketListEntry',
  'formatTicketTable',
  'formatTicketList',

  // Domain-specific getters - presentation/display helpers
  'getCheckIcon',
  'getCheckDisplayName',
  'getScoreEmoji',

  // User repository getters - different query strategies per lookup type
  'getUserById',
  'getUserByUsername',
  'getUserByEmail',

  // Config resolution getters - different resolution strategies
  'getConfigValue',
  'getConfigValueSync',
  'getFullConfigSync',

  // Source analysis getters
  'getLineNumber',

  // Type guards - domain-specific type narrowing
  'isPlainObject',
  'isStringArray',
  'isCommentLine',
  'isTestFile',
  'isValidModuleEntry',

  // Normalization - domain-specific normalization rules
  'normalizeMessage',
  'normalizeCodeSnippet',

  // Git/branch utilities - intentionally separate implementations
  'getCurrentBranch',

  // Cache utilities - domain-specific cache management
  'hasCachedConfig',
  'getCachedConfig',

  // Dependency checking - domain-specific dependency analysis
  'isDeclaredDependency',

  // CLI-local timestamp formatters — each subcommand renders timestamps
  // for a different input shape (Date / ISO string / number-of-ms /
  // unknown) and uses subcommand-local color helpers. They share a name
  // because "format the timestamp for display" is the user-facing intent;
  // collapsing them into one function would force every caller to
  // pre-coerce its input and would need a CLI-color injection scheme.
  'formatTimestamp',

  // Severity-color mapping is consumer-specific — log severity level
  // (numeric) vs. autonomy-mode (string) vs. ticket-status. Each maps a
  // bounded enum to a color helper from createColorScheme.
  'getLevelColor',

  // Duration formatters operate on different units depending on the
  // domain: foundation's canonical formatDuration takes ms, while
  // CLI helpers like pipeline-stalled take minutes. They are not
  // interchangeable; ms-input formatters are exported from
  // @opensip/foundation/utils.
  'formatDuration',

  // Per-domain payload validators — audit corrections, SIP stream
  // events, billing webhook deliveries each validate a different shape
  // against a different schema with a different error type. The name
  // is descriptive of the action ("validate the payload"); the schema
  // and error type are domain-bound.
  'validatePayload',

  // getLogLevel is called by both the logger config schema (returns a
  // ConfigLogLevel from env / config defaults) and the request-
  // observability plugin (maps an HTTP status code to a pino level).
  // Different inputs, different outputs.
  'getLogLevel',

  // Each prompt-injection sanitizer scopes to its package's prompt
  // surface — assistant chat prompts truncate at 500 chars and strip
  // markdown directives; observatory caps at MAX_NOTE_CONTENT_CHARS;
  // enrichment + worker-runtime guard angle brackets at 10_000 chars.
  // Different defaults + different escape sets per LLM context.
  'sanitizeForPrompt',

  // Foundation hosts two correlation-ID providers — request-context
  // exposes the AsyncLocalStorage-backed accessor; error-factory
  // exposes the singleton-CorrelationIdProvider accessor. Each backs
  // a different layer (request-scoped vs. shared error factory
  // composition) and reads from a different storage instance.
  'getCurrentCorrelationId',

  // sanitizeObject in foundation/serialization is a sync replacer-
  // based recursion used by safe-stringify; sanitizeObject in
  // input-sanitization/middleware is the async sanitization pipeline
  // entry point that recurses into nested objects calling per-field
  // sanitizers. Same name, completely different I/O contracts.
  'sanitizeObject',

  // getRemoteUrl in @opensip/github is a thin git CLI wrapper that
  // returns Promise<string> (origin URL only); getRemoteUrl in
  // @opensip/worker-runtime/git-worktree is the Result-wrapped
  // operation-tracked variant that accepts an arbitrary remote name
  // and timeout. Different signatures by design — the worker-runtime
  // version is the safer one for pipeline use.
  'getRemoteUrl',

  // sanitizeField in @opensip/input-sanitization is the per-field
  // step of the async sanitization middleware (takes a sanitizer +
  // key + options bundle); sanitizeField in apiserver/routes/ingest
  // is the signal-route-specific text helper (takes raw text + max-
  // length + modifications array). Different parameter shapes.
  'sanitizeField',
])

interface FunctionInfo {
  name: string
  line: number
  file: string
  bodyHash: string
  bodyLength: number
}

/** Map from function name to map of body hash to locations */
type FunctionsByName = Map<string, Map<string, FunctionInfo[]>>

/**
 * Get unique directories from a list of function locations
 */
function getUniqueDirectories(locations: FunctionInfo[]): Set<string> {
  if (!Array.isArray(locations)) {
    return new Set()
  }
  return new Set(locations.map((l) => dirname(l.file)))
}

/**
 * Flatten all locations from hash groups into a single array
 */
function flattenHashGroups(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const allLocations: FunctionInfo[] = []
  if (hashGroups.size === 0) {
    return allLocations
  }
  for (const locations of hashGroups.values()) {
    if (Array.isArray(locations) && locations.length > 0) {
      allLocations.push(...locations)
    }
  }
  return allLocations
}

/**
 * Get first location from each hash group (unique implementations)
 */
function getFirstFromEachHashGroup(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const uniqueImpls: FunctionInfo[] = []
  if (hashGroups.size === 0) {
    return uniqueImpls
  }
  for (const locations of hashGroups.values()) {
    if (!Array.isArray(locations) || locations.length === 0) {
      continue
    }
    const first = locations[0]
    if (first) {
      uniqueImpls.push(first)
    }
  }
  return uniqueImpls
}

/**
 * Format other files for display in violation message
 */
function formatOtherFiles(locations: FunctionInfo[]): string {
  const otherFiles = locations
    .slice(1)
    .map((l) => basename(l.file))
    .slice(0, 3)
  const moreCount = locations.length > 4 ? ` (+${locations.length - 4} more)` : ''
  return `${otherFiles.join(', ')}${moreCount}`
}

/**
 * Add a function to the functions-by-name collection
 */
function addFunctionToCollection(functionsByName: FunctionsByName, fn: FunctionInfo): void {
  let nameGroup = functionsByName.get(fn.name)
  if (!nameGroup) {
    nameGroup = new Map()
    functionsByName.set(fn.name, nameGroup)
  }

  let hashGroup = nameGroup.get(fn.bodyHash)
  if (!hashGroup) {
    hashGroup = []
    nameGroup.set(fn.bodyHash, hashGroup)
  }

  hashGroup.push(fn)
}

/**
 * Check if locations represent a valid duplicate across multiple directories.
 */
function isValidCrossDirectoryDuplicate(locations: FunctionInfo[]): boolean {
  if (!Array.isArray(locations) || locations.length <= 1) {
    return false
  }
  const locationDirs = getUniqueDirectories(locations)
  return locationDirs.size > 1
}

/**
 * Remove single-line comments from code
 */
function removeSingleLineComments(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('//')
      return commentIndex === -1 ? line : line.slice(0, commentIndex)
    })
    .join('\n')
}

/**
 * Remove multi-line comments from code
 * Uses iterative approach to avoid regex backtracking issues.
 */
function removeMultiLineComments(code: string): string {
  let result = ''
  let i = 0
  while (i < code.length) {
    if (code[i] === '/' && code[i + 1] === '*') {
      const endIndex = code.indexOf('*/', i + 2)
      if (endIndex === -1) {
        break
      }
      i = endIndex + 2
    } else {
      result += code[i]
      i++
    }
  }
  return result
}

/**
 * Normalize function body for comparison.
 * Removes whitespace, comments, and normalizes identifiers.
 */
function normalizeBody(body: string): string {
  let normalized = body
  normalized = removeSingleLineComments(normalized)
  normalized = removeMultiLineComments(normalized)
  normalized = normalized.replaceAll(/\s+/g, ' ')
  normalized = normalized.trim()
  return normalized
}

/**
 * Generate a hash of the normalized function body.
 * Uses SHA-256 for content-addressable deduplication (not for security purposes).
 */
function hashBody(body: string): string {
  const normalized = normalizeBody(body)
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Check if function name matches utility patterns
 */
function isUtilityFunction(name: string): boolean {
  if (DOMAIN_SPECIFIC_FUNCTIONS.has(name)) {
    return false
  }
  return UTILITY_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Extract utility functions from a file with their body hashes
 */
function extractUtilityFunctionsWithBody(filePath: string, content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = []

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node) => {
      // Check function declarations
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const name = node.name.text
        if (isUtilityFunction(name)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const body = node.body.getText(sourceFile)
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          })
        }
      }

      // Check arrow functions assigned to variables
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        const name = node.name.text
        if (isUtilityFunction(name)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const body = node.initializer.body.getText(sourceFile)
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Ignore parse errors
  }

  return functions
}

/**
 * Create a violation for identical implementations
 */
function createIdenticalViolation(name: string, locations: FunctionInfo[]): CheckViolation {
  const first = locations[0]
  if (!first) {
    throw new Error(`createIdenticalViolation called with empty locations array for '${name}'`)
  }
  const otherFilesStr = formatOtherFiles(locations)

  return {
    line: first.line,
    message: `Utility function '${name}' has identical implementation in ${locations.length} locations`,
    severity: 'warning',
    suggestion: `Move '${name}' to packages/shared/backend/foundation/utils/ or a relevant domain utils module. Also in: ${otherFilesStr}`,
    type: 'duplicate-utility-identical',
    match: name,
    filePath: first.file,
  }
}

/**
 * Create a violation for similar implementations (same name, different body)
 */
function createSimilarViolation(name: string, uniqueImpls: FunctionInfo[]): CheckViolation {
  const first = uniqueImpls[0]
  if (!first) {
    throw new Error(`createSimilarViolation called with empty uniqueImpls array for '${name}'`)
  }
  const otherFilesStr = formatOtherFiles(uniqueImpls)
  const numImplementations = uniqueImpls.length

  return {
    line: first.line,
    message: `Utility function '${name}' has ${numImplementations} different implementations - consider consolidation with options`,
    severity: 'warning',
    suggestion: `Create a unified '${name}' function with configurable options in packages/shared/backend/foundation/utils/. Different implementations found in: ${otherFilesStr}`,
    type: 'duplicate-utility-similar',
    match: name,
    filePath: first.file,
  }
}

async function collectFunctionsFromFiles(files: FileAccessor): Promise<FunctionsByName> {
  const functionsByName: FunctionsByName = new Map()

  for (const filePath of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath)
      const functions = extractUtilityFunctionsWithBody(filePath, content)
      const validFunctions = functions.filter((fn) => fn.bodyLength >= MIN_FUNCTION_BODY_LENGTH)

      for (const fn of validFunctions) {
        void addFunctionToCollection(functionsByName, fn)
      }
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return functionsByName
}

function findIdenticalViolations(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  for (const locations of hashGroups.values()) {
    if (isValidCrossDirectoryDuplicate(locations)) {
      violations.push(createIdenticalViolation(name, locations))
    }
  }

  return violations
}

function findSimilarViolation(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation | null {
  if (hashGroups.size <= 1) {
    return null
  }

  const uniqueImpls = getFirstFromEachHashGroup(hashGroups)
  if (!Array.isArray(uniqueImpls) || uniqueImpls.length <= 1) {
    return null
  }

  const implDirs = getUniqueDirectories(uniqueImpls)
  if (implDirs.size <= 1) {
    return null
  }

  return createSimilarViolation(name, uniqueImpls)
}

function processFunctionGroup(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const allLocations = flattenHashGroups(hashGroups)
  const dirs = getUniqueDirectories(allLocations)

  if (dirs.size <= 1 || hashGroups.size === 0) {
    return []
  }

  const violations: CheckViolation[] = [...findIdenticalViolations(name, hashGroups)]

  const similarViolation = findSimilarViolation(name, hashGroups)
  if (similarViolation) {
    violations.push(similarViolation)
  }

  return violations
}

/**
 * Check: quality/duplicate-utility-functions
 *
 * Detects utility functions that should be consolidated across the codebase.
 * Reports two types of issues:
 * - IDENTICAL: Same name, same implementation (true duplicates)
 * - SIMILAR: Same name, different implementation (consolidation opportunities)
 */
export const duplicateUtilityFunctions = defineCheck({
  id: 'aa303a1e-f3f8-4a11-ade2-9e29af89c299',
  slug: 'duplicate-utility-functions',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect duplicate and similar utility functions',
  longDescription: `**Purpose:** Detects utility functions that are duplicated or similarly named across the codebase, flagging consolidation opportunities into shared packages.

**Detects:** Cross-file analysis using TypeScript AST extraction and SHA-256 body hashing.
- **Identical duplicates:** Same-named utility functions with identical normalized bodies in different directories
- **Similar implementations:** Same-named utility functions with different bodies across directories (consolidation with options pattern)
- Targets functions matching utility name patterns: \`format*\`, \`parse*\`, \`is*\`, \`has*\`, \`to*\`, \`get*\`, \`validate*\`, \`sanitize*\`, \`normalize*\`, \`debounce\`, \`throttle\`, \`sleep\`, \`retry\`, etc.
- Skips domain-specific functions listed in \`DOMAIN_SPECIFIC_FUNCTIONS\` and bodies under 50 characters

**Why it matters:** Duplicated utilities create maintenance risk and inconsistent behavior. A single shared implementation in \`foundation/utils\` ensures consistent behavior and reduces code volume.

**Scope:** General best practice`,
  tags: ['quality', 'dry', 'utilities', 'duplication'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const functionsByName = await collectFunctionsFromFiles(files)
    const violations: CheckViolation[] = []

    for (const [name, hashGroups] of functionsByName) {
      // @fitness-ignore-next-line performance-anti-patterns -- spread aggregates small violation arrays from pure function
      violations.push(...processFunctionGroup(name, hashGroups))
    }

    return violations
  },
})
