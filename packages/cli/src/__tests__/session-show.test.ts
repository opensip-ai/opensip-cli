import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolRegistry } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeSessionShow } from '../commands/session-show.js';
import { SessionReplayRegistry } from '../session-replay-registry.js';
import { makeTestScope, withScope } from '@opensip-cli/test-support';
import { currentScope } from '@opensip-cli/core';

import type {
  CommandResult,
  FitDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
} from '@opensip-cli/contracts';
import type { Tool, ToolSessionRecord } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

let tmp: string;
let ds: DataStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-session-show-'));
  ds = DataStoreFactory.open({ backend: 'sqlite', path: join(tmp, 'd.sqlite') });
});

afterEach(() => {
  ds.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeSession(
  id: string,
  ts: number = Date.now(),
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/x',
    timestamp: new Date(ts).toISOString(),
    score: 100,
    passed: true,
    durationMs: 10,
    payload: {
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
    ...overrides,
  };
}

function makeReplayRegistry(): SessionReplayRegistry {
  const registry = new ToolRegistry();
  registry.register({
    metadata: { id: 'fit-replay-test', version: '0.0.0', description: 'test' },
    commands: [],
    sessionReplay: {
      tool: 'fit',
      replaySession: replayFitSession,
    },
  } satisfies Tool);
  return SessionReplayRegistry.fromTools(registry);
}

function replayFitSession(stored: ToolSessionRecord): ToolSessionReplay<CommandResult> {
  const envelope: SignalEnvelope = {
    schemaVersion: 2,
    tool: 'fit',
    runId: stored.id,
    createdAt: stored.timestamp,
    verdict: {
      score: stored.score,
      passed: stored.passed,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
  };
  const result: FitDoneResult = {
    type: 'fit-done',
    label: `session ${stored.id}`,
    cwd: stored.cwd,
    envelope,
    configFound: true,
  };
  return { fidelity: 'projection', envelope, result };
}

/** Capture the host emit seams so each test can assert what reached stdout. */
function makeSinks() {
  const emitted: unknown[] = [];
  const errors: { message: string; exitCode: number; code?: string }[] = [];
  const rendered: CommandResult[] = [];
  const exitCodes: number[] = [];
  return {
    emitted,
    errors,
    rendered,
    exitCodes,
    emitJson: (value: unknown) => {
      emitted.push(value);
    },
    emitError: (detail: { message: string; exitCode: number; code?: string }) => {
      // Mirror the host seam: emitError sets the exit code itself.
      exitCodes.push(detail.exitCode);
      errors.push(detail);
    },
    render: (result: CommandResult) => {
      rendered.push(result);
      return Promise.resolve();
    },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
  };
}

describe('executeSessionShow', () => {
  it('emits a replay JSON wrapper for latest scoped by tool', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1', Date.now()));
    repo.save(makeSession('FIT_2', Date.now() + 1));
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () => {
      // Phase 2/6 hygiene: the handler body (via execute) must see a real entered scope.
      expect(currentScope()).toBeTruthy();
      expect(currentScope()?.datastore()).toBe(ds);
      return executeSessionShow({
        replayRegistry: makeReplayRegistry(),
        ref: 'latest',
        tool: 'fit',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      });
    });

    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0]).toMatchObject({
      session: { id: 'FIT_2', tool: 'fit' },
      fidelity: 'projection',
      envelope: { runId: 'FIT_2', tool: 'fit' },
    });
  });

  it('reports ambiguous latest without a tool as a structured error', async () => {
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: makeReplayRegistry(),
        ref: 'latest',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.exitCodes).toContain(2);
    expect(s.errors[0]).toEqual({
      message: 'latest requires --tool fit|graph|sim',
      exitCode: 2,
      code: 'ambiguous-latest',
    });
  });

  it('renders the replayed result (non-JSON happy path)', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1'));
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () => {
      expect(currentScope()).toBeTruthy();
      return executeSessionShow({
        replayRegistry: makeReplayRegistry(),
        ref: 'FIT_1',
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      });
    });

    expect(s.rendered).toHaveLength(1);
    // Renders through the unified, envelope-driven session-replay view (not the
    // tool's live fit-done view), so fit/graph/sim replays look the same.
    expect(s.rendered[0]).toMatchObject({
      type: 'session-replay',
      session: { id: 'FIT_1', tool: 'fit' },
      envelope: { tool: 'fit' },
      fidelity: 'projection',
    });
  });

  it('carries the recipe onto the replay result when the session has one', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_R', Date.now(), { recipe: 'example' }));
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: makeReplayRegistry(),
        ref: 'FIT_R',
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.rendered[0]).toMatchObject({ type: 'session-replay', session: { recipe: 'example' } });
  });

  it('renders a structured error result when the session cannot be found (non-JSON)', async () => {
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: makeReplayRegistry(),
        ref: 'NOPE',
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.exitCodes).toContain(2);
    expect(s.rendered[0]).toMatchObject({ type: 'error' });
    expect(s.errors).toHaveLength(0);
  });

  it('surfaces a decode-error through emitError when the tool replay throws', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1'));
    const registry = new ToolRegistry();
    registry.register({
      metadata: { id: 'fit-throw', version: '0.0.0', description: 'test' },
      commands: [],
      sessionReplay: {
        tool: 'fit',
        replaySession: () => {
          throw new Error('corrupt payload');
        },
      },
    } satisfies Tool);
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: SessionReplayRegistry.fromTools(registry),
        ref: 'FIT_1',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.errors[0]).toEqual({ message: 'corrupt payload', exitCode: 2, code: 'decode-error' });
  });

  it('reports replay-unavailable through emitError when no tool contributes a replay', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1'));
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: SessionReplayRegistry.empty(),
        ref: 'FIT_1',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.errors[0]).toMatchObject({ code: 'replay-unavailable' });
  });

  it('defaults to an empty replay registry when none is supplied', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1'));
    const s = makeSinks();

    // replayRegistry omitted entirely → the `?? empty()` fallback path.
    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        ref: 'FIT_1',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.errors[0]).toMatchObject({ code: 'replay-unavailable' });
  });

  it('stringifies a non-Error thrown during decode', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1'));
    const registry = new ToolRegistry();
    registry.register({
      metadata: { id: 'fit-throw-str', version: '0.0.0', description: 'test' },
      commands: [],
      sessionReplay: {
        tool: 'fit',
        replaySession: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error decode branch.
          throw 'boom-string';
        },
      },
    } satisfies Tool);
    const s = makeSinks();

    const scope = makeTestScope({ datastore: () => ds });
    await withScope(scope, () =>
      executeSessionShow({
        replayRegistry: SessionReplayRegistry.fromTools(registry),
        ref: 'FIT_1',
        json: true,
        render: s.render,
        emitJson: s.emitJson,
        emitError: s.emitError,
        setExitCode: s.setExitCode,
      })
    );

    expect(s.errors[0]).toEqual({ message: 'boom-string', exitCode: 2, code: 'decode-error' });
  });
});
