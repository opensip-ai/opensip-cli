import {
  buildSignalEnvelope,
  type CommandResult,
  type StoredSession,
  type ToolSessionReplay,
} from '@opensip-cli/contracts';
import {
  configureLogger,
  createSignal,
  HOST_VERDICT_POLICY_FALLBACK,
  logger,
  RunScope,
  type ToolShortId,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo, type SessionReplayFn } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpStdioServer } from '../server.js';
import { SessionResultsReadPort } from '../session-results-read-port.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { ResultsReadPort } from '../results-read-port.js';

let store: DataStore;
let replayed: string[];

beforeEach(() => {
  store = DataStoreFactory.open({ backend: 'memory' });
  replayed = [];
});

afterEach(() => {
  store.close();
  configureLogger({ silent: true, debugMode: false, runId: '' });
  vi.restoreAllMocks();
});

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_LOCAL',
    tool: 'fit',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:30.000Z',
    cwd: '/repo',
    score: 100,
    passed: true,
    durationMs: 30_000,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 } },
    ...overrides,
  };
}

function replay(stored: StoredSession): ToolSessionReplay<CommandResult> {
  replayed.push(stored.id);
  const signal = createSignal({
    source: 'unit',
    severity: 'high',
    ruleId: `${stored.id}-rule`,
    message: `${stored.id} finding`,
    code: { file: 'src/index.ts', line: 1, column: 1 },
  });
  const envelope = buildSignalEnvelope({
    tool: stored.tool,
    runId: `${stored.id}-run`,
    createdAt: '2026-05-21T12:00:00.000Z',
    units: [{ slug: 'unit', passed: false, durationMs: 1 }],
    signals: [signal],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
  return { result: {} as CommandResult, envelope, fidelity: 'projection' };
}

const replayFor: (_tool: ToolShortId) => SessionReplayFn | undefined = () => replay;

function port(): SessionResultsReadPort {
  return new SessionResultsReadPort({ store, projectRoot: '/repo', replayFor });
}

describe('SessionResultsReadPort repo scoping', () => {
  it('lists only sessions whose cwd is inside the project root and exposes cwd', () => {
    const repo = new SessionRepo(store);
    repo.save(
      makeSession({
        id: 'FIT_LOCAL_OLD',
        cwd: '/repo',
        startedAt: '2026-05-01T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'FIT_FOREIGN_NEW',
        cwd: '/other',
        startedAt: '2026-05-03T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'FIT_LOCAL_NEW',
        cwd: '/repo/packages/app',
        startedAt: '2026-05-02T00:00:00.000Z',
      }),
    );

    const out = port().listRuns({ limit: 2 });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.map((run) => run.id)).toEqual(['FIT_LOCAL_NEW', 'FIT_LOCAL_OLD']);
      expect(out.value.map((run) => run.cwd)).toEqual(['/repo/packages/app', '/repo']);
    }
  });

  it('returns not-found for showRun on a foreign session id without replaying it', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    new SessionRepo(store).save(makeSession({ id: 'FIT_FOREIGN', cwd: '/other' }));

    const out = await port().showRun({ ref: 'FIT_FOREIGN' });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-found');
    expect(replayed).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.results.scope.rejected',
        module: 'mcp:results-read-port',
        ref: 'FIT_FOREIGN',
        sessionCwd: '/other',
        projectRoot: '/repo',
      }),
    );
  });

  it('returns not-found for latestFindings when the latest row is foreign', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const repo = new SessionRepo(store);
    repo.save(
      makeSession({ id: 'FIT_LOCAL', cwd: '/repo', startedAt: '2026-05-01T00:00:00.000Z' }),
    );
    repo.save(
      makeSession({
        id: 'FIT_FOREIGN',
        cwd: '/other',
        startedAt: '2026-05-02T00:00:00.000Z',
      }),
    );

    const out = await port().latestFindings({ tool: 'fit' });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-found');
    expect(replayed).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.results.scope.rejected',
        module: 'mcp:results-read-port',
        ref: 'latest',
        sessionCwd: '/other',
        projectRoot: '/repo',
      }),
    );
  });

  it('replays an in-root showRun and carries cwd in the replay summary', async () => {
    new SessionRepo(store).save(makeSession({ id: 'FIT_LOCAL', cwd: '/repo' }));

    const out = await port().showRun({ ref: 'FIT_LOCAL' });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.session?.cwd).toBe('/repo');
      expect(out.value.data.envelope.signals[0]?.ruleId).toBe('FIT_LOCAL-rule');
    }
  });
});

describe('McpStdioServer repo scoping observability', () => {
  it('logs the captured projectRoot when the stdio server starts', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const fakeMcp = {
      server: {} as { onclose?: () => void },
      connect: vi.fn(() => {
        queueMicrotask(() => fakeMcp.server.onclose?.());
        return Promise.resolve();
      }),
      close: vi.fn(() => {
        fakeMcp.server.onclose?.();
        return Promise.resolve();
      }),
    };
    const transport = {};
    const server = new McpStdioServer({
      scope: new RunScope({
        projectContext: {
          cwd: '/repo',
          cwdExplicit: false,
          projectRoot: '/repo',
          configPath: '/repo/opensip-cli.config.yml',
          walkedUp: 0,
          scope: 'project',
        },
      }),
      graph: {} as GraphReadPort,
      results: {} as ResultsReadPort,
      version: '0.0.0-test',
    });
    Object.assign(server as unknown as { mcp: typeof fakeMcp; transport: unknown }, {
      mcp: fakeMcp,
      transport,
    });

    await server.serve();

    expect(fakeMcp.connect).toHaveBeenCalledWith(transport);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'mcp.server.start',
        module: 'mcp:server',
        server: 'opensip-cli-mcp',
        version: '0.0.0-test',
        projectRoot: '/repo',
      }),
    );
  });
});
