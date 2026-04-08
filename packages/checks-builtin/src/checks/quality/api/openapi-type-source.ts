// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
/**
 * @fileoverview OpenAPI Type Source Check
 *
 * Enforces that API-related types are sourced from schema.d.ts (generated from OpenAPI).
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/**
 * Patterns that suggest an API-related type
 */
const API_TYPE_PATTERNS = [/Request$/, /Response$/, /Payload$/, /DTO$/, /ApiError$/, /^Api[A-Z]/]

/**
 * Analyze a file for local API type definitions
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const visitNode = (node: ts.Node): void => {
    ts.forEachChild(node, visitNode)

    // Only check interface or type alias declarations
    if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) return

    const typeName = node.name.text
    const isApiType = API_TYPE_PATTERNS.some((pattern) => pattern.test(typeName))
    if (!isApiType) return

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
    const lineNum = line + 1
    const matchText = node.getText(sourceFile)

    violations.push({
      filePath,
      line: lineNum,
      column: character + 1,
      message: `Local API type '${typeName}' should be sourced from schema.d.ts`,
      severity: 'warning',
      suggestion: `Remove this local type definition and import '${typeName}' from the generated schema.d.ts file instead: import type { ${typeName} } from './schema.js';`,
      match: matchText,
    })
  }

  visitNode(sourceFile)
  return violations
}

/**
 * Check: quality/openapi-type-source
 *
 * Ensures API types are sourced from generated schema.d.ts.
 */
export const openapiTypeSource = defineCheck({
  id: '2f714a63-2c67-4b06-a49d-c8af6f4e717a',
  slug: 'openapi-type-source',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Ensures API types are sourced from generated schema.d.ts',
  longDescription: `**Purpose:** Enforces that API-related types are imported from the OpenAPI-generated \`schema.d.ts\` rather than manually defined in application code.

**Detects:**
- Local \`interface\` or \`type\` declarations whose names match API type patterns: \`/Request$/\`, \`/Response$/\`, \`/Payload$/\`, \`/DTO$/\`, \`/ApiError$/\`, \`/^Api[A-Z]/\`

**Why it matters:** Locally defined API types drift from the OpenAPI spec over time, causing request/response mismatches between client and server that are only caught at runtime.

**Scope:** Codebase-specific convention. Analyzes each file individually using TypeScript AST parsing. Targets frontend files, excluding \`schema.d.ts\` and \`api/schema/\` directories.`,
  tags: ['quality', 'openapi', 'types', 'architecture'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath) {
    try {
      return analyzeFile(content, filePath)
    } catch {
      // @swallow-ok Skip unreadable files
      return []
    }
  },
})
