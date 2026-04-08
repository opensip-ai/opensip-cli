// @fitness-ignore-file fitness-check-architecture -- Type definitions for observability-coverage check, not a standalone check
/**
 * @fileoverview Type definitions for observability coverage analysis
 */

/**
 * Detected logger call within a function body.
 */
export interface LoggerCall {
  /** 1-indexed line number */
  readonly line: number
  /** Logger level (info, warn, error, debug) */
  readonly level: 'info' | 'warn' | 'error' | 'debug'
}

/**
 * Information about an extracted function from the AST.
 */
export interface FunctionInfo {
  /** Function name (or '<anonymous>' for unnamed functions) */
  readonly name: string
  /** Absolute file path */
  readonly filePath: string
  /** 1-indexed start line */
  readonly startLine: number
  /** 1-indexed end line */
  readonly endLine: number
  /** Total lines of code in the function body */
  readonly lineCount: number
  /** Whether the function is async */
  readonly isAsync: boolean
  /** Whether the function contains a try/catch block */
  readonly hasTryCatch: boolean
  /** Whether any logger calls were detected */
  readonly hasLogging: boolean
  /** List of detected logger calls */
  readonly loggerCalls: readonly LoggerCall[]
}

/**
 * Aggregate coverage result across all analyzed files.
 */
export interface CoverageResult {
  /** Total number of functions that require logging */
  readonly totalFunctions: number
  /** Number of functions that have at least one logger call */
  readonly functionsWithLogging: number
  /** Coverage percentage (0-100) */
  readonly coveragePercent: number
  /** Functions that require logging but don't have it */
  readonly unloggedFunctions: readonly FunctionInfo[]
}

/**
 * Inline configuration for the observability coverage check.
 */
export interface CoverageConfig {
  /** Minimum lines of code for a function to require logging */
  readonly minLinesForLogging: number
  /** Whether async functions require logging (subject to minLinesForAsyncLogging) */
  readonly requireLoggingInAsync: boolean
  /** Minimum lines for an async function to require logging (avoids flagging trivial async wrappers) */
  readonly minLinesForAsyncLogging: number
  /** Whether functions with try/catch always require logging regardless of line count */
  readonly requireLoggingInTryCatch: boolean
  /** Minimum coverage percentage before the check reports errors (vs warnings) */
  readonly minCoveragePercent: number
}
