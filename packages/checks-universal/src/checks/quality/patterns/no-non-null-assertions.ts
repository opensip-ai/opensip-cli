/**
 * @fileoverview No non-null assertions check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { isTestFile } from '../../../utils/index.js'

/**
 * Regex to detect non-null assertion operator usage.
 * Matches patterns like: expr!. or expr![ or expr!) where expr is an identifier.
 * Avoids matching !== and != comparisons.
 */
// eslint-disable-next-line sonarjs/slow-regex -- character class has no overlap; '!' acts as fixed delimiter
const NON_NULL_ASSERTION_REGEX = /([\w.[\]]+)!\s*[.[;,)]/g

/**
 * Analyze a file for non-null assertion operator usage
 */
// eslint-disable-next-line sonarjs/cognitive-complexity, sonarjs/cyclomatic-complexity -- Inherent complexity: template literal tracking + regex matching + multiple skip conditions
function analyzeNonNullAssertions(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  // Track template literal nesting to skip lines inside multi-line template literals
  let inTemplateLiteral = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // Track template literal boundaries (count unescaped backticks)
    let backtickCount = 0
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '`' && (c === 0 || line[c - 1] !== '\\')) backtickCount++
    }
    if (backtickCount % 2 === 1) inTemplateLiteral = !inTemplateLiteral

    // Skip lines inside multi-line template literals (e.g., longDescription text)
    if (inTemplateLiteral && backtickCount % 2 === 0) continue

    // Skip comments, imports, and type declarations
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import '))
      continue
    if (
      trimmed.startsWith('type ') ||
      trimmed.startsWith('interface ') ||
      trimmed.startsWith('export type ') ||
      trimmed.startsWith('export interface ')
    )
      continue

    // Skip lines that are string literals (rough heuristic)
    if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith('`')) continue

    NON_NULL_ASSERTION_REGEX.lastIndex = 0
    let match
    while ((match = NON_NULL_ASSERTION_REGEX.exec(line)) !== null) {
      // Make sure this isn't part of !== or !=
      const bangPos = match.index + (match[1]?.length ?? 0)
      const nextChar = line[bangPos + 1]
      if (nextChar === '=') continue

      violations.push({
        line: i + 1,
        message: `Non-null assertion operator (\`!\`) used on '${match[1]}' — this bypasses TypeScript null checking`,
        severity: 'warning',
        suggestion:
          'Use optional chaining (?.), nullish coalescing (??), or a proper null guard instead of the ! operator',
        type: 'non-null-assertion',
        match: trimmed.slice(0, 120),
      })
    }
  }

  return violations
}

/**
 * Check: quality/no-non-null-assertions
 *
 * Detects TypeScript non-null assertion operator (!) usage in production code.
 */
export const noNonNullAssertions = defineCheck({
  id: 'd1e51952-5758-40f3-999b-b83f57db9a42',
  slug: 'no-non-null-assertions',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description:
    'Detects TypeScript non-null assertion operator (!) usage in production code — prefer proper null handling',
  longDescription: `**Purpose:** Detects uses of the TypeScript non-null assertion operator (\`!\`) which bypasses null checking and can mask real null/undefined bugs at runtime.

**Detects:**
- \`expr!.property\` — non-null assertion before property access
- \`expr![index]\` — non-null assertion before index access
- Excludes \`!==\` and \`!=\` comparisons (not assertions)

**Why it matters:** Non-null assertions are type-safety escape hatches. They tell TypeScript "trust me, this is not null" without any runtime check. When wrong, they cause runtime errors.

**Scope:** Production code. Analyzes each file individually via regex.`,
  tags: ['type-safety', 'quality', 'typescript'],
  fileTypes: ['ts', 'tsx'],
  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — non-null assertions in tests are low-risk due to controlled inputs
    if (isTestFile(filePath)) return []
    return analyzeNonNullAssertions(content, filePath)
  },
})
