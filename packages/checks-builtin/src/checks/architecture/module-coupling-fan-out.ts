/**
 * @fileoverview File-level fan-out (outbound coupling) check.
 *
 * Flags files that import many other intra-project files. High fan-out
 * indicates a "god-file" — a module that knows too much, hard to refactor
 * without ripple effects, hard for an AI agent to reason about because
 * search returns too many adjacent matches.
 *
 * Composition-root files (DI containers, plugin registries) legitimately
 * have high fan-out and can be exempted with
 * `// @fitness-ignore-file module-coupling-fan-out` at the top of the file.
 */

import {
  defineCheck,
  type CheckViolation,
  type FileAccessor,
  buildImportGraph,
} from '@opensip-tools/core'

const WARNING_THRESHOLD = 15
const ERROR_THRESHOLD = 30

export const moduleCouplingFanOut = defineCheck({
  id: '4c2e1a8b-9f7d-4e3a-8b6c-1d0f2a3b4c5e',
  slug: 'module-coupling-fan-out',
  description: 'Flags files with high outbound import fan-out (god-files)',
  longDescription:
    `Counts each file's outbound intra-project imports. Files exceeding ${WARNING_THRESHOLD} ` +
    `imports get a warning; files exceeding ${ERROR_THRESHOLD} get an error. Composition ` +
    'roots (DI, plugin registries) legitimately exceed this — exempt them with ' +
    '`// @fitness-ignore-file module-coupling-fan-out` at the top of the file.',
  scope: { languages: ['typescript', 'tsx', 'javascript', 'jsx'], concerns: ['backend', 'frontend', 'cli', 'shared'] },
  confidence: 'medium',
  tags: ['architecture', 'modularity'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const fileMap = await files.readAll()
    const graph = buildImportGraph(fileMap)

    const violations: CheckViolation[] = []
    for (const [filePath, edges] of graph.outbound) {
      const fanOut = edges.size
      if (fanOut <= WARNING_THRESHOLD) continue

      const severity: 'error' | 'warning' = fanOut > ERROR_THRESHOLD ? 'error' : 'warning'
      const limit = severity === 'error' ? ERROR_THRESHOLD : WARNING_THRESHOLD
      violations.push({
        severity,
        message: `High fan-out: ${fanOut} intra-project imports (limit ${limit}). High-fan-out files are hard to refactor and reason about.`,
        filePath,
        line: 1,
      })
    }

    // Sort for deterministic output: highest fan-out first.
    return violations.sort((a, b) => {
      const aFan = graph.outbound.get(a.filePath ?? '')?.size ?? 0
      const bFan = graph.outbound.get(b.filePath ?? '')?.size ?? 0
      return bFan - aFan
    })
  },
})
