// @fitness-ignore-file file-length-limit -- cohesive single-check module; splitting risks breaking the detector contract
/**
 * @fileoverview TOCTOU Race Condition Detection Check
 *
 * Detects Time-of-Check-Time-of-Use race conditions where data is read,
 * then updated without passing version/condition for atomic updates.
 *
 * Refinement notes (Wave E lane E6-redo):
 * The original implementation was a regex-only test for the presence of
 * `.get/.find/...` and `.update/.set/...` strings inside the same function
 * body. That broad pattern produced false positives on:
 *   - Local `Map.get` / `Map.set` accumulator idioms (count++ via map).
 *   - In-process cache fields (`this.#cache.get` then `this.#cache.set`)
 *     used as single-threaded coalescing structures.
 *   - Read-only DB functions that build local Maps for grouping
 *     (`db.select(...)` → `new Map().set(...)`).
 *   - Single-statement atomic SQL writes (`tx.execute(sql`UPDATE...`)`).
 *
 * Refinement strategy: classify each `.get/.set/.update/...` call by its
 * receiver. A function only flags as TOCTOU if there is at least one
 * read+update pair on a *non-local* receiver (i.e. not a local Map/Set,
 * not a "Cache"-named field, and not a tx/db where writes are atomic
 * SQL). All-local-receiver patterns are excluded.
 */


import { defineCheck, getCheckConfig, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Recipe-config shape for toctou-race-condition. Project-specific safe-paths
 * (e.g. opensip's `/chain-walker/`) belong in a recipe's
 * `checks.config['toctou-race-condition']` block, not in built-in defaults.
 */
export interface TocTouConfig extends Record<string, unknown> {
  /**
   * Additional path patterns where TOCTOU is not a concern. Each entry is
   * compiled to a case-insensitive RegExp via `new RegExp(entry, 'i')`.
   */
  additionalSafeTOCTOUPaths?: readonly string[]
}

/** Patterns that indicate proper atomic update handling */
const ATOMIC_PATTERNS = [
  /expectedVersion/i,
  /version\s*:/,
  /ConditionExpression/,
  /conditionalUpdate/i,
  /atomicUpdate/i,
  /compareAndSwap/i,
  /optimisticLock/i,
  /CONCURRENCY SAFE/,
  // Transaction patterns
  /transaction/i,
  /beginTransaction/i,
  /withTransaction/i,
  /runInTransaction/i,
  // Lock patterns
  /acquireLock/i,
  /withLock/i,
  /mutex/i,
  // Idempotency patterns
  /idempotent/i,
  /idempotencyKey/i,
  // Single-threaded/in-memory safety comments
  /single-threaded/i,
  /in-memory/i,
  /atomic in.*Node/i,
  // Documented coalescing/event-loop safety patterns commonly used in Node single-threaded code
  /single-threaded coalesce/i, // explicit coalescing-cache documentation
  /Node single-threaded/i,     // explicit Node single-threaded documentation
  /event-loop semantics/i,     // explicit event-loop atomicity documentation
]

/**
 * Paths where TOCTOU is typically not a concern
 * (in-memory caches, rate limiters, local state managers)
 */
const SAFE_TOCTOU_PATHS = [
  // In-memory data structures
  /\/cache\//i,
  /\/caching\//i,
  /memory-backend/i,
  /memory-cache/i,
  /memory-store/i,
  /in-memory/i,
  // Filename conventions — `*-cache.ts` and `*-prefetcher.ts` are
  // single-threaded coalescing structures by convention (Node event-loop
  // semantics make the .get-then-.set pattern safe). The path-segment
  // /cache/ skip above misses files at top of a package's src/ tree.
  /-cache\.tsx?$/i,
  /-prefetcher\.tsx?$/i,
  // Rate limiting (bounded operations)
  /rate-limit/i,
  /rate_limit/i,
  // Local state management
  /local-storage/i,
  /local-state/i,
  /state-manager/i,
  // CLI/scripts (single user, non-concurrent)
  // CLI commands use local Map/Set operations that are not shared-state TOCTOU risks.
  // Server lifecycle TOCTOU issues are better caught by the reentrancy-guard check.
  /\/cli\//,
  /\/scripts\//,
  // Test utilities
  /\/testing\//,
  /test-utils/,
  // Configuration/Registry (startup-time operations)
  /\/config\//,
  /\/registry\//,
  /\/di-registration\//,
  /\/factories\//,
  // Route handlers — request-scoped Map/Set ops are not shared-state TOCTOU; route handlers are dominated by Zod.pick/parse and per-request local maps that the regex misreads as TOCTOU.
  /\/routes\//,
  // DI composition — fragment graphs construct a per-startup map of providers; not concurrent shared state.
  /\/di\//,
  // Schema declarations — Drizzle/Zod schema files are pure declarative builders, no runtime read/update race surface.
  /\/schema\//,
  // NOTE: opensip-specific paths (e.g. `/chain-walker/` for audit-chain
  // walkers) are NOT defaults. They live in opensip's recipe under
  // `checks.config['toctou-race-condition'].additionalSafeTOCTOUPaths`.
]

/**
 * Compile recipe-provided string entries to case-insensitive RegExp values.
 */
function buildEffectiveSafePaths(): readonly RegExp[] {
  const cfg = getCheckConfig<TocTouConfig>('toctou-race-condition')
  const extras = (cfg.additionalSafeTOCTOUPaths ?? []).map((src) => new RegExp(src, 'i'))
  return [...SAFE_TOCTOU_PATHS, ...extras]
}

/**
 * Check if a file path is in a safe TOCTOU context. Combines built-in
 * defaults with the recipe-config augmentation.
 */
function isSafeToctouPath(filePath: string, safePaths: readonly RegExp[]): boolean {
  return safePaths.some((pattern) => pattern.test(filePath))
}

/** Read operation method names */
const READ_METHODS = new Set(['get', 'find', 'findOne', 'findFirst', 'findMany', 'getById', 'fetch', 'load', 'read'])

/** Update operation method names */
const UPDATE_METHODS = new Set(['update', 'save', 'put', 'set', 'patch', 'modify'])

/**
 * Check if content has atomic patterns
 */
function hasAtomicPatterns(content: string): boolean {
  return ATOMIC_PATTERNS.some((p) => p.test(content))
}

/**
 * Function-like node types that can have TOCTOU patterns
 */
type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression

/**
 * Get function name from a function-like node
 */
function getFunctionNameFromNode(node: FunctionLikeNode, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sourceFile) ?? 'anonymous'
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText(sourceFile)
    }
  }
  return 'anonymous'
}

/**
 * Check if node is a function-like node
 */
function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
}

/**
 * Identify TypeNodes that name an in-memory keyed collection — these are
 * not shared persistent state and read+set on them is not a TOCTOU risk.
 */
const IN_MEMORY_COLLECTION_TYPE_NAMES = new Set([
  'Map',
  'WeakMap',
  'ReadonlyMap',
  'Set',
  'WeakSet',
  'ReadonlySet',
])

function isInMemoryCollectionTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false
  if (ts.isTypeReferenceNode(typeNode)) {
    const name = typeNode.typeName
    if (ts.isIdentifier(name)) {
      if (IN_MEMORY_COLLECTION_TYPE_NAMES.has(name.text)) return true
      // Type names ending in `Cache` (e.g. `SecretsCache`) are an
      // OpenSIP-wide convention for in-process keyed coalescing
      // structures. Treating them as local-collection eliminates the
      // FP class where a service-level `cache: XCache` parameter is
      // read+written within a function body.
      if (name.text.endsWith('Cache')) return true
    }
  }
  return false
}

/**
 * Identify variable initializers that construct an in-memory collection,
 * e.g. `const counts = new Map()`, `new Set<string>()`.
 */
function isInMemoryCollectionInitializer(init: ts.Expression | undefined): boolean {
  if (!init) return false
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
    return IN_MEMORY_COLLECTION_TYPE_NAMES.has(init.expression.text)
  }
  return false
}

/**
 * Heuristic: a property access like `this.#cache`, `this.headerCache`,
 * `this._cache` is treated as an in-process cache field. The `*Cache`
 * suffix and `_cache` / `#cache` conventions are strong signals that the
 * field is a coalescing in-memory structure (single-threaded Node).
 *
 * This is intentionally narrow: only matches `this.<name>` shapes whose
 * `<name>` has the `Cache` suffix or is exactly `cache`.
 */
function isInMemoryCacheReceiverText(text: string): boolean {
  // strip a leading `#` (private field) and `_` (convention)
  const normalized = text.replace(/^[#_]/, '')
  if (normalized === 'cache') return true
  if (normalized.endsWith('Cache')) return true
  return false
}

/**
 * Collect names of local variables/parameters within a function that
 * refer to in-memory keyed collections (`Map`, `Set`, etc.). Names are
 * matched against the simple receiver of `<name>.get/set/...` calls.
 */
function collectLocalCollectionNames(node: FunctionLikeNode): Set<string> {
  const names = new Set<string>()

  // Parameters typed as Map/Set
  for (const param of node.parameters) {
    if (ts.isIdentifier(param.name) && isInMemoryCollectionTypeNode(param.type)) {
      names.add(param.name.text)
    }
  }

  // Local `const x = new Map()` / `new Set()` declarations anywhere in body.
  const visit = (n: ts.Node): void => {
    // Don't descend into nested functions — their locals belong to a
    // different scope.
    if (n !== node && isFunctionLikeNode(n)) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && (isInMemoryCollectionInitializer(n.initializer) || isInMemoryCollectionTypeNode(n.type))) {
        names.add(n.name.text)
      }
    ts.forEachChild(n, visit)
  }
  if (node.body) visit(node.body)
  return names
}

/**
 * Collect class-level field names that are initialized to an in-memory
 * collection (`new Map()` / `new Set()`). Used so that `this.#cache`-style
 * access in a method does not look like shared persistent state.
 *
 * Walks up to the containing ClassDeclaration / ClassExpression. Returns
 * the simple field name (no `#` prefix) for matching against
 * `this.<name>.get/set` receivers.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- AST walk over class members: nested type checks reflect the TypeScript AST shape
function collectClassInMemoryFieldNames(node: FunctionLikeNode): Set<string> {
  const names = new Set<string>()
  let cls: ts.Node | undefined = node.parent
  while (cls && !ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) {
    cls = cls.parent
  }
  if (!cls) return names
  const classNode = cls
  for (const member of classNode.members) {
    if (ts.isPropertyDeclaration(member)) {
      const memberName = member.name
      let fieldName: string | undefined
      if (ts.isIdentifier(memberName)) {
        fieldName = memberName.text
      } else if (ts.isPrivateIdentifier(memberName)) {
        fieldName = memberName.text.replace(/^#/, '')
      }
      if (!fieldName) continue
      if (
        isInMemoryCollectionInitializer(member.initializer) ||
        isInMemoryCollectionTypeNode(member.type)
      ) {
        names.add(fieldName)
      }
    }
  }
  return names
}

/**
 * Index file-local `interface` / `type` declarations to the set of field
 * names whose declared type is an in-memory keyed collection (`Map`/`Set`/…).
 *
 * Used to treat `<stateObj>.<mapField>.get/set(...)` as a *local-collection*
 * access. The "state bag of Maps" pattern — an interface bundling several
 * `Map`/`Set` fields, threaded as a parameter through the steps of an
 * iterative graph / DP algorithm (e.g. Tarjan SCC's `TarjanState`) — is
 * single-threaded in-memory work, not a shared-state read-then-update race.
 * The receiver `state.lowlink` is a *chained* access that the simple-receiver
 * classifier would otherwise treat conservatively as shared.
 */
function collectInterfaceCollectionFields(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>()
  const fieldsFrom = (members: ts.NodeArray<ts.TypeElement>): Set<string> => {
    const fields = new Set<string>()
    for (const member of members) {
      if (
        ts.isPropertySignature(member) &&
        ts.isIdentifier(member.name) &&
        isInMemoryCollectionTypeNode(member.type)
      ) {
        fields.add(member.name.text)
      }
    }
    return fields
  }
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      const fields = fieldsFrom(stmt.members)
      if (fields.size > 0) byType.set(stmt.name.text, fields)
    } else if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      const fields = fieldsFrom(stmt.type.members)
      if (fields.size > 0) byType.set(stmt.name.text, fields)
    }
  }
  return byType
}

/**
 * Collect `<receiver>.<field>` keys for parameters/locals whose declared type
 * is a file-local interface/type that declares `Map`/`Set` fields. Those
 * `<obj>.<field>` accesses behave like local collections (see
 * {@link collectInterfaceCollectionFields}).
 */
function collectLocalObjectCollectionFieldKeys(
  node: FunctionLikeNode,
  interfaceCollectionFields: ReadonlyMap<string, Set<string>>,
): Set<string> {
  const keys = new Set<string>()
  const addFor = (name: string, typeNode: ts.TypeNode | undefined): void => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return
    if (!ts.isIdentifier(typeNode.typeName)) return
    const fields = interfaceCollectionFields.get(typeNode.typeName.text)
    if (!fields) return
    for (const field of fields) keys.add(`${name}.${field}`)
  }
  for (const param of node.parameters) {
    if (ts.isIdentifier(param.name)) addFor(param.name.text, param.type)
  }
  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) addFor(n.name.text, n.type)
    ts.forEachChild(n, visit)
  }
  if (node.body) visit(node.body)
  return keys
}

/** Call-site classification kinds — narrow string literal alias set. */
const KIND_READ_SHARED = 'read-shared' as const
const KIND_UPDATE_SHARED = 'update-shared' as const
const KIND_READ_LOCAL = 'read-local' as const
const KIND_UPDATE_LOCAL = 'update-local' as const

/**
 * Classification of a `<receiver>.<method>(...)` call site.
 */
type CallKind =
  | { kind: typeof KIND_READ_SHARED }
  | { kind: typeof KIND_UPDATE_SHARED }
  | { kind: typeof KIND_READ_LOCAL }
  | { kind: typeof KIND_UPDATE_LOCAL }
  | { kind: 'atomic-sql-write' }
  | { kind: 'unrelated' }

/**
 * Return true if a call expression is `<tx-or-db>.execute(sql\`...\`)`
 * with a single SQL statement — those writes are atomic at the DB layer
 * (single statement, no separate read-then-update window).
 */
function isAtomicSqlExecute(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  if (call.expression.name.text !== 'execute') return false
  const arg = call.arguments[0]
  if (!arg) return false
  if (ts.isTaggedTemplateExpression(arg) && // `sql\`...\``
    ts.isIdentifier(arg.tag) && arg.tag.text === 'sql') return true
  return false
}

/**
 * Drizzle-style ORM writes. `db.update(table)`, `db.insert(table)`,
 * `db.delete(table)` each produce a single atomic SQL statement when
 * awaited — they are not separate-read-then-update sequences.
 *
 * We treat these as `atomic-sql-write` so the function is not flagged
 * unless there is an *actual* read-then-update on a shared receiver
 * elsewhere.
 */
const DRIZZLE_ATOMIC_WRITE_METHODS = new Set(['update', 'insert', 'delete'])

function isDrizzleAtomicWrite(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false
  const methodName = call.expression.name.text
  if (!DRIZZLE_ATOMIC_WRITE_METHODS.has(methodName)) return false
  // Heuristic: receiver looks like a db/tx (named `db`, `tx`, ends in `Db`/`Tx`).
  const receiver = call.expression.expression
  if (ts.isIdentifier(receiver)) {
    const r = receiver.text
    if (r === 'db' || r === 'tx' || /Db$|Tx$/.test(r)) return true
  }
  return false
}

/**
 * Get the simple receiver name from a call expression like
 * `<receiver>.method(...)`. For `this.<name>.method(...)` returns
 * `this.<name>` collapsed; for `<id>.method(...)` returns `<id>`.
 * Returns null if the receiver isn't a simple identifier or this-property.
 */
function getReceiverName(call: ts.CallExpression): { name: string; isThisField: boolean } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  const receiver = call.expression.expression
  if (ts.isIdentifier(receiver)) {
    return { name: receiver.text, isThisField: false }
  }
  if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return { name: receiver.name.text, isThisField: true }
  }
  // `<id>.<field>.method()` — a dotted receiver key (e.g. `state.lowlink`).
  // Keying per `<id>.<field>` is strictly more precise than the old
  // "deep chain → unknown receiver" fallback: a read on `x.a` and an update
  // on `x.b` no longer collide, and it lets the classifier match a
  // state-object's Map/Set field against the local-collection key set.
  if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    return { name: `${receiver.expression.text}.${receiver.name.text}`, isThisField: false }
  }
  return null
}

/**
 * Classify a single call expression for TOCTOU purposes.
 */
function classifyCall(
  call: ts.CallExpression,
  ctx: {
    localCollections: Set<string>
    classCacheFields: Set<string>
    localObjectCollectionKeys: Set<string>
  },
): CallKind {
  // First, atomic SQL writes anywhere short-circuit.
  if (isAtomicSqlExecute(call)) return { kind: 'atomic-sql-write' }
  if (isDrizzleAtomicWrite(call)) return { kind: 'atomic-sql-write' }

  if (!ts.isPropertyAccessExpression(call.expression)) return { kind: 'unrelated' }
  const methodName = call.expression.name.text
  const isRead = READ_METHODS.has(methodName)
  const isUpdate = UPDATE_METHODS.has(methodName)
  if (!isRead && !isUpdate) return { kind: 'unrelated' }

  const receiver = getReceiverName(call)
  if (!receiver) {
    // chained / non-simple receiver — treat as shared
    return { kind: isRead ? KIND_READ_SHARED : KIND_UPDATE_SHARED }
  }

  if (isLocalReceiver(receiver, ctx)) {
    return { kind: isRead ? KIND_READ_LOCAL : KIND_UPDATE_LOCAL }
  }
  return { kind: isRead ? KIND_READ_SHARED : KIND_UPDATE_SHARED }
}

/**
 * Decide whether a classified receiver refers to a local in-memory collection
 * (so reads/updates on it are not shared-state TOCTOU). Covers: local
 * `Map`/`Set` names, the `<stateObj>.<mapField>` "state bag" key, `this.<cache>`
 * class fields, and the `cache`-named convention.
 */
function isLocalReceiver(
  receiver: { name: string; isThisField: boolean },
  ctx: {
    localCollections: Set<string>
    classCacheFields: Set<string>
    localObjectCollectionKeys: Set<string>
  },
): boolean {
  if (receiver.isThisField) {
    return ctx.classCacheFields.has(receiver.name) || isInMemoryCacheReceiverText(receiver.name)
  }
  return (
    ctx.localCollections.has(receiver.name) ||
    // `<stateObj>.<mapField>` dotted key resolved to a file-local interface/
    // type whose field is a Map/Set — the "state bag" pattern.
    ctx.localObjectCollectionKeys.has(receiver.name) ||
    // bare `cache` / `<X>Cache` naming convention.
    isInMemoryCacheReceiverText(receiver.name)
  )
}

/**
 * Walk a function body and classify every call expression.
 *
 * Tracks reads and updates *per receiver* — TOCTOU is fundamentally
 * read-X-then-update-X on the same shared object. A function with a
 * read on receiver A and an update on receiver B is not a TOCTOU.
 */
/* eslint-disable sonarjs/cognitive-complexity -- TOCTOU classifier and its inner AST visitor: branches reflect AST node taxonomy; flatter shape would hide the read/update pairing logic */
function classifyFunctionCalls(
  node: FunctionLikeNode,
  localCollections: Set<string>,
  classCacheFields: Set<string>,
  localObjectCollectionKeys: Set<string>,
): { hasSharedReadAndUpdateOnSameReceiver: boolean } {
  const ctx = { localCollections, classCacheFields, localObjectCollectionKeys }
  // receiver-key → { read, update }. Receiver-key is `<name>` for plain
  // identifiers and `this.<name>` for this-field accesses.
  const perReceiver = new Map<string, { read: boolean; update: boolean }>()
  let hasReadOnUnknownReceiver = false
  let hasUpdateOnUnknownReceiver = false

  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return
    if (ts.isCallExpression(n)) {
      const cls = classifyCall(n, ctx)
      if (cls.kind === 'read-shared' || cls.kind === 'update-shared') {
        const recv = getReceiverName(n)
        if (recv) {
          const key = recv.isThisField ? `this.${recv.name}` : recv.name
          let entry = perReceiver.get(key)
          if (!entry) {
            entry = { read: false, update: false }
            perReceiver.set(key, entry)
          }
          if (cls.kind === 'read-shared') entry.read = true
          else entry.update = true
        } else {
          if (cls.kind === 'read-shared') hasReadOnUnknownReceiver = true
          else hasUpdateOnUnknownReceiver = true
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  if (node.body) visit(node.body)

  for (const entry of perReceiver.values()) {
    if (entry.read && entry.update) {
      return { hasSharedReadAndUpdateOnSameReceiver: true }
    }
  }
  // Conservative fallback: if we have unknown-receiver reads paired with
  // unknown-receiver updates, treat as shared (chained / dynamic call).
  if (hasReadOnUnknownReceiver && hasUpdateOnUnknownReceiver) {
    return { hasSharedReadAndUpdateOnSameReceiver: true }
  }
  return { hasSharedReadAndUpdateOnSameReceiver: false }
}
/* eslint-enable sonarjs/cognitive-complexity */

/**
 * Options for checking a function for TOCTOU patterns
 */
interface CheckFunctionForToctouOptions {
  node: FunctionLikeNode
  sourceFile: ts.SourceFile
  /** File-local interface/type → Map/Set field names (computed once per file). */
  interfaceCollectionFields: ReadonlyMap<string, Set<string>>
}

/**
 * Check a function for TOCTOU patterns
 */
function checkFunctionForToctou(options: CheckFunctionForToctouOptions): CheckViolation | null {
  const { node, sourceFile, interfaceCollectionFields } = options
  if (!node.body) return null

  // Atomic-comment escape hatch retained from the regex implementation —
  // a function (or its surrounding scope) that documents single-threaded
  // / coalescing semantics is treated as safe.
  const funcText = node.getText(sourceFile)
  if (hasAtomicPatterns(funcText)) return null

  const localCollections = collectLocalCollectionNames(node)
  const classCacheFields = collectClassInMemoryFieldNames(node)
  const localObjectCollectionKeys = collectLocalObjectCollectionFieldKeys(
    node,
    interfaceCollectionFields,
  )
  const { hasSharedReadAndUpdateOnSameReceiver } = classifyFunctionCalls(
    node,
    localCollections,
    classCacheFields,
    localObjectCollectionKeys,
  )

  if (!hasSharedReadAndUpdateOnSameReceiver) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const funcName = getFunctionNameFromNode(node, sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `Function '${funcName}' has read-then-update pattern without atomic guarantees`,
    severity: 'warning',
    suggestion:
      'Use optimistic locking: pass expectedVersion to update, or use ConditionExpression for DynamoDB, or wrap in a transaction with SELECT FOR UPDATE for SQL',
    match: funcName,
  }
}

/**
 * Analyze a file for TOCTOU race conditions. Exported for the FP-regression
 * suite (see `__tests__/toctou-fp.test.ts`).
 */
export function analyzeFileForToctou(filePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip files in safe TOCTOU paths (caches, rate limiters, CLI, etc.).
  // Merge built-in defaults with recipe config once per file.
  const safePaths = buildEffectiveSafePaths()
  if (isSafeToctouPath(filePath, safePaths)) {
    return violations
  }

  // Skip if the whole file documents atomic / single-threaded semantics.
  if (hasAtomicPatterns(content)) {
    return violations
  }

  const sourceFile = getSharedSourceFile(filePath, content)
  if (!sourceFile) return []

  const interfaceCollectionFields = collectInterfaceCollectionFields(sourceFile)

  const visit = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) {
      const violation = checkFunctionForToctou({ node, sourceFile, interfaceCollectionFields })
      if (violation) {
        violations.push(violation)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/toctou-race-condition
 *
 * Detects read-then-update patterns without atomic guarantees.
 */
export const toctouRaceCondition = defineCheck({
  id: 'eb67d6f3-c984-485d-b077-1ebabea0d894',
  slug: 'toctou-race-condition',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects read-then-update patterns without atomic guarantees',
  longDescription: `**Purpose:** Detects Time-of-Check-Time-of-Use (TOCTOU) race conditions where data is read then updated without atomic guarantees.

**Detects:** Walks the TypeScript AST per-function. Flags a function only when both (a) at least one read call (\`.get(\`, \`.find(\`, \`.findOne(\`, \`.findFirst(\`, \`.findMany(\`, \`.getById(\`, \`.fetch(\`, \`.load(\`, \`.read(\`) and (b) at least one update call (\`.update(\`, \`.save(\`, \`.put(\`, \`.set(\`, \`.patch(\`, \`.modify(\`) target a *shared* receiver — i.e. neither a local \`Map\`/\`Set\` declared in the function nor a parameter typed \`Map<...>\`/\`Set<...>\`, nor a class field initialized to \`new Map()\`/\`new Set()\`, nor a cache-named field (\`this.cache\`, \`this.#cache\`, \`this.<X>Cache\`). Single-statement atomic SQL writes (\`tx.execute(sql\`UPDATE...\`)\`, \`tx.update(table)\`, \`tx.insert(table)\`, \`tx.delete(table)\`) are not counted as the "update" side. Skips safe contexts: in-memory caches, rate limiters, CLI/scripts, config/registry files, and functions whose body documents atomic / single-threaded semantics (\`single-threaded coalesce\`, \`Node single-threaded\`, \`event-loop semantics\`).

**Why it matters:** TOCTOU bugs allow concurrent requests to overwrite each other's changes, causing silent data loss that only manifests under load.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'best-practices'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000, // 3 minutes - analyzes read-then-update patterns

  analyze(content, filePath) {
    // Skip test files — TOCTOU patterns in tests are low-risk
    if (isTestFile(filePath)) return []
    return analyzeFileForToctou(filePath, content)
  },
})
