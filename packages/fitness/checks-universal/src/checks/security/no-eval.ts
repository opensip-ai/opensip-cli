// @fitness-ignore-file timer-lifecycle -- All setInterval references are in regex patterns and documentation strings, not actual timer usage
// @fitness-ignore-file no-eval -- Fitness check definition references eval/Function/setTimeout/setInterval in string literals and regex patterns, not actual usage
/**
 * @fileoverview Detect dangerous eval and dynamic code execution
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { isCommentLine } from '../../utils/index.js'

// Patterns that indicate dangerous dynamic code execution
const EVAL_PATTERNS = [
  {
    regex: /\beval\s*\(/g,
    message: 'eval() usage detected - use JSON.parse or other safe alternatives',
    suggestion:
      'Replace eval() with safe alternatives: use JSON.parse() for JSON strings, use a proper expression parser for math, or restructure code to avoid dynamic evaluation entirely.',
  },
  {
    regex: /\bnew\s+Function\s*\(/g,
    message: 'new Function() usage detected - avoid dynamic code generation',
    suggestion:
      'Replace new Function() with precompiled functions or safe alternatives. For templating, use a template engine. For dynamic behavior, use configuration objects or the strategy pattern.',
  },
  {
    regex: /setTimeout\s*\(\s*['"`][^'"`]+['"`]/g,
    message: 'setTimeout with string argument detected - use function reference',
    suggestion:
      'Pass a function reference instead of a string: setTimeout(() => doSomething(), 1000) or setTimeout(doSomething, 1000). String arguments are evaluated like eval().',
  },
  {
    regex: /setInterval\s*\(\s*['"`][^'"`]+['"`]/g,
    message: 'setInterval with string argument detected - use function reference',
    suggestion:
      'Pass a function reference instead of a string: setInterval(() => doSomething(), 1000) or setInterval(doSomething, 1000). String arguments are evaluated like eval().',
  },
]

/**
 * Find eval pattern match in a line
 * @returns The pattern and match, or null if no match
 */
function findEvalPattern(
  line: string,
): { pattern: (typeof EVAL_PATTERNS)[0]; match: RegExpExecArray } | null {
  logger.debug({
    evt: 'fitness.checks.no_eval.find_eval_pattern',
    msg: 'Searching for eval pattern in line',
  })
  for (const pattern of EVAL_PATTERNS) {
    pattern.regex.lastIndex = 0
    const match = pattern.regex.exec(line)
    if (match) {
      return { pattern, match }
    }
  }
  return null
}

/**
 * Check: security/no-eval
 *
 * Detects usage of eval(), new Function(), and similar dynamic code execution
 * patterns that can lead to code injection vulnerabilities.
 */
export const noEval = defineCheck({
  id: '9f6d299f-8155-4719-b605-897e9dcb1fdb',
  slug: 'no-eval',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',
  confidence: 'medium',
  description: 'Detect dangerous eval and dynamic code execution',
  longDescription: `**Purpose:** Detects usage of \`eval()\`, \`new Function()\`, and other dynamic code execution patterns that can lead to code injection vulnerabilities.

**Detects:**
- \`eval(\` calls
- \`new Function(\` constructor usage
- \`setTimeout('string', ...)\` with string argument instead of function reference
- \`setInterval('string', ...)\` with string argument instead of function reference

**Why it matters:** Dynamic code execution from strings (\`eval\`, \`new Function\`, string-based timers) allows attackers to inject and run arbitrary code if any input reaches these functions.

**Scope:** General best practice. Analyzes each file individually against the production preset.`,
  tags: ['security', 'injection', 'eval'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.no_eval.analyze',
      msg: 'Analyzing file for dangerous eval and dynamic code execution',
    })
    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum] ?? ''

      // Skip comments and find eval patterns in non-comment lines
      if (!isCommentLine(line)) {
        const found = findEvalPattern(line)
        if (found) {
          const { pattern, match } = found
          violations.push({
            line: lineNum + 1,
            column: match.index,
            message: pattern.message,
            severity: 'error',
            suggestion: pattern.suggestion,
            match: match[0],
            filePath,
          })
        }
      }
    }

    return violations
  },
})
