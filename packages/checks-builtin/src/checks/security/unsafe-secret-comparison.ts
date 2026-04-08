/**
 * @fileoverview Detect unsafe equality comparisons on secret/token values
 *
 * Finds binary equality operators (=== / !==) applied to variables whose names
 * suggest they hold cryptographic secrets (token, secret, signature, password,
 * key). Such comparisons are vulnerable to timing attacks and must use a
 * constant-time comparison function like safeCompare().
 */

import {
  defineCheck,
  type CheckViolation,
  parseSource,
  walkNodes,
  getIdentifierName,
  isLiteral,
  isPropertyAccess,
  getASTLineNumber,
  ts,
} from '@opensip-tools/core'

/**
 * Variable name pattern that indicates a secret value.
 * Matches identifiers containing: secret, token, signature, password, key, hmac, hash, digest.
 */
const SECRET_NAME_PATTERN = /secret|token|signature|password|key|hmac|hash|digest/i

/**
 * Names that look like secrets but are actually safe to compare with ===.
 * E.g. `key.length`, `token !== undefined`, `tokenType === 'bearer'`.
 */
const SAFE_COMPARAND_PATTERNS = [/^undefined$/, /^null$/, /^true$/, /^false$/]

/** Properties that don't carry secret data */
const SAFE_PROPERTY_NAMES = ['length', 'type', 'status', 'kind', 'name', 'id', 'count', 'size']

/**
 * Check if a comparand is a literal value or safe property access,
 * which would make the comparison safe (not comparing two secret values).
 */
function isLiteralOrSafe(node: ts.Node): boolean {
  if (isLiteral(node)) return true
  if (ts.isTypeOfExpression(node)) return true
  if (SAFE_PROPERTY_NAMES.some((prop) => isPropertyAccess(node, prop))) return true

  const text = getIdentifierName(node)
  if (text && SAFE_COMPARAND_PATTERNS.some((p) => p.test(text))) return true

  return false
}

/**
 * Check if either operand has a secret-like name.
 * Returns the secret-bearing operand name for the violation message, or null.
 */
function findSecretOperand(left: ts.Node, right: ts.Node): string | null {
  const leftName = getIdentifierName(left)
  const rightName = getIdentifierName(right)

  const leftIsSecret = SECRET_NAME_PATTERN.test(leftName)
  const rightIsSecret = SECRET_NAME_PATTERN.test(rightName)

  if (!leftIsSecret && !rightIsSecret) return null

  // If one side is secret but the other is a literal/safe value, skip
  if (leftIsSecret && isLiteralOrSafe(right)) return null
  if (rightIsSecret && isLiteralOrSafe(left)) return null

  return leftIsSecret ? leftName : rightName
}

/**
 * Check: security/unsafe-secret-comparison
 *
 * Detects usage of === or !== to compare variables whose names suggest they
 * hold cryptographic secrets. Such comparisons are vulnerable to timing
 * side-channel attacks.
 */
export const unsafeSecretComparison = defineCheck({
  id: '0249cfc8-5342-480a-a9d0-fbf7ad89a6cf',
  slug: 'unsafe-secret-comparison',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',
  confidence: 'high',
  description: 'Detect timing-unsafe equality comparisons on secret/token values',
  longDescription: `**Purpose:** Detects \`===\` or \`!==\` comparisons on variables whose names suggest they hold cryptographic secrets, which are vulnerable to timing side-channel attacks.

**Detects:**
- Binary expressions using \`===\` or \`!==\` where either operand name matches: secret, token, signature, password, key, hmac, hash, or digest (case-insensitive)
- Excludes comparisons against literals, \`undefined\`, \`null\`, \`true\`, \`false\`, \`typeof\`, and safe property accesses (.length, .type, .status, .kind, .name, .id, .count, .size)

**Why it matters:** Standard equality operators short-circuit on the first differing byte, leaking information about how much of a secret value matches. Attackers can reconstruct secrets one byte at a time using timing measurements.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST. Targets auth, middleware, token service, and crypto directories.`,
  tags: ['security', 'timing-attack', 'crypto'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const sourceFile = parseSource(content, filePath)
    if (!sourceFile) return []

    const violations: CheckViolation[] = []

    walkNodes(sourceFile, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        const secretName = findSecretOperand(node.left, node.right)
        if (secretName) {
          const line = getASTLineNumber(node, sourceFile)
          const operator =
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? '===' : '!=='
          violations.push({
            line,
            column: node.operatorToken.getStart() - node.getStart(),
            message: `Timing-unsafe ${operator} comparison on '${secretName}' — use crypto.timingSafeEqual() (Node.js built-in)`,
            severity: 'error',
            suggestion: `Replace \`a ${operator} b\` with \`${operator === '!==' ? '!' : ''}safeCompare(a, b)\` to prevent timing side-channel attacks.`,
            match: node.getText(),
            filePath,
          })
        }
      }
    })

    return violations
  },
})
