/**
 * The `@opensip-cli/mcp` Tool descriptor + tool registration wiring (Task 6.1).
 *
 * Asserts the bundled tool descriptor (`mcp` identity, the single `mcp` command,
 * the `mcp-graph-adapter` capability registrar) and that `registerMcpTools`
 * mounts all 13 tools (9 graph + 4 result) through the server's register seam.
 */

import { describe, expect, it } from 'vitest';

import { mcpTool, MCP_IDENTITY, MCP_STABLE_ID } from '../index.js';
import { registerMcpTools } from '../tools/register.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { ResultsReadPort } from '../results-read-port.js';
import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from '../tools/types.js';

describe('mcpTool descriptor', () => {
  it('declares the mcp identity, one command, and the graph-adapter registrar', () => {
    expect(MCP_IDENTITY.name).toBe('mcp');
    expect(mcpTool.identity.name).toBe('mcp');
    expect(mcpTool.metadata.id).toBe(MCP_STABLE_ID);
    const commands = mcpTool.commands ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe('mcp');
    expect(mcpTool.extensionPoints?.capabilityRegistrars).toHaveProperty('mcp-graph-adapter');
  });
});

describe('registerMcpTools', () => {
  it('mounts all 13 MCP tools (9 graph + 4 result) on the server', () => {
    const names: string[] = [];
    const server = {
      register: (name: string) => {
        names.push(name);
        return undefined;
      },
    } as unknown as McpStdioServer;
    const deps: McpToolDeps = {
      graph: {} as GraphReadPort,
      results: {} as ResultsReadPort,
      validToolIds: new Set(),
    };

    registerMcpTools(server, deps);

    expect(names).toHaveLength(13);
    expect(new Set(names)).toEqual(
      new Set([
        'search_symbols',
        'get_symbol',
        'who_calls',
        'callees_of',
        'trace_path',
        'blast_radius',
        'find_dead_code',
        'get_architecture',
        'refresh_graph',
        'get_agent_catalog',
        'list_runs',
        'show_run',
        'get_latest_findings',
      ]),
    );
  });

  it('describes result tools as persisted replay and warns against log/sqlite/rerun fallbacks', () => {
    const configs = new Map<string, { description?: string }>();
    const server = {
      register: (name: string, config: { description?: string }) => {
        configs.set(name, config);
        return undefined;
      },
    } as unknown as McpStdioServer;
    const deps: McpToolDeps = {
      graph: {} as GraphReadPort,
      results: {} as ResultsReadPort,
      validToolIds: new Set(),
    };

    registerMcpTools(server, deps);

    for (const name of ['get_agent_catalog', 'list_runs', 'show_run', 'get_latest_findings']) {
      const description = configs.get(name)?.description ?? '';
      expect(description).toMatch(/existing|prior/i);
      expect(description).toMatch(/persisted|stored/i);
      expect(description).toMatch(/never re-runs|never re-run/i);
      expect(description).toContain('.runtime/logs');
      expect(description).toContain('datastore.sqlite');
    }
  });
});
