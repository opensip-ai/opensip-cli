// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Financial Transaction Ordering Check
 *
 * Detects unsafe financial transaction ordering patterns:
 * 1. External charge before database persistence (money lost if DB fails)
 * 2. External API calls before state persistence
 * 3. Missing idempotency patterns in payment processing
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Financial file patterns
 */
const FINANCIAL_PATTERNS = [
  /\/payments\//,
  /\/escrow\//,
  /\/subscription\//,
  /\/billing\//,
  /\/checkout\//,
  /-service\.ts$/,
  /-processor\.ts$/,
  /-manager\.ts$/,
]

/**
 * Check if method name suggests financial operation
 * @param {string} name - The method name to check
 * @returns {boolean} True if the method name suggests a financial operation
 */
function isFinancialMethod(name: string): boolean {
  return /process|charge|pay|refund|capture|authorize|transfer|withdraw|deposit|settle/i.test(name)
}

/**
 * Check if method is specifically a charge/payment method
 * @param {string} name - The method name to check
 * @returns {boolean} True if the method is a charge/payment method
 */
function isChargeMethod(name: string): boolean {
  return /process(Payment|Charge)|charge|capture|authorize/i.test(name)
}

/**
 * Detect external financial call patterns
 * Uses simple string matching first, then constrained regex patterns
 * @param {string} text - The code text to analyze
 * @returns {string | null} The type of external financial call detected, or null if none
 */
function detectExternalFinancialCall(text: string): string | null {
  // Use simple string checks before regex for performance
  // Combining if conditions to reduce nesting (collapsible-if rule)
  if (
    text.includes('processor.') &&
    /processor\.(?:processPayment|charge|capture|authorize|refund)/i.test(text)
  ) {
    return 'payment processor'
  }
  if (text.includes('stripe.') && /stripe\.(?:charges|paymentIntents|refunds)/i.test(text)) {
    return 'Stripe API'
  }
  if (/paypal\./i.test(text)) {
    return 'PayPal API'
  }
  // Use a more constrained pattern - match await followed by identifier chain (bounded quantifiers)
  if (
    text.includes('await') &&
    text.includes('Payment') &&
    /await\s{1,20}\w{1,50}\.(?:processPayment|sendPayment|executePayment|chargeCustomer)/i.test(
      text,
    )
  ) {
    return 'external payment'
  }
  return null
}

/**
 * Check if statement is database persistence
 * @param {string} text - The code text to analyze
 * @returns {boolean} True if the statement is a database persistence call
 */
function isDatabasePersistCall(text: string): boolean {
  return /repository\.(create|save|insert|put|update)|\.create\(|\.save\(|\.insert\(/i.test(text)
}

/**
 * Check if statement sets PENDING status
 * Uses simple string matching to avoid complex regex
 * @param {string} text - The code text to analyze
 * @returns {boolean} True if the statement sets a PENDING status
 */
function isPendingStateAssignment(text: string): boolean {
  // Quick pre-check for performance
  if (!text.includes('PENDING') && !text.includes('pending')) {
    return false
  }
  // Use specific, non-backtracking patterns
  return (
    /status:\s*['"]PENDING['"]/i.test(text) ||
    /status\s*=\s*['"]PENDING['"]/i.test(text) ||
    text.includes('PENDING_STATE') ||
    text.includes('PaymentStatus.PENDING')
  )
}

/**
 * Check if file/method is an orchestrator or coordinator
 * @param {string} filePath - The file path to check
 * @param {string} methodName - The method name to check
 * @returns {boolean} True if the file/method is an orchestrator or coordinator
 */
function isOrchestratorOrCoordinator(filePath: string, methodName: string): boolean {
  return (
    /orchestrator|coordinator|manager/i.test(filePath) &&
    /WithFallback|WithRetry|Delegate/i.test(methodName)
  )
}

/**
 * Check if file is a low-level processor
 * @param {string} filePath - The file path to check
 * @returns {boolean} True if the file is a low-level processor
 */
function isLowLevelProcessor(filePath: string): boolean {
  const lowLevelPatterns = [
    /payment-processors\/stripe\/[^/]{1,100}-operation\.ts$/,
    /payment-processors\/paypal\/[^/]{1,100}-operation\.ts$/,
    /processors\/[^/]{1,100}\/[^/]{1,100}-operation\.ts$/,
  ]
  return lowLevelPatterns.some((pattern) => pattern.test(filePath))
}

/**
 * Options for analyzing statement order
 */
interface AnalyzeStatementOrderOptions {
  body: ts.Block
  methodName: string
  sourceFile: ts.SourceFile
}

/**
 * Analyze statement order in a block
 * @param {AnalyzeStatementOrderOptions} options - The analysis options
 * @returns {CheckViolation[]} Array of violations found in the statement order
 */
function analyzeStatementOrder(options: AnalyzeStatementOrderOptions): CheckViolation[] {
  const { body, methodName, sourceFile } = options
  const violations: CheckViolation[] = []
  const statements = body.statements

  let externalCallLine: number | null = null
  let externalCallType: string | null = null
  let persistCallLine: number | null = null
  let hasPendingStateBeforeExternal = false

  for (const statement of statements) {
    const lineInfo = sourceFile.getLineAndCharacterOfPosition(statement.getStart())
    const line = lineInfo.line + 1
    const statementText = statement.getText(sourceFile)

    if (isPendingStateAssignment(statementText) && externalCallLine === null) {
      hasPendingStateBeforeExternal = true
    }

    const externalType = detectExternalFinancialCall(statementText)
    if (externalType && externalCallLine === null) {
      externalCallLine = line
      externalCallType = externalType
    }

    if (isDatabasePersistCall(statementText) && persistCallLine === null) {
      persistCallLine = line
    }
  }

  // Check: External call before persist
  if (externalCallLine !== null && persistCallLine !== null && externalCallLine < persistCallLine) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(body.getStart())
    const lineNum = line + 1
    violations.push({
      line: lineNum,
      column: 0,
      message: `CRITICAL: External ${externalCallType} (line ${externalCallLine}) occurs BEFORE database persistence (line ${persistCallLine}). Money may be lost if DB save fails.`,
      severity: 'error',
      type: 'charge-before-persist',
      suggestion: `Reorder operations: 1) Save record with PENDING status, 2) Call external ${externalCallType}, 3) Update record to SUCCESS/FAILED. This ensures no money is lost if the database write fails.`,
      match: `${externalCallType} before persist`,
    })
  }

  // Check: External financial call without pending state
  if (externalCallLine !== null && !hasPendingStateBeforeExternal && isChargeMethod(methodName)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(body.getStart())
    const lineNum = line + 1
    violations.push({
      line: lineNum,
      column: 0,
      message: `Missing PENDING state before external financial operation in ${methodName}`,
      severity: 'warning',
      type: 'missing-pending-state',
      suggestion:
        'Save record with status PENDING before calling external payment processor. This ensures the transaction can be recovered if the external call fails.',
      match: methodName,
    })
  }

  return violations
}

/**
 * Check if file is a financial service file
 */
function isFinancialFile(filePath: string): boolean {
  if (filePath.includes('.test.') || filePath.includes('.spec.')) return false
  if (filePath.includes('__tests__/')) return false
  return FINANCIAL_PATTERNS.some((p) => p.test(filePath))
}

/**
 * Analyze a file for transaction ordering issues
 * @param {string} content - The file content to analyze
 * @param {string} filePath - The file path being analyzed
 * @returns {CheckViolation[]} Array of violations found in the file
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Filter to financial service files only
  if (!isFinancialFile(filePath)) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      // Check method bodies for transaction ordering
      if (ts.isMethodDeclaration(node) && node.body) {
        const methodName = ts.isIdentifier(node.name) ? node.name.text : 'anonymous'
        if (
          isFinancialMethod(methodName) &&
          !isOrchestratorOrCoordinator(filePath, methodName) &&
          !isLowLevelProcessor(filePath)
        ) {
          const methodViolations = analyzeStatementOrder({
            body: node.body,
            methodName,
            sourceFile,
          })
          violations.push(...methodViolations)
        }
      }

      // Also check function declarations
      if (ts.isFunctionDeclaration(node) && node.body) {
        const functionName = node.name ? node.name.text : 'anonymous'
        if (
          isFinancialMethod(functionName) &&
          !isOrchestratorOrCoordinator(filePath, functionName) &&
          !isLowLevelProcessor(filePath)
        ) {
          const funcViolations = analyzeStatementOrder({
            body: node.body,
            methodName: functionName,
            sourceFile,
          })
          violations.push(...funcViolations)
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/financial-transaction-ordering
 *
 * Detects unsafe financial transaction ordering: charging before persistence,
 * missing pending states, and external calls before DB saves.
 */
export const financialTransactionOrdering = defineCheck({
  id: '3b1b8fdc-bc5a-41fb-9ec8-39c4c565d116',
  slug: 'financial-transaction-ordering',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description:
    'Detect unsafe financial transaction ordering: charging before persistence, missing pending states',
  longDescription: `**Purpose:** Detects unsafe ordering in financial transaction code where external payment calls occur before database persistence, risking money loss if the DB write fails.

**Detects:**
- External payment processor calls (\`processor.charge\`, \`stripe.charges\`, \`paypal.*\`, \`await *.processPayment\`) that appear before \`repository.save\`/\`repository.create\`/\`.insert()\` in statement order
- Charge/payment methods (matching \`process|charge|capture|authorize\`) missing a PENDING state assignment (\`status: 'PENDING'\`, \`PaymentStatus.PENDING\`) before the external call
- Only scans files under \`/payments/\`, \`/escrow/\`, \`/subscription/\`, \`/billing/\`, \`/checkout/\`, or files named \`*-service.ts\`/\`*-processor.ts\`/\`*-manager.ts\`
- Excludes orchestrator/coordinator methods and low-level processor operation files

**Why it matters:** Charging a customer before persisting the transaction record means money is collected but untracked if the database write fails afterward.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'code-quality', 'security', 'best-practices', 'financial'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
