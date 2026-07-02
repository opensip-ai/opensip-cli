import type { McpFinding } from './result-dto.js';
import type { Signal } from '@opensip-cli/core';

/** Project a replayed envelope signal to a compact MCP finding row. */
export function toMcpFinding(signal: Signal): McpFinding {
  return {
    ruleId: signal.ruleId,
    message: signal.message,
    severity: signal.severity,
    ...(signal.filePath ? { filePath: signal.filePath } : {}),
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.column === undefined ? {} : { column: signal.column }),
  };
}
