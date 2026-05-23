/**
 * @fileoverview DynamoDB Scan Detection check
 *
 * Detects ScanCommand usage in production code that should use GSI queries instead.
 * ScanCommand performs O(N) table scans vs O(1) index queries with QueryCommand.
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Safe patterns that indicate intentional scan usage
 */
const ALLOWED_SCAN_PATTERNS = [
  /migration/i,
  /backfill/i,
  /one-time/i,
  /admin/i,
  /ExpressionAttributeValues/,
]

/**
 * @param {*} absolutePath
 * @param {*} content
 * @returns {*}
 * Analyze a file for DynamoDB scan patterns
 */
function analyzeFile(content: string, absolutePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: only scan files with DynamoDB-related code
  const hasDynamoCode =
    content.includes('dynamo') ||
    content.includes('Dynamo') ||
    content.includes('ScanCommand') ||
    content.includes('.scan(')

  // Skip files without DynamoDB code or with allowed patterns
  const hasAllowedPattern = ALLOWED_SCAN_PATTERNS.some((pattern) => pattern.test(content))
  const shouldAnalyze = hasDynamoCode && !hasAllowedPattern

  if (!shouldAnalyze) {
    return violations
  }

  const sourceFile = getSharedSourceFile(absolutePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node) => {
    // Check for ScanCommand usage
    if (ts.isNewExpression(node)) {
      const expression = node.expression.getText(sourceFile)
      if (expression === 'ScanCommand') {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
        const lineNum = line + 1
        violations.push({
          line: lineNum,
          column: 0,
          message: 'ScanCommand performs O(N) full table scan',
          severity: 'error',
          suggestion:
            'Use QueryCommand with GSI for O(1) indexed lookup. Create a Global Secondary Index on the fields you query.',
          type: 'scan-command',
          match: 'ScanCommand',
        })
      }
    }

    // Check for .scan() method calls on DynamoDB client
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.getText(sourceFile)
      if (methodName === 'scan') {
        const objectText = node.expression.expression.getText(sourceFile)
        // Only flag if it looks like a DynamoDB client
        if (
          objectText.includes('client') ||
          objectText.includes('dynamo') ||
          objectText.includes('ddb') ||
          objectText.includes('db')
        ) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
          const lineNum = line + 1
          violations.push({
            line: lineNum,
            column: 0,
            message: '.scan() method performs O(N) full table scan',
            severity: 'error',
            suggestion:
              'Use .query() with GSI for O(1) indexed lookup. Create a Global Secondary Index on the fields you query.',
            type: 'scan-method',
            match: '.scan(',
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/dynamodb-scan-detection
 *
 * Detects DynamoDB ScanCommand usage that should use QueryCommand with GSIs.
 */
export const dynamodbScanDetection = defineCheck({
  id: '58fd30a4-e6b3-4ba9-b8d0-9513163eb18c',
  slug: 'dynamodb-scan-detection',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect DynamoDB ScanCommand usage that should use QueryCommand',
  longDescription: `**Purpose:** Detects DynamoDB full table scan operations in production code that should use indexed queries via Global Secondary Indexes instead.

**Detects:**
- \`new ScanCommand\` instantiations (AWS SDK v3 DynamoDB scan)
- \`.scan()\` method calls on objects named \`client\`, \`dynamo\`, \`ddb\`, or \`db\`
- Allows scans in files matching \`migration\`, \`backfill\`, \`one-time\`, \`admin\`, or containing \`ExpressionAttributeValues\`

**Why it matters:** ScanCommand performs O(N) full table scans, consuming read capacity and degrading performance, whereas QueryCommand with a GSI provides O(1) indexed lookups.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'performance', 'dynamodb', 'database'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
