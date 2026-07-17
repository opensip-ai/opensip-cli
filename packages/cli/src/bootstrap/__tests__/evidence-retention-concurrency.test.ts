import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import {
  commitEvidenceBundle,
  RunRepo,
  SessionRepo,
  type EvidenceBundleInput,
} from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StoredRun, StoredRunStep, StoredSession } from '@opensip-cli/contracts';

const WORKER = fileURLToPath(new URL('fixtures/evidence-retention-worker.mjs', import.meta.url));
const CLI_RETENTION_DIST = fileURLToPath(
  new URL('../../../dist/bootstrap/session-retention.js', import.meta.url),
);
const LOCK_POLICY = {
  waitMs: 30_000,
  staleMs: 120_000,
  heartbeatMs: 2000,
};
const EVENT_TIMEOUT_MS = 15_000;

type WorkerMode = 'commit' | 'retention' | 'purge';

interface WorkerEvent {
  readonly kind: 'ready' | 'locked' | 'waiting' | 'result' | 'closed' | 'error';
  readonly mode?: WorkerMode;
  readonly operation?: string;
  readonly message?: string;
  readonly result?: unknown;
}

interface PendingEvent {
  readonly predicate: (event: WorkerEvent) => boolean;
  readonly resolve: (event: WorkerEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerHarness {
  readonly mode: WorkerMode;
  readonly child: ChildProcessWithoutNullStreams;
  readonly controlPath: string;
  readonly events: WorkerEvent[];
  readonly pending: PendingEvent[];
  stderr: string;
  stdoutBuffer: string;
  closed: boolean;
}

let directory: string;
let datastore: DataStore;
let sessions: SessionRepo;
let runs: RunRepo;
let workers: WorkerHarness[];

function oldEvidence(): EvidenceBundleInput {
  const session: StoredSession = {
    id: 'old-session',
    tool: 'fit',
    startedAt: '2026-07-15T12:00:00.000000Z',
    completedAt: '2026-07-15T12:00:00.250000Z',
    cwd: '/fixture',
    score: 100,
    passed: true,
    runOutcome: 'passed',
    durationMs: 250,
    cliVersion: '0.7.0',
    payload: { __version: 1, fixture: 'old' },
  };
  const run: StoredRun = {
    id: 'old-run',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/fixture',
    startedAt: '2026-07-15T12:00:00.000000Z',
    completedAt: '2026-07-15T12:00:01.000000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 1,
      passed: 1,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    cliVersion: '0.7.0',
  };
  const step: StoredRunStep = {
    id: 'old-step',
    runId: run.id,
    logicalStepKey: '0:fit:fitness',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    effectiveArgs: {},
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    evidence: { kind: 'signal-envelope', schemaVersion: 2 },
    sessionId: session.id,
  };
  return {
    sessions: [{ session, hostMetrics: { totalCommandMs: 300 } }],
    run: { run, steps: [step] },
  };
}

function sortedSessionIds(): readonly string[] {
  return sessions
    .list()
    .map((session) => session.id)
    .sort();
}

function sortedRunIds(): readonly string[] {
  return runs
    .listRuns()
    .map((run) => run.id)
    .sort();
}

function stepLinks(runId: string): readonly string[] {
  return runs
    .listStepsForRun(runId)
    .map((step) => `${step.id}:${step.sessionId ?? 'none'}`)
    .sort();
}

function dispatchWorkerEvent(worker: WorkerHarness, event: WorkerEvent): void {
  const index = worker.pending.findIndex((pending) => pending.predicate(event));
  if (index === -1) {
    worker.events.push(event);
    return;
  }
  const [pending] = worker.pending.splice(index, 1);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  pending.resolve(event);
}

function parseWorkerOutput(worker: WorkerHarness, chunk: string): void {
  worker.stdoutBuffer += chunk;
  let newline = worker.stdoutBuffer.indexOf('\n');
  while (newline >= 0) {
    const line = worker.stdoutBuffer.slice(0, newline);
    worker.stdoutBuffer = worker.stdoutBuffer.slice(newline + 1);
    if (line.length > 0) {
      dispatchWorkerEvent(worker, JSON.parse(line) as WorkerEvent);
    }
    newline = worker.stdoutBuffer.indexOf('\n');
  }
}

function rejectPending(worker: WorkerHarness, message: string): void {
  for (const pending of worker.pending.splice(0)) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`${message}\n${worker.stderr}`.trim()));
  }
}

function startWorker(mode: WorkerMode, datastorePath: string): WorkerHarness {
  const controlPath = join(directory, `control-${mode}-${String(workers.length)}.fifo`);
  execFileSync('mkfifo', [controlPath]);
  const child = spawn(process.execPath, [WORKER, mode, datastorePath, controlPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const worker: WorkerHarness = {
    mode,
    child,
    controlPath,
    events: [],
    pending: [],
    stderr: '',
    stdoutBuffer: '',
    closed: false,
  };
  workers.push(worker);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => parseWorkerOutput(worker, chunk));
  child.stderr.on('data', (chunk: string) => {
    worker.stderr += chunk;
  });
  child.once('close', (code, signal) => {
    worker.closed = true;
    rejectPending(
      worker,
      `${mode} worker closed before the expected event (code=${String(code)}, signal=${String(signal)})`,
    );
  });
  return worker;
}

function waitForEvent(
  worker: WorkerHarness,
  predicate: (event: WorkerEvent) => boolean,
  description: string,
): Promise<WorkerEvent> {
  const index = worker.events.findIndex(predicate);
  if (index >= 0) {
    const [event] = worker.events.splice(index, 1);
    if (event !== undefined) return Promise.resolve(event);
  }
  if (worker.closed) {
    return Promise.reject(
      new Error(`${worker.mode} worker already closed while awaiting ${description}`),
    );
  }
  return new Promise((resolve, reject) => {
    const pending: PendingEvent = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        const pendingIndex = worker.pending.indexOf(pending);
        if (pendingIndex >= 0) worker.pending.splice(pendingIndex, 1);
        reject(
          new Error(
            `Timed out awaiting ${description} from ${worker.mode} worker.\n${worker.stderr}`.trim(),
          ),
        );
      }, EVENT_TIMEOUT_MS),
    };
    worker.pending.push(pending);
  });
}

function event(
  worker: WorkerHarness,
  kind: WorkerEvent['kind'],
  operation?: string,
): Promise<WorkerEvent> {
  return waitForEvent(
    worker,
    (candidate) =>
      candidate.kind === kind && (operation === undefined || candidate.operation === operation),
    operation === undefined ? kind : `${kind}:${operation}`,
  );
}

function send(worker: WorkerHarness, command: 'GO' | 'RELEASE' | 'CLOSE'): void {
  writeFileSync(worker.controlPath, `${command}\n`, 'utf8');
}

async function closeWorker(worker: WorkerHarness): Promise<void> {
  const closedEvent = event(worker, 'closed');
  send(worker, 'CLOSE');
  await closedEvent;
  await new Promise<void>((resolve, reject) => {
    if (worker.closed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${worker.mode} worker to exit.`));
    }, EVENT_TIMEOUT_MS);
    worker.child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else {
        reject(
          new Error(
            `${worker.mode} worker failed (code=${String(code)}, signal=${String(signal)}).\n${worker.stderr}`.trim(),
          ),
        );
      }
    });
  });
}

beforeEach(() => {
  if (!existsSync(CLI_RETENTION_DIST)) {
    throw new Error(
      `Built retention module missing at ${CLI_RETENTION_DIST}. Run pnpm build before this concurrency test.`,
    );
  }
  directory = mkdtempSync(join(tmpdir(), 'opensip-evidence-retention-'));
  const datastorePath = join(directory, 'datastore.sqlite');
  datastore = DataStoreFactory.open({
    backend: 'sqlite',
    path: datastorePath,
    lock: { policy: LOCK_POLICY, command: 'concurrency-test-reader' },
  });
  sessions = new SessionRepo(datastore);
  runs = new RunRepo(datastore);
  workers = [];
  expect(commitEvidenceBundle(datastore, oldEvidence()).status).toBe('committed');
});

afterEach(async () => {
  const shutdowns = workers.map(
    (worker) =>
      new Promise<void>((resolve) => {
        if (worker.closed) resolve();
        else worker.child.once('close', () => resolve());
      }),
  );
  for (const worker of workers) {
    if (!worker.closed) worker.child.kill('SIGKILL');
  }
  await Promise.all(shutdowns);
  datastore.close();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'file-backed evidence retention serialization',
  () => {
    it('never exposes an evidence-bundle prefix while bounded retention waits on the same lock', async () => {
      const datastorePath = join(directory, 'datastore.sqlite');
      const commit = startWorker('commit', datastorePath);
      const retention = startWorker('retention', datastorePath);
      await Promise.all([event(commit, 'ready'), event(retention, 'ready')]);

      send(commit, 'GO');
      await event(commit, 'locked', 'evidence-bundle.commit');
      send(retention, 'GO');
      await event(retention, 'waiting', 'session.prune_to_count_batch');

      expect(sortedSessionIds()).toEqual(['old-session']);
      expect(sortedRunIds()).toEqual(['old-run']);
      expect(stepLinks('old-run')).toEqual(['old-step:old-session']);

      const commitResult = event(commit, 'result');
      const retentionLocked = event(retention, 'locked', 'session.prune_to_count_batch');
      send(commit, 'RELEASE');
      const committed = await commitResult;
      expect(committed.result).toMatchObject({
        status: 'committed',
        sessionIds: ['new-session-0', 'new-session-1'],
        runId: 'new-run',
        sessionCount: 2,
        stepCount: 2,
      });
      await retentionLocked;

      expect(sortedSessionIds()).toEqual(['new-session-0', 'new-session-1', 'old-session']);
      expect(sortedRunIds()).toEqual(['new-run', 'old-run']);
      expect(stepLinks('new-run')).toEqual([
        'new-step-0:new-session-0',
        'new-step-1:new-session-1',
      ]);

      const retentionResult = event(retention, 'result');
      send(retention, 'RELEASE');
      const retained = await retentionResult;
      expect(retained.result).toMatchObject({
        sessionsDeleted: 1,
        runsDeleted: 1,
      });

      expect(sortedSessionIds()).toEqual(['new-session-0', 'new-session-1']);
      expect(sortedRunIds()).toEqual(['new-run']);
      expect(stepLinks('new-run')).toEqual([
        'new-step-0:new-session-0',
        'new-step-1:new-session-1',
      ]);

      await closeWorker(commit);
      await closeWorker(retention);
    });

    it('serializes explicit Session purge with an evidence commit and nulls links atomically', async () => {
      const datastorePath = join(directory, 'datastore.sqlite');
      const purge = startWorker('purge', datastorePath);
      const commit = startWorker('commit', datastorePath);
      await Promise.all([event(purge, 'ready'), event(commit, 'ready')]);

      send(purge, 'GO');
      await event(purge, 'locked', 'session.purge');
      send(commit, 'GO');
      await event(commit, 'waiting', 'evidence-bundle.commit');

      expect(sortedSessionIds()).toEqual(['old-session']);
      expect(sortedRunIds()).toEqual(['old-run']);
      expect(stepLinks('old-run')).toEqual(['old-step:old-session']);

      const purgeResult = event(purge, 'result');
      const commitLocked = event(commit, 'locked', 'evidence-bundle.commit');
      send(purge, 'RELEASE');
      const purged = await purgeResult;
      expect(purged.result).toEqual({ deleted: 1 });
      await commitLocked;

      expect(sortedSessionIds()).toEqual([]);
      expect(sortedRunIds()).toEqual(['old-run']);
      expect(stepLinks('old-run')).toEqual(['old-step:none']);

      const commitResult = event(commit, 'result');
      send(commit, 'RELEASE');
      const committed = await commitResult;
      expect(committed.result).toMatchObject({
        status: 'committed',
        sessionIds: ['new-session-0', 'new-session-1'],
        runId: 'new-run',
      });

      expect(sortedSessionIds()).toEqual(['new-session-0', 'new-session-1']);
      expect(sortedRunIds()).toEqual(['new-run', 'old-run']);
      expect(stepLinks('old-run')).toEqual(['old-step:none']);
      expect(stepLinks('new-run')).toEqual([
        'new-step-0:new-session-0',
        'new-step-1:new-session-1',
      ]);

      await closeWorker(purge);
      await closeWorker(commit);
    });
  },
);
