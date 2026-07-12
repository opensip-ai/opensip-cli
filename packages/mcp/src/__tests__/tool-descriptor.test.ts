/**
 * The `@opensip-cli/mcp` Tool descriptor + tool registration wiring (Task 6.1).
 *
 * Asserts the bundled tool descriptor (`mcp` identity, the single `mcp` command,
 * the `mcp-graph-adapter` capability registrar) and that `registerMcpTools`
 * mounts all 21 tools (15 graph/package/wiring + 6 result/review) through the server's register seam.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mcpTool, MCP_IDENTITY, MCP_STABLE_ID } from '../index.js';
import { registerMcpTools } from '../tools/register.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { RepairWritePort } from '../repair-write-port.js';
import type { ResultsReadPort } from '../results-read-port.js';
import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from '../tools/types.js';

const DEFAULT_TOOL_NAMES = [
  'search_symbols',
  'search_declarations',
  'references_to',
  'get_symbol',
  'who_calls',
  'callees_of',
  'trace_path',
  'blast_radius',
  'find_dead_code',
  'get_architecture',
  'package_dependencies',
  'why_depends',
  'package_cycles',
  'refresh_graph',
  'get_runtime_wiring',
  'get_agent_catalog',
  'list_runs',
  'show_run',
  'get_latest_findings',
  'review_change',
  'compare_to_baseline',
] as const;

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
  it('mounts all 21 MCP tools (15 graph/package/wiring + 6 result/review) on the server', () => {
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
      runtimeWiring: {} as McpToolDeps['runtimeWiring'],
      validToolIds: new Set(),
    };

    registerMcpTools(server, deps);

    expect(names).toHaveLength(21);
    expect(new Set(names)).toEqual(new Set(DEFAULT_TOOL_NAMES));
  });

  it('adds repair_apply_verify only when mutation is explicitly enabled', () => {
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
      runtimeWiring: {} as McpToolDeps['runtimeWiring'],
      validToolIds: new Set(['fit']),
      mutationsEnabled: true,
      repairWrite: {} as RepairWritePort,
    };

    registerMcpTools(server, deps);

    expect(names).toHaveLength(22);
    expect(new Set(names)).toEqual(new Set([...DEFAULT_TOOL_NAMES, 'repair_apply_verify']));
  });

  it('registers every default and opt-in tool with a strict object schema', () => {
    const configs = new Map<string, { readonly inputSchema?: unknown }>();
    const server = {
      register: (name: string, config: { readonly inputSchema?: unknown }) => {
        configs.set(name, config);
        return undefined;
      },
    } as unknown as McpStdioServer;
    const deps: McpToolDeps = {
      graph: {} as GraphReadPort,
      results: {} as ResultsReadPort,
      runtimeWiring: {} as McpToolDeps['runtimeWiring'],
      validToolIds: new Set(['fit']),
      mutationsEnabled: true,
      repairWrite: {} as RepairWritePort,
    };

    registerMcpTools(server, deps);

    expect(configs.size).toBe(22);
    for (const [name, config] of configs) {
      expect(config.inputSchema, `${name} must declare an input schema`).toBeInstanceOf(
        z.ZodObject,
      );
      const schema = config.inputSchema as z.ZodObject;
      expect(schema.toJSONSchema(), `${name} must reject unknown keys`).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
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
      runtimeWiring: {} as McpToolDeps['runtimeWiring'],
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

  it('describes get_architecture as including bounded target convention counts', () => {
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
      runtimeWiring: {} as McpToolDeps['runtimeWiring'],
      validToolIds: new Set(),
    };

    registerMcpTools(server, deps);

    expect(configs.get('get_architecture')?.description ?? '').toMatch(
      /sections=\["metrics"\]|topN|packageEdges|hotspots/i,
    );
  });
});
