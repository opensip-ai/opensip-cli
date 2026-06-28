/**
 * Graph tool handlers vs. a FAKE `GraphReadPort` (Task 6.1 steps 1–3).
 *
 * Each handler is registered through a capturing fake server, then invoked
 * directly with already-valid args (Zod boundary validation is covered in
 * schemas.test.ts). Asserts freshness stamping, `truncated` metadata, symbolId
 * resolution errors (unknown id → structured error), `get_symbol` span/ambiguity
 * behavior, and that no DTO carries a raw file body (metadata + bodyHash only).
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
  AdjacencySnapshot,
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeDto,
  GraphGeneration,
  GraphReadPort,
  SearchSymbolsOptions,
} from '../../graph-read-port.js';
import type { McpReadError } from '../../mcp-error.js';
import type { McpStdioServer, CallToolResult } from '../../server.js';
import type { Freshness, McpToolResult, SymbolRef } from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

// ── capturing fake server ────────────────────────────────────────────

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

interface Captured {
  readonly handlers: Map<string, Handler>;
  readonly server: McpStdioServer;
}

function captureServer(): Captured {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
      return undefined;
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
}

/** Parse the single JSON text item a tool result carries. */
function parseResult(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

const FRESH: Freshness = { fresh: true, builtAt: '2026-05-22T00:00:00.000Z' };
const STALE: Freshness = { fresh: false, reason: 'missing' };

function symRef(over: Partial<SymbolRef> = {}): SymbolRef {
  return {
    symbolId: 'src/a.ts:10:2',
    bodyHash: 'h-a',
    qualifiedName: 'a',
    filePath: 'src/a.ts',
    line: 10,
    column: 2,
    kind: 'function',
    visibility: 'exported',
    ...over,
  };
}

function wrap<T>(data: T, truncated?: boolean, fresh: Freshness = FRESH): McpToolResult<T> {
  return { data, freshness: fresh, ...(truncated ? { truncated: true } : {}) };
}

/** A configurable fake GraphReadPort — only the methods a test exercises are overridden. */
function fakeGraph(over: Partial<GraphReadPort> = {}): GraphReadPort {
  const base: GraphReadPort = {
    getGeneration: () => ok(wrap<GraphGeneration | undefined>(undefined)),
    resolveSymbolId: () => ok(wrap<SymbolRef | undefined>(undefined)),
    searchSymbols: () => ok(wrap<readonly SymbolRef[]>([])),
    findBySpan: () => ok(wrap<readonly SymbolRef[]>([])),
    callerGraph: () => ok(wrap(emptySnapshot())),
    calleeGraph: () => ok(wrap(emptySnapshot())),
    blast: () => ok(wrap<BlastDto | undefined>(undefined)),
    deadCode: () => ok(wrap<readonly DeadCodeDto[]>([])),
    architectureSummary: () =>
      ok(
        wrap<ArchitectureSummaryDto>({
          functionCount: 0,
          edgeCount: 0,
          languages: [],
          packages: [],
          hotspots: [],
        }),
      ),
    refresh: () => Promise.resolve(ok(wrap<GraphGeneration>({ builtAt: FRESH.builtAt ?? '' }))),
    freshness: () => FRESH,
  };
  return { ...base, ...over };
}

function emptySnapshot(): AdjacencySnapshot {
  return { edges: new Map(), resolve: () => undefined };
}

/** Build a walkable adjacency snapshot from a body-hash graph + a hash→ref table. */
function snapshot(
  edges: Record<string, readonly string[]>,
  refs: Record<string, SymbolRef>,
): AdjacencySnapshot {
  return {
    edges: new Map(Object.entries(edges)),
    resolve: (hash) => refs[hash],
  };
}

function deps(graph: GraphReadPort): McpToolDeps {
  return { graph, results: {} as McpToolDeps['results'], validToolIds: new Set() };
}

// ── search_symbols ───────────────────────────────────────────────────

describe('search_symbols handler', () => {
  it('returns the port envelope with freshness, forwarding the limit', () => {
    let seenOpts: SearchSymbolsOptions | undefined;
    const { server, handlers } = captureServer();
    registerSearchSymbols(
      server,
      deps(
        fakeGraph({
          searchSymbols: (_q, opts): Result<McpToolResult<readonly SymbolRef[]>, McpReadError> => {
            seenOpts = opts;
            return ok(wrap([symRef()], true));
          },
        }),
      ),
    );
    const out = parseResult(
      handlers.get('search_symbols')!({ query: 'a', limit: 5 }) as CallToolResult,
    );
    expect(out.isError).toBe(false);
    expect(seenOpts).toEqual({ limit: 5 });
    expect(out.body.truncated).toBe(true);
    expect(out.body.freshness).toEqual(FRESH);
    const data = out.body.data as SymbolRef[];
    // No raw file body crosses the boundary — metadata + bodyHash only.
    expect(data[0]).toHaveProperty('bodyHash');
    expect(data[0]).not.toHaveProperty('body');
    expect(data[0]).not.toHaveProperty('source');
  });

  it('narrows by kind post-hoc on the already-capped page', () => {
    const { server, handlers } = captureServer();
    registerSearchSymbols(
      server,
      deps(
        fakeGraph({
          searchSymbols: () =>
            ok(wrap([symRef({ kind: 'function' }), symRef({ kind: 'method', symbolId: 'b:1:1' })])),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('search_symbols')!({ query: 'a', kind: 'method' }) as CallToolResult,
    );
    const data = out.body.data as SymbolRef[];
    expect(data).toHaveLength(1);
    expect(data[0]?.kind).toBe('method');
  });

  it('surfaces a port error as an isError result', () => {
    const { server, handlers } = captureServer();
    registerSearchSymbols(
      server,
      deps(fakeGraph({ searchSymbols: () => err({ code: 'boom', message: 'db down' }) })),
    );
    const out = parseResult(handlers.get('search_symbols')!({ query: 'a' }) as CallToolResult);
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('boom');
  });
});

// ── get_symbol (span containment + ambiguity) ────────────────────────

describe('get_symbol handler', () => {
  it('returns a single symbol when exactly one span encloses the line', () => {
    const { server, handlers } = captureServer();
    registerGetSymbol(server, deps(fakeGraph({ findBySpan: () => ok(wrap([symRef()])) })));
    const out = parseResult(
      handlers.get('get_symbol')!({ file: 'src/a.ts', line: 10 }) as CallToolResult,
    );
    expect(out.isError).toBe(false);
    expect((out.body.data as SymbolRef).symbolId).toBe('src/a.ts:10:2');
    expect(out.body.ambiguous).toBeUndefined();
  });

  it('returns a candidate list (never a silent pick) when nested spans both enclose the line', () => {
    const { server, handlers } = captureServer();
    const outer = symRef({ symbolId: 'src/a.ts:1:0', qualifiedName: 'outer' });
    const inner = symRef({ symbolId: 'src/a.ts:5:2', qualifiedName: 'inner' });
    registerGetSymbol(server, deps(fakeGraph({ findBySpan: () => ok(wrap([outer, inner])) })));
    const out = parseResult(
      handlers.get('get_symbol')!({ file: 'src/a.ts', line: 6 }) as CallToolResult,
    );
    expect(out.body.ambiguous).toBe(true);
    expect((out.body.candidates as SymbolRef[]).map((c) => c.qualifiedName)).toEqual([
      'outer',
      'inner',
    ]);
  });

  it('returns a structured symbol-not-found error when no span matches', () => {
    const { server, handlers } = captureServer();
    registerGetSymbol(server, deps(fakeGraph({ findBySpan: () => ok(wrap([])) })));
    const out = parseResult(
      handlers.get('get_symbol')!({ file: 'src/a.ts', line: 99 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('symbol-not-found');
  });

  it('hints to refresh when the catalog is stale and no span matched', () => {
    const { server, handlers } = captureServer();
    registerGetSymbol(server, deps(fakeGraph({ findBySpan: () => ok(wrap([], false, STALE)) })));
    const out = parseResult(
      handlers.get('get_symbol')!({ file: 'src/a.ts', line: 99 }) as CallToolResult,
    );
    expect((out.body.error as McpReadError).message).toContain('refresh_graph');
  });
});

// ── who_calls / callees_of (bounded walk + unknown symbolId) ──────────

describe('who_calls handler', () => {
  it('rejects an unknown symbolId with a structured error', () => {
    const { server, handlers } = captureServer();
    registerWhoCalls(server, deps(fakeGraph({ resolveSymbolId: () => ok(wrap(undefined)) })));
    const out = parseResult(
      handlers.get('who_calls')!({ symbolId: 'x:1:1', depth: 5 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('symbol-not-found');
  });

  it('walks the reverse-call adjacency and resolves callers to SymbolRefs', () => {
    const start = symRef({ symbolId: 'src/a.ts:10:2', bodyHash: 'h-a' });
    const caller = symRef({ symbolId: 'src/b.ts:3:0', bodyHash: 'h-b', qualifiedName: 'b' });
    const { server, handlers } = captureServer();
    registerWhoCalls(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: () => ok(wrap<SymbolRef | undefined>(start)),
          callerGraph: () =>
            ok(wrap(snapshot({ 'h-a': ['h-b'] }, { 'h-a': start, 'h-b': caller }))),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('who_calls')!({ symbolId: 'src/a.ts:10:2', depth: 5 }) as CallToolResult,
    );
    const data = out.body.data as SymbolRef[];
    expect(data.map((d) => d.qualifiedName)).toEqual(['b']);
    expect(out.body.freshness).toEqual(FRESH);
  });
});

describe('callees_of handler', () => {
  it('walks the forward-call adjacency from a resolved symbol', () => {
    const start = symRef({ symbolId: 'src/a.ts:10:2', bodyHash: 'h-a' });
    const callee = symRef({ symbolId: 'src/c.ts:1:0', bodyHash: 'h-c', qualifiedName: 'c' });
    const { server, handlers } = captureServer();
    registerCalleesOf(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: () => ok(wrap<SymbolRef | undefined>(start)),
          calleeGraph: () =>
            ok(wrap(snapshot({ 'h-a': ['h-c'] }, { 'h-a': start, 'h-c': callee }))),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('callees_of')!({ symbolId: 'src/a.ts:10:2', depth: 5 }) as CallToolResult,
    );
    expect((out.body.data as SymbolRef[]).map((d) => d.qualifiedName)).toEqual(['c']);
  });
});

// ── trace_path ───────────────────────────────────────────────────────

describe('trace_path handler', () => {
  const from = symRef({ symbolId: 'a:1:0', bodyHash: 'h-a', qualifiedName: 'a' });
  const mid = symRef({ symbolId: 'b:1:0', bodyHash: 'h-b', qualifiedName: 'b' });
  const to = symRef({ symbolId: 'c:1:0', bodyHash: 'h-c', qualifiedName: 'c' });

  const byId: Record<string, SymbolRef> = { 'a:1:0': from, 'c:1:0': to };

  function tracePortWith(edges: Record<string, readonly string[]>): GraphReadPort {
    const refs = { 'h-a': from, 'h-b': mid, 'h-c': to };
    return fakeGraph({
      resolveSymbolId: (id) => ok(wrap<SymbolRef | undefined>(byId[id])),
      calleeGraph: () => ok(wrap(snapshot(edges, refs))),
    });
  }

  it('returns the ordered path when one exists', () => {
    const { server, handlers } = captureServer();
    registerTracePath(server, deps(tracePortWith({ 'h-a': ['h-b'], 'h-b': ['h-c'] })));
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    const data = out.body.data as { found: boolean; path: SymbolRef[] };
    expect(data.found).toBe(true);
    expect(data.path.map((p) => p.qualifiedName)).toEqual(['a', 'b', 'c']);
  });

  it('returns { found: false } when no path exists within the bound (not an error)', () => {
    const { server, handlers } = captureServer();
    registerTracePath(server, deps(tracePortWith({ 'h-a': [], 'h-b': [], 'h-c': [] })));
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    expect(out.isError).toBe(false);
    expect((out.body.data as { found: boolean }).found).toBe(false);
  });

  it('errors when one endpoint symbolId is unknown', () => {
    const { server, handlers } = captureServer();
    registerTracePath(server, deps(tracePortWith({ 'h-a': ['h-b'] })));
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'missing:9:9',
        depth: 5,
      }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('symbol-not-found');
  });
});

// ── blast_radius / find_dead_code / get_architecture ─────────────────

describe('blast_radius handler', () => {
  it('returns the blast score for a resolved symbol', () => {
    const blast: BlastDto = { symbol: symRef(), direct: 3, transitive: 4, score: 5 };
    const { server, handlers } = captureServer();
    registerBlastRadius(
      server,
      deps(fakeGraph({ blast: () => ok(wrap<BlastDto | undefined>(blast)) })),
    );
    const out = parseResult(
      handlers.get('blast_radius')!({ symbolId: 'src/a.ts:10:2' }) as CallToolResult,
    );
    expect((out.body.data as BlastDto).score).toBe(5);
  });

  it('returns a structured blast-unavailable error when no score exists', () => {
    const { server, handlers } = captureServer();
    registerBlastRadius(server, deps(fakeGraph({ blast: () => ok(wrap(undefined)) })));
    const out = parseResult(
      handlers.get('blast_radius')!({ symbolId: 'src/a.ts:10:2' }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('blast-unavailable');
  });
});

describe('find_dead_code handler', () => {
  it('returns the dead-code envelope, forwarding the limit', () => {
    let seenLimit: number | undefined;
    const { server, handlers } = captureServer();
    registerFindDeadCode(
      server,
      deps(
        fakeGraph({
          deadCode: (limit) => {
            seenLimit = limit;
            return ok(wrap([{ symbol: symRef(), message: 'orphan' }], true));
          },
        }),
      ),
    );
    const out = parseResult(handlers.get('find_dead_code')!({ limit: 7 }) as CallToolResult);
    expect(seenLimit).toBe(7);
    expect(out.body.truncated).toBe(true);
    expect((out.body.data as DeadCodeDto[])[0]?.message).toBe('orphan');
  });
});

describe('get_architecture handler', () => {
  it('returns the architecture summary with freshness', () => {
    const summary: ArchitectureSummaryDto = {
      functionCount: 42,
      edgeCount: 99,
      languages: ['typescript'],
      packages: [{ name: 'core', couplingOut: 3, couplingIn: 1 }],
      hotspots: [{ symbol: symRef(), direct: 2, transitive: 1, score: 2.5 }],
    };
    const { server, handlers } = captureServer();
    registerGetArchitecture(
      server,
      deps(fakeGraph({ architectureSummary: () => ok(wrap(summary)) })),
    );
    const out = parseResult(handlers.get('get_architecture')!({}) as CallToolResult);
    expect((out.body.data as ArchitectureSummaryDto).functionCount).toBe(42);
    expect(out.body.freshness).toEqual(FRESH);
  });
});

// ── adjacency / port error arms (second port call fails) ─────────────

describe('graph handler error arms', () => {
  const start = symRef({ symbolId: 'a:1:0', bodyHash: 'h-a' });
  const portErr: McpReadError = { code: 'db-down', message: 'sqlite gone' };

  it('who_calls surfaces a callerGraph port error', () => {
    const { server, handlers } = captureServer();
    registerWhoCalls(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: () => ok(wrap<SymbolRef | undefined>(start)),
          callerGraph: () => err(portErr),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('who_calls')!({ symbolId: 'a:1:0', depth: 5 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('db-down');
  });

  it('who_calls surfaces a resolveSymbolId port error', () => {
    const { server, handlers } = captureServer();
    registerWhoCalls(server, deps(fakeGraph({ resolveSymbolId: () => err(portErr) })));
    const out = parseResult(
      handlers.get('who_calls')!({ symbolId: 'a:1:0', depth: 5 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
  });

  it('callees_of surfaces a calleeGraph port error', () => {
    const { server, handlers } = captureServer();
    registerCalleesOf(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: () => ok(wrap<SymbolRef | undefined>(start)),
          calleeGraph: () => err(portErr),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('callees_of')!({ symbolId: 'a:1:0', depth: 5 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
  });

  it('callees_of rejects an unknown symbolId', () => {
    const { server, handlers } = captureServer();
    registerCalleesOf(server, deps(fakeGraph({ resolveSymbolId: () => ok(wrap(undefined)) })));
    const out = parseResult(
      handlers.get('callees_of')!({ symbolId: 'a:1:0', depth: 5 }) as CallToolResult,
    );
    expect((out.body.error as McpReadError).code).toBe('symbol-not-found');
  });

  it('trace_path surfaces a calleeGraph port error', () => {
    const to = symRef({ symbolId: 'c:1:0', bodyHash: 'h-c' });
    const { server, handlers } = captureServer();
    registerTracePath(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: (id) => ok(wrap<SymbolRef | undefined>(id === 'a:1:0' ? start : to)),
          calleeGraph: () => err(portErr),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
  });

  it('trace_path surfaces a resolve error on the from endpoint', () => {
    const { server, handlers } = captureServer();
    registerTracePath(server, deps(fakeGraph({ resolveSymbolId: () => err(portErr) })));
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
  });

  it('blast_radius surfaces a port error', () => {
    const { server, handlers } = captureServer();
    registerBlastRadius(server, deps(fakeGraph({ blast: () => err(portErr) })));
    const out = parseResult(handlers.get('blast_radius')!({ symbolId: 'a:1:0' }) as CallToolResult);
    expect(out.isError).toBe(true);
  });

  it('blast_radius hints to refresh when the catalog is stale and no score exists', () => {
    const { server, handlers } = captureServer();
    registerBlastRadius(
      server,
      deps(fakeGraph({ blast: () => ok(wrap(undefined, false, STALE)) })),
    );
    const out = parseResult(handlers.get('blast_radius')!({ symbolId: 'a:1:0' }) as CallToolResult);
    expect((out.body.error as McpReadError).message).toContain('refresh_graph');
  });

  it('find_dead_code surfaces a port error', () => {
    const { server, handlers } = captureServer();
    registerFindDeadCode(server, deps(fakeGraph({ deadCode: () => err(portErr) })));
    const out = parseResult(handlers.get('find_dead_code')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });

  it('get_architecture surfaces a port error', () => {
    const { server, handlers } = captureServer();
    registerGetArchitecture(server, deps(fakeGraph({ architectureSummary: () => err(portErr) })));
    const out = parseResult(handlers.get('get_architecture')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });

  it('get_symbol surfaces a findBySpan port error', () => {
    const { server, handlers } = captureServer();
    registerGetSymbol(server, deps(fakeGraph({ findBySpan: () => err(portErr) })));
    const out = parseResult(
      handlers.get('get_symbol')!({ file: 'a.ts', line: 1 }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('db-down');
  });

  it('trace_path surfaces a resolve error on the to endpoint (from resolves first)', () => {
    const { server, handlers } = captureServer();
    registerTracePath(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: (id) =>
            id === 'a:1:0' ? ok(wrap<SymbolRef | undefined>(start)) : err(portErr),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    expect(out.isError).toBe(true);
  });

  it('trace_path reports the missing FROM endpoint id', () => {
    const to = symRef({ symbolId: 'c:1:0', bodyHash: 'h-c' });
    const { server, handlers } = captureServer();
    registerTracePath(
      server,
      deps(
        fakeGraph({
          resolveSymbolId: (id) => ok(wrap<SymbolRef | undefined>(id === 'c:1:0' ? to : undefined)),
        }),
      ),
    );
    const out = parseResult(
      handlers.get('trace_path')!({
        fromSymbolId: 'a:1:0',
        toSymbolId: 'c:1:0',
        depth: 5,
      }) as CallToolResult,
    );
    expect((out.body.error as McpReadError).message).toContain('a:1:0');
  });
});
