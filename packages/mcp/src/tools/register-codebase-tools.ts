/** Register MCP reads owned by the captured codebase inventory port. */

import { registerGetFileContext } from './get-file-context.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerCodebaseTools(server: McpStdioServer, deps: McpToolDeps): void {
  registerGetFileContext(server, deps);
}
