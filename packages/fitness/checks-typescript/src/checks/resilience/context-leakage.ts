/**
 * @fileoverview Context leakage detection — flags request-scoped state stored
 * in module or class scope that can leak between concurrent requests.
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

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
