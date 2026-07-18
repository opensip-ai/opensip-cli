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
 * The contention journeys hold a real SQLite write transaction with the
 * installed candidate's native dependency, then observe the installed CLI's
 * datastore lock before releasing or interrupting it. Their synchronization
 * diagnostics are HARNESS evidence, not a customer behavior claim.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { readBoundedOwnedTextFile } from '../bounded-owned-file.mjs';
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
const SQLITE_PROBE_WAIT_MS = 10_000;
// Engagement bound for the short-wait writer: it must SETTLE (fail its bounded
// lock acquisition, or terminally misbehave) inside this window while the
// native transaction is still held. Sized against the shipped datastore's
// SQLite `busy_timeout = 5000` (packages/datastore/src/backends/shared.ts):
// the blocked owner survives ~5s of native contention, so
// stable-observation (150ms) + this bound + the unchanged-lock recheck must
// stay comfortably under it.
const SQLITE_EXHAUSTION_SETTLE_MS = 3500;
const SQLITE_PROBE_PROCESS_TIMEOUT_MS = 15_000;
const SQLITE_WRITE_LOCK_STABLE_MS = 150;
const SQLITE_COMPETITOR_BARRIER_MS = 1250;
const STATE_LOCK_EXHAUST_WAIT_MS = 250;
const SQLITE_PROBE_SOURCE = String.raw`
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [mode, entrypoint, dbPath, readyMarker, releaseMarker, waitText] = process.argv.slice(2);
const waitMs = Number(waitText);
if (mode !== 'hold-write-transaction') {
  throw new Error('unknown sqlite acceptance probe mode');
}
if (!Number.isSafeInteger(waitMs) || waitMs <= 0) {
  throw new Error('sqlite acceptance probe wait must be a positive integer');
}
const rootRequire = createRequire(entrypoint);
const datastoreEntry = rootRequire.resolve('@opensip-cli/datastore');
const datastoreRequire = createRequire(datastoreEntry);
const loaded = datastoreRequire('better-sqlite3');
const Database = loaded.default ?? loaded;
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec('BEGIN IMMEDIATE');
db.exec('CREATE TABLE IF NOT EXISTS opensip_acceptance_probe (id INTEGER PRIMARY KEY, mode TEXT NOT NULL)');
db.prepare('INSERT INTO opensip_acceptance_probe(mode) VALUES (?)').run(mode);
const readyTemp = readyMarker + '.tmp-' + process.pid;
writeFileSync(readyTemp, JSON.stringify({ phase: 'transaction-active', walPresent: existsSync(dbPath + '-wal') }), { flag: 'wx' });
renameSync(readyTemp, readyMarker);
const deadline = Date.now() + waitMs;
while (!existsSync(releaseMarker) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!existsSync(releaseMarker)) {
  db.exec('ROLLBACK');
  db.close();
  throw new Error('sqlite acceptance holder was not released before its deadline');
}
db.exec('ROLLBACK');
db.close();
process.stdout.write(JSON.stringify({ ok: true, phase: 'contention-released' }) + '\n');
`;

const HISTORY_EXPECT = {
  exitCode: 0,
  json: (parsed) =>
    cmdData(parsed)?.type === 'history'
      ? []
      : [`sessions list type: expected "history", got ${JSON.stringify(cmdData(parsed)?.type)}`],
};

/** Initialize a fresh project in `cwd`; returns a failing outcome on error. */
export async function initProject(context, cwd) {
  try {
    const sourceDir = join(cwd, 'src');
    mkdirSync(sourceDir, { recursive: true });
    const tsconfig = join(cwd, 'tsconfig.json');
    const source = join(sourceDir, 'index.ts');
    if (!existsSync(tsconfig)) {
      writeFileSync(
        tsconfig,
        `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    }
    if (!existsSync(source)) {
      writeFileSync(source, 'export const persistenceProbe = 1;\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
  } catch (error) {
    return {
      ok: false,
      outcome: fail('persistence-project-seed-failed', [
        context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
      ]),
    };
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observeProcess(promise) {
  const observation = {
    settled: false,
    result: null,
    error: null,
    promise: null,
  };
  observation.promise = Promise.resolve(promise).then(
    (result) => {
      observation.settled = true;
      observation.result = result;
      return result;
    },
    (error) => {
      observation.settled = true;
      observation.error = error;
      return null;
    },
  );
  return observation;
}

async function waitForMarker(path, observations, timeoutMs = SQLITE_PROBE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    if (observations.some((observation) => observation.settled)) return false;
    await delay(10);
  }
  return existsSync(path);
}

function markerHasPhase(path, phase, root) {
  try {
    const result = readBoundedOwnedTextFile({
      path,
      root,
      maxBytes: 1024,
      reasonPrefix: 'sqlite-marker',
      requireNonEmpty: true,
    });
    return result.ok && JSON.parse(result.text)?.phase === phase;
  } catch {
    return false;
  }
}

function readWriteLockIdentity(path, root) {
  try {
    const result = readBoundedOwnedTextFile({
      path,
      root,
      maxBytes: 4096,
      reasonPrefix: 'sqlite-write-lock',
      requireNonEmpty: true,
    });
    if (!result.ok) return null;
    const value = JSON.parse(result.text);
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.command !== 'graph'
    ) {
      return null;
    }
    return {
      ownerToken: value.ownerToken,
      pid: value.pid,
      command: value.command,
    };
  } catch {
    return null;
  }
}

async function waitForStableWriteLock(
  path,
  root,
  holder,
  writer,
  timeoutMs = SQLITE_PROBE_WAIT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let identity = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (holder.settled || writer.settled) return null;
    const current = readWriteLockIdentity(path, root);
    if (
      current !== null &&
      identity !== null &&
      current.ownerToken === identity.ownerToken &&
      current.pid === identity.pid
    ) {
      if (Date.now() - stableSince >= SQLITE_WRITE_LOCK_STABLE_MS) return current;
    } else {
      identity = current;
      stableSince = current === null ? 0 : Date.now();
    }
    await delay(10);
  }
  return null;
}

async function waitForUnchangedWriteLock(
  path,
  root,
  expected,
  observations,
  timeoutMs = SQLITE_PROBE_WAIT_MS,
  stableMs = SQLITE_WRITE_LOCK_STABLE_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (observations.some((observation) => observation.settled)) return false;
    const current = readWriteLockIdentity(path, root);
    if (current === null) {
      // A heartbeat replaces the lockfile atomically. A bounded read can race
      // that rename, so treat a transient absence as "not stable yet" rather
      // than as proof that ownership changed.
      stableSince = 0;
      await delay(10);
      continue;
    }
    if (current.ownerToken !== expected.ownerToken || current.pid !== expected.pid) return false;
    if (stableSince === 0) stableSince = Date.now();
    if (Date.now() - stableSince >= stableMs) return true;
    await delay(10);
  }
  return false;
}

async function waitForSettled(observation, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observation.settled) return true;
    await delay(10);
  }
  return observation.settled;
}

function releaseSqliteHolder(path, lockIdentity) {
  try {
    writeFileSync(path, JSON.stringify({ phase: 'release', ownerToken: lockIdentity.ownerToken }), {
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function probeInputs(context, cwd) {
  const nodeArgv = context.toolchain?.node?.argv;
  const entrypoint = context.installed?.jsEntrypoint?.script;
  const dbPath = join(cwd, 'opensip-cli', '.runtime', 'datastore.sqlite');
  if (!Array.isArray(nodeArgv) || nodeArgv.length === 0) {
    return { ok: false, reasonCode: 'node-toolchain-unavailable' };
  }
  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    return { ok: false, reasonCode: 'installed-entrypoint-missing' };
  }
  if (!existsSync(dbPath)) return { ok: false, reasonCode: 'sqlite-store-missing' };
  let probeDir;
  try {
    probeDir = mkdtempSync(join(cwd, '.opensip-acceptance-sqlite-'));
  } catch {
    return { ok: false, reasonCode: 'sqlite-probe-directory-failed' };
  }
  const script = join(probeDir, 'sqlite-acceptance-probe.mjs');
  try {
    writeFileSync(script, SQLITE_PROBE_SOURCE, { flag: 'wx', mode: 0o600 });
  } catch {
    return { ok: false, reasonCode: 'sqlite-probe-write-failed' };
  }
  return { ok: true, nodeArgv, entrypoint, dbPath, probeDir, script };
}

function cleanProcess(result, allowedStatuses = [0]) {
  return (
    result !== null &&
    result !== undefined &&
    allowedStatuses.includes(result.status) &&
    result.signal === null &&
    result.timedOut !== true &&
    result.cancelled !== true &&
    result.cleanup?.residualDescendants === 0
  );
}

function isBoundedStateLockExhaustion(result) {
  if (
    result === null ||
    result === undefined ||
    !Number.isSafeInteger(result.status) ||
    result.status <= 0 ||
    result.signal !== null ||
    result.timedOut === true ||
    result.cancelled === true ||
    result.outputTruncated === true ||
    result.cleanup?.residualDescendants !== 0
  ) {
    return false;
  }
  const parsed = readJson(result);
  if (!parsed.ok) return false;
  const value = parsed.value;
  const events = value?.diagnostics?.events;
  return (
    value?.kind === 'command.error' &&
    value?.status === 'error' &&
    value?.exitCode === result.status &&
    Array.isArray(value?.errors) &&
    value.errors.length > 0 &&
    Array.isArray(events) &&
    events.some(
      (event) =>
        event?.phase === 'persist' &&
        event?.message === 'state.lock.acquire.timeout' &&
        event?.data?.resource === 'datastore' &&
        event?.data?.waitMs === STATE_LOCK_EXHAUST_WAIT_MS,
    )
  );
}

async function ensureReadableStore(context, cwd) {
  const listed = await runCli(context, {
    args: ['sessions', 'list', '--json'],
    cwd,
  });
  if (!cleanProcess(listed)) {
    return {
      ok: false,
      outcome: fail('sqlite-store-open-failed', [context.assert.diagnostic(listed.stderrTail)]),
    };
  }
  const parsed = readJson(listed);
  if (!parsed.ok || cmdData(parsed.value)?.type !== 'history') {
    return {
      ok: false,
      outcome: fail('sqlite-store-history-invalid', [
        context.assert.diagnostic(
          parsed.ok ? 'sessions list did not return history' : parsed.message,
        ),
      ]),
    };
  }
  const sessions = cmdData(parsed.value)?.sessions;
  if (!Array.isArray(sessions)) {
    return {
      ok: false,
      outcome: fail('sqlite-store-history-invalid', [
        context.assert.diagnostic('sessions list history did not contain a sessions array'),
      ]),
    };
  }
  return {
    ok: true,
    sessionIds: new Set(
      sessions
        .map((session) => session?.id)
        .filter((id) => typeof id === 'string' && id.length > 0),
    ),
  };
}

function publicGraphReplayFailures(data, expectedId) {
  const failures = [];
  if (data?.session?.id !== expectedId) {
    failures.push(
      `replay.session.id: expected ${JSON.stringify(expectedId)}, got ${JSON.stringify(data?.session?.id)}`,
    );
  }
  if (data?.session?.tool !== 'graph') {
    failures.push(
      `replay.session.tool: expected "graph", got ${JSON.stringify(data?.session?.tool)}`,
    );
  }
  if (data?.fidelity !== 'projection') {
    failures.push(`replay.fidelity: expected "projection", got ${JSON.stringify(data?.fidelity)}`);
  }
  if (data?.envelope?.schemaVersion !== 2 || data?.envelope?.tool !== 'graph') {
    failures.push('replay.envelope: expected a schemaVersion 2 graph envelope');
  }
  return failures;
}

async function verifyNewGraphSessions(context, cwd, priorSessionIds, reasonPrefix, expectedCount) {
  const listed = await runCli(context, {
    args: ['sessions', 'list', '--json'],
    cwd,
  });
  if (!cleanProcess(listed)) {
    return {
      ok: false,
      outcome: fail(`${reasonPrefix}-read-failed`, [context.assert.diagnostic(listed.stderrTail)]),
    };
  }
  const parsed = readJson(listed);
  const sessions = parsed.ok ? cmdData(parsed.value)?.sessions : null;
  const newSessions = Array.isArray(sessions)
    ? sessions.filter(
        (candidate) =>
          candidate?.tool === 'graph' &&
          typeof candidate.id === 'string' &&
          !priorSessionIds.has(candidate.id),
      )
    : [];
  if (newSessions.length !== expectedCount) {
    return {
      ok: false,
      outcome: fail(`${reasonPrefix}-session-missing`, [
        context.assert.diagnostic(
          `expected exactly ${expectedCount} new graph session(s), observed ${newSessions.length}`,
        ),
      ]),
    };
  }

  const sessionIds = [];
  for (const session of newSessions.slice(0, expectedCount)) {
    const shown = await runCli(context, {
      args: ['sessions', 'show', session.id, '--json'],
      cwd,
    });
    const replay = assertCommand(
      context,
      shown,
      {
        exitCode: 0,
        json: (value) => {
          const data = cmdData(value);
          return publicGraphReplayFailures(data, session.id);
        },
      },
      `${reasonPrefix}-replay-failed`,
    );
    if (replay.status !== 'pass') return { ok: false, outcome: replay };
    sessionIds.push(session.id);
  }
  return { ok: true, sessionIds };
}

async function verifyNewGraphSession(context, cwd, priorSessionIds, reasonPrefix) {
  const result = await verifyNewGraphSessions(context, cwd, priorSessionIds, reasonPrefix, 1);
  return result.ok
    ? { ok: true, sessionId: result.sessionIds[0] }
    : { ok: false, outcome: result.outcome };
}

/** Total byte size of a directory tree, bounded by entry count. */
function isUnder(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export function boundedDirSize(root) {
  let total = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return { bytes: total, truncated: false, unsafe: true };
    }
    for (const dirent of dirents) {
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) {
        return { bytes: total, truncated: true, unsafe: false };
      }
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          return { bytes: total, truncated: false, unsafe: true };
        }
      } else {
        return { bytes: total, truncated: false, unsafe: true };
      }
    }
  }
  return { bytes: total, truncated: false, unsafe: false };
}

const sqliteLoadExecutor = async (context) => {
  // A `sessions list` that returns a well-formed history proves the native
  // better-sqlite3 backend loaded and opened the store on this host.
  const result = await runCli(context, {
    args: ['sessions', 'list', '--json'],
  });
  return assertCommand(context, result, HISTORY_EXPECT, 'sqlite-load-failed');
};

const firstOpenMigrationExecutor = async (context) => {
  const initialized = await initProject(context, context.paths.workRoot);
  if (!initialized.ok) return initialized.outcome;
  // First write into a never-opened store forces schema migration to run.
  const persisted = await runCli(context, {
    args: ['graph'],
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
  const persisted = await runCli(context, { args: ['graph'], cwd });
  if (persisted.timedOut || (persisted.status ?? 1) !== 0)
    return fail('persist-failed', [context.assert.diagnostic(persisted.stderrTail)]);
  // Process B lists it.
  const listed = await runCli(context, {
    args: ['sessions', 'list', '--json'],
    cwd,
  });
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
  const shown = await runCli(context, {
    args: ['sessions', 'show', id, '--json'],
    cwd,
  });
  return assertCommand(
    context,
    shown,
    {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return publicGraphReplayFailures(data, id);
      },
    },
    'cross-process-replay-failed',
  );
};

/**
 * Deterministically force an installed CLI writer to wait on an active SQLite
 * transaction. The helper resolves better-sqlite3 from the installed candidate,
 * then holds BEGIN IMMEDIATE until the journey writes the release marker (or
 * the SQLITE_PROBE_WAIT_MS deadline expires, whichever comes first).
 */
export async function runSqliteContentionProbe(context, cwd) {
  const readable = await ensureReadableStore(context, cwd);
  if (!readable.ok) return readable.outcome;
  const probe = probeInputs(context, cwd);
  if (!probe.ok) return fail(probe.reasonCode, []);
  const readyMarker = join(probe.probeDir, 'ready.json');
  const releaseMarker = join(probe.probeDir, 'release.json');
  const writeLock = `${probe.dbPath}.write.lock`;
  if (existsSync(writeLock) || existsSync(readyMarker) || existsSync(releaseMarker)) {
    return fail('contention-probe-state-not-clean', []);
  }
  const holderController = new AbortController();
  const ownerController = new AbortController();
  const exhaustionController = new AbortController();
  const waiterController = new AbortController();
  const holder = observeProcess(
    context.process.run({
      argv: [
        ...probe.nodeArgv,
        probe.script,
        'hold-write-transaction',
        probe.entrypoint,
        probe.dbPath,
        readyMarker,
        releaseMarker,
        String(SQLITE_PROBE_WAIT_MS),
      ],
      cwd,
      signal: holderController.signal,
      timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
    }),
  );
  let owner = null;
  let exhaustion = null;
  let waiter = null;
  let lockIdentity = null;
  let holderReleased = false;
  let completed = false;
  try {
    if (!(await waitForMarker(readyMarker, [holder]))) {
      return fail('contention-lock-not-acquired', [
        context.assert.diagnostic(
          'the installed SQLite helper never entered its write transaction',
        ),
      ]);
    }
    if (!markerHasPhase(readyMarker, 'transaction-active', cwd)) {
      return fail('contention-marker-invalid', []);
    }

    owner = observeProcess(
      runCli(context, {
        args: ['graph'],
        cwd,
        signal: ownerController.signal,
        timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
      }),
    );

    // The first normal-policy writer is the only CLI process in flight here,
    // so observing one stable outer lock proves it owns the contention head
    // start. Launching competitors only after that proof prevents scheduler
    // timing from letting the short-wait process become the lock owner.
    lockIdentity = await waitForStableWriteLock(writeLock, cwd, holder, owner);
    if (lockIdentity === null) {
      return fail('contention-not-observed', [
        context.assert.diagnostic(
          'the head-start CLI writer did not retain a stable datastore lock while SQLite was write-locked',
        ),
      ]);
    }

    exhaustion = observeProcess(
      runCli(context, {
        args: ['graph', '--json'],
        cwd,
        env: { OPENSIP_STATE_LOCK_WAIT_MS: String(STATE_LOCK_EXHAUST_WAIT_MS) },
        signal: exhaustionController.signal,
        timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
      }),
    );
    // The waiter keeps the DEFAULT lock policy deliberately: it proves the
    // shipped queue behavior, and with the engagement-driven release below the
    // lock frees well inside the CI default wait (release ≤ settle bound +
    // recheck after the owner locked; the waiter's own wait stays ~2s worst
    // case on a slow VM).
    waiter = observeProcess(
      runCli(context, {
        args: ['graph'],
        cwd,
        signal: waiterController.signal,
        timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
      }),
    );

    // Engagement proof: the short-wait writer must SETTLE while the owner
    // still holds the datastore lock and the native transaction is active. A
    // launch-order barrier alone cannot prove engagement — on a slow VM the
    // short-wait process can still be in Node startup when a time-based
    // barrier expires; it then arrives after release, succeeds against a free
    // lock, and misreports the CLI's bounded timeout as broken. (That exact
    // sequence kept the qualification lane red: every process exit 0, reason
    // `contention-retry-not-exhausted`, on 3-core virtual runners whose
    // installed-CLI startup exceeded the old fixed barrier.)
    if (!(await waitForSettled(exhaustion, SQLITE_EXHAUSTION_SETTLE_MS))) {
      holderReleased = releaseSqliteHolder(releaseMarker, lockIdentity);
      return fail('contention-competitor-not-engaged', [
        context.assert.diagnostic(
          'the short-wait CLI writer did not settle inside the contention window — infrastructure timing (slow spawn/startup on this host), not candidate lock behavior',
        ),
      ]);
    }

    // The owner must still hold the SAME lock after the competitor settled —
    // this converts "the short-wait writer settled" into "the short-wait
    // writer settled UNDER contention", while the queued waiter remains in
    // flight behind the unchanged owner. The stability window here is the
    // short SQLITE_WRITE_LOCK_STABLE_MS: engagement is already proven above,
    // and the total native-hold time must stay inside the owner's SQLite
    // busy_timeout.
    if (
      !(await waitForUnchangedWriteLock(
        writeLock,
        cwd,
        lockIdentity,
        [holder, owner, waiter],
        SQLITE_COMPETITOR_BARRIER_MS,
        SQLITE_WRITE_LOCK_STABLE_MS,
      ))
    ) {
      return fail('contention-waiter-not-observed', [
        context.assert.diagnostic(
          'a queued CLI writer did not remain pending behind the unchanged datastore lock owner',
        ),
      ]);
    }

    holderReleased = releaseSqliteHolder(releaseMarker, lockIdentity);
    if (!holderReleased) return fail('contention-release-failed', []);

    const [holderResult, ownerResult, exhaustionResult, waiterResult] = await Promise.all([
      holder.promise,
      owner.promise,
      exhaustion.promise,
      waiter.promise,
    ]);
    if (!isBoundedStateLockExhaustion(exhaustionResult)) {
      return fail('contention-retry-not-exhausted', [
        context.assert.diagnostic(
          'a short-wait CLI writer did not report the bounded datastore lock timeout',
        ),
        context.assert.diagnostic(exhaustionResult?.stderrTail ?? ''),
      ]);
    }
    if (!cleanProcess(holderResult) || !cleanProcess(ownerResult) || !cleanProcess(waiterResult)) {
      return fail('contention-not-retried', [
        context.assert.diagnostic(
          'the blocked and queued CLI writers did not resume cleanly after lock release',
        ),
        context.assert.diagnostic(
          waiterResult?.stderrTail ?? ownerResult?.stderrTail ?? holderResult?.stderrTail ?? '',
        ),
      ]);
    }
    if (existsSync(writeLock)) {
      return fail('contention-write-lock-not-released', []);
    }

    const replay = await verifyNewGraphSessions(
      context,
      cwd,
      readable.sessionIds,
      'post-contention',
      2,
    );
    if (!replay.ok) return replay.outcome;
    completed = true;
    return pass([
      context.assert.diagnostic(
        `harness: bounded lock exhaustion and queued recovery were observed; graph sessions ${replay.sessionIds.join(', ')} are replayable`,
      ),
    ]);
  } finally {
    if (!completed && waiter !== null && !waiter.settled) waiterController.abort();
    if (!completed && exhaustion !== null && !exhaustion.settled) {
      exhaustionController.abort();
    }
    if (!completed && owner !== null && !owner.settled) ownerController.abort();
    if (!holderReleased) {
      holderReleased = releaseSqliteHolder(
        releaseMarker,
        lockIdentity ?? { ownerToken: 'harness-cleanup' },
      );
    }
    if (!holderReleased && !holder.settled) holderController.abort();
    await Promise.all([
      holder.promise,
      ...(owner === null ? [] : [owner.promise]),
      ...(exhaustion === null ? [] : [exhaustion.promise]),
      ...(waiter === null ? [] : [waiter.promise]),
    ]);
  }
}

/** Interrupt the installed CLI only after its write is observably blocked in SQLite. */
export async function runInterruptedSqliteProbe(context, cwd) {
  const readable = await ensureReadableStore(context, cwd);
  if (!readable.ok) return readable.outcome;
  const probe = probeInputs(context, cwd);
  if (!probe.ok) return fail(probe.reasonCode, []);
  const readyMarker = join(probe.probeDir, 'ready.json');
  const releaseMarker = join(probe.probeDir, 'release.json');
  const writeLock = `${probe.dbPath}.write.lock`;
  if (existsSync(writeLock) || existsSync(readyMarker) || existsSync(releaseMarker)) {
    return fail('interrupt-probe-state-not-clean', []);
  }
  const holderController = new AbortController();
  const writerController = new AbortController();
  const holder = observeProcess(
    context.process.run({
      argv: [
        ...probe.nodeArgv,
        probe.script,
        'hold-write-transaction',
        probe.entrypoint,
        probe.dbPath,
        readyMarker,
        releaseMarker,
        String(SQLITE_PROBE_WAIT_MS),
      ],
      cwd,
      signal: holderController.signal,
      timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
    }),
  );
  let writer = null;
  let lockIdentity = null;
  let holderReleased = false;
  let completed = false;
  try {
    if (!(await waitForMarker(readyMarker, [holder]))) {
      return fail('interrupt-holder-not-active', [
        context.assert.diagnostic('the SQLite helper never entered its write transaction'),
      ]);
    }
    if (!markerHasPhase(readyMarker, 'transaction-active', cwd)) {
      return fail('interrupt-marker-invalid', []);
    }

    writer = observeProcess(
      runCli(context, {
        args: ['graph'],
        cwd,
        signal: writerController.signal,
        timeoutMs: SQLITE_PROBE_PROCESS_TIMEOUT_MS,
      }),
    );
    lockIdentity = await waitForStableWriteLock(writeLock, cwd, holder, writer);
    if (lockIdentity === null) {
      return fail('interrupt-write-not-active', [
        context.assert.diagnostic(
          'the CLI did not retain its datastore write lock while SQLite was write-locked',
        ),
      ]);
    }

    writerController.abort();
    const interruptedResult = await writer.promise;
    if (
      interruptedResult?.cancelled !== true ||
      interruptedResult.timedOut === true ||
      interruptedResult.cleanup?.residualDescendants !== 0
    ) {
      return fail('interrupt-not-cleanly-observed', [
        context.assert.diagnostic(
          'the blocked CLI writer was not cancelled with zero observed residual descendants',
        ),
      ]);
    }
    const interruptedLock = readWriteLockIdentity(writeLock, cwd);
    if (
      (interruptedLock === null && existsSync(writeLock)) ||
      (interruptedLock !== null &&
        (interruptedLock.ownerToken !== lockIdentity.ownerToken ||
          interruptedLock.pid !== lockIdentity.pid))
    ) {
      return fail('interrupt-stale-lock-not-observed', [
        context.assert.diagnostic(
          'after cancellation, the datastore lock was neither removed nor the exact interrupted writer lock',
        ),
      ]);
    }
    const recoveryMode = interruptedLock === null ? 'clean-lock-removal' : 'stale-lock-reclaim';

    holderReleased = releaseSqliteHolder(releaseMarker, lockIdentity);
    if (!holderReleased) return fail('interrupt-release-failed', []);
    const holderResult = await holder.promise;
    if (!cleanProcess(holderResult)) {
      return fail('interrupt-holder-cleanup-failed', [
        context.assert.diagnostic(holderResult?.stderrTail ?? ''),
      ]);
    }

    const recovered = await runCli(context, { args: ['graph'], cwd });
    if (!cleanProcess(recovered)) {
      return fail('interrupted-recovery-write-failed', [
        context.assert.diagnostic(recovered.stderrTail),
      ]);
    }
    if (existsSync(writeLock)) {
      return fail('interrupted-recovery-lock-not-released', []);
    }
    const replay = await verifyNewGraphSession(
      context,
      cwd,
      readable.sessionIds,
      'interrupted-recovery',
    );
    if (!replay.ok) return replay.outcome;
    completed = true;
    return pass([
      context.assert.diagnostic(
        recoveryMode === 'clean-lock-removal'
          ? `harness: a blocked CLI writer removed its lock during cancellation before graph session ${replay.sessionId}`
          : `harness: a blocked CLI writer left its exact stale lock, which was reclaimed before graph session ${replay.sessionId}`,
      ),
    ]);
  } finally {
    if (!completed && writer !== null && !writer.settled) writerController.abort();
    if (!holderReleased) {
      holderReleased = releaseSqliteHolder(
        releaseMarker,
        lockIdentity ?? { ownerToken: 'harness-cleanup' },
      );
    }
    if (!holderReleased && !holder.settled) holderController.abort();
    await Promise.all([holder.promise, ...(writer === null ? [] : [writer.promise])]);
  }
}

const contentionRetryExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const initialized = await initProject(context, cwd);
  if (!initialized.ok) return initialized.outcome;
  return runSqliteContentionProbe(context, cwd);
};

const interruptedRecoveryExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const initialized = await initProject(context, cwd);
  if (!initialized.ok) return initialized.outcome;
  return runInterruptedSqliteProbe(context, cwd);
};

const stateBoundsExecutor = async (context) => {
  // Keep the global rssRequired profile meaningful for this otherwise
  // filesystem-only assertion and prove the bounded state is still readable.
  const readable = await runCli(context, {
    args: ['sessions', 'list', '--json'],
  });
  const readableOutcome = assertCommand(
    context,
    readable,
    HISTORY_EXPECT,
    'runtime-state-unreadable',
  );
  if (readableOutcome.status !== 'pass') return readableOutcome;

  // The shared project's runtime state must live UNDER the project (no escape)
  // and stay within a generous size bound.
  const runtimeDir = join(context.paths.workRoot, 'opensip-cli', '.runtime');
  if (!existsSync(runtimeDir)) {
    return fail('runtime-state-missing', [
      context.assert.diagnostic('no project-local .runtime directory was found'),
    ]);
  }
  let runtimeReal;
  let workRootReal;
  try {
    runtimeReal = realpathSync(runtimeDir);
    workRootReal = realpathSync(context.paths.workRoot);
  } catch {
    return fail('runtime-state-unreadable', [
      context.assert.diagnostic('project-local runtime state could not be resolved'),
    ]);
  }
  if (!isUnder(workRootReal, runtimeReal)) {
    return fail('runtime-state-escaped', [
      context.assert.diagnostic('project-local runtime state resolved outside the project'),
    ]);
  }
  const { bytes, truncated, unsafe } = boundedDirSize(runtimeReal);
  if (truncated) {
    return fail('runtime-state-unbounded', [
      context.assert.diagnostic('runtime state exceeded the bounded directory walk'),
    ]);
  }
  if (unsafe) {
    return fail('runtime-state-unsafe-entry', [
      context.assert.diagnostic('runtime state contained an unreadable or non-regular entry'),
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
      agent:
        'lock waiting is bounded, a queued writer resumes, and both successful sessions replay',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'hold an installed SQLite write transaction' },
      { label: 'observe one CLI writer own its datastore write lock' },
      {
        label: 'prove short-wait exhaustion and a queued writer behind the same owner',
      },
      { label: 'release and publicly replay both successful sessions' },
    ],
    executor: contentionRetryExecutor,
  }),
  defineJourney({
    id: 'persistence.interrupted-recovery',
    category: 'persistence',
    value: {
      human: 'An interrupted run recovers',
      agent: 'a blocked writer is cancelled cleanly before a fresh write and replay',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'hold an installed SQLite write transaction' },
      { label: 'cancel the blocked CLI writer and verify zero observed residual descendants' },
      { label: 'recover with a fresh write and public replay' },
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
      { label: 'read state through sessions list --json' },
      { label: 'locate opensip-cli/.runtime' },
      { label: 'assert it exists and is within bounds' },
    ],
    executor: stateBoundsExecutor,
  }),
]);
