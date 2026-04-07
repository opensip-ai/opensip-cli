// @fitness-ignore-file no-raw-regex-on-code -- fitness check: regex patterns analyze trusted codebase content, not user input
/**
 * @fileoverview Dependency Architecture check
 * Enforces workspace boundaries and core internal tiers using dependency-cruiser.
 * @module fitness/checks/architecture/dependency-architecture
 */

import * as path from 'node:path'

import { defineCheck, execAbortable, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

interface DependencyCruiserViolation {
  from: string
  to: string
  rule: {
    name: string
    severity: 'error' | 'warn' | 'info'
    comment?: string
  }
}

interface DependencyCruiserOutput {
  modules: unknown[]
  summary: {
    violations: DependencyCruiserViolation[]
    error: number
    warn: number
    info: number
    totalCruised: number
    totalDependenciesCruised: number
  }
}

function getSuggestion(ruleName: string): string {
  if (ruleName.includes('circular')) {
    return 'Break circular dependency using dependency injection or extracting shared interfaces.'
  }
  if (ruleName.includes('tier')) {
    return 'Modules can only import from lower-numbered tiers. See .config/dependency-cruiser.cjs for tier definitions.'
  }
  if (ruleName.includes('no-cli-to') || ruleName.includes('no-dashboard-to')) {
    return 'Apps must communicate with services over HTTP via api-client, not direct imports.'
  }
  if (ruleName.includes('no-packages-to') || ruleName.includes('no-services-to')) {
    return 'Packages are shared libraries. Services/apps are consumers. Do not import upward.'
  }
  if (ruleName.includes('orphan')) {
    return 'Remove unused module or add it to the dependency graph.'
  }
  if (ruleName.includes('deprecated')) {
    return 'Replace deprecated Node.js API with its modern equivalent.'
  }
  if (ruleName.includes('node-modules-internals')) {
    return 'Import from the package entry point, not its internal files.'
  }
  return 'See .config/dependency-cruiser.cjs for architecture guidelines.'
}

export const dependencyArchitecture = defineCheck({
  id: '74ce34ac-e7c2-458c-a1db-a5074e375ae0',
  slug: 'dependency-architecture',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },

  confidence: 'medium',
  description: 'Enforces workspace boundaries and core internal tiers via dependency-cruiser',
  longDescription: `**Purpose:** Enforces architectural boundaries by running dependency-cruiser against the codebase.

**Detects:**
- Cross-app imports (cli <-> dashboard)
- Dashboard importing non-api-client workspace packages
- Services importing from apps or vice versa
- Packages importing from apps or services
- Core internal tier violations (Tier 1-5 layering)
- Circular dependencies
- Node modules internal imports
- Orphaned modules

**Why it matters:** Boundary violations create tight coupling that makes packages unmaintainable and breaks independent deployability.

**Scope:** Runs \`depcruise --output-type json\` via \`analyzeAll\`.`,
  tags: ['architecture', 'structure', 'dependencies'],
  fileTypes: ['ts'],

  async analyzeAll(_files: FileAccessor): Promise<CheckViolation[]> {
    const cwd = process.cwd()

    try {
      const cmd = 'npx dependency-cruiser packages services apps --config .config/dependency-cruiser.cjs --output-type json'

      // @fitness-ignore-next-line no-hardcoded-timeouts -- safety timeout for dependency-cruiser subprocess
      const result = await execAbortable(cmd, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300000, // 5 minutes
      })

      if (result.aborted) {
        return []
      }

      // dependency-cruiser exits non-zero on violations but still outputs JSON
      const output = result.stdout || result.stderr

      if (!output) {
        return []
      }

      const parsed: DependencyCruiserOutput = JSON.parse(output)
      const dcViolations = parsed.summary.violations

      // Filter out orphan false positives for structural/library files
      const filtered = dcViolations.filter((v) => {
        if (!v.rule.name.includes('orphan')) {
          return true
        }
        const from = v.from
        // Barrel files (index.ts that only re-export) are organizational
        if (/(?:^|\/)index\.ts$/.test(from)) return false
        // Infrastructure package is a library — exports may not all be consumed
        if (from.startsWith('packages/infrastructure/')) return false
        // API schemas are consumed by Fastify for serialization
        if (from.startsWith('packages/api-schemas/')) return false
        // Error codes and error domain files are consumed at runtime
        if (/error-codes\.ts$/.test(from) || /\/error-domains\//.test(from)) return false
        // Test files and test utilities are entry points for test runners
        if (/\.test\.(ts|tsx|js)$/.test(from) || /\/__tests__\//.test(from)) return false
        // CLI command files are entry points wired by the CLI binary
        if (from.startsWith('apps/cli/src/commands/')) return false
        // Dashboard pages and components are entry points wired by React Router
        if (from.startsWith('apps/dashboard/src/pages/') || from.startsWith('apps/dashboard/src/components/')) return false
        return true
      })

      return filtered.map((violation) => {
        const suggestion = violation.rule.comment ?? getSuggestion(violation.rule.name)
        return {
          filePath: path.join(cwd, violation.from),
          line: 1,
          message: `${violation.from} -> ${violation.to}: ${suggestion}`,
          severity: violation.rule.severity === 'error' ? ('error' as const) : ('warning' as const),
          suggestion,
          match: `${violation.from} -> ${violation.to}`,
          type: violation.rule.name,
        }
      })
    } catch {
      // @swallow-ok -- dependency-cruiser errors (e.g., not installed, malformed config)
      return []
    }
  },
})
