/* eslint-disable no-restricted-syntax -- Allowed in fitness check targets */
// @fitness-ignore-file fitness-check-standards -- Uses fs for README existence checking, not source file content
/**
 * @fileoverview Project README existence check
 *
 * Ensures every package, app, CLI, and service has a README.md file.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

/**
 * Check: architecture/project-readme-existence
 *
 * Ensures every package, app, CLI tool, and service has a README.md file
 * for documentation and discoverability.
 */
export const projectReadmeExistence = defineCheck({
  id: 'a7d3e1f2-8b4c-4d9e-af12-6c8b3d7e9f01',
  slug: 'project-readme-existence',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },

  confidence: 'medium',
  description: 'Ensures every package has a README.md file',
  longDescription: `**Purpose:** Ensures every package, app, CLI tool, and service has a README.md file for documentation and discoverability.

**Detects:**
- Missing \`README.md\` files in package directories
- Checks sibling directory of each \`package.json\`
- Skips the monorepo root \`package.json\` (via target patterns)

**Why it matters:** README files are essential for onboarding, discoverability, and maintaining documentation standards across the monorepo. Without them, developers must read source code to understand package purpose and usage.

**Scope:** Cross-file analysis via \`analyzeAll\`. Codebase-specific convention.`,
  tags: ['architecture', 'documentation'],

  // @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    // Only check directories that contain a package.json (actual packages)
    const packageJsonPaths = files.paths.filter((fp) => path.basename(fp) === 'package.json')

    for (const packageJsonPath of packageJsonPaths) {
      const dirPath = path.dirname(packageJsonPath)
      const readmePath = path.join(dirPath, 'README.md')

      if (!fs.existsSync(readmePath)) {
        violations.push({
          filePath: packageJsonPath,
          line: 1,
          message: `Missing README.md in ${path.basename(dirPath)}`,
          severity: 'warning',
          suggestion:
            'Create a README.md file with package description, usage, and API documentation',
        })
      }
    }

    return violations
  },
})
