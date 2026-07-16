/** Register exact task-context replay reads. */

import { registerGetContextStatus } from './get-context-status.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerContextTools(server: McpStdioServer, deps: McpToolDeps): void {
  registerGetContextStatus(server, deps);
}
