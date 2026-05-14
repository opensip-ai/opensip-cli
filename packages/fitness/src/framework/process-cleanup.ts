// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Process cleanup utilities for fitness checks
 *
 * Handles cleanup of orphaned child processes from external tool checks.
 */

import { execSync } from 'node:child_process'

/**
 * Known process names that can become orphaned from fitness checks.
 */
const ORPHAN_CANDIDATE_PROCESSES = [
  'semgrep-core',
  'eslint_d',
] as const

/**
 * Check if any orphaned processes from fitness checks are running.
 */
export function findOrphanedProcesses(): string[] {
  const found: string[] = []

  for (const processName of ORPHAN_CANDIDATE_PROCESSES) {
    try {
      execSync(`pgrep -x "${processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      })
      found.push(processName)
    } catch {
      // @swallow-ok pgrep returns non-zero if no process found
    }
  }

  return found
}

/**
 * Kill orphaned processes from fitness checks.
 */
export function cleanupOrphanedProcesses(): number {
  let killedCount = 0

  for (const processName of ORPHAN_CANDIDATE_PROCESSES) {
    try {
      execSync(`pgrep -x "${processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      })
      execSync(`pkill -9 -x "${processName}"`, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      killedCount++
    } catch {
      // @swallow-ok Process doesn't exist or kill failed
    }
  }

  return killedCount
}

/**
 * Check if a specific check might leave orphaned processes.
 */
export function checkMayLeaveOrphans(checkId: string): boolean {
  const checksWithOrphanRisk = [
    'security-scan-suite',
    'eslint-backend',
    'eslint-frontend',
    'sonarjs-backend',
    'sonarjs-frontend',
  ]
  return checksWithOrphanRisk.includes(checkId)
}

/**
 * Cleanup after a check if it might have left orphaned processes.
 */
export function cleanupAfterCheck(checkId: string): number {
  if (!checkMayLeaveOrphans(checkId)) return 0
  return cleanupOrphanedProcesses()
}
