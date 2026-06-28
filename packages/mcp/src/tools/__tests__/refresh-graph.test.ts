/**
 * `refresh_graph` handler — observability (Task 6.1 step 5, §Observability).
 *
 * Asserts the rebuild-latency metric is recorded on the shared meter with
 * BOUNDED-cardinality labels only (`{ command, op, outcome }` — never a path /
 * symbol / id), via an in-memory meter provider; and that the handler logs its
 * decision points (`mcp.refresh.run.ok` / `.error`) through the structured
 * logger (the stderr sink during serve — never stdout).
 */

import { err, logger, ok } from '@opensip-cli/core';
import { metrics, type Meter, type MeterProvider } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRefreshGraph } from '../refresh-graph.js';

import type { GraphGeneration, GraphReadPort } from '../../graph-read-port.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type { Freshness, McpToolResult } from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

interface Recorded {
  readonly name: string;
  readonly value: number;
  readonly attributes: Record<string, unknown>;
}

const recorded: Recorded[] = [];

/** Install a minimal in-memory meter provider that captures every histogram record. */
function installFakeMeter(): void {
  recorded.length = 0;
  metrics.disable();
  const provider = {
    getMeter: () =>
      ({
        createHistogram: (name: string) => ({
          record: (value: number, attributes?: Record<string, unknown>) =>
            recorded.push({ name, value, attributes: attributes ?? {} }),
        }),
      }) as unknown as Meter,
  } as unknown as MeterProvider;
  metrics.setGlobalMeterProvider(provider);
}

function captureServer(): { handlers: Map<string, Handler>; server: McpStdioServer } {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
      return undefined;
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
}

const FRESH: Freshness = { fresh: true, builtAt: '2026-05-22T00:00:00.000Z' };

function gen(): McpToolResult<GraphGeneration> {
  return { data: { builtAt: FRESH.builtAt ?? '' }, freshness: FRESH };
}

function fakeGraph(refresh: GraphReadPort['refresh']): GraphReadPort {
  return {
    refresh,
    freshness: () => FRESH,
  } as unknown as GraphReadPort;
}

function deps(graph: GraphReadPort): McpToolDeps {
  return { graph, results: {} as McpToolDeps['results'], validToolIds: new Set() };
}

beforeEach(() => {
  installFakeMeter();
});

afterEach(() => {
  metrics.disable();
  vi.restoreAllMocks();
});

describe('refresh_graph observability', () => {
  it('records rebuild latency with bounded { command, op, outcome:ok } labels and logs the ok decision point', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(server, deps(fakeGraph(() => Promise.resolve(ok(gen())))));

    const result = await handlers.get('refresh_graph')!({});
    const body = JSON.parse(
      result.content[0]?.type === 'text' ? result.content[0].text : '{}',
    ) as Record<string, unknown>;
    expect(body.builtAt).toBe(FRESH.builtAt);
    expect(typeof body.durationMs).toBe('number');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.name).toBe('opensip_cli.mcp.refresh.duration_ms');
    // Bounded cardinality: EXACTLY these three label keys, no path/symbol/id.
    expect(recorded[0]?.attributes).toEqual({ command: 'mcp', op: 'refresh', outcome: 'ok' });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'mcp.refresh.run.ok', module: 'mcp:refresh' }),
    );
  });

  it('records outcome:error and logs the error decision point when refresh returns an err', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      deps(
        fakeGraph(() =>
          Promise.resolve(err({ code: 'refresh-unavailable', message: 'not wired' })),
        ),
      ),
    );

    const result = await handlers.get('refresh_graph')!({});
    expect(result.isError).toBe(true);
    expect(recorded[0]?.attributes.outcome).toBe('error');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'mcp.refresh.run.error', code: 'refresh-unavailable' }),
    );
  });

  it('records outcome:error and re-throws when the rebuild throws at the infra boundary', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      deps(fakeGraph(() => Promise.reject(new Error('child build blew up')))),
    );

    await expect(handlers.get('refresh_graph')!({})).rejects.toThrow('child build blew up');
    expect(recorded[0]?.attributes.outcome).toBe('error');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ evt: 'mcp.refresh.run.error' }));
  });

  it('coerces a non-Error throwable in the error log (records outcome:error, re-throws)', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately a non-Error throwable to exercise the String(error) coercion branch
      deps(fakeGraph(() => Promise.reject('bare string failure'))),
    );
    await expect(handlers.get('refresh_graph')!({})).rejects.toBe('bare string failure');
    expect(recorded[0]?.attributes.outcome).toBe('error');
  });
});
