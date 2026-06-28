/**
 * Shared MCP tool-result helpers (ADR-0084).
 *
 * Every graph tool returns the same `{ data, freshness, truncated? }` envelope
 * (the {@link McpToolResult} the ports already produce); every result tool
 * returns an {@link McpResultReplay}. Both are serialized into a JSON-RPC reply
 * the SAME way: a single `text` content item carrying the pretty-printed JSON.
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

import type { McpReadError } from '../mcp-error.js';
import type { CallToolResult } from '../server.js';

/** Serialize a successful tool payload as a single pretty-printed JSON text item. */
export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/** Surface a structured domain error as an `isError` result (machine-readable body). */
export function errorResult(error: McpReadError): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }, null, 2) }],
    isError: true,
  };
}

/** Build an inline structured error result from a `code` + `message` pair. */
export function failure(code: string, message: string): CallToolResult {
  return errorResult({ code, message });
}

/** A structured `unknown-tool` error for a `tool` argument outside the live registry. */
export function unknownToolError(tool: string, valid: ReadonlySet<string>): CallToolResult {
  const known = [...valid].sort().join(', ') || '(none registered)';
  return failure('unknown-tool', `Unknown tool "${tool}". Registered tools: ${known}.`);
}
