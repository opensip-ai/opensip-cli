/**
 * @fileoverview Contracts schema consistency check
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/**
 * Check: architecture/contracts-schema-consistency
 *
 * Validates that contracts use Zod schemas consistently:
 * - Types derived from schemas via z.infer
 */
export const contractsSchemaConsistency = defineCheck({
  id: '3f2fb75f-27f5-4572-aa18-1947f98ac82f',
  slug: 'contracts-schema-consistency',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description:
    'Validates that contracts use Zod schemas consistently: types derived from schemas via z.infer',
  longDescription: `**Purpose:** Ensures contracts package maintains consistency between Zod schemas and TypeScript types.

**Detects:**
- Types defined alongside Zod schemas that are NOT derived via \`z.infer<typeof Schema>\`

**Why it matters:** Manual type definitions alongside schemas can drift, causing runtime/compile-time mismatches.

**Scope:** Contracts package only. Analyzes all matched files together (\`analyzeAll\`).`,
  tags: ['architecture', 'contracts', 'zod', 'consistency'],
  fileTypes: ['ts'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Schema validation requires nested checks for type derivation patterns across multiple Zod constructs
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    // @fitness-ignore-next-line batch-operation-limits -- files.paths is bounded by contracts package scope (typically <100 files)
    for (const filePath of files.paths) {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath)
      if (!content) continue
      const lines = content.split('\n')

      // --- Check 1: Types alongside schemas should use z.infer ---
      const schemaNames = new Set<string>()
      // @fitness-ignore-next-line batch-operation-limits -- iterating over lines of a single file, bounded by file-length-limits check
      for (const line of lines) {
        const schemaMatch = /export\s+const\s+(\w+Schema)\s*=\s*z\./.exec(line)
        if (schemaMatch?.[1]) {
          schemaNames.add(schemaMatch[1])
        }
      }

      for (const [i, line_] of lines.entries()) {
        const line = line_ ?? ''

        // Check for manually defined types that have a corresponding schema
        const typeMatch = /export\s+type\s+(\w+)\s*=\s*(?!z\.infer)/.exec(line)
        if (typeMatch?.[1]) {
          const typeName = typeMatch[1]
          const expectedSchema = `${typeName}Schema`
          if (schemaNames.has(expectedSchema) && !line.includes('z.infer')) {
            violations.push({
              filePath,
              line: i + 1,
              message: `Type '${typeName}' has a corresponding Zod schema '${expectedSchema}' but is not derived from it`,
              severity: 'error',
              suggestion: `Change to: export type ${typeName} = z.infer<typeof ${expectedSchema}>`,
              type: 'type-schema-mismatch',
            })
          }
        }

        // Check 2 (.passthrough()/.strict() on object schemas) is intentionally
        // disabled — opensip does not use .passthrough() as a convention and the
        // sub-check produced false positives across the codebase.
      }
    }

    return violations
  },
})
