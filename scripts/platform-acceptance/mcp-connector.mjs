/**
 * @fileoverview The injected MCP client port for platform-acceptance mcp
 * journeys.
 *
 * `createDefaultMcpConnector(...)` returns an `McpClientPort` (see
 * `journey-catalog.d.mts`). `connect({ cwd })` launches the installed MCP server
 * as a child — `node <jsEntrypoint> mcp --cwd <cwd>` — over stdio through the
 * `@modelcontextprotocol/sdk` client, performs the initialize handshake, and
 * returns a ready `McpClientHandle`. A journey supplies only a run-owned project
 * `cwd` (and optional literal env overrides); it never spawns the server itself
 * and never parses stderr as protocol data (stderr is a bounded summary only).
 *
 * The SDK is resolved LAZILY from the `@opensip-cli/agent-eval` package (the
 * declared owner of the dependency) so this repo script's static import surface
 * stays dependency-free (Node built-ins only) — the SDK is loaded only when an
 * mcp journey actually connects. The client pattern mirrors
 * `packages/agent-eval/src/adapters/opensip-mcp-connection.ts`.
 *
 * @typedef {import('./journey-catalog.d.mts').McpClientPort} McpClientPort
 * @typedef {import('./journey-catalog.d.mts').McpClientHandle} McpClientHandle
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_NAME = 'opensip-platform-acceptance';
const CLIENT_VERSION = '1.0.0';
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/** A bounded byte ring for stderr accounting (never parsed as protocol data). */
class BoundedByteRing {
  #max;
  #retained = Buffer.alloc(0);
  #seen = 0;
  #truncated = false;

  constructor(maximumBytes) {
    this.#max =
      Number.isSafeInteger(maximumBytes) && maximumBytes > 0
        ? maximumBytes
        : DEFAULT_MAX_STDERR_BYTES;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.#seen = Math.min(Number.MAX_SAFE_INTEGER, this.#seen + buffer.byteLength);
    const combined = Buffer.concat([this.#retained, buffer]);
    if (combined.byteLength <= this.#max) {
      this.#retained = combined;
      return;
    }
    this.#retained = combined.subarray(combined.byteLength - this.#max);
    this.#truncated = true;
  }

  summary() {
    return { bytes: this.#seen, truncated: this.#truncated };
  }
}

/** Lazily resolve + import the MCP SDK client + stdio transport from agent-eval. */
async function loadSdk(repoRoot) {
  const anchor = join(repoRoot, 'packages', 'agent-eval', 'package.json');
  const require = createRequire(anchor);
  const clientPath = require.resolve('@modelcontextprotocol/sdk/client');
  const stdioPath = require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
  const [clientModule, stdioModule] = await Promise.all([
    import(pathToFileURL(clientPath).href),
    import(pathToFileURL(stdioPath).href),
  ]);
  const Client = clientModule.Client ?? clientModule.default?.Client;
  const StdioClientTransport =
    stdioModule.StdioClientTransport ?? stdioModule.default?.StdioClientTransport;
  if (typeof Client !== 'function' || typeof StdioClientTransport !== 'function') {
    throw new TypeError('MCP SDK did not export Client / StdioClientTransport');
  }
  return { Client, StdioClientTransport };
}

/**
 * @param {object} options
 * @param {{ script: string }} options.jsEntrypoint the resolved installed JS entrypoint.
 * @param {Record<string,string>} options.baseEnv    the deterministic, credential-free base env.
 * @param {object} options.bounds                    the active profile bounds.
 * @param {string} options.repoRoot                  repo root (anchors SDK resolution).
 * @param {string} [options.platform]
 * @param {(root: string) => Promise<object>} [options.loadSdk] test seam.
 * @param {string} [options.nodeExecutable]          override the node executable (defaults to the run's node).
 * @returns {McpClientPort}
 */
export function createDefaultMcpConnector(options) {
  const jsEntrypoint = options.jsEntrypoint;
  const baseEnv = options.baseEnv ?? {};
  const bounds = options.bounds ?? {};
  const repoRoot = options.repoRoot;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const loadSdkImpl = options.loadSdk ?? (() => loadSdk(repoRoot));
  const maxStderrBytes = bounds.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const defaultTimeout = bounds.journeyTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return Object.freeze({
    async connect(spec) {
      if (spec === null || typeof spec !== 'object' || typeof spec.cwd !== 'string') {
        throw new TypeError('mcp connect requires a cwd');
      }
      const timeoutMs = spec.timeoutMs ?? defaultTimeout;
      const { Client, StdioClientTransport } = await loadSdkImpl(repoRoot);
      const stderrRing = new BoundedByteRing(maxStderrBytes);
      const transport = new StdioClientTransport({
        command: nodeExecutable,
        args: [jsEntrypoint.script, 'mcp', '--cwd', spec.cwd],
        cwd: spec.cwd,
        env: { ...baseEnv, ...spec.env },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => stderrRing.append(chunk));
      const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
      await client.connect(transport, { timeout: timeoutMs });

      return Object.freeze({
        serverVersion() {
          return client.getServerVersion();
        },
        listTools() {
          return client.listTools(undefined, { timeout: timeoutMs });
        },
        callTool(input) {
          return client.callTool({ name: input.name, arguments: input.arguments }, undefined, {
            timeout: timeoutMs,
          });
        },
        stderrSummary() {
          return stderrRing.summary();
        },
        close() {
          return client.close();
        },
      });
    },
  });
}
