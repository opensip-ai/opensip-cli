/**
 * @fileoverview No Custom Event Emitter check (v2)
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

interface EventEmitterIssue {
  file: string
  line: number
  type: string
  match: string
  suggestion: string
  severity: 'error' | 'warning'
}

/**
 * Creates a pre-compiled RegExp for pattern matching.
 * These patterns operate on trusted source code files, not user input.
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags
 * @returns Compiled RegExp object
 */
function createPattern(pattern: string, flags?: string): RegExp {
  // @fitness-ignore-next-line semgrep-scan -- non-literal RegExp is intentional; patterns are hardcoded string constants for code analysis, not user input
  return new RegExp(pattern, flags)
}

// Note: These regex patterns operate on trusted source code files, not user input.
// The patterns use bounded character classes ([^}]*) instead of .* to prevent ReDoS.
const EVENT_EMITTER_PATTERNS = [
  {
    // Fixed pattern - no backtracking issues
    pattern: createPattern(String.raw`new\s+EventEmitter\s*\(`, 'g'),
    type: 'new-event-emitter',
    suggestion: 'Use a centralized event bus instead of direct EventEmitter instantiation',
    severity: 'error' as const,
  },
  {
    // Fixed pattern - word boundary prevents issues
    pattern: createPattern(String.raw`extends\s+EventEmitter\b`, 'g'),
    type: 'extends-event-emitter',
    suggestion: 'Implement event handling via a centralized event bus instead of extending EventEmitter',
    severity: 'error' as const,
  },
  {
    // Use [^}]* (bounded by curly brace) instead of .* to prevent catastrophic backtracking
    pattern: createPattern(String.raw`import\s+[^}]*\bEventEmitter\b[^}]*from\s+['"]events['"]`, 'g'),
    type: 'import-event-emitter',
    suggestion: 'Use a centralized event bus instead of importing EventEmitter directly',
    severity: 'error' as const,
  },
  {
    // Use [^}]* (bounded by curly brace) instead of .* to prevent catastrophic backtracking
    pattern: createPattern(
      String.raw`import\s+[^}]*\bEventEmitter\b[^}]*from\s+['"]node:events['"]`,
      'g',
    ),
    type: 'import-event-emitter',
    suggestion: 'Use a centralized event bus instead of importing EventEmitter directly',
    severity: 'error' as const,
  },
]

const EVENT_INFRA_PATTERNS = [/infrastructure\/events\//, /foundation\//, /\/adapters\//, /interfaces\//]

function analyzeFile(filePath: string, content: string): EventEmitterIssue[] {
  const issues: EventEmitterIssue[] = []

  if (EVENT_INFRA_PATTERNS.some((p) => p.test(filePath))) {
    return []
  }

  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    if (!line) continue

    for (const { pattern, type, suggestion, severity } of EVENT_EMITTER_PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match) {
        issues.push({
          file: filePath,
          line: i + 1,
          type,
          match: match[0],
          suggestion,
          severity,
        })
      }
    }
  }

  return issues
}

/**
 * Check: architecture/no-custom-event-emitter
 *
 * Detects direct EventEmitter usage that should use infrastructure/events module.
 * Ensures consistent event handling patterns across the codebase.
 */
export const noCustomEventEmitter = defineCheck({
  id: '7a36c3b8-fb23-42fc-8f25-336e012aab57',
  slug: 'no-custom-event-emitter',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detects direct EventEmitter usage that should use infrastructure/events',
  longDescription: `**Purpose:** Prevents direct usage of Node.js \`EventEmitter\` in favor of a centralized event bus.

**Detects:**
- Direct instantiation of Node.js event emitter
- Class inheritance from Node.js event emitter
- Imports of Node.js event emitter from 'events' or 'node:events'
- Excludes \`infrastructure/events/\`, \`foundation/\`, \`/adapters/\`, and \`interfaces/\` directories

**Why it matters:** Custom event emitters bypass centralized event bus patterns, making event flows untraceable and inconsistent across the platform.

**Scope:** Codebase-specific convention. Analyzes each file individually.`,
  tags: ['architecture', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip if no EventEmitter usage
    if (!content.includes('EventEmitter')) {
      return []
    }

    const issues = analyzeFile(filePath, content)

    return issues.map((issue) => ({
      line: issue.line,
      message: `Custom event emitter: ${issue.type}. ${issue.suggestion}`,
      severity: issue.severity,
      suggestion: issue.suggestion,
      match: issue.match,
      type: issue.type,
    }))
  },
})
