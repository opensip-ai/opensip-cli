import { z } from 'zod';

import { boundedText, sessionRef, strictInput, toolId } from './schemas.js';
import { errorResult, jsonResult, unknownToolError } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const selector = () =>
  boundedText(512, 'signal').regex(
    /^(id|fingerprint|index):.+$/,
    'signal must be id:<value>, fingerprint:<value>, or index:<zero-based>',
  );

const actionId = () => boundedText(128, 'action');

export function registerRepairApplyVerify(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'repair_apply_verify',
    {
      title: 'Apply and verify a structured OpenSIP repair',
      description:
        'Mutating OpenSIP MCP tool. It applies one structured signal.repair action from a stored session ' +
        'and reruns deterministic verification through the same host repair apply --verify path. This tool ' +
        'is registered only when the MCP server is started with mutation explicitly enabled.',
      inputSchema: strictInput({
        ref: sessionRef(),
        tool: toolId(),
        signal: selector(),
        action: actionId(),
        force: z.boolean().optional(),
      }),
    },
    async ({ ref, tool, signal, action, force }, request) => {
      if (!deps.validToolIds.has(tool)) return unknownToolError(tool, deps.validToolIds);
      if (deps.repairWrite === undefined) {
        return errorResult({
          code: 'mcp-mutation-disabled',
          message: 'repair_apply_verify requires opensip mcp --allow-mutations.',
        });
      }
      const outcome = await deps.repairWrite.applyVerify({
        ref,
        tool,
        signal,
        action,
        ...(force === undefined ? {} : { force }),
        ...(request?.signal === undefined ? {} : { abortSignal: request.signal }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
