/**
 * Result/history tool handlers vs. a FAKE `ResultsReadPort` (Task 6.1 step 5).
 *
 * The result tools replay persisted sessions only — they NEVER re-run a tool.
 * Asserts each handler forwards its args to the port, validates `tool` against
 * the live registry (unknown → structured error), and surfaces the err arm.
 */

import { err, ok } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { registerGetAgentCatalog } from '../get-agent-catalog.js';
import { registerGetLatestFindings } from '../get-latest-findings.js';
import { registerListRuns } from '../list-runs.js';
import { registerShowRun } from '../show-run.js';

import type { McpReadError } from '../../mcp-error.js';
import type {
  LatestFindingsOptions,
  McpFinding,
  McpResultReplay,
  RunSummary,
  ShowRunData,
} from '../../result-dto.js';
import type { ListRunsOptions, ResultsReadPort, ShowRunOptions } from '../../results-read-port.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type { McpToolDeps } from '../types.js';
import type { AgentCatalog } from '@opensip-cli/contracts';
import type { Result } from '@opensip-cli/core';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

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

function parseResult(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

function fakeResults(over: Partial<ResultsReadPort>): ResultsReadPort {
  const base: ResultsReadPort = {
    agentCatalog: () => ok({ commands: [] } as unknown as AgentCatalog),
    listRuns: () => ok([]),
    showRun: () => Promise.resolve(err({ code: 'x', message: 'x' })),
    latestFindings: () => Promise.resolve(err({ code: 'x', message: 'x' })),
  };
  return { ...base, ...over };
}

function deps(results: ResultsReadPort, validToolIds = new Set(['fit', 'graph'])): McpToolDeps {
  return { graph: {} as McpToolDeps['graph'], results, validToolIds };
}

// ── get_latest_findings ──────────────────────────────────────────────

describe('get_latest_findings handler', () => {
  it('forwards tool/severity/limit to the port and returns the replay', async () => {
    let seen: LatestFindingsOptions | undefined;
    const replay: McpResultReplay<readonly McpFinding[]> = {
      data: [{ ruleId: 'r', message: 'm', severity: 'high' }],
      filtersApplied: ['errors-only', 'top:3'],
    };
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: (opts) => {
            seen = opts;
            return Promise.resolve(ok(replay));
          },
        }),
      ),
    );
    const out = parseResult(
      await handlers.get('get_latest_findings')!({
        tool: 'fit',
        severity: 'errors',
        limit: 3,
      }),
    );
    expect(seen).toEqual({ tool: 'fit', severity: 'errors', limit: 3 });
    expect((out.body.data as McpFinding[])[0]?.ruleId).toBe('r');
    expect(out.body.filtersApplied).toEqual(['errors-only', 'top:3']);
  });

  it('rejects an unknown tool with a structured unknown-tool error (no port call)', async () => {
    let called = false;
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: () => {
            called = true;
            return Promise.resolve(ok({ data: [] }));
          },
        }),
      ),
    );
    const out = parseResult(await handlers.get('get_latest_findings')!({ tool: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
    expect(called).toBe(false);
  });

  it('surfaces the port err arm', async () => {
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: () => Promise.resolve(err({ code: 'not-found', message: 'no runs' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('get_latest_findings')!({ tool: 'fit' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── list_runs ────────────────────────────────────────────────────────

describe('list_runs handler', () => {
  it('forwards tool/limit/summaryOnly and wraps rows under { runs }', () => {
    let seen: ListRunsOptions | undefined;
    const row: RunSummary = {
      id: 's1',
      tool: 'fit',
      startedAt: 't',
      completedAt: 't',
      score: 90,
      passed: true,
      showCommand: 'opensip sessions show s1 --json',
    };
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(
        fakeResults({
          listRuns: (opts): Result<readonly RunSummary[], McpReadError> => {
            seen = opts;
            return ok([row]);
          },
        }),
      ),
    );
    const out = parseResult(
      handlers.get('list_runs')!({ tool: 'fit', limit: 10, summaryOnly: true }) as CallToolResult,
    );
    expect(seen).toEqual({ tool: 'fit', limit: 10, summaryOnly: true });
    expect((out.body.runs as RunSummary[])[0]?.id).toBe('s1');
  });

  it('lists with no arguments (all optional filters omitted)', () => {
    let seen: ListRunsOptions | undefined;
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(
        fakeResults({
          listRuns: (opts) => {
            seen = opts;
            return ok([]);
          },
        }),
      ),
    );
    const out = parseResult(handlers.get('list_runs')!({}) as CallToolResult);
    expect(out.isError).toBe(false);
    expect(seen).toEqual({});
  });

  it('rejects an unknown tool filter, naming "(none registered)" when no tools exist', () => {
    const { server, handlers } = captureServer();
    registerListRuns(server, deps(fakeResults({ listRuns: () => ok([]) }), new Set()));
    const out = parseResult(handlers.get('list_runs')!({ tool: 'nope' }) as CallToolResult);
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).message).toContain('(none registered)');
  });

  it('surfaces a listRuns port error', () => {
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(fakeResults({ listRuns: () => err({ code: 'boom', message: 'x' }) })),
    );
    const out = parseResult(handlers.get('list_runs')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });
});

// ── show_run ─────────────────────────────────────────────────────────

describe('show_run handler', () => {
  it('forwards ref/tool/filters/raw to the port', async () => {
    let seen: ShowRunOptions | undefined;
    const { server, handlers } = captureServer();
    registerShowRun(
      server,
      deps(
        fakeResults({
          showRun: (opts) => {
            seen = opts;
            return Promise.resolve(
              ok({
                data: { fidelity: 'projection' } as ShowRunData,
              }),
            );
          },
        }),
      ),
    );
    await handlers.get('show_run')!({
      ref: 'latest',
      tool: 'fit',
      filters: ['errors-only'],
      raw: true,
    });
    expect(seen).toEqual({ ref: 'latest', tool: 'fit', filters: ['errors-only'], raw: true });
  });

  it('rejects an unknown tool sanity-check', async () => {
    const { server, handlers } = captureServer();
    registerShowRun(server, deps(fakeResults({})));
    const out = parseResult(await handlers.get('show_run')!({ ref: 'latest', tool: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
  });

  it('surfaces a not-found err arm', async () => {
    const { server, handlers } = captureServer();
    registerShowRun(
      server,
      deps(
        fakeResults({
          showRun: () => Promise.resolve(err({ code: 'not-found', message: 'no session' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('show_run')!({ ref: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── get_agent_catalog ────────────────────────────────────────────────

describe('get_agent_catalog handler', () => {
  it('returns the agent catalog', () => {
    const { server, handlers } = captureServer();
    registerGetAgentCatalog(
      server,
      deps(
        fakeResults({ agentCatalog: () => ok({ commands: ['fit'] } as unknown as AgentCatalog) }),
      ),
    );
    const out = parseResult(handlers.get('get_agent_catalog')!({}) as CallToolResult);
    expect(out.isError).toBe(false);
    expect(out.body.commands).toEqual(['fit']);
  });

  it('surfaces an err arm', () => {
    const { server, handlers } = captureServer();
    registerGetAgentCatalog(
      server,
      deps(fakeResults({ agentCatalog: () => err({ code: 'boom', message: 'x' }) })),
    );
    const out = parseResult(handlers.get('get_agent_catalog')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });
});
