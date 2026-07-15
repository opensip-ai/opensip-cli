/**
 * @fileoverview Persistence journeys — native SQLite behavior.
 *
 * `sqlite-load` and `state-bounds` observe the shared, already-populated project
 * (`isolated: false`); the migration / cross-process / contention / interruption
 * journeys own a fresh project each (`isolated: true`) so the runner may
 * parallelize them. Every child runs through the injected measured-process port;
 * assertions target PUBLIC contract fields (exit codes, `data.type`, JSON
 * purity, on-disk state location) — never internal SQLite structures.
 *
 * The contention journey drives CONCURRENT persisting CLI processes and asserts
 * they all complete without corruption; its diagnostics are HARNESS evidence
 * (the shape of the concurrency it induced), not a customer behavior claim.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  pass,
  readJson,
  runCli,
} from '../journey-kit.mjs';

const cmdData = (parsed) => parsed?.data ?? parsed;

/** A generous upper bound on a single acceptance project's runtime state. */
const MAX_RUNTIME_STATE_BYTES = 128 * 1024 * 1024;
/** Bounded directory walk so a pathological tree cannot exhaust the harness. */
const MAX_WALK_ENTRIES = 4096;

const HISTORY_EXPECT = {
  exitCode: 0,
  json: (parsed) =>
    cmdData(parsed)?.type === 'history'
      ? []
      : [`sessions list type: expected "history", got ${JSON.stringify(cmdData(parsed)?.type)}`],
};

/** Initialize a fresh project in `cwd`; returns a failing outcome on error. */
async function initProject(context, cwd) {
  const result = await runCli(context, {
    args: ['init', '--language', 'typescript', '--json'],
    cwd,
  });
  if (result.timedOut || (result.status ?? 1) !== 0) {
    return {
      ok: false,
      outcome: fail('init-failed', [context.assert.diagnostic(result.stderrTail)]),
    };
  }
  return { ok: true };
}

/** Total byte size of a directory tree, bounded by entry count. */
function boundedDirSize(root) {
  let total = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) return { bytes: total, truncated: true };
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* skip unreadable file */
        }
      }
    }
  }
  return { bytes: total, truncated: false };
}

const sqliteLoadExecutor = async (context) => {
  // A `sessions list` that returns a well-formed history proves the native
  // better-sqlite3 backend loaded and opened the store on this host.
  const result = await runCli(context, { args: ['sessions', 'list', '--json'] });
  return assertCommand(context, result, HISTORY_EXPECT, 'sqlite-load-failed');
};

const firstOpenMigrationExecutor = async (context) => {
  const initialized = await initProject(context, context.paths.workRoot);
  if (!initialized.ok) return initialized.outcome;
  // First write into a never-opened store forces schema migration to run.
  const persisted = await runCli(context, {
    args: ['graph', '--json'],
    cwd: context.paths.workRoot,
  });
  if (persisted.timedOut || (persisted.status ?? 1) !== 0) {
    return fail('first-open-persist-failed', [context.assert.diagnostic(persisted.stderrTail)]);
  }
  // The migrated schema must now serve a read that reflects the persisted run.
  const listed = await runCli(context, {
    args: ['sessions', 'list', '--json'],
    cwd: context.paths.workRoot,
  });
  if (listed.timedOut || (listed.status ?? 1) !== 0)
    return fail('post-migration-read-failed', [context.assert.diagnostic(listed.stderrTail)]);
  const parsed = readJson(listed);
  if (!parsed.ok)
    return fail('post-migration-read-not-json', [context.assert.diagnostic(parsed.message)]);
  const sessions = cmdData(parsed.value)?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return fail('first-open-not-persisted', [
      context.assert.diagnostic('no session survived the first-open migration'),
    ]);
  }
  return pass();
};

const crossProcessReplayExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const initialized = await initProject(context, cwd);
  if (!initialized.ok) return initialized.outcome;
  // Process A persists a run.
  const persisted = await runCli(context, { args: ['graph', '--json'], cwd });
  if (persisted.timedOut || (persisted.status ?? 1) !== 0)
    return fail('persist-failed', [context.assert.diagnostic(persisted.stderrTail)]);
  // Process B lists it.
  const listed = await runCli(context, { args: ['sessions', 'list', '--json'], cwd });
  const listedParsed = readJson(listed);
  if (listed.timedOut || (listed.status ?? 1) !== 0 || !listedParsed.ok) {
    return fail('cross-process-list-failed', [context.assert.diagnostic(listed.stderrTail)]);
  }
  const id = (cmdData(listedParsed.value)?.sessions ?? []).find(
    (s) => typeof s?.id === 'string',
  )?.id;
  if (id === undefined)
    return fail('no-persisted-session', [
      context.assert.diagnostic('a persisted session was not visible to a second process'),
    ]);
  // Process C replays it.
  const shown = await runCli(context, { args: ['sessions', 'show', id, '--json'], cwd });
  return assertCommand(
    context,
    shown,
    {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        const failures = [];
        if (data?.type !== 'session-replay')
          failures.push(
            `replay.type: expected "session-replay", got ${JSON.stringify(data?.type)}`,
          );
        if (data?.session?.id !== id)
          failures.push(
            `replay.session.id: expected ${JSON.stringify(id)}, got ${JSON.stringify(data?.session?.id)}`,
          );
        return failures;
      },
    },
    'cross-process-replay-failed',
  );
};

const contentionRetryExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const initialized = await initProject(context, cwd);
  if (!initialized.ok) return initialized.outcome;
  // HARNESS EVIDENCE: induce write contention with concurrent persisting CLIs
  // against ONE project store; a correct SQLite retry path lets both complete
  // without corruption. This is the concurrency the harness created — not a
  // customer behavior claim.
  const [a, b] = await Promise.all([
    runCli(context, { args: ['graph', '--json'], cwd }),
    runCli(context, { args: ['fit', '--json', '--check', 'no-console-log'], cwd }),
  ]);
  const busy = [a, b].filter((r) => r.timedOut || (r.status ?? 1) > 1);
  if (busy.length > 0) {
    return fail('contention-not-retried', [
      context.assert.diagnostic(
        'harness: concurrent writers did not both complete under contention',
      ),
      context.assert.diagnostic(busy.map((r) => r.stderrTail).join(' | ')),
    ]);
  }
  // The store must remain readable after concurrent writers.
  const listed = await runCli(context, { args: ['sessions', 'list', '--json'], cwd });
  return assertCommand(context, listed, HISTORY_EXPECT, 'post-contention-read-failed');
};

const interruptedRecoveryExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const initialized = await initProject(context, cwd);
  if (!initialized.ok) return initialized.outcome;
  // Interrupt a persisting run with a hard, short timeout (the port terminates
  // the process tree). The store must survive an interrupted writer.
  const interrupted = await runCli(context, { args: ['graph', '--json'], cwd, timeoutMs: 50 });
  if (interrupted.cleanup.residualDescendants > 0) {
    return fail('interrupt-left-descendants', [
      context.assert.diagnostic(
        `interrupted run left ${interrupted.cleanup.residualDescendants} descendant(s)`,
      ),
    ]);
  }
  // Recovery: a fresh process must still open + read the store cleanly.
  const recovered = await runCli(context, { args: ['sessions', 'list', '--json'], cwd });
  return assertCommand(context, recovered, HISTORY_EXPECT, 'interrupted-recovery-failed');
};

const stateBoundsExecutor = async (context) => {
  // The shared project's runtime state must live UNDER the project (no escape)
  // and stay within a generous size bound.
  const runtimeDir = join(context.paths.workRoot, 'opensip-cli', '.runtime');
  if (!existsSync(runtimeDir)) {
    return fail('runtime-state-missing', [
      context.assert.diagnostic('no project-local .runtime directory was found'),
    ]);
  }
  const { bytes, truncated } = boundedDirSize(runtimeDir);
  if (truncated) {
    return fail('runtime-state-unbounded', [
      context.assert.diagnostic('runtime state exceeded the bounded directory walk'),
    ]);
  }
  if (bytes > MAX_RUNTIME_STATE_BYTES) {
    return fail('runtime-state-too-large', [
      context.assert.diagnostic(
        `runtime state is ${bytes} bytes (bound ${MAX_RUNTIME_STATE_BYTES})`,
      ),
    ]);
  }
  return pass();
};

export const persistenceJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'persistence.sqlite-load',
    category: 'persistence',
    value: {
      human: 'The database loads natively',
      agent: 'sessions list returns a history — SQLite loaded on this host',
    },
    steps: [{ label: 'run sessions list --json' }, { label: 'assert data.type=history, exit 0' }],
    executor: sqliteLoadExecutor,
  }),
  defineJourney({
    id: 'persistence.first-open-migration',
    category: 'persistence',
    value: {
      human: 'A new store migrates cleanly',
      agent: 'first write into a fresh store migrates and persists',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'persist a run (first open)' },
      { label: 'read it back' },
    ],
    executor: firstOpenMigrationExecutor,
  }),
  defineJourney({
    id: 'persistence.cross-process-replay',
    category: 'persistence',
    value: {
      human: 'Results persist across runs',
      agent: 'a run persisted by one process is replayable by another',
    },
    isolated: true,
    steps: [
      { label: 'persist (process A)' },
      { label: 'list (process B)' },
      { label: 'replay (process C)' },
    ],
    executor: crossProcessReplayExecutor,
  }),
  defineJourney({
    id: 'persistence.contention-retry',
    category: 'persistence',
    value: {
      human: 'Concurrent runs do not corrupt state',
      agent: 'concurrent writers both complete and the store stays readable',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'run two persisting CLIs concurrently (harness)' },
      { label: 'read the store back' },
    ],
    executor: contentionRetryExecutor,
  }),
  defineJourney({
    id: 'persistence.interrupted-recovery',
    category: 'persistence',
    value: {
      human: 'An interrupted run recovers',
      agent: 'a killed writer leaves no descendants and the store stays readable',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'interrupt a persisting run (short timeout)' },
      { label: 'recover with a fresh read' },
    ],
    executor: interruptedRecoveryExecutor,
  }),
  defineJourney({
    id: 'persistence.state-bounds',
    category: 'persistence',
    value: {
      human: 'State stays local and bounded',
      agent: 'runtime state lives under the project and stays within size bounds',
    },
    steps: [
      { label: 'locate opensip-cli/.runtime' },
      { label: 'assert it exists and is within bounds' },
    ],
    executor: stateBoundsExecutor,
  }),
]);
