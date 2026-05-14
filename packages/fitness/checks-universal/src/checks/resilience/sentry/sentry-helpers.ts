/**
 * @fileoverview Shared helpers for Sentry fitness checks
 * @module checks-builtin/checks/resilience/sentry/sentry-helpers
 */

/**
 * Quick bail-out: returns true if the file references Sentry at all.
 * All Sentry checks should call this first to avoid unnecessary work.
 */
export function hasSentryUsage(content: string): boolean {
  return content.includes('@sentry/') || content.includes('Sentry.')
}

/**
 * Returns true if the file contains a `Sentry.init(` call.
 * Used by checks that validate init configuration.
 */
export function hasSentryInit(content: string): boolean {
  return content.includes('Sentry.init(') || content.includes('Sentry.init (')
}

/**
 * Extracts the Sentry.init() call block from file content.
 * Returns the line range (start/end indices) and the content of the init block.
 * Handles multi-line init calls by tracking brace depth.
 */
export function extractSentryInitBlock(
  content: string,
): { startLine: number; endLine: number; block: string } | null {
  const lines = content.split('\n')

  let initLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.includes('Sentry.init(') || line.includes('Sentry.init (')) {
      initLineIdx = i
      break
    }
  }

  if (initLineIdx === -1) return null

  // Collect the full init block by tracking parenthesis depth
  let parenDepth = 0
  let started = false
  const blockLines: string[] = []

  for (let i = initLineIdx; i < lines.length; i++) {
    const line = lines[i] ?? ''
    blockLines.push(line)

    for (const char of line) {
      if (char === '(') {
        parenDepth++
        started = true
      }
      if (char === ')') {
        parenDepth--
      }
    }

    if (started && parenDepth <= 0) {
      return {
        startLine: initLineIdx,
        endLine: i,
        block: blockLines.join('\n'),
      }
    }
  }

  // Unclosed init — return what we have
  return {
    startLine: initLineIdx,
    endLine: lines.length - 1,
    block: blockLines.join('\n'),
  }
}
