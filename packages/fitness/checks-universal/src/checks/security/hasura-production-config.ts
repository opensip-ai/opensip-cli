// @fitness-ignore-file batch-operation-limits -- Promise.all is bounded to production docker-compose files (typically 1-3)
/**
 * @fileoverview Verify Hasura production security settings
 *
 * Validates that production docker-compose files include required Hasura security settings:
 * - Introspection disabled
 * - Allow-list enabled
 * - Dev mode disabled
 * - Console disabled
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

interface RequiredSetting {
  envVar: string
  expectedValue: string
  description: string
}

const REQUIRED_SETTINGS: RequiredSetting[] = [
  {
    envVar: 'HASURA_GRAPHQL_ENABLE_INTROSPECTION',
    expectedValue: '"false"',
    description: 'Introspection must be disabled in production to prevent schema discovery',
  },
  {
    envVar: 'HASURA_GRAPHQL_ENABLE_ALLOWLIST',
    expectedValue: '"true"',
    description: 'Allow-list must be enabled in production to restrict queries to known operations',
  },
  {
    envVar: 'HASURA_GRAPHQL_DEV_MODE',
    expectedValue: '"false"',
    description: 'Dev mode must be disabled in production to hide detailed error messages',
  },
  {
    envVar: 'HASURA_GRAPHQL_ENABLE_CONSOLE',
    expectedValue: '"false"',
    description: 'Console must be disabled in production to prevent unauthorized schema access',
  },
]

function findHasuraEnvLine(content: string): number {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').includes('HASURA_GRAPHQL_')) {
      return i + 1
    }
  }
  return 1
}

function checkMissingSettings(filePath: string, content: string): CheckViolation[] {
  if (!content.includes('hasura') || !content.includes('HASURA_GRAPHQL_')) return []

  const violations: CheckViolation[] = []
  for (const setting of REQUIRED_SETTINGS) {
    const presencePattern = new RegExp(`${setting.envVar}\\s*:`)
    const correctValuePattern = new RegExp(
      `${setting.envVar}\\s*:\\s*${setting.expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    )

    if (!presencePattern.test(content)) {
      violations.push({
        filePath,
        line: findHasuraEnvLine(content),
        severity: 'warning',
        message: `Missing ${setting.envVar}: ${setting.expectedValue}. ${setting.description}.`,
        suggestion: `Add \`${setting.envVar}: ${setting.expectedValue}\` to the hasura environment section.`,
      })
    } else if (!correctValuePattern.test(content)) {
      const lines = content.split('\n')
      const settingLine = lines.findIndex(l => presencePattern.test(l))
      violations.push({
        filePath,
        line: settingLine >= 0 ? settingLine + 1 : findHasuraEnvLine(content),
        severity: 'warning',
        message: `${setting.envVar} has incorrect value. Expected: ${setting.expectedValue}. ${setting.description}.`,
        suggestion: `Change to \`${setting.envVar}: ${setting.expectedValue}\`.`,
      })
    }
  }
  return violations
}

export const hasuraProductionConfig = defineCheck({
  id: '54cc4b96-2cb3-4a43-9405-550e6b25bbb9',
  slug: 'hasura-production-config',
  disabled: true,
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Verify Hasura production docker-compose has required security settings',
  longDescription: `**Purpose:** Ensures production docker-compose files include all required Hasura GraphQL Engine security settings.

**Detects:**
- Missing \`HASURA_GRAPHQL_ENABLE_INTROSPECTION: "false"\` (prevents schema discovery)
- Missing \`HASURA_GRAPHQL_ENABLE_ALLOWLIST: "true"\` (restricts queries to known operations)
- Missing \`HASURA_GRAPHQL_DEV_MODE: "false"\` (hides detailed error messages)
- Missing \`HASURA_GRAPHQL_ENABLE_CONSOLE: "false"\` (prevents unauthorized schema access)

**Why it matters:** Hasura defaults are permissive for development. In production, exposed introspection, console, and dev mode leak schema details and enable unauthorized query exploration.

**Scope:** Codebase-specific convention. Cross-file analysis on production docker-compose files (\`*prod*\`).`,
  tags: ['security', 'hasura', 'graphql', 'infrastructure'],
  fileTypes: ['yml', 'yaml'],
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    logger.debug({
      evt: 'fitness.checks.hasura_production_config.analyze_all',
      msg: 'Analyzing production docker-compose files for Hasura security settings',
    })
    const prodFiles = files.paths.filter((p) => {
      const filename = p.split('/').pop() ?? ''
      return filename.includes('prod')
    })

    // Read all prod files in parallel to avoid sequential async in loop
    // @fitness-ignore-next-line no-unbounded-concurrency -- Bounded to production docker-compose files (typically 1-3)
    const fileEntries = await Promise.all(
      prodFiles.map(async (filePath) => {
        const content = await files.read(filePath)
        return { filePath, content }
      }),
    )

    const violations: CheckViolation[] = []

    for (const { filePath, content } of fileEntries) {
      // @lazy-ok -- result validation depends on preceding file read operation
      if (!content) continue
      violations.push(...checkMissingSettings(filePath, content))
    }

    return violations
  },
})
