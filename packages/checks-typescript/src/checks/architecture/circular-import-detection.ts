/**
 * @fileoverview Circular-import detection check.
 *
 * Detects file-level circular dependencies using Tarjan's SCC algorithm
 * over the project's intra-project import graph. Each strongly-connected
 * component of size > 1 represents a real cycle (a chain of files where
 * `a → b → ... → a`).
 *
 * Complements the existing module/package-level coupling checks; this one
 * operates at the file level, where cycles most often originate during
 * iterative agent-driven development.
 */

import {
  defineCheck,
  type CheckViolation,
  type FileAccessor,
  buildImportGraph,
  findStronglyConnectedComponents,
} from '@opensip-tools/core'

export const circularImportDetection = defineCheck({
  id: '7b3a9e1c-8d2f-4a5b-9c6d-0e1f2a3b4c5d',
  slug: 'circular-import-detection',
  description: 'Detects file-level circular import dependencies',
  longDescription:
    'Builds the project import graph and runs Tarjan\'s SCC algorithm to find ' +
    'cycles. Each cycle (chain of files where a → b → … → a) is reported as a ' +
    'separate violation against the first file in the cycle (the anchor).',
  scope: { languages: ['typescript', 'tsx', 'javascript', 'jsx'], concerns: ['backend', 'frontend', 'cli', 'shared'] },
  confidence: 'high',
  tags: ['architecture', 'modularity'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const fileMap = await files.readAll()
    const graph = buildImportGraph(fileMap)
    const sccs = findStronglyConnectedComponents(graph)

    const violations: CheckViolation[] = []
    for (const scc of sccs) {
      // Skip SCCs of size 1 (no cycle, or self-loop which is rare and not
      // structurally interesting at the file level).
      if (scc.length < 2) continue

      // The anchor file gets the violation. Sort the cycle for deterministic
      // output regardless of graph iteration order.
      const cycle = [...scc].sort()
      const anchor = cycle[0]!
      const chain = cycle.join(' → ') + ' → ' + anchor

      violations.push({
        severity: 'error',
        message: `Circular import (${cycle.length} files): ${chain}`,
        filePath: anchor,
        // Graph-level violation — no specific statement; line 1 is the conventional
        // anchor for file-scoped findings.
        line: 1,
      })
    }
    return violations
  },
})
