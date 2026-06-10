// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
/**
 * @fileoverview Zod OpenAPI Sync Check
 *
 * Enforces that Zod schemas use the `.satisfies z.ZodType<GeneratedType>` pattern
 * to stay in sync with OpenAPI-generated types.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

/** Zod schema match result */
interface ZodSchemaMatch {
  schemaName: string;
  startIndex: number;
}

/**
 * Check if a zod schema definition is missing satisfies pattern
 * @returns null if schema is valid, otherwise returns violation info
 */
function checkZodSchema(
  content: string,
  match: ZodSchemaMatch,
  satisfiesPattern: RegExp,
): { lineNumber: number; schemaName: string } | null {
  const { schemaName, startIndex } = match;
  const afterMatch = content.slice(startIndex);
  const endMatch = /;\s*$/m.exec(afterMatch);

  if (!endMatch) return null;

  const endIndex = endMatch.index ?? 0;
  const schemaDefinition = afterMatch.slice(0, endIndex + 1);

  if (satisfiesPattern.test(schemaDefinition)) return null;

  const lineNumber = content.slice(0, startIndex).split('\n').length;
  return { lineNumber, schemaName };
}

/**
 * Scan file content for Zod schemas missing satisfies pattern
 */
function scanFileForZodSchemas(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const zodObjectPattern = /export\s+const\s+(\w+Schema)\s*=\s*z\.object\(/g;
  const satisfiesPattern = /satisfies\s+z\.ZodType</;

  let match;
  while ((match = zodObjectPattern.exec(content)) !== null) {
    const result = checkZodSchema(
      content,
      { schemaName: match[1] ?? 'UnknownSchema', startIndex: match.index },
      satisfiesPattern,
    );
    if (!result) continue;

    const { lineNumber, schemaName } = result;

    violations.push({
      filePath,
      line: lineNumber,
      column: 0,
      message: `Zod schema '${schemaName}' missing .satisfies z.ZodType<> pattern`,
      severity: 'warning',
      suggestion: `Add type constraint after the schema: export const ${schemaName} = z.object({...}) satisfies z.ZodType<GeneratedTypeName>; This ensures the schema stays in sync with OpenAPI-generated types`,
      match: schemaName,
    });
  }

  return violations;
}

/**
 * Check: quality/zod-openapi-sync
 *
 * Ensures Zod schemas use .satisfies z.ZodType<> pattern.
 */
export const zodOpenapiSync = defineCheck({
  id: '260f2344-0cf0-4b19-a929-f93eb79ae4f6',
  slug: 'zod-openapi-sync',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Ensures Zod schemas use .satisfies z.ZodType<> pattern',
  longDescription: `**Purpose:** Enforces that exported Zod object schemas include a \`satisfies z.ZodType<GeneratedType>\` constraint to stay in sync with OpenAPI-generated types.

**Detects:**
- Exported Zod schemas (matched by \`/export\\s+const\\s+(\\w+Schema)\\s*=\\s*z\\.object\\(/g\`) whose definitions lack the \`satisfies z.ZodType<\` pattern before the closing semicolon

**Why it matters:** Without the \`satisfies\` constraint, Zod schemas can silently diverge from the OpenAPI-generated TypeScript types, causing runtime validation failures that the type system cannot catch at compile time.

**Scope:** Codebase-specific convention. Analyzes each file individually using regex-based text scanning. Only processes files under \`/schemas/\` directories.`,
  tags: ['quality', 'architecture', 'consistency'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath) {
    // Focus on schema files
    if (!filePath.includes('/schemas/')) {
      return [];
    }

    try {
      return scanFileForZodSchemas(content, filePath);
    } catch {
      // @swallow-ok Skip unreadable files
      return [];
    }
  },
});
