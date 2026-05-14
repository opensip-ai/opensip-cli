// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file context-mutation-check -- Local array/object mutations are safe within function scope; not shared context
// @fitness-ignore-file file-length-limits -- JSDoc documentation required for public API
// @fitness-ignore-file silent-early-returns -- Guard clauses in pattern matching function return false for non-matching patterns
/**
 * @fileoverview Context safety and mutation checks
 */


import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

import { isCommentLine, isTestFile } from '../../utils/index.js'

// =============================================================================
// CONTEXT MUTATION CHECK
// =============================================================================

/**
 * Safe string patterns for checking context objects.
 * Using string includes for safe, linear-time matching.
 */
const CONTEXT_STRING_PATTERNS = [
  'request.context',
  'request.ctx',
  'req.context',
  'req.ctx',
  'ctx.',
  'context.',
  'RequestContext',
  'ExecutionContext',
]

/**
 * Checks if content uses context patterns.
 * @param content - The content to check
 * @returns True if content contains context patterns
 */
function usesContextPattern(content: string): boolean {
  return CONTEXT_STRING_PATTERNS.some((pattern) => content.includes(pattern))
}

/**
 * Mutation detection configuration.
 * Using simple string matching for linear-time detection.
 */
interface MutationDetector {
  readonly test: (line: string) => boolean
  readonly patternName: string
}

/**
 * Finds the end index of a word (consecutive word characters) in a string.
 * @param str - The string to search
 * @returns The index after the last word character, or 0 if no word characters found
 */
function findWordEndIndex(str: string): number {
  logger.debug({
    evt: 'fitness.checks.context_safety.find_word_end_index',
    msg: 'Finding end index of word characters in string',
  })
  let wordEnd = 0
  // eslint-disable-next-line unicorn/no-for-loop -- offset-bearing scan: returns the UTF-16 index after the last word char
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (char === undefined || !/\w/.test(char)) {
      return wordEnd
    }
    wordEnd = i + 1
  }
  return wordEnd
}

/**
 * Creates a safe mutation detector using string matching.
 * Detects patterns like: ctx.property = or context.field =
 * Does NOT match comparison operators (==, ===, !=, !==)
 * @param prefix - The prefix to match (e.g., 'ctx.')
 * @returns A detector that checks for assignment after prefix and word
 */
function createAssignmentDetector(prefix: string): MutationDetector {
  return {
    test: (line: string): boolean => {
      logger.debug({
        evt: 'fitness.checks.context_safety.assignment_detector_test',
        msg: 'Testing line for context assignment mutation',
      })
      const idx = line.indexOf(prefix)
      if (idx === -1) return false
      // Find next non-word character after prefix
      const afterPrefix = line.slice(Math.max(0, idx + prefix.length))
      // Must have at least one word character
      const wordEnd = findWordEndIndex(afterPrefix)
      if (wordEnd === 0) return false
      const afterWord = afterPrefix.slice(Math.max(0, wordEnd)).trimStart()
      // Check for assignment (but NOT comparison operators)
      if (!afterWord.startsWith('=')) return false
      // Exclude === and == (comparison) and !=, !==
      const secondChar = afterWord.charAt(1)
      if (secondChar === '=' || secondChar === '!') return false
      return true
    },
    patternName: `${prefix}*=`,
  }
}

/**
 * Creates a simple string contains detector.
 * @param pattern - The string pattern to match
 * @returns A detector that checks for pattern inclusion
 */
function createContainsDetector(pattern: string): MutationDetector {
  return {
    test: (line: string): boolean => line.includes(pattern),
    patternName: pattern,
  }
}

/**
 * Creates a detector for array mutation methods on context objects.
 * Only matches patterns like ctx.array.push() or context.items.splice()
 * Does NOT match local variables like myArray.push()
 * @param method - The method name (e.g., 'push', 'splice')
 * @returns A detector that checks for context-prefixed array mutations
 */
function createContextArrayMutationDetector(method: string): MutationDetector {
  const contextPrefixes = [
    'ctx.',
    'context.',
    'req.context.',
    'request.context.',
    'req.',
    'request.',
  ]
  return {
    test: (line: string): boolean => {
      logger.debug({
        evt: 'fitness.checks.context_safety.array_mutation_detector_test',
        msg: 'Testing line for context array mutation pattern',
      })
      // Must contain the method call
      if (!line.includes(`.${method}(`)) return false
      // Check if it's prefixed by a context variable
      for (const prefix of contextPrefixes) {
        const prefixIdx = line.indexOf(prefix)
        if (prefixIdx !== -1) {
          // Check if the method call is after the context prefix
          const methodIdx = line.indexOf(`.${method}(`, prefixIdx)
          if (methodIdx > prefixIdx) {
            return true
          }
        }
      }
      return false
    },
    patternName: `ctx/*.${method}()`,
  }
}

/**
 * Safe mutation detectors using string-based matching.
 * Only flags mutations on actual context objects, not local variables.
 */
const MUTATION_DETECTORS: readonly MutationDetector[] = [
  createAssignmentDetector('ctx.'),
  createAssignmentDetector('context.'),
  createAssignmentDetector('req.context.'),
  createAssignmentDetector('request.context.'),
  createContainsDetector('Object.assign(ctx'),
  createContainsDetector('Object.assign( ctx'),
  createContainsDetector('Object.assign(context'),
  createContainsDetector('Object.assign( context'),
  // Only flag array mutations when prefixed by context objects
  createContextArrayMutationDetector('push'),
  createContextArrayMutationDetector('splice'),
  createContextArrayMutationDetector('pop'),
  createContextArrayMutationDetector('shift'),
  createContextArrayMutationDetector('unshift'),
  createContainsDetector('delete ctx.'),
  createContainsDetector('delete context.'),
]

/**
 * Safe keywords (allowed mutations).
 * These are common fields that are either:
 * - Standard context setup fields that are expected to be set
 * - Fields that indicate local object construction, not request context mutation
 */
const SAFE_KEYWORDS = [
  'correlationId',
  'requestId',
  'traceId',
  'spanId',
  'logger',
  'startTime',
  // Common local context construction patterns
  'userId', // User ID setup in local context objects
  'timestamp', // Timestamp field in local context
  'details', // Details field in error/result context
  'metadata', // Metadata field in local context
  'statusCode', // Status code in error context
  'code', // Error code in error context
  // Recovery/retry execution context fields
  'fallbackAttempts', // Used in recovery/retry execution contexts
  'lastError', // Used in retry execution contexts
  'strategy', // Used in retry execution contexts
  'retryAttempts', // Used in retry execution contexts
  // Validation context fields
  'schemaName', // Used in validation contexts
  // Ticket/build context fields
  'git', // Used in ticket/build context
  'environment', // Used in ticket/build context
  // Search relevance context fields
  'userPreferences', // Used in search relevance context
  'boosts', // Used in search relevance context
  // Fitness check analysis context fields
  'violations', // Used in fitness check analysis contexts
]

/**
 * Safe context prefixes that indicate non-request context objects.
 * These are local/scoped context objects, not shared request contexts.
 */
const SAFE_CONTEXT_PREFIXES = [
  'entry.context', // Log entry context (per-entry metadata)
  'logEntry.context', // Log entry context
  'this.context', // Builder pattern on class instances
  'result.context', // Result/response context
  'error.context', // Error context builder
  'config.context', // Configuration context
  'options.context', // Options object context
  'params.context', // Parameters context
  'state.context', // Local state context
  'item.context', // Item/element context
  'record.context', // Record context
  'event.context', // Event context
]

/**
 * Checks if a line contains safe mutation patterns.
 * @param line - The line to check
 * @returns True if line contains safe patterns
 */
function isSafeMutation(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.context_safety.is_safe_mutation',
    msg: 'Checking if line contains safe mutation patterns',
  })
  // Check for safe keywords
  if (SAFE_KEYWORDS.some((keyword) => line.includes(keyword))) {
    return true
  }
  // Check for safe context prefixes (non-request context objects)
  if (SAFE_CONTEXT_PREFIXES.some((prefix) => line.includes(prefix))) {
    return true
  }
  return false
}

/**
 * Find a mutation detector that matches the line.
 * @param line - The line to check.
 * @returns The matching detector and whether it's a safe mutation, or null if no match.
 */
function findMutationMatch(line: string): { detector: MutationDetector; isSafe: boolean } | null {
  for (const detector of MUTATION_DETECTORS) {
    if (detector.test(line)) {
      return { detector, isSafe: isSafeMutation(line) }
    }
  }
  return null
}

/**
 * Check if the mutation is defensive (inside a try block).
 * @param lines - All lines of the file.
 * @param index - Current line index.
 * @returns True if the mutation is in a try block.
 */
function isDefensiveMutation(lines: string[], index: number): boolean {
  if (!Array.isArray(lines)) {
    return false
  }
  const contextBefore = lines.slice(Math.max(0, index - 5), index).join('\n')
  return contextBefore.includes('try')
}

/**
 * Check: resilience/context-mutation-check
 *
 * Detects potentially unsafe mutations of request/execution context objects.
 * Context should be immutable to prevent side effects across middleware.
 */
export const contextMutationCheck = defineCheck({
  id: 'abed5b29-960b-486f-bb0d-5b9e1744241d',
  slug: 'context-mutation-check',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detect unsafe mutations of request/execution context',
  longDescription: `**Purpose:** Prevents direct mutation of request/execution context objects, which can cause side effects across middleware and handlers.

**Detects:**
- Assignment to context properties: \`ctx.prop =\`, \`context.prop =\`, \`req.context.prop =\`, \`request.context.prop =\` (excluding \`==\`/\`===\` comparisons)
- \`Object.assign(ctx, ...)\` and \`Object.assign(context, ...)\`
- Array mutation methods on context objects: \`.push()\`, \`.splice()\`, \`.pop()\`, \`.shift()\`, \`.unshift()\`
- \`delete ctx.\` / \`delete context.\` expressions
- Allows safe fields like \`correlationId\`, \`requestId\`, \`logger\`, and non-request context prefixes like \`error.context\`, \`this.context\`

**Why it matters:** Mutating shared request context causes unpredictable cross-request data leakage in concurrent server environments.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'context', 'immutability'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.context_safety.context_mutation_check_analyze',
      msg: 'Analyzing file for unsafe context mutations',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't use context patterns
    if (!usesContextPattern(content)) {
      return violations
    }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || !line) continue
      if (isCommentLine(line)) continue

      const match = findMutationMatch(line)
      if (!match || match.isSafe) continue

      const isDefensive = isDefensiveMutation(lines, i)
      const lineNumber = i + 1

      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Mutation of context object may cause side effects',
        severity: isDefensive ? 'warning' : 'error',
        suggestion:
          'Create a new context object instead of mutating. Use spread operator: const newCtx = { ...ctx, property: newValue }; or Object.freeze() for immutability.',
        match: match.detector.patternName,
        type: 'context-mutation',
        filePath,
      })
    }

    return violations
  },
})

// =============================================================================
// REQUEST CONTEXT LEAKAGE (AST-based)
// =============================================================================

/**
 * Names that look like a request-scoped context variable.
 * Matches whole-word boundaries (case-insensitive): "ctx", "context", "request"
 * but excludes generic suffixes that aren't request state (e.g. `parserContext`
 * is still flagged, but that is fine — it's evaluated together with the type).
 */
function variableNameLooksContextual(name: string): boolean {
  const lower = name.toLowerCase()
  // Whole-word: ends with "context"/"ctx" or starts with "request"/"req"
  return (
    lower.endsWith('context') ||
    lower.endsWith('ctx') ||
    lower === 'request' ||
    lower === 'req' ||
    lower.startsWith('request') ||
    lower.startsWith('req') && lower.length <= 12
  )
}

/**
 * Type-name suffixes that indicate a request-scoped context type.
 * Matches identifier types whose name ends with "Context" or "Ctx".
 * Excludes well-known process-scoped wrappers (`Injector<…>`, `SyncStrategy<…>`,
 * `Promise<…>`) — those are detected by inspecting the OUTER type identifier
 * and refusing to recurse into its generic arguments.
 */
function isContextTypeName(name: string): boolean {
  return /(?:Context|Ctx)$/.test(name)
}

/**
 * Type identifiers that, regardless of generic arguments, are NOT request
 * state. If the outer type is one of these, we ignore generic args entirely.
 */
const PROCESS_SCOPED_WRAPPER_TYPES = new Set([
  'Injector',
  'SyncStrategy',
  'Promise',
  'PromiseLike',
  'Awaited',
  'Array',
  'ReadonlyArray',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Result',
  'Either',
  'Observable',
  'AsyncIterable',
  'Iterable',
  'WeakMap',
  'WeakSet',
])

/**
 * OTel and project metric instrument type names. A module-level
 * `let counter: Counter | null = null` lazy-init pattern with one of these
 * as the declared type is process-scoped per-instrument state, not request state.
 */
const METRIC_INSTRUMENT_TYPES = new Set([
  'Counter',
  'Histogram',
  'UpDownCounter',
  'Gauge',
  'ObservableCounter',
  'ObservableGauge',
  'ObservableUpDownCounter',
  'Meter',
  'Tracer',
  'TracerProvider',
  'MeterProvider',
])

/**
 * Path patterns where the check is structurally inappropriate.
 * - DBOS steps register process-scoped DI via `static ctx`; that's the framework's
 *   contract, not request leakage.
 */
const SKIP_PATH_PATTERNS: RegExp[] = [/[/\\]dbos[/\\]steps[/\\]/]

function isSkippedPath(filePath: string): boolean {
  return SKIP_PATH_PATTERNS.some((p) => p.test(filePath))
}

/**
 * Walk a TypeNode and decide whether it references a request-scoped context
 * type *as the outer / value-shape* (not as an inner generic argument of a
 * process-scoped wrapper like `Injector<AuditContext>`).
 */
/** Get the simple name of a type reference's `typeName` (handles qualified names). */
function getTypeRefName(typeName: ts.EntityName): string {
  if (ts.isIdentifier(typeName)) return typeName.text
  if (ts.isQualifiedName(typeName)) return typeName.right.text
  return ''
}

function typeLooksLikeRequestContext(type: ts.TypeNode | undefined): boolean {
  if (!type) return false

  // Union: any branch that looks like context counts (excluding `null`/`undefined`)
  if (ts.isUnionTypeNode(type)) {
    return type.types.some((t) => typeLooksLikeRequestContext(t))
  }

  if (ts.isTypeReferenceNode(type)) {
    const name = getTypeRefName(type.typeName)
    if (PROCESS_SCOPED_WRAPPER_TYPES.has(name)) {
      // The outer wrapper is process-scoped; ignore its generic arguments.
      return false
    }
    return isContextTypeName(name)
  }

  // Other shapes (TypeLiteral, intersection of inline shapes, etc.) — be lenient
  // and don't flag. Inline-typed module-level state would still be caught if
  // the variable name itself is contextual (handled separately).
  return false
}

/**
 * Detect the `let foo: <MetricType> | null = null` lazy-init shape that is
 * common for OTel instruments. These declarations are process-scoped per
 * metric, not request state, so we skip them.
 */
function isMetricLazyInit(decl: ts.VariableDeclaration): boolean {
  const t = decl.type
  if (!t) return false
  if (decl.initializer?.kind !== ts.SyntaxKind.NullKeyword) return false

  // Require a `<Something> | null` (or `<Something> | undefined`) shape.
  const candidates: ts.TypeNode[] = ts.isUnionTypeNode(t) ? [...t.types] : [t]
  const hasNullBranch = candidates.some(
    (c) =>
      c.kind === ts.SyntaxKind.NullKeyword ||
      c.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isLiteralTypeNode(c) && c.literal.kind === ts.SyntaxKind.NullKeyword),
  )
  if (!hasNullBranch) return false

  return candidates.some((c) => {
    if (!ts.isTypeReferenceNode(c)) return false
    return METRIC_INSTRUMENT_TYPES.has(getTypeRefName(c.typeName))
  })
}

/**
 * Detect AsyncLocalStorage-typed declarations; these are the *correct* way to
 * store request-scoped state and should never be flagged.
 */
function isAsyncLocalStorageType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  if (ts.isTypeReferenceNode(type)) {
    return getTypeRefName(type.typeName) === 'AsyncLocalStorage'
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some(isAsyncLocalStorageType)
  }
  return false
}

/**
 * A class is "request-scoped" if any of its public methods take a `tenantId`
 * parameter (typed or named), or it has a `requestId` field. This is a heuristic
 * — process-scoped DI classes (composition roots, providers) typically don't
 * pass tenantId around as a method param; request handlers do.
 */
function classLooksRequestScoped(cls: ts.ClassDeclaration): boolean {
  for (const member of cls.members) {
    // Field named requestId / correlationId
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const fieldName = member.name.text
      if (fieldName === 'requestId' || fieldName === 'correlationId') return true
    }
    // Method with `tenantId` parameter
    if (
      (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
      member.parameters.some(
        (p) => ts.isIdentifier(p.name) && (p.name.text === 'tenantId' || p.name.text === 'tenant_id'),
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * A class declaration is a DBOS step host if any member carries a `@DBOS.step()`
 * decorator (or `@DBOS.workflow()`). These are process-scoped DI containers.
 */
function classIsDbosStepHost(cls: ts.ClassDeclaration): boolean {
  const checkDecorators = (mods: readonly ts.ModifierLike[] | undefined): boolean => {
    if (!mods) return false
    for (const m of mods) {
      if (!ts.isDecorator(m)) continue
      const exprText = m.expression.getText()
      if (exprText.startsWith('DBOS.step') || exprText.startsWith('DBOS.workflow')) return true
    }
    return false
  }
  if (checkDecorators(ts.getModifiers(cls))) return true
  for (const member of cls.members) {
    if (
      ts.canHaveDecorators(member) &&
      checkDecorators(ts.getDecorators(member))
    ) {
      return true
    }
  }
  return false
}

interface ContextLeakageFinding {
  line: number
  column: number
  match: string
}

/**
 * Walk top-level statements and class declarations of a SourceFile and collect
 * findings for genuine module-level / request-scoped class-level leakage.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- module/class-level walk; branches map to AST node kinds and are easier to read inline than as a fragmented dispatcher
function collectContextLeakage(sourceFile: ts.SourceFile): ContextLeakageFinding[] {
  const findings: ContextLeakageFinding[] = []

  // 1. Module-level `let`/`var` declarations
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue

    const flags = stmt.declarationList.flags
    // Skip `const` — request-scoped state cannot be assigned more than once
    // anyway. The leakage shape requires a re-assignable binding.
    if (flags & ts.NodeFlags.Const) continue

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const varName = decl.name.text

      // AsyncLocalStorage — the correct request-scoping primitive
      if (isAsyncLocalStorageType(decl.type)) continue

      // Lazy-init metric instrument: process-scoped per metric, not per request
      if (isMetricLazyInit(decl)) continue

      const typeIsContextual = typeLooksLikeRequestContext(decl.type)
      const nameIsContextual = variableNameLooksContextual(varName)

      // Require BOTH name AND type to point at request context (or at least the
      // type — the regex check used to flag "request" in metric names; we now
      // require an explicit type-shape signal).
      if (!typeIsContextual && !nameIsContextual) continue

      // If the variable has a non-null initializer that's an object literal /
      // function call producing a known process-scoped value (e.g. `new Map()`),
      // and the type isn't contextual, skip.
      if (!typeIsContextual && nameIsContextual) {
        // Name-only signal is too weak by itself — require initializer to be `null`
        // and a contextual-looking type. If the user wrote `let req = …` without a
        // type, modern TS will infer it; we don't have type info here, so we punt.
        continue
      }

      const start = decl.getStart(sourceFile)
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
      findings.push({
        line: line + 1,
        column: character + 1,
        match: `let ${varName}: <Context>`,
      })
    }
  }

  // 2. Class fields — non-readonly, non-static `PropertyDeclaration` whose
  //    type is a request-scoped context AND the class itself is request-scoped.
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt)) continue
    if (classIsDbosStepHost(stmt)) continue
    if (!classLooksRequestScoped(stmt)) continue

    for (const member of stmt.members) {
      if (!ts.isPropertyDeclaration(member)) continue
      if (!ts.isIdentifier(member.name)) continue

      const mods = ts.getModifiers(member)
      const isReadonly = mods?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false
      const isStatic = mods?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false
      if (isReadonly || isStatic) continue

      if (!typeLooksLikeRequestContext(member.type)) continue

      const start = member.getStart(sourceFile)
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
      findings.push({
        line: line + 1,
        column: character + 1,
        match: `private ${member.name.text}: <Context>`,
      })
    }
  }

  return findings
}

/**
 * Check: resilience/context-leakage
 *
 * Detects request context stored in module or class scope, which could cause
 * cross-request pollution in multi-tenant / concurrent server environments.
 *
 * Implemented as a TypeScript AST walk. The previous regex implementation flagged:
 * - type-only references (`SyncStrategy<InitialSyncContext>`),
 * - method-parameter types (`(ctx: SomeContext) => …`),
 * - module-level lazy-init metric instruments (`let counter: Counter | null = null`).
 * The AST rewrite eliminates those false positives by inspecting the actual
 * declaration shape rather than line text.
 */
export const contextLeakage = defineCheck({
  id: '037b58ef-7b7d-404c-896b-2d40efe02a95',
  slug: 'context-leakage',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  description: 'Detect potential request context leakage',
  longDescription: `**Purpose:** Detects request context stored in module or class scope, which can leak between concurrent requests.

**Detects (AST-based):**
- Module-level mutable bindings (\`let\`/\`var\`) whose declared type ends in \`Context\` or \`Ctx\` (e.g. \`let activeContext: RequestContext | null = null\`).
- Class \`PropertyDeclaration\` (non-\`readonly\`, non-\`static\`) whose type ends in \`Context\` or \`Ctx\` AND whose enclosing class is heuristically request-scoped (a method takes a \`tenantId\` parameter, or the class declares a \`requestId\` field).

**Explicitly excluded:**
- Type-only generic-argument references (\`SyncStrategy<InitialSyncContext>\`, \`Injector<AuditContext>\`, \`Promise<Foo>\`) — the outer wrapper identifier suppresses recursion into generics.
- Method-parameter types (\`(ctx: SomeContext) => …\`) — parameters are never module-level declarations.
- Function-local bindings — only top-level \`SourceFile.statements\` are walked.
- DBOS step \`static ctx\` slots — files under \`**/dbos/steps/**\` are skipped, and classes whose members carry \`@DBOS.step()\` / \`@DBOS.workflow()\` decorators are skipped.
- Module-level OTel lazy-init shape: \`let <name>: <MetricType> | null = null\` where \`<MetricType>\` is one of \`Counter\`, \`Histogram\`, \`UpDownCounter\`, \`Gauge\`, \`Observable*\`, \`Meter\`, \`Tracer\`, \`TracerProvider\`, \`MeterProvider\` — these are process-scoped per-instrument caches, not per-request state.
- \`AsyncLocalStorage\`-typed declarations — the correct request-scoping primitive.

**Why it matters:** Storing per-request context in shared scope causes cross-request pollution in multi-tenant or concurrent server environments.

**Known limitations:**
- The "class is request-scoped" check is a syntactic heuristic — it does not consult the type checker. A request handler that doesn't take \`tenantId\` directly (e.g. takes a \`FastifyRequest\` and reads tenant from inside) will not match. Prefer adding a \`requestId\` field on such classes if you want them in scope.
- Inline-typed module bindings (\`let foo = someValue\` with no annotation) are not flagged — the AST has no type information without the type checker. If you want stricter detection, declare the type explicitly.

**Scope:** General best practice. Analyzes each file individually via a single AST walk.`,
  tags: ['resilience', 'context', 'security'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return []
    if (isSkippedPath(filePath)) return []

    logger.debug({
      evt: 'fitness.checks.context_safety.context_leakage_analyze',
      msg: 'Analyzing file for request context leakage (AST)',
    })

    // Quick text bail-out: if the file mentions neither "context" nor "ctx",
    // there is nothing to find. Saves the parse-cache hit.
    const lower = content.toLowerCase()
    if (!lower.includes('context') && !lower.includes('ctx')) return []

    let sourceFile: ts.SourceFile | null
    try {
      sourceFile = getSharedSourceFile(filePath, content)
    } catch {
      // @swallow-ok Skip files that fail to parse — no signal to emit.
      return []
    }
    if (!sourceFile) return []

    const findings = collectContextLeakage(sourceFile)
    return findings.map<CheckViolation>((f) => ({
      line: f.line,
      column: f.column,
      message: 'Request context stored in module/class scope may leak between requests',
      severity: 'warning',
      suggestion:
        'Use AsyncLocalStorage for request-scoped context or pass context as a parameter. Storing context in module/class scope can cause cross-request pollution.',
      match: f.match,
      type: 'context-leakage',
      filePath,
    }))
  },
})
