// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
/**
 * @fileoverview Stream Buffer Size Limits Check
 *
 * Detects Buffer.concat() and stream buffering patterns without size limit guards.
 * These patterns can lead to DoS vulnerabilities when processing untrusted input.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'
import { stripStringsAndComments } from '@opensip-tools/core/framework/strip-literals.js'

/** Patterns that indicate bounded buffer usage */
const BOUNDED_PATTERNS = [
  /maxSize/i,
  /MAX_SIZE/,
  /maxLength/i,
  /sizeLimit/i,
  /maxBuffer/i,
  /\.length\s*[<>]/,
  /\.byteLength\s*[<>]/,
  /totalSize\s*[<>]/,
  /cipher\.final\(\)/,
  /decipher\.final\(\)/,
]

/** Quick filter keywords */
const QUICK_FILTER = ['Buffer', 'chunks', 'stream']

interface CallExpressionContext {
  node: ts.CallExpression
  sourceFile: ts.SourceFile
  content: string
}

/**
 * Get surrounding context for a line (50 lines before and after)
 */
function getSurroundingContext(content: string, line: number): string {
  const lines = content.split('\n')
  const start = Math.max(0, line - 50)
  const end = Math.min(lines.length, line + 50)
  return lines.slice(start, end).join('\n')
}

/**
 * Check if context has bounded patterns
 */
function hasBoundedPattern(context: string): boolean {
  return BOUNDED_PATTERNS.some((p) => p.test(context))
}

/**
 * Check Buffer.concat call for size limit guards
 */
function checkBufferConcat(ctx: CallExpressionContext): CheckViolation | null {
  const { node, sourceFile, content } = ctx
  const callText = node.getText(sourceFile)

  if (!callText.includes('Buffer.concat')) {
    return null
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const context = getSurroundingContext(content, line)

  if (hasBoundedPattern(context)) {
    return null
  }

  const lineNum = line + 1

  return {
    line: lineNum,
    column: 0,
    message: 'Buffer.concat() without size limit guard (DoS risk)',
    severity: 'error',
    suggestion:
      'Add a size limit check before Buffer.concat: track totalSize as chunks are pushed, and throw an error if totalSize exceeds MAX_SIZE (e.g., 10MB)',
    match: callText.slice(0, 50),
  }
}

/**
 * Check unbounded push to chunk arrays
 */
function checkUnboundedPush(ctx: CallExpressionContext): CheckViolation | null {
  const { node, sourceFile, content } = ctx

  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null
  }

  const methodName = node.expression.name.getText(sourceFile)
  const objectName = node.expression.expression.getText(sourceFile)
  const isChunkPush =
    methodName === 'push' &&
    /^(?:chunks?|buffers?|dataChunks?|dataBuffers?)$/.test(objectName)

  if (!isChunkPush) {
    return null
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const context = getSurroundingContext(content, line)

  if (hasBoundedPattern(context)) {
    return null
  }

  const callText = node.getText(sourceFile)
  const lineNum = line + 1

  return {
    line: lineNum,
    column: 0,
    message: `Unbounded ${objectName}.push() - potential memory exhaustion`,
    severity: 'warning',
    suggestion: `Add a size check before pushing: if (totalSize + chunk.length > MAX_SIZE) throw new Error('Size limit exceeded'); then track totalSize += chunk.length`,
    match: callText.slice(0, 50),
  }
}

/**
 * Check: quality/stream-buffer-size-limits
 *
 * Detects unbounded buffer operations (DoS risk).
 */
export const streamBufferSizeLimits = defineCheck({
  id: 'a3206507-aa7f-4210-ae8c-06ed1025abfd',
  slug: 'stream-buffer-size-limits',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Detects Buffer.concat() and stream buffering without size limit guards',
  longDescription: `**Purpose:** Detects unbounded buffer accumulation patterns that can lead to denial-of-service via memory exhaustion.

**Detects:** Analyzes each file individually using TypeScript AST. Checks for:
- \`Buffer.concat()\` calls without nearby size-limit guards (\`maxSize\`, \`MAX_SIZE\`, \`sizeLimit\`, \`.length <\`, \`.byteLength <\`)
- \`.push()\` calls on variables named \`chunk*\` or \`buffer*\` without nearby bounded-pattern guards

**Why it matters:** Unbounded buffering allows an attacker or misbehaving client to exhaust server memory by sending arbitrarily large payloads.

**Scope:** General best practice (security/DoS prevention)`,
  tags: ['quality', 'security', 'best-practices'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180000, // 3 minutes - scans buffer usage patterns

  analyze(content, filePath) {
    // Quick filter
    const strippedContent = stripStringsAndComments(content)
    if (!QUICK_FILTER.some((kw) => strippedContent.includes(kw))) {
      return []
    }

    const violations: CheckViolation[] = []

    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callCtx: CallExpressionContext = {
          node,
          sourceFile,
          content,
        }

        const bufferConcatViolation = checkBufferConcat(callCtx)
        if (bufferConcatViolation) {
          violations.push(bufferConcatViolation)
        }

        const unboundedPushViolation = checkUnboundedPush(callCtx)
        if (unboundedPushViolation) {
          violations.push(unboundedPushViolation)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return violations
  },
})
