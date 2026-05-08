// @fitness-ignore-file file-length-limits -- Fitness check with extensive sync function/receiver whitelists for false positive suppression
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file canonical-result-usage -- References Result pattern in comments and regex patterns for detection, not actual Result usage
/**
 * @fileoverview Async pattern resilience checks
 */

import * as ts from 'typescript'

import { defineCheck, getCheckConfig, type CheckViolation, getLineNumber } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'
import { isCommentLine, isTestFile } from '../../utils/index.js'

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

const DETACHED_PROMISES_SLUG = 'detached-promises'

// =============================================================================
// DETACHED PROMISES (AST-based)
// =============================================================================

/**
 * Known synchronous functions that do NOT return promises.
 * These are commonly flagged as false positives.
 */
const KNOWN_SYNC_FUNCTIONS = new Set([
  // Correlation ID helpers (synchronous)
  'ensureCorrelationIdFor',
  'ensureCorrelationId',
  'generateCorrelationId',
  'getCorrelationId',
  'setCorrelationId',
  // Logger methods (synchronous - write to buffer)
  'info',
  'error',
  'warn',
  'debug',
  'trace',
  'fatal',
  'child',
  // CLI output helpers (synchronous)
  'outputStep',
  'output',
  'outputSuccess',
  'outputError',
  'outputWarning',
  'outputInfo',
  'chalk',
  // Node.js sync methods
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
  // Registration/setup functions (synchronous)
  'register',
  'registerRoutes',
  'registerManifestEndpoint',
  'use',
  'addHook',
  'decorate',
  'decorateRequest',
  'decorateReply',
  // Fastify/HTTP framework (synchronous — framework manages promise lifecycle)
  'send',
  'code',
  'status',
  'header',
  'headers',
  'type',
  'redirect',
  'route',
  'put',
  'patch',
  'head',
  'options',
  'all',
  'post',
  // Type guards, assertions, and lifecycle guards (synchronous)
  'assert',
  'assertNever',
  'invariant',
  'ensureInitialized',
  'ensureNotDisposed',
  'validateIterations',
  'checkHandlerLimit',
  'enqueueUpdate',
  // Error wrapping (synchronous)
  'wrapError',
  // Lifecycle/cleanup methods (synchronous)
  'release',
  'releaseLock',           // Web Streams ReadableStreamReader.releaseLock — sync, returns void
  'reset',
  'reject',
  'resolve',
  'abort',
  'cancel',
  'dispose',
  'close',
  'destroy',
  'stop',
  'pause',
  'resume',
  'cleanup',               // Common sync lifecycle — process-host CrashGuards.cleanup, etc.
  'unref',                 // Node Timer/Immediate/Socket.unref — sync, returns the handle
  'kill',                  // Node ChildProcess.kill — synchronous signal dispatch, returns boolean
  // OpenTelemetry / context propagation helpers (generic OTel surface)
  'inject',                // OTel TextMapPropagator.inject — sync header injection
  'observe',               // OTel ObservableResult.observe (gauge callback) — sync record
  // NOTE: opensip-specific OTel/error helpers — `attachDomainContext`,
  // `attachProfileIdToSpan`, `sendError`, `finalizeError` — are NOT defaults.
  // They live in opensip's recipe under `checks.config['detached-promises']
  // .additionalSyncFunctions`. See packages/core/src/recipes/check-config.ts.
  // Pyroscope per-profiler starters — sync, returns void (Pyroscope.default.startWallProfiling/startHeapProfiling)
  'startWallProfiling',
  'startHeapProfiling',
  'startCpuProfiling',
  // Timer clearing (synchronous)
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  // Middleware/iterator next (synchronous callback dispatch)
  'next',
  // Queue/state management (synchronous triggers)
  'processQueue',
  'initialize',
  'markInitialized',
  'updateTimerRef',
  'setCorrelationContext',
  'end',
  // Metrics/stats recording (synchronous counters)
  'recordError',
  'recordDuration',
  'recordRequest',
  'increment',
  'decrement',
  'gauge',
  'histogram',
  // Array methods returning new arrays (synchronous)
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
  // JSON methods (synchronous)
  'stringify',
  'parse',
  // Math methods (synchronous)
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
  // Console methods (synchronous - but also flagged by other checks)
  'log',
  'time',
  'timeEnd',
  // Builder pattern terminators (synchronous returns)
  'build',
  'toJSON',
  'toString',
  'valueOf',
  // Vitest/Jest test framework (synchronous)
  'describe',
  'it',
  'test',
  'expect',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'vi',
  // Vitest/Jest assertion methods (synchronous)
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeTruthy',
  'toBeFalsy',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toHaveBeenCalled',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toThrow',
  'toThrowError',
  'toMatch',
  'toMatchObject',
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeInstanceOf',
  // Vitest/Jest mock methods (synchronous)
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
  'mockImplementation',
  'mockImplementationOnce',
  'mockClear',
  'mockReset',
  'mockRestore',
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
  // Set/Map methods (synchronous)
  'add',
  'delete',
  'has',
  'clear',
  'get',
  'set',
  'size',
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
 * Known synchronous receiver patterns.
 * When the receiver (object before the dot) matches these, the call is likely sync.
 */
const KNOWN_SYNC_RECEIVERS = new Set([
  // Logging/output (synchronous — write to buffer)
  'logger',
  'log',
  'console',
  'chalk',
  'cli',
  'writer',
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
  // Built-in collection instances (synchronous)
  'map',
  'set',
  'array',
  // Database (Drizzle/better-sqlite3 is synchronous)
  'db',
  // Context/config/state (synchronous property access)
  'ctx',
  'context',
  'config',
  'options',
  'opts',
  'props',
  'state',
  'callbacks',
  // Metrics/observability (synchronous counters)
  'metrics',
  'stats',
  // OTel context propagation API — propagation.inject/extract are synchronous
  'propagation',
  // Pyroscope profiling SDK — Pyroscope.start/.default.startWallProfiling/.startHeapProfiling are all sync (returns void)
  'Pyroscope',
  // HTTP response objects (synchronous — framework handles promise)
  'res',
  'reply',
  // Fastify instance (registration methods are synchronous)
  'fastify',
  'app',
  'server',
  // Test framework (synchronous)
  'expect',
  'vi',
  'jest',
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
 * Method name prefixes that indicate synchronous guard/assertion/validation calls.
 * Methods starting with these prefixes are overwhelmingly synchronous in practice
 * and should not be flagged as detached promises.
 */
const KNOWN_SYNC_PREFIXES = [
  // Guard/assertion/validation prefixes
  'ensure',
  'validate',
  'check',
  'assert',
  // Property accessors & mutators
  'set',
  'get',
  'add',
  'remove',
  'delete',
  'clear',
  'reset',
  // Registration & lifecycle
  'register',
  'unregister',
  'init',          // initX() / initialize() — DBOS step .init(deps), initConnection, initSipPipelineSteps, etc. are all synchronous wiring helpers
  // In-memory upsert helpers (upsertProfile and similar mutate sync stores). DB upserts are typically called via
  // explicit await on a Result-returning method, so the prefix-based whitelist here trades a small precision loss
  // for ~10× FP reduction on these helper patterns.
  'upsert',
  // Event system
  'emit',
  'dispatch',
  'publish',
  'subscribe',
  'unsubscribe',
  'on',
  'off',
  'once',
  // Logging (covers log, logError, logWarning, etc.)
  'log',
  'debug',
  'info',
  'warn',
  'error',
  'trace',
  // Boolean predicates
  'is',
  'has',
  'can',
  'should',
  'was',
  'will',
  // Queue/state management
  'enqueue',
  'record',
  'mark',
  'wrap',
  'build',
  'apply',
  'evict',
  'invalidate',
  'deliver',
  'notify',
  // Metric counter increments — incrementXxx is universally synchronous
  'increment',
  // Validation/floor enforcement — enforceXxx throws on violation, sync
  'enforce',
  // DI wiring helpers — wireXxx wires composition, sync
  'wire',
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
  const cfg = getCheckConfig<DetachedPromisesConfig>(DETACHED_PROMISES_SLUG)
  const fns = new Set(KNOWN_SYNC_FUNCTIONS)
  for (const name of cfg.additionalSyncFunctions ?? []) fns.add(name)
  const recvs = new Set(KNOWN_SYNC_RECEIVERS)
  for (const name of cfg.additionalSyncReceivers ?? []) recvs.add(name)
  const prefixes = [...KNOWN_SYNC_PREFIXES, ...(cfg.additionalSyncPrefixes ?? [])]
  return { syncFunctions: fns, syncReceivers: recvs, syncPrefixes: prefixes }
}

/**
 * Check if a node is inside an async function or method
 */
function isInAsyncContext(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AST traversal: parent is undefined at SourceFile root despite Node type
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return !!current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    }
    if (ts.isMethodDeclaration(current)) {
      return !!current.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    }
    current = current.parent
  }
  return false
}

/**
 * Check if a method call expression is to a known synchronous receiver or method.
 */
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AST walk
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime guard: VoidExpression wrapping is not reflected in static ts.Expression union
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AST traversal; loop body reassigns current
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- AST traversal terminates when current is no longer a chained access
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- current is reassigned in loop body; TypeScript cannot statically prove it remains truthy
  while (current && !ts.isClassDeclaration(current) && !ts.isClassExpression(current)) {
    current = current.parent
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop may exit with undefined current
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

// =============================================================================
// NO UNBOUNDED CONCURRENCY
// =============================================================================

/**
 * Pattern indicating unbounded Promise.all usage.
 * Safe regex: uses word boundaries and explicit character classes, no nested quantifiers.
 */
const UNBOUNDED_PROMISE_ALL_PATTERN = /Promise\.all\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\.map\s*\(/g

/**
 * Check if content contains bounded concurrency patterns.
 * @param {string} content - The content to check
 * @returns {boolean} True if bounded patterns found
 */
function hasBoundedConcurrencyPattern(content: string): boolean {
  const lowerContent = content.toLowerCase()
  // Check simple string patterns first (faster)
  if (lowerContent.includes('plimit')) return true
  if (lowerContent.includes('p-limit')) return true
  if (content.includes('Promise.allSettled')) return true
  // Check regex patterns
  if (/concurrency:\s*\d+/i.test(content)) return true
  if (/\b(?:chunk|batch)\b/i.test(content)) return true
  if (/\b(?:throttle|rateLimit)\b/i.test(content)) return true
  return false
}

/**
 * Check: resilience/no-unbounded-concurrency
 *
 * Detects Promise.all with .map() that may spawn unbounded concurrent operations.
 */
export const noUnboundedConcurrency = defineCheck({
  id: 'fc2a0fee-8374-432b-a7ef-763aea867855',
  slug: 'no-unbounded-concurrency',
  description: 'Detect Promise.all with unbounded concurrency',
  longDescription: `**Purpose:** Prevents unbounded parallel execution that can overwhelm downstream services or exhaust system resources.

**Detects:**
- \`Promise.all(items.map(\` pattern without nearby concurrency controls
- Skips files containing bounded concurrency indicators: \`plimit\`, \`p-limit\`, \`Promise.allSettled\`, \`concurrency: N\`, \`chunk\`, \`batch\`, \`throttle\`, \`rateLimit\`

**Why it matters:** Mapping an unbounded array into concurrent promises can spawn thousands of simultaneous operations, causing connection exhaustion or OOM.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'async', 'concurrency'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Skip files that don't use Promise.all
    if (!content.includes('Promise.all')) {
      return violations
    }

    // Check if file has bounded concurrency patterns
    if (hasBoundedConcurrencyPattern(content)) {
      return violations
    }

    UNBOUNDED_PROMISE_ALL_PATTERN.lastIndex = 0
    let match
    while ((match = UNBOUNDED_PROMISE_ALL_PATTERN.exec(content)) !== null) {
      // @lazy-ok -- 'await' appears in suggestion string literal, not actual await
      // Check context around match for bounded patterns
      const start = Math.max(0, match.index - 200)
      const end = Math.min(content.length, match.index + 200)
      const context = content.substring(start, end)

      if (!hasBoundedConcurrencyPattern(context)) {
        const lineNumber = getLineNumber(content, match.index)
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'Promise.all with .map() may spawn unbounded concurrent operations',
          severity: 'warning',
          suggestion:
            'Use p-limit or batch processing to limit concurrency. Example: const limit = pLimit(10); await Promise.all(items.map(item => limit(() => process(item))))',
          match: match[0],
          type: 'unbounded-promise-all',
          filePath,
        })
      }
    }

    return violations
  },
})

// =============================================================================
// NO RAW FETCH
// =============================================================================

/**
 * Pattern for detecting raw fetch() calls.
 *
 * Safe regex: bounded whitespace + a single negative lookbehind that
 * rejects any identifier-char or `.` immediately before `fetch`. The
 * lookbehind excludes both larger identifiers ending in `fetch`
 * (`prefetch`, `recordReconcilerPrefetch`, `MyClass.fetch`) AND any
 * dotted call (`this.fetch`, `cacheGit.fetch`, `httpClient.fetch`) in
 * one rule — there's no need for a separate `this.` exclusion.
 *
 * The previous form `(?<!this\.)fetch...` had no word-boundary on the
 * left, so anything ending in `fetch(` matched (false positives on
 * `prefetch(`, `recordReconcilerPrefetch(`, etc.).
 */
const RAW_FETCH_PATTERN = /(?<![\w$.])fetch\s{0,10}\(/g

/**
 * Check: resilience/no-raw-fetch
 *
 * Detects direct use of fetch() without retry/timeout wrapper.
 */
export const noRawFetch = defineCheck({
  id: 'cfeba2d8-0f62-4b64-b625-f5ba8a0f3b11',
  slug: 'no-raw-fetch',
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],
  description: 'Detect direct fetch() calls that should use wrapped HTTP clients',
  longDescription: `**Purpose:** Enforces use of the platform HTTP client wrapper instead of raw \`fetch()\` calls.

**Detects:**
- Bare \`fetch(\` calls via regex \`(?<![\\w$.])fetch\\s{0,10}\\(\` (excludes any \`<ident>.fetch\` method call AND any larger identifier ending in \`fetch\`, e.g. \`prefetch\`)
- Skips comment lines

**Why it matters:** Raw \`fetch()\` lacks built-in retry, timeout, observability, and error normalization that the canonical HttpClient provides.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['resilience', 'http', 'fetch'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Quick check: skip files that don't contain fetch
    if (!content.includes('fetch(')) {
      return violations
    }

    // Skip the resilient fetch wrapper itself — this IS the raw fetch implementation
    if (filePath.includes('resilient-fetch') || filePath.includes('resilient_fetch')) {
      return violations
    }

    // Skip test files — tests legitimately invoke `fetch(` directly to
    // exercise the wrapper, mock the global, or hit a localhost test
    // server. Routing those through the wrapper would defeat the test.
    if (
      filePath.endsWith('.test.ts') ||
      filePath.endsWith('.test.tsx') ||
      filePath.endsWith('.test.js') ||
      filePath.endsWith('.test.jsx') ||
      filePath.endsWith('.spec.ts') ||
      filePath.endsWith('.spec.tsx') ||
      filePath.includes('/__tests__/')
    ) {
      return violations
    }

    // Skip fitness check definitions that reference fetch in string/regex patterns
    if (filePath.includes('/fitness/src/checks/')) {
      return violations
    }

    // Skip LLM adapter files — infrastructure boundary making direct API calls
    if (filePath.includes('/llm/') || filePath.includes('/llm-adapter')) {
      return violations
    }

    // Skip SSE/streaming implementations that require raw fetch for stream parsing
    if (
      content.includes('ReadableStream') ||
      content.includes('text/event-stream') ||
      content.includes('EventSource') ||
      content.includes('getReader()')
    ) {
      return violations
    }

    const lines = content.split('\n')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? ''

      // Skip comment lines
      if (isCommentLine(line)) {
        continue
      }

      RAW_FETCH_PATTERN.lastIndex = 0
      let match
      while ((match = RAW_FETCH_PATTERN.exec(line)) !== null) {
        violations.push({
          line: lineNum + 1,
          column: match.index,
          message: 'Raw fetch() usage detected',
          severity: 'warning',
          suggestion: 'Use a shared HTTP client wrapper with built-in retry, timeout, and error handling instead of raw fetch()',
          match: match[0],
          filePath,
        })
      }
    }

    return violations
  },
})

// =============================================================================
// AWAIT RESULT UNWRAP
// =============================================================================

/**
 * Pattern to detect async call followed by .unwrap().
 * Safe regex: uses explicit character classes, no nested quantifiers.
 */
const ASYNC_CALL_UNWRAP_PATTERN = /\.[a-zA-Z_$][a-zA-Z0-9_$]*\([^)]*\)\s*\.unwrap\s*\(\)/

/**
 * Check: resilience/await-result-unwrap
 *
 * Detects potential missing await before .unwrap() on async results.
 */
export const awaitResultUnwrap = defineCheck({
  id: 'f0cd1ad8-edea-42dc-b245-4f2a80bc56a0',
  slug: 'await-result-unwrap',
  disabled: true,
  description: 'Detect potential missing await before .unwrap() on async results',
  longDescription: `**Purpose:** Catches missing \`await\` before calling \`.unwrap()\` on async Result values, which would unwrap a Promise instead of the Result.

**Detects:**
- Lines containing \`.unwrap()\` without \`await\` keyword, where the preceding expression matches \`.methodName(args).unwrap()\`
- Only flags files that also contain \`async\` or \`await\` keywords

**Why it matters:** Calling \`.unwrap()\` on an unresolved Promise instead of a Result silently produces \`undefined\` or throws unexpectedly, bypassing the Result error-handling pattern.

**Scope:** Codebase-specific convention (Result pattern). Analyzes each file individually via regex.`,
  tags: ['resilience', 'async', 'result-pattern'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = []

    // Skip files that don't use unwrap
    if (!content.includes('.unwrap(')) {
      return violations
    }

    // Skip files that don't have async context
    if (!content.includes('async ') && !content.includes('await ')) {
      // @lazy-ok -- 'await' is in string literals, not actual await
      return violations
    }

    const lines = content.split('\n')

    // Pre-filter lines that have .unwrap() without await
    const candidateLines = lines // @lazy-ok -- 'await' is in string comparisons, not actual await
      .map((line, i) => ({ line, index: i }))
      .filter(({ line }) => {
        if (!line) return false
        return line.includes('.unwrap()') && !line.includes('await')
      })

    // @fitness-ignore-next-line performance-anti-patterns -- 'await' appears in comments and string literals within this loop, not actual await expressions
    for (const { line, index: i } of candidateLines) {
      // Check if the line has an async call before unwrap
      const asyncMatch = line.match(ASYNC_CALL_UNWRAP_PATTERN)
      if (!asyncMatch) {
        continue
      }

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: line.indexOf('.unwrap'),
        message: 'Potential missing await before .unwrap() on async result',
        severity: 'warning',
        suggestion:
          'Add await if the Result is from an async function: `const result = await someAsyncFn(); result.unwrap();` or `(await someAsyncFn()).unwrap()`',
        match: asyncMatch[0],
        type: 'missing-await-unwrap',
        filePath,
      })
    }

    return violations
  },
})
