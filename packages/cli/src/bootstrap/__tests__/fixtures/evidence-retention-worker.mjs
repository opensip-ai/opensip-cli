import { readFileSync, writeSync } from 'node:fs';
import process from 'node:process';

import { DataStoreFactory } from '@opensip-cli/datastore';
import { commitEvidenceBundle, SessionRepo } from '@opensip-cli/session-store';

import { enforceSessionRetention } from '../../../../dist/bootstrap/session-retention.js';

const mode = process.argv[2];
const datastorePath = process.argv[3];
const controlPath = process.argv[4];

if (mode === undefined || datastorePath === undefined || controlPath === undefined) {
  throw new Error(
    'Usage: evidence-retention-worker.mjs <commit|retention|purge> <datastore> <control-fifo>',
  );
}

const LOCK_POLICY = {
  waitMs: 30_000,
  staleMs: 120_000,
  heartbeatMs: 2000,
};

const silentLogger = {
  debug() {
    return;
  },
  info() {
    return;
  },
  warn() {
    return;
  },
  error() {
    return;
  },
};

function emit(event) {
  writeSync(1, `${JSON.stringify(event)}\n`, undefined, 'utf8');
}

function readCommand() {
  return readFileSync(controlPath, 'utf8').trim();
}

function waitAtBarrier(operation) {
  emit({ kind: 'locked', operation });
  const command = readCommand();
  if (command !== 'RELEASE') {
    throw new Error(`Expected RELEASE at ${operation}; received ${command}.`);
  }
}

function newSession(index) {
  return {
    id: `new-session-${index}`,
    tool: 'fit',
    startedAt: `2026-07-16T12:00:0${index}.000000Z`,
    completedAt: `2026-07-16T12:00:0${index}.250000Z`,
    cwd: '/fixture',
    recipe: 'agent-risk',
    score: 100,
    passed: true,
    runOutcome: 'passed',
    durationMs: 250,
    cliVersion: '0.7.0',
    engineVersion: '1.2.3',
    payload: { __version: 1, index },
  };
}

function newStep(index) {
  return {
    id: `new-step-${index}`,
    runId: 'new-run',
    logicalStepKey: `${index}:fit:fitness`,
    ordinal: index,
    attempt: 1,
    tool: 'fit',
    command: 'fitness',
    stableId: 'tool-fit',
    effectiveArgs: { recipe: 'agent-risk' },
    exitCode: 0,
    outcome: 'passed',
    durationMs: 250,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    evidence: { kind: 'signal-envelope', schemaVersion: 2 },
    sessionId: `new-session-${index}`,
  };
}

function commitInput() {
  return {
    sessions: [0, 1].map((index) => ({
      session: newSession(index),
      hostMetrics: { renderMs: 2, totalCommandMs: 300 },
    })),
    run: {
      run: {
        id: 'new-run',
        name: 'audit',
        source: 'built-in-suite',
        cwd: '/fixture',
        startedAt: '2026-07-16T12:00:00.000000Z',
        completedAt: '2026-07-16T12:00:02.000000Z',
        durationMs: 2000,
        exitCode: 0,
        aggregate: {
          steps: 2,
          passed: 2,
          failed: 0,
          faulted: 0,
          errors: 0,
          warnings: 0,
        },
        cliVersion: '0.7.0',
      },
      steps: [newStep(0), newStep(1)],
    },
    precondition() {
      waitAtBarrier('evidence-bundle.commit');
      return true;
    },
  };
}

function installLockBarrier(datastore, targetOperation) {
  const original = datastore.withWriteLock.bind(datastore);
  let pending = true;
  datastore.withWriteLock = (operation, fn) =>
    original(operation, () => {
      if (pending && operation === targetOperation) {
        pending = false;
        waitAtBarrier(operation);
      }
      return fn();
    });
}

const waitingOperations = new Set();
let datastore;

try {
  datastore = DataStoreFactory.open({
    backend: 'sqlite',
    path: datastorePath,
    lock: {
      policy: LOCK_POLICY,
      command: `concurrency-fixture:${mode}`,
      onLockEvent(event) {
        if (
          event.kind === 'acquire.wait' &&
          event.operation !== undefined &&
          !waitingOperations.has(event.operation)
        ) {
          waitingOperations.add(event.operation);
          emit({ kind: 'waiting', operation: event.operation });
        }
      },
    },
  });

  if (mode === 'retention') {
    installLockBarrier(datastore, 'session.prune_to_count_batch');
  } else if (mode === 'purge') {
    installLockBarrier(datastore, 'session.purge');
  } else if (mode !== 'commit') {
    throw new Error(`Unknown worker mode: ${mode}`);
  }

  emit({ kind: 'ready', mode });
  const command = readCommand();
  if (command !== 'GO') throw new Error(`Expected GO; received ${command}.`);

  let result;
  if (mode === 'commit') {
    result = commitEvidenceBundle(datastore, commitInput());
  } else if (mode === 'retention') {
    result = enforceSessionRetention(
      datastore,
      { keep: 2, maxAgeDays: 1, maxSizeMb: 0 },
      { now: Date.parse('2026-07-17T00:00:00.000Z'), logger: silentLogger },
    );
  } else {
    result = { deleted: new SessionRepo(datastore).purge(new Date('2026-07-17T00:00:00.000Z')) };
  }
  emit({ kind: 'result', mode, result });

  const closeCommand = readCommand();
  if (closeCommand !== 'CLOSE') {
    throw new Error(`Expected CLOSE; received ${closeCommand}.`);
  }
  datastore.close();
  datastore = undefined;
  emit({ kind: 'closed', mode });
} catch (error) {
  emit({
    kind: 'error',
    mode,
    message: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${error}\n`);
  datastore?.close();
  process.exitCode = 1;
}
