// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file fitness-check-standards -- Uses fs for .dockerignore reading, not source file content
/**
 * @fileoverview Docker .dockerignore validation fitness check
 * @invariants
 * - Every Dockerfile directory must have a .dockerignore file
 * - .dockerignore must include .git pattern
 * - Node-based Dockerfiles must also include node_modules pattern
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

// =============================================================================
// REGEX PATTERNS
// =============================================================================

/** Matches FROM node:XX or FROM node:XX-alpine etc. */
const FROM_NODE_PATTERN = /^FROM\s+node:/im

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if a .dockerignore file contains a required pattern.
 * Matches exact lines (trimmed), not substrings.
 */
function hasPattern(dockerignoreContent: string, pattern: string): boolean {
  const lines = dockerignoreContent.split('\n').map((l) => l.trim())
  return lines.includes(pattern)
}

/**
 * Determine if a Dockerfile is Node-based by checking for FROM node: directives.
 */
function isNodeDockerfile(content: string): boolean {
  return FROM_NODE_PATTERN.test(content)
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: architecture/docker-ignore-validation
 *
 * Validates that every Dockerfile has a corresponding .dockerignore with required patterns:
 * 1. .git — always required
 * 2. node_modules — required for Node-based Dockerfiles
 *
 * @throws {Error} When a .dockerignore file exceeds 10MB
 */
export const dockerIgnoreValidation = defineCheck({
  id: '70123fbb-c538-4186-a82e-fdb5e53d52d7',
  slug: 'docker-ignore-validation',
  disabled: true,
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate .dockerignore files exist alongside Dockerfiles with required patterns',
  longDescription: `**Purpose:** Ensures every Dockerfile has a corresponding \`.dockerignore\` with required exclusion patterns to keep build contexts small and secure.

**Detects:**
- Missing \`.dockerignore\` file in the same directory as a Dockerfile
- \`.dockerignore\` missing the \`.git\` pattern (always required)
- \`.dockerignore\` missing the \`node_modules\` pattern for Node-based Dockerfiles (detected via \`FROM node:\` directives)

**Why it matters:** Without proper \`.dockerignore\` files, Docker build contexts include unnecessary files (.git history, node_modules), causing slow builds and potential secret leaks.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\`.`,
  tags: ['docker', 'dockerignore', 'architecture'],

  /** @throws {Error} When file system operations fail */
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    for (const filePath of files.paths) {
      const dockerfileDir = path.dirname(filePath)
      const dockerignorePath = path.join(dockerfileDir, '.dockerignore')
      const relPath = path.relative(process.cwd(), filePath)

      // Check if .dockerignore exists
      if (!fs.existsSync(dockerignorePath)) {
        violations.push({
          line: 1,
          filePath,
          message: `No .dockerignore found alongside ${relPath}`,
          severity: 'warning',
          suggestion: `Create a .dockerignore file in ${path.relative(process.cwd(), dockerfileDir)} with at least .git pattern`,
          type: 'missing-dockerignore',
        })
        continue
      }

      // Read .dockerignore and validate required patterns
      const dockerignoreStats = fs.statSync(dockerignorePath)
      if (dockerignoreStats.size > 10_000_000) throw new Error(`File too large: ${dockerignorePath}`)
      const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf-8')
      const content = await files.read(filePath)

      // .git is always required
      if (!hasPattern(dockerignoreContent, '.git')) {
        violations.push({
          line: 1,
          filePath,
          message: `.dockerignore for ${relPath} is missing required pattern: .git`,
          severity: 'warning',
          suggestion:
            'Add .git to .dockerignore to exclude version control data from build context',
          type: 'missing-pattern',
        })
      }

      // node_modules is required for Node-based Dockerfiles
      if (isNodeDockerfile(content) && !hasPattern(dockerignoreContent, 'node_modules')) {
        violations.push({
          line: 1,
          filePath,
          message: `.dockerignore for ${relPath} is missing required pattern: node_modules`,
          severity: 'warning',
          suggestion:
            'Add node_modules to .dockerignore to exclude local dependencies from build context',
          type: 'missing-pattern',
        })
      }
    }

    return violations
  },
})
