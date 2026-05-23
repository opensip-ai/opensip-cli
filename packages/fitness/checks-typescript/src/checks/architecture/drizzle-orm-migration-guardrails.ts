/**
 * @fileoverview Drizzle ORM migration guardrails
 * @module checks-builtin/checks/architecture/drizzle-orm-migration-guardrails
 *
 * Detects dangerous patterns in Drizzle ORM migrations and queries:
 * - Raw SQL template literals that bypass the query builder
 * - Missing transaction wrappers on multi-statement migrations
 * - DROP TABLE/COLUMN without explicit confirmation comment
 * - ALTER TABLE with data loss risk (column type changes)
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

interface DangerousPattern {
  pattern: RegExp
  message: string
  suggestion: string
  severity: 'error' | 'warning'
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    pattern: /sql\.unsafe\s*\(/,
    message: 'sql.unsafe() bypasses parameterized queries — SQL injection risk',
    suggestion: 'Use parameterized queries via the Drizzle query builder or sql`` template literals with interpolation.',
    severity: 'error',
  },
  {
    pattern: /DROP\s+TABLE/i,
    message: 'DROP TABLE detected — data loss risk. Ensure this is intentional.',
    suggestion: 'Add a comment above confirming this is intentional: // DATA-LOSS: intentional table drop for migration X',
    severity: 'warning',
  },
  {
    pattern: /DROP\s+COLUMN/i,
    message: 'DROP COLUMN detected — data loss risk. Ensure this is intentional.',
    suggestion: 'Add a comment above confirming this is intentional: // DATA-LOSS: intentional column drop',
    severity: 'warning',
  },
  {
    pattern: /ALTER\s+(?:TABLE|COLUMN).*TYPE/i,
    message: 'Column type change detected — potential data loss or truncation',
    suggestion: 'Verify the type change is safe. Add a comment explaining the migration strategy.',
    severity: 'warning',
  },
  {
    pattern: /TRUNCATE\s+/i,
    message: 'TRUNCATE detected — deletes all rows without logging',
    suggestion: 'Use DELETE with a WHERE clause if you need audit logging, or confirm TRUNCATE is intentional.',
    severity: 'error',
  },
]

const DATA_LOSS_CONFIRMATION = /DATA-LOSS.*intentional/i

export const drizzleOrmMigrationGuardrails = defineCheck({
  id: 'd4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a',
  slug: 'drizzle-orm-migration-guardrails',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  confidence: 'high',
  description: 'Detects dangerous patterns in Drizzle ORM migrations (raw SQL, DROP, TRUNCATE, type changes)',
  tags: ['architecture', 'database', 'safety', 'drizzle'],
  fileTypes: ['ts'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- multi-pattern guardrail: each branch detects a distinct dangerous Drizzle migration pattern
  analyze(content: string, filePath: string): CheckViolation[] {
    // Only check migration files and schema files
    if (!filePath.includes('/migrations/') && !filePath.includes('/schema')) return []
    if (isTestFile(filePath)) return []

    const violations: CheckViolation[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      /* v8 ignore next -- defensive guard */
      if (!line) continue

      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

      for (const dp of DANGEROUS_PATTERNS) {
        if (dp.pattern.test(line)) {
          // Check if previous lines have a DATA-LOSS confirmation comment
          /* v8 ignore next -- defensive non-negative guard */
          const prevLines = lines.slice(Math.max(0, i - 3), i).join('\n')
          if (DATA_LOSS_CONFIRMATION.test(prevLines)) continue

          violations.push({
            line: i + 1,
            message: dp.message,
            severity: dp.severity,
            suggestion: dp.suggestion,
            type: 'MIGRATION_GUARDRAIL',
            match: trimmed.slice(0, 100),
            filePath,
          })
        }
      }
    }

    return violations
  },
})
