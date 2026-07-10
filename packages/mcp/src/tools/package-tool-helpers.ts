import { errorResult, jsonResult } from './tool-result.js';

import type { McpReadError } from '../mcp-error.js';
import type { CallToolResult } from '../server.js';
import type { Result } from '@opensip-cli/core';
import type { GraphSourceFilter } from '@opensip-cli/graph/read';

/** Keep the shared package-tool filter projection in one place. */
export function packageSourceFilter(args: GraphSourceFilter): GraphSourceFilter {
  return {
    packages: args.packages,
    filePath: args.filePath,
    filePrefix: args.filePrefix,
    kinds: args.kinds,
    visibilities: args.visibilities,
    sourceScope: args.sourceScope,
    generated: args.generated,
  };
}

/** Render the common graph-port Result contract for package tools. */
export async function packageToolResult<T>(
  pending: Promise<Result<T, McpReadError>>,
): Promise<CallToolResult> {
  const outcome = await pending;
  return outcome.ok ? jsonResult(outcome.value) : errorResult(outcome.error);
}
