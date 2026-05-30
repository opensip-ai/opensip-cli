/**
 * @fileoverview PII Exposure in Logs Check
 *
 * Uses AST analysis to detect PII exposure in log statements.
 * Walks call expressions to find logger.info/warn/error/debug/trace/fatal calls,
 * then inspects arguments for PII field names. AST context eliminates false
 * positives from PII field names in non-log contexts (type definitions,
 * variable names, string constants).
 *
 * @see Logging Standards
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { parseSource, walkNodes, getPropertyChain, getLineNumber } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

// PII field names that should never be logged directly
const PII_FIELD_NAMES = new Set([
  'email',
  'emailaddress',
  'email_address',
  'phone',
  'phonenumber',
  'phone_number',
  'ssn',
  'socialsecuritynumber',
  'social_security_number',
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'password',
  'passwd',
  'pwd',
  'secret',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'address',
  'streetaddress',
  'street_address',
  'ipaddress',
  'ip_address',
  'dateofbirth',
  'date_of_birth',
  'dob',
])

/** Logger method names that indicate a log call */
const LOG_METHOD_NAMES = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

/** Logger object names (L is our shorthand, logger is standard) */
const LOGGER_OBJECT_NAMES = new Set(['L', 'logger', 'log'])

/** Safe function calls that indicate the PII field value is sanitized */
const SAFE_WRAPPER_FUNCTIONS = new Set([
  'hashpii',
  'hash',
  'redact',
  'mask',
  'sanitize',
  'encrypt',
  'hashpiifield',
  'redactfield',
  'maskfield',
])

/**
 * Check if a node is a logger call expression.
 * Matches: logger.info(...), L.warn(...), log.error(...), this.logger.debug(...)
 */
function isLoggerCall(node: ts.CallExpression): boolean {
  const expr = node.expression
  if (!ts.isPropertyAccessExpression(expr)) return false
  if (!LOG_METHOD_NAMES.has(expr.name.text)) return false

  const chain = getPropertyChain(expr.expression)
  // Direct logger call: logger.info, L.warn
  if (LOGGER_OBJECT_NAMES.has(chain)) return true
  // Nested: this.logger.info, context.logger.warn
  if (chain.endsWith('.logger') || chain.endsWith('.L') || chain.endsWith('.log')) return true

  return false
}

/**
 * Check if a property value expression is wrapped in a sanitization function.
 * E.g., hashPii(email), mask(phone), redact(ssn)
 */
function isWrappedInSafeCall(node: ts.Expression): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (ts.isIdentifier(callee) && SAFE_WRAPPER_FUNCTIONS.has(callee.text.toLowerCase())) {
      return true
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      SAFE_WRAPPER_FUNCTIONS.has(callee.name.text.toLowerCase())
    ) {
      return true
    }
  }
  return false
}

/**
 * Inspect an object literal for PII field names in its properties.
 * Returns the first PII field found, or null if none.
 */
function findPiiFieldInObject(
  obj: ts.ObjectLiteralExpression,
): { fieldName: string; safe: boolean } | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue

    let propName = ''
    if (ts.isIdentifier(prop.name)) {
      propName = prop.name.text
    } else if (ts.isStringLiteral(prop.name)) {
      propName = prop.name.text
    } else if (ts.isComputedPropertyName(prop.name)) {
      continue // skip computed properties
    }

    if (PII_FIELD_NAMES.has(propName.toLowerCase())) {
      const safe = isWrappedInSafeCall(prop.initializer)
      return { fieldName: propName, safe }
    }

    // Check nested object literals
    if (ts.isObjectLiteralExpression(prop.initializer)) {
      const nested = findPiiFieldInObject(prop.initializer)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Check: quality/pii-exposure-in-logs
 *
 * Detects potential PII exposure in log statements using AST analysis.
 * Walks call expressions to find logger calls, then inspects arguments
 * for PII field names in object literals.
 *
 * @see Logging Standards
 */
export const piiExposureInLogs = defineCheck({
  id: 'afe54c52-c75d-4078-a81d-94bf80281e13',
  slug: 'pii-exposure-in-logs',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Detects potential PII exposure in log statements',
  longDescription: `**Purpose:** Detects potential PII (Personally Identifiable Information) exposure in log statements using TypeScript AST analysis, ensuring sensitive data is never logged in plaintext.

**Detects:**
- PII field names (\`email\`, \`phone\`, \`ssn\`, \`creditcard\`, \`password\`, \`apikey\`, \`accesstoken\`, \`address\`, \`dob\`, and variants) used as property keys in object literals passed to logger calls
- Logger calls on objects named \`logger\`, \`L\`, or \`log\` with methods \`trace\`, \`debug\`, \`info\`, \`warn\`, \`error\`, \`fatal\`
- Nested object literals containing PII fields within log arguments
- Exempts fields wrapped in safe sanitization calls: \`hashPii\`, \`hash\`, \`redact\`, \`mask\`, \`sanitize\`, \`encrypt\`

**Why it matters:** Logging PII in plaintext violates data protection regulations and creates security/compliance risks if logs are accessed by unauthorized parties.

**Scope:** General best practice (logging standards). Analyzes each file individually using TypeScript AST walking.`,
  tags: ['security', 'compliance', 'quality'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000, // 3 minutes - scans all log statements

  analyze(content: string, filePath: string): CheckViolation[] {
    // Quick filter: skip files without logger patterns
    if (!content.includes('logger.') && !content.includes('L.') && !content.includes('log.')) {
      return []
    }

    const sourceFile = parseSource(content, filePath)
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return []

    const violations: CheckViolation[] = []

    walkNodes(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return
      if (!isLoggerCall(node)) return

      // Inspect each argument for PII fields
      for (const arg of node.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          const piiField = findPiiFieldInObject(arg)
          if (piiField && !piiField.safe) {
            violations.push({
              line: getLineNumber(node, sourceFile),
              column: 0,
              message: `Potential PII field '${piiField.fieldName}' in log call (should be hashed/sanitized)`,
              severity: 'error',
              suggestion: `Use a centralized PII masking utility before logging: hash or redact sensitive fields, e.g. log { ${piiField.fieldName}: hashPii(${piiField.fieldName}) } or redact the field entirely`,
              match:
                node.getText().length > 200 ? node.getText().slice(0, 200) + '...' : node.getText(),
              filePath,
            })
            break // one violation per log call is sufficient
          }
        }
      }
    })

    return violations
  },
})
