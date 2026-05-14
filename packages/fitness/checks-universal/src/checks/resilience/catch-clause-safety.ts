// @fitness-ignore-file catch-clause-safety -- check definition contains pattern examples in description strings
/**
 * @fileoverview Catch clause safety check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Analyze catch clauses for unsafe patterns
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Inherent complexity: multi-pattern catch clause analysis tracking brace depth, instanceof checks, and rethrow patterns
function analyzeCatchSafety(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  // Quick check: skip files without catch
  if (!content.includes('catch')) return violations

  let inCatchBlock = false
  let catchBlockStart = 0
  let braceDepth = 0
  let catchHasInstanceofCheck = false
  let catchVarName = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    // Detect catch clause entry
    const catchMatch = line.match(/\bcatch\s*\(\s*(\w+)(?:\s*:\s*(\w+))?\s*\)/)
    if (catchMatch) {
      inCatchBlock = true
      catchBlockStart = i
      braceDepth = 0
      catchHasInstanceofCheck = false
      catchVarName = catchMatch[1] ?? 'error'
      const typeAnnotation = catchMatch[2]

      // Check for explicit `any` annotation: catch (e: any)
      if (typeAnnotation === 'any') {
        violations.push({
          line: i + 1,
          message: '`catch` variable explicitly typed as `any` — use `unknown` for type safety',
          severity: 'warning',
          suggestion: `Change \`catch (${catchVarName}: any)\` to \`catch (${catchVarName})\` (TypeScript defaults to unknown with useUnknownInCatchVariables)`,
          type: 'catch-any-annotation',
          match: trimmed.slice(0, 120),
        })
      }
    }

    if (inCatchBlock) {
      // Track brace depth
      for (const char of line) {
        if (char === '{') braceDepth++
        if (char === '}') braceDepth--
      }

      // Check for instanceof Error guard
      if (line.includes('instanceof Error')) {
        catchHasInstanceofCheck = true
      }

      // Check for unsafe `as Error` cast
      if (line.includes('as Error') && !catchHasInstanceofCheck) {
        violations.push({
          line: i + 1,
          message:
            'Unsafe `as Error` cast in catch block without `instanceof Error` guard — caught value may not be an Error',
          severity: 'warning',
          suggestion: `Use \`if (${catchVarName} instanceof Error)\` guard or normalize the error with a toError() utility`,
          type: 'unsafe-error-cast',
          match: trimmed.slice(0, 120),
        })
      }

      // Exit catch block when braces close
      if (braceDepth <= 0 && i > catchBlockStart) {
        inCatchBlock = false
      }
    }
  }

  return violations
}

/**
 * Check: resilience/catch-clause-safety
 *
 * Detects unsafe catch clause patterns:
 * - `as Error` casts without instanceof guard
 * - `catch(e: any)` explicit any annotation
 */
export const catchClauseSafety = defineCheck({
  id: 'b0bae498-e01a-4eeb-ab5e-ab18776e3111',
  slug: 'catch-clause-safety',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  description:
    'Detects unsafe catch clause patterns: as Error casts without instanceof, catch(e: any)',
  longDescription: `**Purpose:** Detects unsafe catch clause patterns that can cause runtime errors when the caught value is not actually an Error instance.

**Detects:**
- \`as Error\` type casts inside catch blocks without a preceding \`instanceof Error\` guard
- \`catch (e: any)\` explicit any annotations instead of using unknown

**Why it matters:** Caught values in JavaScript can be anything (string, number, object), not just Error instances. Unsafe casts can cause secondary runtime errors that mask the original problem.

**Scope:** Production code. Analyzes each file individually via regex-based line scanning.`,
  tags: ['errors', 'resilience', 'type-safety'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings',
  confidence: 'medium',
  analyze: analyzeCatchSafety,
})
