// @fitness-ignore-file fitness-check-architecture -- Helper module providing shared parseOutput utilities for OpenAPI checks; not a standalone check requiring defineCheck pattern
// @fitness-ignore-file correlation-id-coverage -- Stateless utility module, not an API handler or service
/**
 * @fileoverview Shared utilities for OpenAPI freshness checks
 */

import type { CheckViolation } from '@opensip-tools/core'

/**
 * Creates a parseOutput function for OpenAPI freshness checks.
 * Shared between marketplace-openapi-freshness and openapi-types-freshness.
 */
export function createOpenApiParseOutput(config: {
  message: string
  suggestion: string
  type: string
  filePath: string
}): (stdout: string, stderr: string, exitCode: number) => CheckViolation[] {
  return (stdout: string, stderr: string, exitCode: number): CheckViolation[] => {
    if (exitCode === 0) {
      return [] // Spec is up to date
    }

    // Combine stdout and stderr for the full message
    const output = [stderr, stdout].filter(Boolean).join('\n').trim()

    return [
      {
        line: 1,
        message: config.message,
        severity: 'error',
        suggestion: config.suggestion,
        type: config.type,
        match: output.slice(0, 200),
        filePath: config.filePath,
      },
    ]
  }
}
