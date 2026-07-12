/**
 * `refresh_graph` handler — observability + structured Result failures.
 */

import { err, logger, ok } from '@opensip-cli/core';
import { metrics, type Meter, type MeterProvider } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRefreshGraph } from '../refresh-graph.js';

import type { GraphReadPort, RefreshResult } from '../../graph-read-port.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type { Freshness, GraphToolResult } from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

interface Recorded {
  readonly name: string;
  readonly value: number;
  readonly attributes: Record<string, unknown>;
}

const recorded: Recorded[] = [];

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

function captureServer(): {
  handlers: Map<string, Handler>;
  server: McpStdioServer;
} {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
}

const FRESH: Freshness = {
  fresh: true,
  builtAt: '2026-05-22T00:00:00.000Z',
  verifiedAt: '2026-05-22T00:00:01.000Z',
  verification: 'complete',
};

function refreshResult(
  action: RefreshResult['action'] = 'rebuilt',
): GraphToolResult<RefreshResult> {
  return {
    data: {
      generation: {
        builtAt: FRESH.builtAt!,
        identity: 'g1:abc',
        source: 'refresh-rebuild',
      },
      action,
      durationMs: 12,
      priorGenerationAvailable: false,
    },
    context: {
      project: {
        root: '/proj',
        scope: 'project',
        configPath: 'opensip-cli.config.yml',
      },
      catalog: {
        status: 'loaded',
        builtAt: FRESH.builtAt,
        identity: 'g1:abc',
      },
    },
    freshness: FRESH,
    coverage: {
      inventory: { requested: true, complete: true, truncated: false, reasons: [] },
      evidence: { requested: false, complete: true, truncated: false, reasons: [] },
      grouping: { requested: false, complete: true, truncated: false, reasons: [] },
      projection: { requested: false, complete: true, truncated: false, reasons: [] },
      complete: true,
      truncated: false,
      reasons: [],
    },
  };
}

function fakeGraph(refresh: GraphReadPort['refresh']): GraphReadPort {
  return { refresh } as unknown as GraphReadPort;
}

function deps(graph: GraphReadPort): McpToolDeps {
  return {
    graph,
    results: {} as McpToolDeps['results'],
    runtimeWiring: {} as McpToolDeps['runtimeWiring'],
    validToolIds: new Set(),
  };
}

beforeEach(() => {
  installFakeMeter();
});

afterEach(() => {
  metrics.disable();
  vi.restoreAllMocks();
});

describe('refresh_graph observability', () => {
  it('records latency with action label and logs completed', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      deps(fakeGraph(() => Promise.resolve(ok(refreshResult('rebuilt'))))),
    );

    const result = await handlers.get('refresh_graph')!({});
    const body = JSON.parse(
      result.content[0]?.type === 'text' ? result.content[0].text : '{}',
    ) as Record<string, unknown>;
    expect((body.data as { action: string }).action).toBe('rebuilt');
    expect(body.freshness).toBeDefined();
    expect(body.context).toBeDefined();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.name).toBe('opensip_cli.mcp.refresh.duration_ms');
    expect(recorded[0]?.attributes).toEqual({
      command: 'mcp',
      op: 'refresh_graph',
      action: 'rebuilt',
      outcome: 'ok',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.graph.refresh.completed',
        module: 'mcp:refresh',
      }),
    );
    expect(
      info.mock.calls.filter(
        ([entry]) =>
          typeof entry === 'object' &&
          entry !== null &&
          entry.evt === 'mcp.graph.refresh.completed',
      ),
    ).toHaveLength(1);
  });

  it('records outcome:error when refresh returns err', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      deps(
        fakeGraph(() =>
          Promise.resolve(
            err({
              code: 'graph-refresh-failed',
              message: 'not wired',
              details: {
                failedPhase: 'rebuild',
                outcome: 'failed',
                projectKey: 'a'.repeat(24),
                priorGenerationKey: 'missing',
                currentGenerationKey: 'g1:current',
                priorGenerationAvailable: false,
              },
            }),
          ),
        ),
      ),
    );

    const result = await handlers.get('refresh_graph')!({});
    expect(result.isError).toBe(true);
    expect(recorded[0]?.attributes).toEqual({
      command: 'mcp',
      op: 'refresh_graph',
      action: 'failed',
      outcome: 'error',
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.graph.refresh.failed',
        failedPhase: 'rebuild',
        outcome: 'failed',
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toMatch(
      /projectKey|priorGenerationKey|currentGenerationKey/u,
    );
    expect(
      error.mock.calls.filter(
        ([entry]) =>
          typeof entry === 'object' && entry !== null && entry.evt === 'mcp.graph.refresh.failed',
      ),
    ).toHaveLength(1);
    const body = JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}') as {
      error?: { details?: Record<string, unknown> };
    };
    expect(body.error?.details).toMatchObject({
      failedPhase: 'rebuild',
      outcome: 'failed',
      projectKey: 'a'.repeat(24),
      priorGenerationKey: 'missing',
      currentGenerationKey: 'g1:current',
    });
  });

  it('maps unexpected throws to bounded result', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { server, handlers } = captureServer();
    registerRefreshGraph(
      server,
      deps(
        fakeGraph(() =>
          Promise.reject(new Error('secret token at /private/project/datastore.sqlite')),
        ),
      ),
    );

    const result = await handlers.get('refresh_graph')!({});
    const body = JSON.parse(
      result.content[0]?.type === 'text' ? result.content[0].text : '{}',
    ) as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'graph-refresh-failed',
        message: 'Graph refresh failed due to an infrastructure error.',
        details: { failedPhase: 'handler', outcome: 'failed' },
      },
    });
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/secret|private|sqlite/i);
  });
});
