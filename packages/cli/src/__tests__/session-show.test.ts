import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory } from '@opensip-tools/datastore';
import { SessionRepo } from '@opensip-tools/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeSessionShow } from '../commands/session-show.js';
import { SessionReplayRegistry } from '../session-replay-registry.js';

import type {
  CommandResult,
  FitDoneResult,
  SignalEnvelope,
  StoredSession,
  ToolSessionReplay,
} from '@opensip-tools/contracts';
import type { Tool, ToolSessionRecord } from '@opensip-tools/core';
import { ToolRegistry } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

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

describe('executeSessionShow', () => {
  it('emits a replay JSON wrapper for latest scoped by tool', async () => {
    const repo = new SessionRepo(ds);
    repo.save(makeSession('FIT_1', Date.now()));
    repo.save(makeSession('FIT_2', Date.now() + 1));
    const emitted: unknown[] = [];

    await executeSessionShow({
      datastore: ds,
      replayRegistry: makeReplayRegistry(),
      ref: 'latest',
      tool: 'fit',
      json: true,
      render: async () => {},
      emitJson: (value) => { emitted.push(value); },
      setExitCode: () => {},
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      session: { id: 'FIT_2', tool: 'fit' },
      fidelity: 'projection',
      envelope: { runId: 'FIT_2', tool: 'fit' },
    });
  });

  it('reports ambiguous latest without a tool', async () => {
    const emitted: unknown[] = [];
    let exitCode = 0;

    await executeSessionShow({
      datastore: ds,
      replayRegistry: makeReplayRegistry(),
      ref: 'latest',
      json: true,
      render: async () => {},
      emitJson: (value) => { emitted.push(value); },
      setExitCode: (code) => { exitCode = code; },
    });

    expect(exitCode).toBe(2);
    expect(emitted[0]).toEqual({
      error: 'latest requires --tool fit|graph|sim',
      reason: 'ambiguous-latest',
    });
  });
});
