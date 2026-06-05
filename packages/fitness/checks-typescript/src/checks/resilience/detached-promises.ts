// @fitness-ignore-file file-length-limit -- AST detection requires both an AST visitor pipeline and the merged sync-call constants kept in this file
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file canonical-result-usage -- References Result pattern in comments and regex patterns for detection, not actual Result usage
/**
 * @fileoverview Detached promise detection — flags un-awaited promise-returning
 * calls inside async contexts.
 *
 * The defaults here cover **generic JS/TS sync APIs only** (Array, String,
 * Object, Math, JSON, `console.*`, the Node `*Sync` family, timer
 * scheduling, and EventEmitter). Framework-specific helpers (Fastify
 * decorators, Pyroscope SDK, OTel propagation, DBOS `.init`, Vitest /
 * Drizzle helpers, etc.) belong in a recipe's
 * `checks.config['detached-promises']` block — see
 * {@link DetachedPromisesConfig}. The check reads that block via
 * `getCheckConfig` and merges it into the effective sync-call sets.
 */

import { defineCheck, getCheckConfig, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile, isInAsyncContext } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Recipe-config shape for the detached-promises check. Each field augments the
 * built-in defaults; nothing here is required. Project-specific helper names
 * (e.g. opensip's `attachDomainContext`, `sendError`) belong in a recipe's
 * `checks.config['detached-promises']` block, not in built-in defaults.
 */
export interface DetachedPromisesConfig extends Record<string, unknown> {
  /** Method/function names that are synchronous (no await needed). */
  additionalSyncFunctions?: readonly string[]
  /** Receiver identifiers (the part before the dot) that are synchronous. */
  additionalSyncReceivers?: readonly string[]
  /** Method-name prefixes that mark a call as synchronous (e.g. `'wire'`). */
  additionalSyncPrefixes?: readonly string[]
}

/**
 * Known synchronous functions that do NOT return promises. Limited to
 * generic JS / TS / Node defaults; framework-specific entries live in
 * recipe config under `additionalSyncFunctions`.
 */
const KNOWN_SYNC_FUNCTIONS = new Set([
  // Node.js sync filesystem / process methods
  'execSync',
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'mkdirSync',
  'rmdirSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'unlinkSync',
  'copyFileSync',
  'renameSync',
  'accessSync',
  // Timer clearing/scheduling helpers (sync side)
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  // Console (synchronous)
  'log',
  'time',
  'timeEnd',
  // Promise resolution helpers (sync wrappers)
  'reject',
  'resolve',
  // Builder / coercion terminators
  'build',
  'toJSON',
  'toString',
  'valueOf',
  // Array methods (synchronous)
  'map',
  'filter',
  'reduce',
  'find',
  'findIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'slice',
  'concat',
  'join',
  'sort',
  'reverse',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'fill',
  'copyWithin',
  'flat',
  'flatMap',
  'forEach',
  // String methods (synchronous)
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'substring',
  'substr',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'match',
  'matchAll',
  'search',
  'normalize',
  'localeCompare',
  // Object methods (synchronous)
  'keys',
  'values',
  'entries',
  'assign',
  'freeze',
  'seal',
  'fromEntries',
  'create',
  'defineProperty',
  'defineProperties',
  'getOwnPropertyNames',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'setPrototypeOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  // JSON methods
  'stringify',
  'parse',
  // Math methods
  'floor',
  'ceil',
  'round',
  'max',
  'min',
  'abs',
  'random',
  'pow',
  'sqrt',
  'sign',
  'trunc',
  // Set/Map/WeakMap/WeakSet methods (synchronous)
  'add',
  'delete',
  'has',
  'clear',
  'get',
  'set',
  'size',
  // EventEmitter methods (synchronous)
  'emit',
  'on',
  'off',
  'once',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'eventNames',
  'listeners',
  'listenerCount',
  'rawListeners',
  // Date methods (synchronous)
  'getTime',
  'getDate',
  'getDay',
  'getFullYear',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'setTime',
  'setDate',
  'setFullYear',
  'setHours',
  'setMinutes',
  'setSeconds',
  'setMilliseconds',
  'toISOString',
  'toDateString',
  'toTimeString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'now',
])

/**
 * Known synchronous receiver identifiers — generic JS / Node namespaces.
 * When the receiver (object before the dot) matches these, the call is
 * likely synchronous. Framework-specific receivers (Fastify, Pyroscope,
 * OTel propagation, Vitest, etc.) live in recipe config under
 * `additionalSyncReceivers`.
 */
const KNOWN_SYNC_RECEIVERS = new Set([
  // Logging/output (synchronous — write to buffer). `log` is the common
  // logger-variable shorthand; the receiver-pattern list below only matches
  // names containing the literal `logger`, so `log.info(...)` (a void logger
  // call) would otherwise be a false positive. Exact match avoids the
  // substring breadth of adding `log` to the pattern list (catalog/dialog).
  'console',
  'log',
  // Node.js built-ins (synchronous APIs)
  'path',
  'fs',
  'process',
  // JavaScript built-in objects (synchronous)
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Date',
  'RegExp',
  'Symbol',
  'Boolean',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Reflect',
  'Proxy',
  'Intl',
])

/**
 * Substrings to match against receiver variable names (case-insensitive).
 * If a receiver name contains any of these, the call is likely synchronous.
 */
const KNOWN_SYNC_RECEIVER_PATTERNS = [
  'logger',
  'writer',
  'emitter',
  'registry',
  'cache',
  'store',
  'queue',
  'buffer',
  'timer',
  'counter',
  'gauge',
]

/**
 * File path patterns that indicate CLI commands or route registrations.
 * These files are dominated by sync calls in async contexts and produce
 * excessive false positives.
 */
const FILE_SKIP_PATTERNS = [
  '/commands/',
  '/routes/',
  '/route-handlers/',
  '/handlers/',
  '/plugins/',
  'register-routes',
  'register-plugins',
]

/**
 * Method-name prefixes that indicate synchronous calls. Limited to broadly
 * applicable JS conventions — boolean predicates, property accessors and
 * mutators, EventEmitter-style. Project-specific prefixes (e.g. `wire`,
 * `enforce`, `init` for DBOS step `.init`) come from the recipe via
 * `additionalSyncPrefixes`.
 */
const KNOWN_SYNC_PREFIXES = [
  // Property accessors & mutators
  'set',
  'get',
  'add',
  'remove',
  'delete',
  'clear',
  'reset',
  // Boolean predicates
  'is',
  'has',
  'can',
  'should',
  'was',
  'will',
  // EventEmitter-style
  'emit',
  'on',
  'off',
  'once',
  'dispatch',
]

/**
 * Method name suffixes that indicate synchronous calls.
 * Methods ending with these suffixes are synchronous by convention.
 */
const KNOWN_SYNC_SUFFIXES = [
  'Sync',
]

/**
 * Fire-and-forget patterns that are intentionally not awaited.
 * These are scheduler functions that run callbacks async.
 */
const FIRE_AND_FORGET_PATTERNS = new Set([
  'setImmediate',
  'setTimeout',
  'setInterval',
  'nextTick',
  'queueMicrotask',
])

/**
 * Built-in defaults merged with the recipe's `detached-promises` config slice.
 * Built once per `analyze` invocation and threaded through helpers.
 */
interface EffectiveSyncSets {
  syncFunctions: ReadonlySet<string>
  syncReceivers: ReadonlySet<string>
  syncPrefixes: readonly string[]
}

/**
 * Build effective sync-call lookup sets by merging built-in defaults with the
 * recipe-provided augmentation for `detached-promises`.
 */
function buildEffectiveSyncSets(): EffectiveSyncSets {
  const cfg = getCheckConfig<DetachedPromisesConfig>('detached-promises')
  const fns = new Set(KNOWN_SYNC_FUNCTIONS)
  for (const name of cfg.additionalSyncFunctions ?? []) fns.add(name)
  const recvs = new Set(KNOWN_SYNC_RECEIVERS)
  for (const name of cfg.additionalSyncReceivers ?? []) recvs.add(name)
  const prefixes = [...KNOWN_SYNC_PREFIXES, ...(cfg.additionalSyncPrefixes ?? [])]
  return { syncFunctions: fns, syncReceivers: recvs, syncPrefixes: prefixes }
}

/**
 * Check if a method call expression is to a known synchronous receiver or method.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- multi-pattern dispatcher: distinguishes receivers, methods, and aliased members across N known sync APIs
function isKnownSyncMethodCall(expr: ts.PropertyAccessExpression, sets: EffectiveSyncSets): boolean {
  const methodName = expr.name.text
  const receiverExpr = expr.expression

  // Check if method is known sync, fire-and-forget, or matches sync prefix
  if (
    sets.syncFunctions.has(methodName) ||
    FIRE_AND_FORGET_PATTERNS.has(methodName) ||
    matchesSyncNamePattern(methodName, sets)
  ) {
    return true
  }

  // Check if receiver is known sync object: logger.info(), path.join(), etc.
  if (ts.isIdentifier(receiverExpr)) {
    const receiverName = receiverExpr.text
    if (sets.syncReceivers.has(receiverName)) {
      return true
    }
    // Handle this.logger.info() via logger at end
    if (receiverName === 'this') {
      return false
    }
  }

  // Handle nested: this.logger.info(), this.config.get(), this.callbacks.onUpdate()
  if (ts.isPropertyAccessExpression(receiverExpr)) {
    const nestedName = receiverExpr.name.text
    if (sets.syncReceivers.has(nestedName)) {
      return true
    }
    // Also walk to the root identifier of the chain. e.g. Pyroscope.default.start()
    // — the call's receiver is `Pyroscope.default` (PropertyAccess); the rightmost
    // segment is `default`, but the SDK identity is `Pyroscope`. Walk left to find it.
    let cursor: ts.Node = receiverExpr.expression

    while (cursor && ts.isPropertyAccessExpression(cursor)) {
      cursor = cursor.expression
    }
    if (ts.isIdentifier(cursor) && sets.syncReceivers.has(cursor.text)) {
      return true
    }
  }

  // Check receiver name pattern matching (e.g. myLogger.info(), cliWriter.output())
  if (ts.isIdentifier(receiverExpr)) {
    const receiverName = receiverExpr.text.toLowerCase()
    if (KNOWN_SYNC_RECEIVER_PATTERNS.some((pattern) => receiverName.includes(pattern))) {
      return true
    }
  }

  return false
}

/**
 * Check if a function/method name matches a known synchronous prefix or suffix.
 */
function matchesSyncNamePattern(name: string, sets: EffectiveSyncSets): boolean {
  if (sets.syncPrefixes.some((prefix) => name.startsWith(prefix))) return true
  if (KNOWN_SYNC_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true
  return false
}

/**
 * Check if a call expression is to a known synchronous function
 */
function isKnownSyncCall(node: ts.CallExpression, sets: EffectiveSyncSets): boolean {
  const expr = node.expression

  // super() calls — constructor delegation, always synchronous
  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    return true
  }

  // Direct function call: functionName()
  if (ts.isIdentifier(expr)) {
    const name = expr.text
    if (
      sets.syncFunctions.has(name) ||
      FIRE_AND_FORGET_PATTERNS.has(name) ||
      matchesSyncNamePattern(name, sets)
    ) {
      return true
    }
  }

  // Method call: receiver.method()
  if (ts.isPropertyAccessExpression(expr)) {
    return isKnownSyncMethodCall(expr, sets)
  }

  return false
}

/**
 * Check if a call expression has explicit promise handling via .then/.catch/.finally chain
 */
function hasPromiseChainHandling(node: ts.ExpressionStatement): boolean {
  const expr = node.expression
  if (!ts.isCallExpression(expr)) return false

  // Check if the call itself is a .then/.catch/.finally method
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const methodName = expr.expression.name.text
    if (methodName === 'then' || methodName === 'catch' || methodName === 'finally') {
      return true
    }
  }

  return false
}

/**
 * Check if a statement is a floating expression (not assigned, awaited, or returned)
 */
function isFloatingExpression(node: ts.ExpressionStatement): boolean {
  const expr = node.expression

  // Check for void prefix: void doSomething()

  if (expr.kind === ts.SyntaxKind.VoidExpression) {
    return false // Explicitly voided
  }

  // Must be a call expression
  if (!ts.isCallExpression(expr)) return false

  // Pattern: `(await x.foo()).bar()` and similar paren-wrapped awaits with a chained call.
  // The outer call is a CallExpression whose callee descends through PropertyAccess/Element
  // access into a ParenthesizedExpression wrapping an AwaitExpression. The await is the
  // real promise consumer; the chained sync call after it is not a floating promise.
  if (containsAwaitedReceiver(expr)) return false

  // Pattern: `unwrap(await x.foo())`, `assertOk(await fn())`, `expectSuccess(await ...)`.
  // The outer call wraps an awaited promise — a sync helper that consumes a Result/value.
  // The await is the real promise consumer; the floating outer call only operates on the
  // already-resolved value. Marking the statement as floating produces false positives at
  // every boundary that uses a sync result-unwrap helper.
  if (hasAwaitedArgument(expr)) return false

  return true
}

/**
 * Return true if any direct argument of the call is an `await` expression
 * (or an `await` wrapped in parentheses / a non-null assertion). A floating
 * `outer(await inner())` statement has the await as its real promise
 * consumer; the outer sync wrapper is not a detached promise.
 */
function hasAwaitedArgument(call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    if (isAwaitedExpression(arg)) return true
  }
  return false
}

/**
 * Walk through paren-wrap / non-null-assertion noise to determine whether
 * the underlying expression is an `await`.
 */
function isAwaitedExpression(node: ts.Expression): boolean {
  let current: ts.Expression = node

  while (current) {
    if (ts.isAwaitExpression(current)) return true
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression
      continue
    }
    break
  }
  return false
}

/**
 * Walk a call expression's receiver chain and return true if it descends into
 * a `(await X)` parenthesized await. Handles `(await x.f()).g()` and longer
 * tails like `(await x.f()).g().h`.
 */
function containsAwaitedReceiver(call: ts.CallExpression): boolean {
  let current: ts.Expression = call.expression

  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      const inner = current.expression
      if (ts.isAwaitExpression(inner)) return true
      current = inner
      continue
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isCallExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression
      continue
    }
    break
  }
  return false
}

/**
 * Check if a `this.methodName()` call targets a method defined as synchronous
 * in the same class. Walks up to the enclosing class declaration, finds a
 * method with the matching name, and returns true only when it lacks the
 * `async` modifier.
 */
function isDefinedAsSyncInSameFile(expr: ts.CallExpression): boolean {
  // Must be this.method() pattern
  if (!ts.isPropertyAccessExpression(expr.expression)) return false
  const propAccess = expr.expression
  if (propAccess.expression.kind !== ts.SyntaxKind.ThisKeyword) return false

  const methodName = propAccess.name.text

  // Walk up to the enclosing class
  let current: ts.Node | undefined = expr.parent

  while (current && !ts.isClassDeclaration(current) && !ts.isClassExpression(current)) {
    current = current.parent
  }

  if (!current) return false

  // Look for a method with the same name in the class
  for (const member of current.members) {
    if (!ts.isMethodDeclaration(member)) continue
    if (!ts.isIdentifier(member.name)) continue
    if (member.name.text !== methodName) continue

    // Found the method — check if it is NOT async
    const isAsync = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    return !isAsync
  }

  return false
}

/**
 * Analyze a file for detached promise issues
 */
function analyzeFileForDetachedPromises(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip CLI command files and route registrations — dominated by sync calls in async contexts
  if (FILE_SKIP_PATTERNS.some((pattern) => filePath.includes(pattern))) {
    return violations
  }

  // Build the effective sync-call sets once per file from defaults + recipe config.
  const sets = buildEffectiveSyncSets()

  try {
    // @lazy-ok -- 'await' appears in string literals, not actual await expression
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit)

      // Only check expression statements (standalone calls ending with ;)
      if (!ts.isExpressionStatement(node)) return

      // Skip void expressions entirely (explicitly fire-and-forget)
      if (node.expression.kind === ts.SyntaxKind.VoidExpression) return

      // Skip expressions with .then/.catch/.finally chains (explicitly handled)
      if (hasPromiseChainHandling(node)) return

      // Must be a call expression
      const expr = node.expression
      if (!ts.isCallExpression(expr)) return

      // Must be inside an async context
      if (!isInAsyncContext(node)) return

      // Skip known synchronous calls
      if (isKnownSyncCall(expr, sets)) return

      // Skip this.method() calls where method is defined as sync in the same class
      if (isDefinedAsSyncInSameFile(expr)) return

      // Skip if this is a floating expression that's not a detached promise
      if (!isFloatingExpression(node)) return

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
      const lineNum = line + 1
      const matchText = node.getText(sourceFile)

      violations.push({
        line: lineNum,
        column: character + 1,
        message: 'Possible detached promise (missing await)',
        severity: 'warning',
        type: 'detached-promise',
        suggestion:
          'Add await to ensure the promise is handled, or use void with error handling if intentionally fire-and-forget',
        match: matchText,
        filePath,
      })
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: resilience/detached-promises
 *
 * Detects promises that are not awaited or handled.
 * Missing await can cause silent failures.
 *
 * Uses AST analysis to:
 * - Only flag calls inside async functions/methods
 * - Skip known synchronous functions (logger.*, ensureCorrelationIdFor, etc.)
 * - Skip fire-and-forget patterns (process.nextTick, setImmediate, etc.)
 */
export const detachedPromises = defineCheck({
  id: 'fda3b4f5-bb4f-4b77-9d0d-9103f958febb',
  slug: 'detached-promises',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect promises that may not be awaited (potential silent failures)',
  longDescription: `**Purpose:** Ensures promises inside async functions are properly awaited to prevent silent failures.

**Detects:**
- Call expressions inside async functions/methods that are neither awaited, assigned, returned, nor voided
- Excludes known synchronous functions (logger methods, array/string/object builtins, Node.js sync APIs, EventEmitter methods)
- Excludes fire-and-forget scheduling calls (\`setImmediate\`, \`setTimeout\`, \`nextTick\`)

**Why it matters:** Unhandled promises can silently swallow errors, leading to data loss or inconsistent state with no diagnostic trail.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing.`,
  tags: ['resilience', 'async', 'promises'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — detached promises in tests are low-risk
    if (isTestFile(filePath)) return []
    return analyzeFileForDetachedPromises(content, filePath)
  },
})
