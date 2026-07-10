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
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    },
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
    info.mockClear();

    const out = await port().showRun({ ref: 'FIT_FOREIGN' });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-found');
    expect(replayed).toEqual([]);
    expect(info).toHaveBeenCalledWith({
      evt: 'mcp.results.scope.rejected',
      module: 'mcp:results-read-port',
      reason: 'outside-project',
    });
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('FIT_FOREIGN');
    expect(logged).not.toContain('/other');
    expect(logged).not.toContain('/repo');
  });

  it('latestFindings selects the newest in-root session over a newer foreign one', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
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
        id: 'FIT_LOCAL_NEW',
        cwd: '/repo/packages/app',
        startedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'FIT_FOREIGN_NEW',
        cwd: '/other',
        startedAt: '2026-05-03T00:00:00.000Z',
      }),
    );

    const out = await port().latestFindings({ tool: 'fit' });

    expect(out.ok).toBe(true);
    if (out.ok) {
      // The 'latest' sentinel SELECTS the newest in-scope row, skipping the
      // newer foreign one — it is not resolved-then-rejected.
      expect(out.value.session?.id).toBe('FIT_LOCAL_NEW');
      expect(out.value.data[0]?.ruleId).toBe('FIT_LOCAL_NEW-rule');
    }
    // Only the in-scope session is ever replayed; the foreign row is filtered
    // out before resolution, so it never reaches the replay closure.
    expect(replayed).toEqual(['FIT_LOCAL_NEW']);
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'mcp.results.scope.rejected' }),
    );
  });

  it('latestFindings returns not-found when only foreign sessions exist, without replaying', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    new SessionRepo(store).save(makeSession({ id: 'FIT_FOREIGN', cwd: '/other' }));

    const out = await port().latestFindings({ tool: 'fit' });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('not-found');
    // The foreign row is filtered out pre-resolution, so nothing replays and the
    // per-row scope.rejected log does NOT fire on the latest path (that log is
    // reserved for explicit ids that resolve globally then fail the scope check).
    expect(replayed).toEqual([]);
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'mcp.results.scope.rejected' }),
    );
  });

  it('showRun({ ref: latest }) scope-selects the newest in-root session', async () => {
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
        id: 'FIT_LOCAL_NEW',
        cwd: '/repo/packages/app',
        startedAt: '2026-05-02T00:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'FIT_FOREIGN_NEW',
        cwd: '/other',
        startedAt: '2026-05-03T00:00:00.000Z',
      }),
    );

    const out = await port().showRun({ ref: 'latest', tool: 'fit' });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.session?.id).toBe('FIT_LOCAL_NEW');
      expect(out.value.data.envelope.signals[0]?.ruleId).toBe('FIT_LOCAL_NEW-rule');
    }
    expect(replayed).toEqual(['FIT_LOCAL_NEW']);
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
  it('logs bounded project scope without the captured project root', async () => {
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
        projectScope: 'project',
      }),
    );
    // Absolute project paths must not appear on the shared stderr start event.
    const startPayload = info.mock.calls.find(
      (call) => (call[0] as { evt?: string } | undefined)?.evt === 'mcp.server.start',
    )?.[0] as Record<string, unknown> | undefined;
    expect(startPayload).not.toHaveProperty('projectRoot');
  });
});
