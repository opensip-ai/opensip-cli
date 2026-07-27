/**
 * Shared MCP tool-result helpers (ADR-0084).
 *
 * Graph tools return {@link GraphToolResult} envelopes; result tools return
 * {@link McpResultReplay}. Both are serialized into a JSON-RPC reply the SAME
 * way: a single `text` content item carrying the pretty-printed JSON.
 *
 * We deliberately do NOT set `structuredContent` (no per-tool `outputSchema` is
 * declared — the SDK only honours `structuredContent` against an output schema),
 * so the JSON text content is the single, widely-compatible payload channel.
 *
 * A port/domain failure (`Result` err arm) is surfaced as an `isError: true`
 * result whose JSON body is the structured {@link McpReadError} — the agent sees
 * a machine-readable `code` + `message`, never a thrown stack. `throw` stays
 * reserved for genuine infra failures (the SDK converts those to a JSON-RPC error
 * frame; the server's `dispatch` logs the decision point).
 */

import { assertJsonPayloadSize } from '../graph-query-page.js';

import type { McpReadError, McpReadReason } from '../mcp-error.js';
import type { CallToolResult } from '../server.js';

/** Serialize a successful tool payload as a single pretty-printed JSON text item. */
export function jsonResult(payload: unknown): CallToolResult {
  const sized = assertJsonPayloadSize(payload);
  if (!sized.ok) {
    return errorResult(sized.error);
  }
  return { content: [{ type: 'text', text: sized.value }] };
}

/** Surface a structured domain error as an `isError` result (machine-readable body). */
export function errorResult(error: McpReadError): CallToolResult {
  const sized = assertJsonPayloadSize({ error });
  const text = sized.ok ? sized.value : JSON.stringify({ error: sized.error }, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/** Build an inline structured error result from a `code` + `message` pair. */
export function failure(code: McpReadReason, message: string): CallToolResult {
  return errorResult({ code, message });
}

/** A structured `unknown-tool` error for a `tool` argument outside the live registry. */
export function unknownToolError(tool: string, valid: ReadonlySet<string>): CallToolResult {
  const known = [...valid].sort().join(', ') || '(none registered)';
  return failure('unknown-tool', `Unknown tool "${tool}". Registered tools: ${known}.`);
}
