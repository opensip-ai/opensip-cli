/**
 * `opensip mcp` is a TRANSPORT, not a run (Task 6.1 §Observability).
 *
 * - It owns stdout for JSON-RPC: `output: 'raw-stream'` + `rawStreamReason:
 *   'mcp-stdio'`, project-scoped.
 * - It records NO session: the command returns no `ToolSessionContribution`, and
 *   MCP source never names `SessionRepo` / a `persist*Session` / a
 *   `runSession.record` writer (host-owned-run-timing). Verified structurally
 *   across the whole package source (the same symbols the dogfood self-checks
 *   forbid — asserted here as an explicit unit, not just at CI).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentScope, logger, RunScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mcpCommandSpec } from '../command.js';
import { McpStdioServer } from '../server.js';

import type { CallToolResult } from '../server.js';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

function serverWithScope(scope: RunScope): McpStdioServer {
  return new McpStdioServer({
    scope,
    graph: {} as ConstructorParameters<typeof McpStdioServer>[0]['graph'],
    results: {} as ConstructorParameters<typeof McpStdioServer>[0]['results'],
    version: '0.0.0-test',
  });
}

type Dispatch = (
  name: string,
  run: () => CallToolResult | Promise<CallToolResult>,
) => Promise<CallToolResult>;

function dispatchOf(server: McpStdioServer): Dispatch {
  return (
    server as unknown as {
      dispatch: Dispatch;
    }
  ).dispatch.bind(server);
}

const OK_RESULT: CallToolResult = { content: [{ type: 'text', text: '{}' }] };

/** Every production `.ts` under `src/` (excludes `__tests__/` and `*.test.ts`). */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('mcp command — raw-stream transport contract', () => {
  it('owns stdout for JSON-RPC via the documented raw-stream escape hatch', () => {
    expect(mcpCommandSpec.output).toBe('raw-stream');
    expect(mcpCommandSpec.rawStreamReason).toBe('mcp-stdio');
    expect(mcpCommandSpec.scope).toBe('project');
  });
});

describe('mcp source — no session-record writer (transport, not a run)', () => {
  const sources = productionSources(SRC_DIR);
  const contents = new Map(sources.map((f) => [f, readFileSync(f, 'utf8')]));

  it('discovers the production source set', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('never USES SessionRepo (reads sessions only through the read API; prose mentions are fine)', () => {
    // The host-owned-run-timing invariant forbids importing/instantiating the
    // writer — not naming it in a doc-comment that explains the constraint.
    const offenders = [...contents]
      .filter(
        ([, c]) => /\bnew\s+SessionRepo\b/.test(c) || /import[^;]*\bSessionRepo\b[^;]*from/.test(c),
      )
      .map(([f]) => f);
    expect(
      offenders,
      `SessionRepo must not be imported/instantiated:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never returns a ToolSessionContribution or calls a session writer', () => {
    const forbidden = ['ToolSessionContribution', 'persistSession', 'runSession.record'];
    for (const needle of forbidden) {
      const offenders = [...contents].filter(([, c]) => c.includes(needle)).map(([f]) => f);
      expect(
        offenders,
        `${needle} must not appear in MCP source:\n${offenders.join('\n')}`,
      ).toEqual([]);
    }
  });

  it('never imports currentScope in production MCP code', () => {
    const offenders = [...contents]
      .filter(([, content]) => /import[^;]*\bcurrentScope\b[^;]*from/.test(content))
      .map(([file]) => file);
    expect(
      offenders,
      `MCP production must use captured ports, not currentScope:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('MCP dispatch observability', () => {
  it('re-enters the captured scope and logs a bounded ok outcome with duration', async () => {
    const scope = new RunScope();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const result = await dispatchOf(serverWithScope(scope))('search_symbols', () => {
      expect(currentScope()).toBe(scope);
      return OK_RESULT;
    });
    expect(result).toBe(OK_RESULT);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.tool.dispatch.ok',
        tool: 'search_symbols',
        outcome: 'ok',
        durationMs: expect.any(Number),
      }),
    );
    const exit = info.mock.calls.find(
      (call) => (call[0] as { evt?: string }).evt === 'mcp.tool.dispatch.ok',
    )?.[0] as Record<string, unknown>;
    expect(exit.durationMs).toEqual(expect.any(Number));
    expect(exit).not.toHaveProperty('projectRoot');
    expect(exit).not.toHaveProperty('query');
    expect(Object.keys(exit).sort()).toEqual(
      ['durationMs', 'evt', 'module', 'outcome', 'tool'].sort(),
    );
  });

  it('logs a returned MCP tool error without throwing', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const toolError: CallToolResult = { ...OK_RESULT, isError: true };
    await expect(
      dispatchOf(serverWithScope(new RunScope()))('get_runtime_wiring', () => toolError),
    ).resolves.toBe(toolError);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.tool.dispatch.ok',
        tool: 'get_runtime_wiring',
        outcome: 'tool-error',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('logs thrown infrastructure failures without raw path/query/error payloads', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const secret = '/private/project?query=raw-symbol';
    await expect(
      dispatchOf(serverWithScope(new RunScope()))('who_calls', () => {
        throw new Error(secret);
      }),
    ).rejects.toThrow('<path>');
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.tool.dispatch.error',
        tool: 'who_calls',
        outcome: 'thrown',
        durationMs: expect.any(Number),
      }),
    );
    const event = errorLog.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(event)).not.toContain('/private/project');
    expect(event).not.toHaveProperty('error');
    expect(Object.keys(event).sort()).toEqual(
      ['durationMs', 'evt', 'module', 'outcome', 'tool'].sort(),
    );
  });
});
