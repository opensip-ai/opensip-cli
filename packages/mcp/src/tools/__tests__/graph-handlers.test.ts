/**
 * Graph tool handlers vs. a FAKE async `GraphReadPort` (Phase 1 cutover).
 */

import { err, ok, type Result } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { registerBlastRadius } from '../blast-radius.js';
import { registerCalleesOf } from '../callees-of.js';
import { registerFindDeadCode } from '../find-dead-code.js';
import { registerGetArchitecture } from '../get-architecture.js';
import { registerGetSymbol } from '../get-symbol.js';
import { registerSearchSymbols } from '../search-symbols.js';
import { registerTracePath } from '../trace-path.js';
import { registerWhoCalls } from '../who-calls.js';

import type {
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeDto,
  GraphReadPort,
  RefreshResult,
  TraversalSnapshot,
} from '../../graph-read-port.js';
import type { McpReadError } from '../../mcp-error.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type {
  Freshness,
  GraphEvidenceContext,
  GraphToolResult,
  SymbolRef,
} from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

function captureServer(): { handlers: Map<string, Handler>; server: McpStdioServer } {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
}

function parseResult(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

const FRESH: Freshness = {
  fresh: true,
  builtAt: '2026-05-22T00:00:00.000Z',
  verifiedAt: '2026-05-22T00:00:01.000Z',
  verification: 'complete',
};

const CONTEXT: GraphEvidenceContext = {
  project: { root: '/proj', scope: 'project', configPath: 'opensip-cli.config.yml' },
  catalog: {
    status: 'loaded',
    builtAt: '2026-05-22T00:00:00.000Z',
    language: 'typescript',
    identity: 'g1:abc',
    loadedAt: '2026-05-22T00:00:00.000Z',
    generationSource: 'initial-load',
  },
};

const COVERAGE = { complete: true, truncated: false, reasons: [] as const };

function wrap<T>(data: T): GraphToolResult<T> {
  return { data, context: CONTEXT, freshness: FRESH, coverage: COVERAGE };
}

function symRef(over: Partial<SymbolRef> = {}): SymbolRef {
  return {
    symbolId: 'src/a.ts:10:2',
    bodyHash: 'h-a',
    simpleName: 'a',
    qualifiedName: 'a',
    filePath: 'src/a.ts',
    line: 10,
    column: 2,
    kind: 'function-declaration',
    visibility: 'exported',
    package: 'pkg',
    inTestFile: false,
    definedInGenerated: false,
    ...over,
  };
}

function fakePort(overrides: Partial<GraphReadPort> = {}): GraphReadPort {
  const base: GraphReadPort = {
    catalogStatus: async () => ok({ context: CONTEXT, freshness: FRESH }),
    resolveSymbolId: async (id) =>
      ok(wrap(id === 'src/a.ts:10:2' ? symRef() : undefined)),
    searchSymbols: async () => ok(wrap([symRef()] as readonly SymbolRef[])),
    findBySpan: async () => ok(wrap([symRef()] as readonly SymbolRef[])),
    traverse: async (query) => {
      const nodes = [{ symbol: symRef(), depth: 0 }, { symbol: symRef({ symbolId: 'src/b.ts:1:0' }), depth: 1 }];
      const data: TraversalSnapshot = {
        found: true,
        nodes,
        path: query.direction === 'path' ? nodes.map((n) => n.symbol) : undefined,
        truncated: false,
        identityMode: 'body-twin-union',
      };
      return ok(wrap(data));
    },
    blast: async () =>
      ok(
        wrap({
          symbol: symRef(),
          direct: 2,
          transitive: 4,
          score: 4,
          identityMode: 'body-twin-union',
        } satisfies BlastDto),
      ),
    deadCode: async () =>
      ok(wrap([{ symbol: symRef(), message: 'orphan' }] as readonly DeadCodeDto[])),
    architectureSummary: async () =>
      ok(
        wrap({
          functionCount: 1,
          edgeCount: 1,
          languages: ['typescript'],
          packages: [{ name: 'pkg', couplingOut: 1, couplingIn: 0 }],
          hotspots: [],
        } satisfies ArchitectureSummaryDto),
      ),
    refresh: async () =>
      ok(
        wrap({
          generation: { builtAt: FRESH.builtAt!, identity: 'g1:abc' },
          action: 'rebuilt',
          durationMs: 1,
          priorGenerationAvailable: false,
        } satisfies RefreshResult),
      ),
  };
  return { ...base, ...overrides };
}

function deps(graph: GraphReadPort): McpToolDeps {
  return {
    graph,
    results: {} as McpToolDeps['results'],
    validToolIds: new Set(['fit', 'graph']),
  };
}

describe('graph handlers (async GraphToolResult)', () => {
  it('search_symbols returns context + freshness envelope', async () => {
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(fakePort()));
    const result = await handlers.get('search_symbols')!({ query: 'a' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body).toMatchObject({
      context: CONTEXT,
      freshness: FRESH,
      coverage: COVERAGE,
    });
    expect(Array.isArray(parsed.body['data'])).toBe(true);
  });

  it('get_symbol returns candidates with context', async () => {
    const { handlers, server } = captureServer();
    registerGetSymbol(server, deps(fakePort()));
    const result = await handlers.get('get_symbol')!({ file: 'src/a.ts', line: 10 });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body['context']).toEqual(CONTEXT);
  });

  it('who_calls and callees_of await traverse', async () => {
    const { handlers, server } = captureServer();
    registerWhoCalls(server, deps(fakePort()));
    registerCalleesOf(server, deps(fakePort()));
    for (const name of ['who_calls', 'callees_of'] as const) {
      const result = await handlers.get(name)!({ symbolId: 'src/a.ts:10:2', depth: 2 });
      const parsed = parseResult(result);
      expect(parsed.isError).toBe(false);
      expect(parsed.body['context']).toEqual(CONTEXT);
      expect(parsed.body['coverage']).toBeDefined();
      expect(parsed.body).not.toHaveProperty('truncated');
    }
  });

  it('trace_path returns path envelope without top-level truncated', async () => {
    const { handlers, server } = captureServer();
    registerTracePath(server, deps(fakePort()));
    const result = await handlers.get('trace_path')!({
      fromSymbolId: 'src/a.ts:10:2',
      toSymbolId: 'src/b.ts:1:0',
      depth: 3,
    });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body).toMatchObject({
      data: { found: true },
      context: CONTEXT,
    });
    expect(parsed.body).not.toHaveProperty('truncated');
  });

  it('blast_radius labels identity mode', async () => {
    const { handlers, server } = captureServer();
    registerBlastRadius(server, deps(fakePort()));
    const result = await handlers.get('blast_radius')!({ symbolId: 'src/a.ts:10:2' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    const data = parsed.body['data'] as Record<string, unknown>;
    expect(data['identityMode']).toBe('body-twin-union');
  });

  it('find_dead_code and get_architecture await async port', async () => {
    const { handlers, server } = captureServer();
    registerFindDeadCode(server, deps(fakePort()));
    registerGetArchitecture(server, deps(fakePort()));
    const dead = parseResult(await handlers.get('find_dead_code')!({ limit: 10 }));
    const arch = parseResult(await handlers.get('get_architecture')!({ limit: 10 }));
    expect(dead.isError).toBe(false);
    expect(arch.isError).toBe(false);
    expect(dead.body['context']).toEqual(CONTEXT);
    expect(arch.body['context']).toEqual(CONTEXT);
  });

  it('maps port errors through errorResult', async () => {
    const graph = fakePort({
      searchSymbols: async (): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> =>
        err({ code: 'boom', message: 'failed' }),
    });
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(graph));
    const result = await handlers.get('search_symbols')!({ query: 'x' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(true);
    expect((parsed.body['error'] as { code: string }).code).toBe('boom');
  });
});
