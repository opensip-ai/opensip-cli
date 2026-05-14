// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Database Schema Validation check
 *
 * Validates database schema definitions for best practices:
 * - Primary key definitions
 * - Foreign key relationships
 * - Appropriate column types
 * - Index definitions
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

// =============================================================================
// Helper Types and Interfaces
// =============================================================================

interface EntityAnalysisState {
  hasIdColumn: boolean
  hasCreatedAt: boolean
  hasUpdatedAt: boolean
}

interface AnalysisContext {
  absolutePath: string
  content: string
  sourceFile: ts.SourceFile
  lines: string[]
}

// =============================================================================
// Code Snippet Helpers
// =============================================================================

/**
 * Determine which audit columns are missing.
 *
 * @param hasCreatedAt - Has createdAt column
 * @param hasUpdatedAt - Has updatedAt column
 * @returns Description of missing columns
 */
function getMissingAuditColumnsDescription(hasCreatedAt: boolean, hasUpdatedAt: boolean): string {
  if (!hasCreatedAt && !hasUpdatedAt) {
    return 'createdAt and updatedAt'
  }
  if (!hasCreatedAt) {
    return 'createdAt'
  }
  return 'updatedAt'
}

// =============================================================================
// Decorator Analysis Helpers
// =============================================================================

/**
 * Check if a class has the @Entity decorator.
 *
 * @param node - Class declaration node
 * @returns True if has Entity decorator
 */
function hasEntityDecorator(node: ts.ClassDeclaration): boolean {
  return (
    node.modifiers?.some(
      (m) =>
        ts.isDecorator(m) &&
        ts.isCallExpression(m.expression) &&
        ts.isIdentifier(m.expression.expression) &&
        m.expression.expression.text === 'Entity',
    ) ?? false
  )
}

/**
 * Get the decorator name from a decorator node if it's a call expression.
 *
 * @param decorator - Decorator node
 * @returns Decorator name or null
 */
function getDecoratorName(decorator: ts.Decorator): string | null {
  if (!ts.isCallExpression(decorator.expression)) {
    return null
  }
  if (!ts.isIdentifier(decorator.expression.expression)) {
    return null
  }
  return decorator.expression.expression.text
}

/**
 * Check if a Column decorator has nullable: true without a default value.
 *
 * @param decorator - Decorator node
 * @returns True if nullable without default
 */
function isNullableWithoutDefault(decorator: ts.Decorator): boolean {
  if (!ts.isCallExpression(decorator.expression)) {
    return false
  }

  const arg = decorator.expression.arguments[0]
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return false
  }

  const isNullable = arg.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'nullable' &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword,
  )

  const hasDefault = arg.properties.some(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'default',
  )

  return isNullable && !hasDefault
}

// =============================================================================
// Violation Creation Helpers
// =============================================================================

/**
 * Create a violation for a nullable column without default.
 *
 * @param propName - Property name
 * @param line - Line number (0-indexed)
 * @returns Violation object
 */
function createNullableColumnViolation(propName: string, line: number): CheckViolation {
  return {
    line: line + 1,
    column: 0,
    message: `Column '${propName}' is nullable - consider adding default value`,
    severity: 'warning',
    suggestion: `Add default: null or default: '' to @Column({ nullable: true, default: ... }) for '${propName}' to avoid undefined behavior`,
    type: 'nullable-without-default',
    match: propName,
  }
}

/**
 * Create a violation for missing primary key.
 *
 * @param ctx - Analysis context
 * @param node - Class declaration node
 * @returns Violation object
 */
function createMissingPrimaryKeyViolation(
  ctx: AnalysisContext,
  node: ts.ClassDeclaration,
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const line = lineIdx + 1
  const className = node.name?.getText(ctx.sourceFile) ?? 'Entity'

  return {
    line,
    column: character + 1,
    message: 'Entity missing primary key column',
    severity: 'error',
    suggestion: `Add '@PrimaryGeneratedColumn('uuid') id: string;' to ${className} for proper identity management`,
    type: 'missing-primary-key',
    match: className,
  }
}

/**
 * Create a violation for missing audit columns.
 *
 * @param ctx - Analysis context
 * @param node - Class declaration node
 * @param state - Entity analysis state
 * @returns Violation object
 */
function createMissingAuditColumnsViolation(
  ctx: AnalysisContext,
  node: ts.ClassDeclaration,
  state: EntityAnalysisState,
): CheckViolation {
  const { line: lineIdx, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const line = lineIdx + 1
  const className = node.name?.getText(ctx.sourceFile) ?? 'Entity'
  const missing = getMissingAuditColumnsDescription(state.hasCreatedAt, state.hasUpdatedAt)

  return {
    line,
    column: character + 1,
    message: 'Entity missing audit columns (createdAt/updatedAt)',
    severity: 'warning',
    suggestion: `Add '@CreateDateColumn() createdAt: Date;' and '@UpdateDateColumn() updatedAt: Date;' to ${className} for audit trail (missing: ${missing})`,
    type: 'missing-audit-columns',
    match: className,
  }
}

// =============================================================================
// Property Analysis
// =============================================================================

/**
 * Process a single property member and update state/violations.
 *
 * @param member - Property declaration
 * @param ctx - Analysis context
 * @param state - Entity analysis state
 * @param violations - Violations array to append to
 */
function processPropertyMember(
  member: ts.PropertyDeclaration,
  ctx: AnalysisContext,
  state: EntityAnalysisState,
  violations: CheckViolation[],
): void {
  if (!ts.isIdentifier(member.name)) {
    return
  }

  const propName = member.name.text
  const { line } = ctx.sourceFile.getLineAndCharacterOfPosition(member.getStart())
  const decorators = ts.getDecorators(member) ?? []

  for (const decorator of decorators) {
    const decoratorName = getDecoratorName(decorator)
    if (!decoratorName) {
      continue
    }

    updateStateFromDecorator(decoratorName, state)
    checkColumnDecorator({ decorator, decoratorName, propName, line, violations })
  }
}

/**
 * Update entity state based on decorator name.
 *
 * @param decoratorName - Name of the decorator
 * @param state - State to update
 */
function updateStateFromDecorator(decoratorName: string, state: EntityAnalysisState): void {
  if (decoratorName === 'PrimaryGeneratedColumn' || decoratorName === 'PrimaryColumn') {
    state.hasIdColumn = true
  }
  if (decoratorName === 'CreateDateColumn') {
    state.hasCreatedAt = true
  }
  if (decoratorName === 'UpdateDateColumn') {
    state.hasUpdatedAt = true
  }
}

/**
 * Options for checking column decorators
 */
interface CheckColumnDecoratorOptions {
  decorator: ts.Decorator
  decoratorName: string
  propName: string
  line: number
  violations: CheckViolation[]
}

/**
 * Check if a Column decorator has violations.
 *
 * @param options - Options containing decorator and analysis context
 */
function checkColumnDecorator(options: CheckColumnDecoratorOptions): void {
  const { decorator, decoratorName, propName, line, violations } = options

  // Validate array parameter
  if (!Array.isArray(violations)) {
    return
  }

  if (decoratorName !== 'Column') {
    return
  }

  if (isNullableWithoutDefault(decorator)) {
    violations.push(createNullableColumnViolation(propName, line))
  }
}

// =============================================================================
// Entity Class Analysis
// =============================================================================

/**
 * Analyze an entity class for schema validation issues.
 *
 * @param node - Class declaration node
 * @param ctx - Analysis context
 * @param violations - Violations array to append to
 */
function analyzeEntityClass(
  node: ts.ClassDeclaration,
  ctx: AnalysisContext,
  violations: CheckViolation[],
): void {
  // Validate array parameter
  if (!Array.isArray(violations)) {
    return
  }

  const state: EntityAnalysisState = {
    hasIdColumn: false,
    hasCreatedAt: false,
    hasUpdatedAt: false,
  }

  // Process all property members
  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member)) {
      processPropertyMember(member, ctx, state, violations)
    }
  }

  // Check for missing primary key
  if (!state.hasIdColumn) {
    violations.push(createMissingPrimaryKeyViolation(ctx, node))
  }

  // Check for missing audit columns
  if (!state.hasCreatedAt || !state.hasUpdatedAt) {
    violations.push(createMissingAuditColumnsViolation(ctx, node, state))
  }
}

// =============================================================================
// Main Analysis Function
// =============================================================================

/**
 * Check if file is an entity/schema file
 */
function isEntityFile(filePath: string): boolean {
  return (
    filePath.includes('/entities/') ||
    filePath.includes('/models/') ||
    filePath.includes('.entity.ts') ||
    filePath.includes('.model.ts')
  )
}

/**
 * Analyze a file for schema validation issues.
 *
 * @param content - File content
 * @param absolutePath - Absolute path to the file
 * @returns Array of violations found
 */
function analyzeFile(content: string, absolutePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Filter to entity/schema files
  if (!isEntityFile(absolutePath)) {
    return violations
  }

  // Check if file contains TypeORM entity
  if (!content.includes('@Entity') && !content.includes('@Table')) {
    return violations
  }

  const sourceFile = getSharedSourceFile(absolutePath, content)
    if (!sourceFile) return []

  const ctx: AnalysisContext = {
    absolutePath,
    content,
    sourceFile,
    lines: content.split('\n'),
  }

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && hasEntityDecorator(node)) {
      analyzeEntityClass(node, ctx, violations)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/database-schema-validation
 *
 * Validates database schema definitions follow best practices.
 */
export const databaseSchemaValidation = defineCheck({
  id: 'b052a199-cf3c-4c31-8707-6d60331621a8',
  slug: 'database-schema-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Validate database schema definitions follow best practices',
  longDescription: `**Purpose:** Validates that TypeORM entity classes follow schema best practices for primary keys, audit columns, and nullable column defaults.

**Detects:**
- Entity classes (decorated with \`@Entity\`) missing a \`@PrimaryGeneratedColumn\` or \`@PrimaryColumn\` decorator
- Entity classes missing \`@CreateDateColumn\` and/or \`@UpdateDateColumn\` audit columns
- \`@Column({ nullable: true })\` without a \`default\` value, which can cause undefined behavior
- Only scans files in \`/entities/\`, \`/models/\`, or files named \`*.entity.ts\`/\`*.model.ts\` that contain \`@Entity\` or \`@Table\`

**Why it matters:** Missing primary keys break identity management, missing audit columns lose change history, and nullable columns without defaults cause subtle data integrity bugs.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'database', 'schema', 'typeorm'],
  fileTypes: ['ts'],

  analyze: analyzeFile,
})
