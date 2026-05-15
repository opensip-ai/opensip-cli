// @fitness-ignore-file file-length-limits -- Fitness check with TypeScript AST traversal and interface consistency analysis
// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file interface-implementation-consistency -- Fitness check definition file; references interface patterns for detection, not actual implementations
// @fitness-ignore-file performance-anti-patterns -- sequential file reading and bounded violation loops; not hot paths
/**
 * @fileoverview Interface Implementation Consistency check
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

// Pre-compiled regex patterns for better performance and to avoid ReDoS
// Using bounded quantifiers to prevent super-linear runtime
// Note: the interface header may span multiple lines (a generic-parameter
// declaration on one line, `extends OtherIface<TParam> {` on the next). The
// regex matches the first line; the parser scans forward for an `extends`
// clause until it finds `{`. See `tryStartInterface` / `parseInterfaces`.
//
// The `extends` capture uses a greedy character class that includes `<>`
// so generic type arguments (e.g. `extends IFoo<TParam>`) are captured
// alongside the bare name. `parseTypeList` / `stripGenerics` handle the
// downstream normalisation.
const INTERFACE_PATTERN =
  /^(?:export\s+)?interface\s+(\w+)(?:<[^>]{1,200}>)?(?:\s+extends\s+([\w,\s<>]+))?/
// Standalone `extends` clause continuation for multi-line interface headers
// — captures the type list (which may include generics like
// `IFoo<TParam>, IBar`).
// eslint-disable-next-line sonarjs/slow-regex -- anchored line match with bounded prefix; `[\w,\s<>]+?` is followed by `\s*\{?\s*$` and exhausts on bounded input
const INTERFACE_EXTENDS_CONTINUATION = /^\s{0,40}extends\s+([\w,\s<>]+?)\s*\{?\s*$/
const CLASS_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- single regex captures class name + optional extends + optional implements; splitting requires multiple anchored matches
  /^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+(?:<[^>]{1,200}>)?)?(?:\s+implements\s+([\w,\s<>]+))?/
const METHOD_IN_INTERFACE_PATTERN = /^\s{0,20}(\w+)\??\s{0,5}\(/
const METHOD_IN_CLASS_PATTERN =
  /^\s{0,20}(?:(?:public|private|protected)\s+)?(?:async\s+)?(?:static\s+)?(\w+)\s{0,5}\(/
// Detects the `static` modifier on a class method declaration (after any
// visibility modifier and before the method name). Interfaces cannot declare
// statics, so `static fromX()` factories must be skipped — comparing them
// against an interface's instance methods is always a false positive.
const STATIC_MODIFIER_PATTERN =
  /^\s{0,20}(?:(?:public|private|protected)\s+)?(?:async\s+)?static\s+\w+\s{0,5}\(/

// Pre-compiled patterns for isMethodDefinition
const VISIBILITY_MODIFIER_PATTERN = /^(?:public|protected)\s/
const ASYNC_STATIC_METHOD_PATTERN = /^(?:async|static)\s{1,5}[a-zA-Z_]\w{0,99}\s{0,5}\(/
const TYPE_ANNOTATION_PATTERN = /\):\s{0,5}[a-zA-Z]/
const METHOD_BODY_PATTERN = /\)\s{0,5}\{/
const CLASS_LEVEL_METHOD_PATTERN = /^[a-zA-Z_]\w{0,99}\s{0,5}\(/

interface InterfaceDefinition {
  name: string
  methods: string[]
  extends: string[]
  startLine: number
  file: string
}

interface ClassImplementation {
  name: string
  implements: string[]
  methods: string[]
  startLine: number
  file: string
}

interface ConsistencyIssue {
  file: string
  line: number
  type: 'extra-method' | 'missing-method'
  name: string
  message: string
  severity: 'error' | 'warning'
}

const JS_KEYWORDS = new Set([
  'if',
  'else',
  'while',
  'for',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'void',
  'in',
  'of',
  'function',
  'class',
  'extends',
  'super',
  'this',
  'import',
  'export',
  'default',
  'const',
  'let',
  'var',
  'await',
  'yield',
  'static',
  'get',
  'set',
  'async',
])

const ALLOWED_EXTRA_METHODS = new Set([
  'dispose',
  'destroy',
  'cleanup',
  'close',
  'shutdown',
  'terminate',
  'initialize',
  'init',
  'setup',
  'configure',
  'start',
  'stop',
  'toJSON',
  'toString',
  'valueOf',
  'clone',
  'copy',
  'getStatus',
  'getStats',
  'getHealthStatus',
  'getMetrics',
  'getSuccessRate',
  'subscribe',
  'unsubscribe',
  'publish',
  'emit',
  'on',
  'off',
  'once',
  'listeners',
  'recordMetric',
  'recordMetrics',
  'flush',
  'recordActivity',
  'exists',
  'validate',
  'isValid',
  'isExpired',
  'isEnabled',
  'validateRecipient',
  'send',
  'receive',
  'healthCheck',
  'isHealthy',
  'getDeliveryStatus',
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'log',
  'authenticate',
  'refresh',
  'revoke',
  'invalidate',
  'invalidateAll',
  'clearCache',
  'warmCache',
  'getCacheStats',
  'getCacheStatistics',
  'getConfig',
  'clear',
  'reset',
  'resetMetrics',
  'getInstance',
  'isInitialized',
  'getInitializationState',
  'getName',
  'getLogLevel',
  'hasTarget',
  'getFilePath',
  'getLogGroupName',
  'listDomains',
  'listPolicies',
  'isRegistered',
  'create',
  'createWithStoreConfig',
  'createStore',
  'createAlgorithmStrategy',
  'createStoreStrategy',
  'createValidationStrategy',
  'getProviderInstance',
  'add',
  'remove',
  'getChildren',
  'getComponentInfo',
  'getMostUsedFallback',
  'hasHealthCheck',
  'hasFallback',
  'isSensitiveField',
  'recommendStrategy',
  'supportsTimestamp',
  'getConnectionStatus',
  'updateConnectionStatus',
  'getPermissions',
  'addPermission',
  'removePermission',
  'getHealthCheckError',
  'getAllEvents',
  'archiveEvents',
  'listObjects',
  'setProvider',
  'setSecret',
  'deleteSecret',
  'getAllSessions',
  'createSession',
  'query',
  'getEventCount',
  'size',
  'createInvalidation',
  'getInvalidation',
  'waitForInvalidation',
  'createRateLimiter',
  'fromConfig',
  'createCacheKey',
  'toEnvVarName',
])

/**
 * Strips generic type-parameter clauses from a type reference. Handles
 * nested generics (`Foo<Bar<Baz>>`) by repeatedly removing innermost
 * `<...>` until idempotent. Used both for resolving interface lookups
 * (`IFoo<T>` -> `IFoo`) and for the `extends` / `implements` clause text
 * which may carry generic args.
 */
function stripGenerics(typeRef: string): string {
  let prev = typeRef
  for (;;) {
    const next = prev.replaceAll(/<[^<>]*>/g, '')
    if (next === prev) return next.trim()
    prev = next
  }
}

function countBraces(line: string): { open: number; close: number } {
  let open = 0
  let close = 0
  for (const char of line) {
    if (char === '{') open++
    if (char === '}') close++
  }
  return { open, close }
}

interface ParseState {
  name: string
  extends: string[]
  startLine: number
  methods: string[]
  braces: number
}

/**
 * Splits a comma-separated type list at angle-bracket depth 0 only. Naive
 * `.split(',')` would shred multi-arg generics like
 * `TypedPipelineStep<Input, Output>` into `TypedPipelineStep<Input` and
 * `Output>` — both garbage.
 */
function splitTopLevel(raw: string): string[] {
  const segments: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of raw) {
    if (ch === '<') depth++
    else if (ch === '>') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      segments.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.length > 0) segments.push(buf)
  return segments
}

function parseTypeList(raw: string): string[] {
  return splitTopLevel(raw)
    .map((segment) => stripGenerics(segment.trim()))
    .filter(Boolean)
}

function tryStartInterface(line: string, lineIndex: number): ParseState | null {
  const match = INTERFACE_PATTERN.exec(line)
  if (!match?.[1]) return null
  return {
    name: match[1],
    extends: parseTypeList(match[2] ?? ''),
    startLine: lineIndex + 1,
    methods: [],
    braces: 0,
  }
}

function extractInterfaceMethod(line: string): string | null {
  const methodMatch = METHOD_IN_INTERFACE_PATTERN.exec(line)
  if (!methodMatch?.[1]) return null
  if (JS_KEYWORDS.has(methodMatch[1])) return null
  if (line.includes('//')) return null
  return methodMatch[1]
}

function parseInterfaces(content: string, file: string): InterfaceDefinition[] {
  const interfaces: InterfaceDefinition[] = []
  const lines = content.split('\n')
  let current: ParseState | null = null

  for (const [i, line_] of lines.entries()) {
    const line = line_ ?? ''

    const justStarted = current === null
    current ??= tryStartInterface(line, i)
    if (!current) continue

    // Multi-line interface header: when an `extends` clause appears on a
    // continuation line before the opening `{`, capture it. The first
    // line's extends (if any) was parsed by `tryStartInterface`; we only
    // pick up the continuation when the body has not yet opened.
    if (!justStarted && current.braces === 0 && current.extends.length === 0) {
      const continuationMatch = INTERFACE_EXTENDS_CONTINUATION.exec(line)
      if (continuationMatch?.[1]) {
        current.extends = parseTypeList(continuationMatch[1])
      }
    }

    const hadBraces = current.braces > 0
    const { open, close } = countBraces(line)
    current.braces += open - close

    const method = extractInterfaceMethod(line)
    if (method) {
      current.methods.push(method)
    }

    if (current.braces === 0 && (hadBraces || open > 0)) {
      interfaces.push({
        name: current.name,
        extends: current.extends,
        methods: current.methods,
        startLine: current.startLine,
        file,
      })
      current = null
    }
  }

  return interfaces
}

function isMethodDefinition(line: string): boolean {
  const trimmed = line.trim()
  const leadingWhitespace = line.length - line.trimStart().length

  if (leadingWhitespace > 4) return false
  if (trimmed.endsWith(');')) return false
  if (trimmed.endsWith('),') || trimmed.endsWith('(,')) return false
  if (VISIBILITY_MODIFIER_PATTERN.test(trimmed)) return true
  if (ASYNC_STATIC_METHOD_PATTERN.test(trimmed)) return true
  if (TYPE_ANNOTATION_PATTERN.test(trimmed) || METHOD_BODY_PATTERN.test(trimmed)) return true
  if (leadingWhitespace <= 2 && CLASS_LEVEL_METHOD_PATTERN.test(trimmed)) return true

  return false
}

interface ClassParseState {
  name: string
  implements: string[]
  startLine: number
  methods: string[]
  braces: number
}

function tryStartClass(line: string, lineIndex: number): ClassParseState | null {
  const match = CLASS_PATTERN.exec(line)
  if (!match?.[1]) return null
  return {
    name: match[1],
    // `parseTypeList` strips generic args so `implements IFoo<T>` is keyed
    // by the bare interface name, matching the `allInterfaces` map.
    implements: parseTypeList(match[2] ?? ''),
    startLine: lineIndex + 1,
    methods: [],
    braces: 0,
  }
}

function extractClassMethod(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed.startsWith('private') || trimmed.startsWith('protected')) return null
  if (line.includes('//')) return null

  // Skip static methods. Interfaces cannot declare static members, so
  // a class's `static fromX()` factory or `static create()` would always
  // appear to be an "extra" method — that's a false positive.
  if (STATIC_MODIFIER_PATTERN.test(line)) return null

  const methodMatch = METHOD_IN_CLASS_PATTERN.exec(line)
  if (!methodMatch?.[1]) return null
  if (methodMatch[1] === 'constructor') return null
  if (JS_KEYWORDS.has(methodMatch[1])) return null
  if (!isMethodDefinition(line)) return null

  return methodMatch[1]
}

function parseClasses(content: string, file: string): ClassImplementation[] {
  const classes: ClassImplementation[] = []
  const lines = content.split('\n')
  let current: ClassParseState | null = null

  for (const [i, line_] of lines.entries()) {
    const line = line_ ?? ''

    current ??= tryStartClass(line, i)
    if (!current) continue

    const hadBraces = current.braces > 0
    const { open, close } = countBraces(line)
    current.braces += open - close

    const method = extractClassMethod(line)
    if (method) {
      current.methods.push(method)
    }

    if (current.braces === 0 && (hadBraces || open > 0)) {
      classes.push({
        name: current.name,
        implements: current.implements,
        methods: [...new Set(current.methods)],
        startLine: current.startLine,
        file,
      })
      current = null
    }
  }

  return classes
}

function mergeInterface(
  allInterfaces: Map<string, InterfaceDefinition>,
  iface: InterfaceDefinition,
): void {
  const existing = allInterfaces.get(iface.name)
  if (!existing) {
    allInterfaces.set(iface.name, iface)
    return
  }
  const methodSet = new Set(existing.methods)
  for (const method of iface.methods) methodSet.add(method)
  allInterfaces.set(iface.name, { ...existing, methods: [...methodSet] })
}

function resolveInterface(
  allInterfaces: Map<string, InterfaceDefinition>,
  name: string,
): InterfaceDefinition | undefined {
  // Defensive: callers strip generics on parse, but if a generic slips
  // through here we still want the lookup to succeed.
  const bare = stripGenerics(name)
  let iface = allInterfaces.get(bare)
  if (iface) return iface

  if (bare.startsWith('I') && bare.length > 1 && bare[1] === bare[1]?.toUpperCase()) {
    iface = allInterfaces.get(bare.slice(1))
    if (iface) return iface
  }

  return allInterfaces.get('I' + bare)
}

function createInterfaceMethodsResolver(
  allInterfaces: Map<string, InterfaceDefinition>,
): (name: string, visited?: Set<string>) => string[] {
  return function getInterfaceMethods(name: string, visited = new Set<string>()): string[] {
    if (visited.has(name)) return []
    visited.add(name)

    const iface = resolveInterface(allInterfaces, name)
    if (!iface) return []

    const methods = [...iface.methods]
    for (const ext of iface.extends) {
      for (const method of getInterfaceMethods(ext, visited)) methods.push(method)
    }
    return methods
  }
}

/**
 * Test fakes (`class Fake<X> implements I<X>`) intentionally extend the
 * production interface with helper methods that drive the fake's state
 * (`queueError`, `setEvents`, `reset`, etc.). Flagging these as
 * "extra methods" produces noise without surfacing real interface drift.
 * Detected by class-name prefix rather than file path so the rule fires
 * uniformly regardless of where fakes live.
 */
const TEST_DOUBLE_CLASS_NAME_PATTERN = /^(Fake|Mock|Stub|Spy)[A-Z]/

function checkConsistencyForClass(
  cls: ClassImplementation,
  getInterfaceMethods: (name: string) => string[],
  issues: ConsistencyIssue[],
): void {
  if (!Array.isArray(issues)) return
  if (cls.implements.length === 0) return
  if (TEST_DOUBLE_CLASS_NAME_PATTERN.test(cls.name)) return

  const allowedMethods = new Set<string>()
  for (const ifaceName of cls.implements) {
    for (const method of getInterfaceMethods(ifaceName)) {
      allowedMethods.add(method)
    }
  }

  const reportInterface = cls.implements[0] ?? 'unknown'
  const extraMethods = cls.methods.filter(
    (method) => !ALLOWED_EXTRA_METHODS.has(method) && !allowedMethods.has(method),
  )


  for (const method of extraMethods) {
    issues.push({
      file: cls.file,
      line: cls.startLine,
      type: 'extra-method',
      name: `${cls.name}.${method}`,
      message: `Method '${method}()' in class '${cls.name}' is not declared in interface '${reportInterface}'`,
      severity: 'warning',
    })
  }
}

/**
 * Check: architecture/interface-implementation-consistency
 *
 * Verifies interfaces match their implementations:
 * - Detects methods in class not declared in interface
 * - Allows common utility methods (dispose, init, etc.)
 */
export const interfaceImplementationConsistency = defineCheck({
  id: 'c9549378-95bf-4b5f-923c-c342134c3068',
  slug: 'interface-implementation-consistency',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Verifies interfaces match their implementations',
  longDescription: `**Purpose:** Ensures classes that \`implements\` an interface do not expose public methods absent from that interface, keeping contracts honest.

**Detects:**
- Public methods in a class that are not declared in any of its implemented interfaces (parsed via regex patterns for \`interface\` and \`class ... implements\`)
- Resolves interface inheritance chains (\`extends\`) to collect the full set of allowed methods
- Skips private/protected methods, constructors, JS keywords, and a curated allowlist of common utility methods (e.g., \`dispose\`, \`init\`, \`toJSON\`, \`subscribe\`)

**Why it matters:** Undeclared public methods on implementing classes break the Interface Segregation Principle and make it harder to swap implementations.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` across packages and services.`,
  timeout: 120_000,
  tags: ['architecture', 'consistency'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const allInterfaces = new Map<string, InterfaceDefinition>()
    const allClasses = new Map<string, ClassImplementation>()


    // @lazy-ok -- validations inside loop depend on file content from await
    // Collect interfaces and classes
    for (const file of files.paths) {

      const content = await files.read(file)
      if (!content) continue

      if (content.includes('interface ')) {
        for (const iface of parseInterfaces(content, file)) {
          void mergeInterface(allInterfaces, iface)
        }
      }

      if (content.includes('class ') && content.includes('implements ')) {
        for (const cls of parseClasses(content, file)) {
          allClasses.set(cls.name, cls)
        }
      }
    }

    const getInterfaceMethods = createInterfaceMethodsResolver(allInterfaces)
    const issues: ConsistencyIssue[] = []

    // Check each class against its interfaces
    allClasses.forEach((cls) => {
      checkConsistencyForClass(cls, getInterfaceMethods, issues)
    })

    return issues.map((issue) => ({
      filePath: issue.file,
      line: issue.line,
      message: issue.message,
      severity: issue.severity,
      suggestion: `Add method '${issue.name.split('.')[1]}()' to the interface, or remove it from the class if it's not part of the public API.`,
      match: issue.name,
      type: issue.type,
    }))
  },
})
