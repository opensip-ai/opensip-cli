// @fitness-ignore-file callback-invocation-safe -- This file IS the callback-invocation-safe check; its JSDoc and `longDescription` template literal necessarily contain example patterns (`subscribers.forEach((cb) => cb(...))`, `for (const cb of listeners)`) so the documentation can describe what the check detects. The check uses `contentFilter: 'raw'` (intentional — must see real code), so it cannot strip its own documentation. Reviewers grepping for the rationale land here.
// @fitness-ignore-file performance-anti-patterns -- spread patterns appear in the check's own JSDoc example strings, not real loop code
/**
 * @fileoverview resilience/callback-invocation-safe — callbacks iterated
 * from producer code paths (`subscribers.forEach((cb) => cb(...))`,
 * `for (const cb of listeners) { cb(...) }`) must be wrapped in a
 * `safe<Name>(...)` helper or a `try { ... }` block. A throw from a
 * single subscriber must never crash the producer or skip subsequent
 * subscribers in the same notification.
 *
 * Why it matters: callback iteration inside `setInterval` or async
 * drain loops will surface a subscriber throw as `uncaughtException`
 * — and even on a synchronous code path, an unprotected throw drops
 * every later subscriber in the same loop iteration. The contract is
 * "subscribers are isolated"; this check is the regression gate.
 *
 * Scope (deliberately narrow):
 *   - `.ts` / `.tsx` source under `packages/`.
 *   - Skips tests and `.d.ts`.
 *   - Detects only iteration over identifiers ending in
 *     `subscribers`, `listeners`, `observers`, `callbacks`, `handlers`.
 *
 * Per-site opt-out: `// @callback-invocation-safe-by-caller -- <reason>`
 * on the same line or the line immediately above. A bare pragma without
 * `-- <reason>` is itself flagged so reviewers can grep the rationale.
 *
 * Confidence: low. Under-flag aggressively. This is a regression guard,
 * not a discovery tool.
 *
 * Inspired by `opensip-ai/opensip/opensip-tools` `arch-callback-invocation-safe`.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

const SCOPE_PREFIXES = ['packages/'] as const

const PRAGMA_RE = /@callback-invocation-safe-by-caller\s*--\s*\S+/
const PRAGMA_BARE_RE = /@callback-invocation-safe-by-caller\b(?!\s*--\s*\S)/

const COLLECTION_NAMES = new Set(['subscribers', 'listeners', 'observers', 'callbacks', 'handlers'])

// Two-step match — first the receiver + `.forEach(`, then the arrow
// parameter. Splitting the original mega-regex avoids the
// sonarjs/regex-complexity ceiling and makes each step easier to reason
// about. Both regexes are bounded — they only consume identifier chars
// and a few whitespace boundaries, never backtrack on user input.
const FOREACH_HEAD_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*forEach\s*\(\s*/g
// eslint-disable-next-line sonarjs/slow-regex -- arrow header; bounded prefix optional groups, anchored at slice start
const FOREACH_ARROW_RE = /^(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{?\s*/

// `for (const <ident> of <receiver>) { ... }`
const FOR_OF_INVOCATION_RE =
  /\bfor\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\)\s*\{/g

function collectionNameMatches(name: string): boolean {
  const lower = name.toLowerCase()
  for (const n of COLLECTION_NAMES) {
    if (lower === n || lower.endsWith(n)) return true
  }
  return false
}

function lineNumberOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

function inScope(normalized: string): boolean {
  return SCOPE_PREFIXES.some((p) => normalized.startsWith(p) || normalized.includes(`/${p}`))
}

function bodyInvokesIdent(body: string, ident: string): boolean {
  const re = new RegExp(String.raw`(?<![A-Za-z0-9_$.])` + ident + String.raw`\s*\(`)
  return re.test(body)
}

function bodyHasSafeWrapper(body: string): boolean {
  return /\bsafe[A-Z][\w$]*\s*\(/.test(body)
}

function isInsideTryBlock(stripped: string, idx: number): boolean {
  const start = Math.max(0, idx - 400)
  const slice = stripped.slice(start, idx)
  const lastTry = slice.lastIndexOf('try')
  if (lastTry === -1) return false
  let depth = 0
  let saw = false
  for (let i = lastTry; i < slice.length; i++) {
    const ch = slice[i]
    if (ch === '{') {
      depth++
      saw = true
    } else if (ch === '}') {
      depth--
      if (saw && depth <= 0) return false
    }
  }
  return saw && depth > 0
}

function pragmaAt(lines: readonly string[], callLine: number): 'honored' | 'bare' | 'absent' {
  for (const offset of [0, -1]) {
    const idx = callLine - 1 + offset
    if (idx < 0 || idx >= lines.length) continue
    const line = lines[idx] ?? ''
    if (PRAGMA_RE.test(line)) return 'honored'
    if (PRAGMA_BARE_RE.test(line)) return 'bare'
  }
  return 'absent'
}

interface CallSite {
  readonly callLine: number
  readonly receiver: string
  readonly ident: string
}

function fileIsInScope(filePath: string): boolean {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return false
  if (filePath.endsWith('.d.ts')) return false
  if (isTestFile(filePath)) return false
  return inScope(filePath.replaceAll('\\', '/'))
}

function contentMentionsCollection(content: string): boolean {
  for (const name of COLLECTION_NAMES) {
    if (content.includes(name)) return true
  }
  return false
}

function shouldEmitForEachSite(
  content: string,
  m: RegExpMatchArray,
): CallSite | null {
  const receiver = m[1] ?? ''
  if (!collectionNameMatches(receiver)) return null
  const idx = m.index ?? 0
  // The match consumed up to and including the `(` of forEach; parse the
  // arrow parameter from the slice that follows.
  const afterParen = content.slice(idx + m[0].length, idx + m[0].length + 200)
  const arrowMatch = FOREACH_ARROW_RE.exec(afterParen)
  if (!arrowMatch) return null
  const ident = arrowMatch[1] ?? ''
  const bodyTail = afterParen.slice(arrowMatch[0].length, arrowMatch[0].length + 200)
  if (!bodyInvokesIdent(bodyTail, ident)) return null
  if (bodyHasSafeWrapper(bodyTail)) return null
  if (isInsideTryBlock(content, idx)) return null
  return { callLine: lineNumberOfIndex(content, idx), receiver, ident }
}

function shouldEmitForOfSite(
  content: string,
  m: RegExpMatchArray,
): CallSite | null {
  const ident = m[1] ?? ''
  const receiver = m[2] ?? ''
  if (!collectionNameMatches(receiver)) return null
  const idx = m.index ?? 0
  const blockBody = content.slice(idx, Math.min(content.length, idx + 400))
  if (!bodyInvokesIdent(blockBody, ident)) return null
  if (bodyHasSafeWrapper(blockBody)) return null
  if (isInsideTryBlock(content, idx)) return null
  return { callLine: lineNumberOfIndex(content, idx), receiver, ident }
}

function findCallSites(content: string): CallSite[] {
  const sites: CallSite[] = []
  for (const m of content.matchAll(FOREACH_HEAD_RE)) {
    const site = shouldEmitForEachSite(content, m)
    if (site) sites.push(site)
  }
  for (const m of content.matchAll(FOR_OF_INVOCATION_RE)) {
    const site = shouldEmitForOfSite(content, m)
    if (site) sites.push(site)
  }
  return sites
}

function barePragmaViolation(line: number): CheckViolation {
  return {
    line,
    severity: 'error',
    message:
      `Pragma '@callback-invocation-safe-by-caller' requires a '-- <rationale>' suffix. ` +
      `Bare pragmas are rejected so reviewers can grep the rationale on every opt-out.`,
    suggestion: `Change to '// @callback-invocation-safe-by-caller -- <one-line rationale>'.`,
  }
}

/** Exported for unit tests. */
export function analyzeCallbackInvocationSafe(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (!fileIsInScope(filePath)) return []
  if (!contentMentionsCollection(content)) return []

  const sites = findCallSites(content)
  if (sites.length === 0) return []

  const lines = content.split('\n')
  const violations: CheckViolation[] = []
  const seen = new Set<number>()
  for (const site of sites) {
    if (seen.has(site.callLine)) continue
    seen.add(site.callLine)

    const pragma = pragmaAt(lines, site.callLine)
    if (pragma === 'honored') continue
    if (pragma === 'bare') {
      violations.push(barePragmaViolation(site.callLine))
      continue
    }

    const capIdent = site.ident.charAt(0).toUpperCase() + site.ident.slice(1)
    violations.push({
      line: site.callLine,
      severity: 'error',
      message:
        `Direct callback invocation \`${site.ident}(...)\` inside iteration over \`${site.receiver}\` is not wrapped in try/catch or a safe<Name>(...) helper. A throw from a single subscriber will propagate out of the producer loop, dropping subsequent subscribers and (under setInterval/async drain) surfacing as uncaughtException.`,
      suggestion:
        `Wrap the invocation in a private safe${capIdent}(cb, ...args) helper that catches and logs at warn, then call this.safe${capIdent}(cb, ...) instead. Per-site opt-out: '// @callback-invocation-safe-by-caller -- <rationale>'.`,
    })
  }

  return violations
}

export const callbackInvocationSafe = defineCheck({
  id: 'd3e7b1c8-95a2-4f6d-b8e2-2c4e7a9d1f3c',
  slug: 'callback-invocation-safe',
  scope: { languages: ['typescript'], concerns: ['backend', 'architecture', 'resilience'] },
  contentFilter: 'raw',
  confidence: 'low',
  description:
    'Class-field callbacks invoked from producer code paths (subscribers.forEach, for-of over listeners, etc.) must be wrapped in a safe<Name>(...) helper or try/catch. A throw from one subscriber must not crash the producer or skip subsequent subscribers.',
  longDescription: `**Purpose:** Subscriber/listener throws must be isolated from the producer that fires them.

**Detects:**
- \`subscribers.forEach((cb) => cb(...))\` and equivalents over identifiers ending in subscribers/listeners/observers/callbacks/handlers
- \`for (const cb of <coll>) { cb(...) }\`

**Skips when ANY hold:**
- The invocation is inside a \`try { ... }\` block
- The body of the iteration uses a \`safe<Name>(...)\` helper instead of the bare callback
- The opt-out pragma \`// @callback-invocation-safe-by-caller -- <rationale>\` appears on the same line or the line above

**Why it matters:** Inside \`setInterval\` or an async drain loop, a subscriber throw becomes \`uncaughtException\` and kills the producer. Even on a sync code path, a throw drops every subsequent subscriber in the same notification — silent partial-failure.

**Scope:** TypeScript source under \`packages/\`. Tests, \`.d.ts\`, and files that don't reference any of the recognised collection names are skipped via fast path. Detection is deliberately narrow (confidence: low) — this is a regression guard, not a discovery tool.`,
  tags: ['architecture', 'resilience'],
  fileTypes: ['ts', 'tsx'],
  analyze: analyzeCallbackInvocationSafe,
})
