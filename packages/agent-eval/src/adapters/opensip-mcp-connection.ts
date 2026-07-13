// @fitness-ignore-next-line missing-type-exports -- MCP SDK declares "./client" in its external package exports; the workspace-only check cannot discover external package manifests.
import { Client } from '@modelcontextprotocol/sdk/client';
// @fitness-ignore-next-line missing-type-exports -- MCP SDK publishes client/stdio.js through its declared "./*" export; the workspace-only check cannot discover external package manifests.
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { JsonObject } from '../model/task.js';
import type { Stream } from 'node:stream';

const CLIENT_NAME = 'opensip-agent-eval';
const CLIENT_VERSION = '1.0.0';

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface McpToolCall {
  readonly arguments: JsonObject;
  readonly name: string;
}

export interface McpServerVersion {
  readonly name: string;
  readonly version: string;
}

/** Narrow SDK connection seam used by focused protocol-mapping tests. */
export interface McpConnection {
  readonly stderr: Stream | null;
  callTool(input: McpToolCall, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
  connect(timeoutMs: number): Promise<void>;
  listTools(timeoutMs: number): Promise<unknown>;
  serverVersion(): McpServerVersion | undefined;
}

export interface McpConnectionOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type McpConnectionFactory = (options: McpConnectionOptions) => McpConnection;

export class BoundedByteRing {
  private retained = Buffer.alloc(0);
  private seenBytes = 0;
  private wasTruncated = false;

  public constructor(private readonly maximumBytes: number) {}

  public append(chunk: unknown): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.seenBytes = Math.min(Number.MAX_SAFE_INTEGER, this.seenBytes + buffer.byteLength);
    const combined = Buffer.concat([this.retained, buffer]);
    if (combined.byteLength <= this.maximumBytes) {
      this.retained = combined;
      return;
    }
    this.retained = combined.subarray(combined.byteLength - this.maximumBytes);
    this.wasTruncated = true;
  }

  public summary(): { readonly bytes: number; readonly truncated: boolean } {
    return { bytes: this.seenBytes, truncated: this.wasTruncated };
  }
}

/**
 * Resolve an optional positive integer within a hard maximum.
 *
 * @throws {RangeError} When the supplied or fallback value is outside the accepted range.
 */
export function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive integer at most ${maximum}.`);
  }
  return resolved;
}

export function defaultConnectionFactory(options: McpConnectionOptions): McpConnection {
  const transport = new StdioClientTransport({
    args: [...options.args],
    command: options.command,
    cwd: options.cwd,
    env: { ...options.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  return {
    callTool: (input, timeoutMs) =>
      client.callTool({ arguments: input.arguments, name: input.name }, undefined, {
        timeout: timeoutMs,
      }),
    close: () => client.close(),
    connect: (timeoutMs) => client.connect(transport, { timeout: timeoutMs }),
    listTools: (timeoutMs) => client.listTools(undefined, { timeout: timeoutMs }),
    serverVersion: () => client.getServerVersion(),
    stderr: transport.stderr,
  };
}
