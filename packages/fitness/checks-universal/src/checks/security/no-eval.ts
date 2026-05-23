// @fitness-ignore-file timer-lifecycle -- All setInterval references are in regex patterns and documentation strings, not actual timer usage
// @fitness-ignore-file no-eval -- Fitness check definition references eval/Function/setTimeout/setInterval in string literals and regex patterns, not actual usage
/**
 * @fileoverview Detect dangerous eval and dynamic code execution
 *
 * Migrated to defineRegexListCheck (Layer 4 Phase C6). The original
 * `findEvalPattern` shape returned only the first matching pattern's
 * exec result per line; that semantics is preserved via the helper's
 * `oneViolationPerLine: true` option (combined with non-global regexes).
 */

import { defineRegexListCheck } from '@opensip-tools/fitness'

/**
 * Check: security/no-eval
 *
 * Detects usage of eval(), new Function(), and similar dynamic code execution
 * patterns that can lead to code injection vulnerabilities.
 */
export const noEval = defineRegexListCheck({
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
  options: {
    // Original site emitted at most one violation per line, returning
    // the FIRST matching pattern via findEvalPattern().
    oneViolationPerLine: true,
  },
  patterns: [
    {
      id: 'a48c7e1a-2acb-4be6-9f97-71f95dee9eef',
      slug: 'eval-call',
      regex: /\beval\s*\(/,
      message: 'eval() usage detected - use JSON.parse or other safe alternatives',
      severity: 'error',
      suggestion:
        'Replace eval() with safe alternatives: use JSON.parse() for JSON strings, use a proper expression parser for math, or restructure code to avoid dynamic evaluation entirely.',
    },
    {
      id: 'b2c0d1aa-9d24-4d9c-8e22-2c2b78c2c021',
      slug: 'new-function',
      regex: /\bnew\s+Function\s*\(/,
      message: 'new Function() usage detected - avoid dynamic code generation',
      severity: 'error',
      suggestion:
        'Replace new Function() with precompiled functions or safe alternatives. For templating, use a template engine. For dynamic behavior, use configuration objects or the strategy pattern.',
    },
    {
      id: 'c3d1e2bb-ae34-4e0d-9f33-3d3c89d3d132',
      slug: 'set-timeout-string',
      regex: /setTimeout\s*\(\s*['"`][^'"`]+['"`]/,
      message: 'setTimeout with string argument detected - use function reference',
      severity: 'error',
      suggestion:
        'Pass a function reference instead of a string: setTimeout(() => doSomething(), 1000) or setTimeout(doSomething, 1000). String arguments are evaluated like eval().',
    },
    {
      id: 'd4e2f3cc-bf45-4f1e-a044-4e4d9ae4e243',
      slug: 'set-interval-string',
      regex: /setInterval\s*\(\s*['"`][^'"`]+['"`]/,
      message: 'setInterval with string argument detected - use function reference',
      severity: 'error',
      suggestion:
        'Pass a function reference instead of a string: setInterval(() => doSomething(), 1000) or setInterval(doSomething, 1000). String arguments are evaluated like eval().',
    },
  ],
})
