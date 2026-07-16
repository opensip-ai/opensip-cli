/**
 * @fileoverview Resilience journeys — host-failure behavior.
 *
 * Each owns its own state (`isolated: true`): awkward roots (spaces/Unicode,
 * symlinks), a read-only path, an isolated HOME, and cancellation / timeout /
 * descendant cleanup. Native prerequisites are declared as capabilities so a
 * missing one becomes an explicit `unavailable` result (the runner gates on
 * them), never an omitted row. Cancellation and timeout assert the port's
 * `cancelled` / `timedOut` flags and, critically, `cleanup.residualDescendants
 * === 0` — no residual descendant was observed under the POSIX process-group
 * plus sampled process-table model.
 */

import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  pass,
  runCli,
} from '../journey-kit.mjs';

/** True when any file exists anywhere under `dir` (bounded walk). */
function hasAnyFile(dir) {
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      visited += 1;
      if (visited > 4096) return true;
      if (dirent.isFile()) return true;
      if (dirent.isDirectory()) stack.push(join(current, dirent.name));
    }
  }
  return false;
}

/** Seed a minimal TS project (a single console.log file fit will flag) under `dir`. */
function seedProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'bad.ts'), "console.log('debug');\n");
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
  );
}

const FIT_ENVELOPE_EXPECT = {
  exitCode: 1,
  json: expectEnvelope({ tool: 'fit' }),
};

const spacesUnicodeExecutor = async (context) => {
  const dir = join(context.paths.workRoot, 'wörk späce ✓');
  try {
    seedProject(dir);
  } catch (error) {
    return fail('spaces-unicode-setup-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  const result = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log'],
    cwd: dir,
  });
  return assertCommand(context, result, FIT_ENVELOPE_EXPECT, 'spaces-unicode-failed');
};

const symlinkRootExecutor = async (context) => {
  const real = join(context.paths.workRoot, 'real-root');
  const link = join(context.paths.workRoot, 'linked-root');
  try {
    seedProject(real);
    symlinkSync(real, link, 'dir');
  } catch (error) {
    return fail('symlink-setup-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  const result = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log'],
    cwd: link,
  });
  return assertCommand(context, result, FIT_ENVELOPE_EXPECT, 'symlink-root-failed');
};

const permissionsExecutor = async (context) => {
  const readOnly = join(context.paths.workRoot, 'read-only');
  try {
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
  } catch (error) {
    return fail('permissions-setup-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  try {
    // A write into a read-only directory must fail gracefully (a reasoned
    // non-zero exit), never crash or silently succeed.
    const result = await runCli(context, {
      args: ['init', '--language', 'typescript', '--json'],
      cwd: readOnly,
    });
    if (result.timedOut)
      return fail('timed-out', [context.assert.diagnostic('init in a read-only dir timed out')]);
    if ((result.status ?? 0) === 0) {
      return fail('permission-denied-silently-succeeded', [
        context.assert.diagnostic('init reported success writing into a read-only directory'),
      ]);
    }
    return pass();
  } finally {
    // Restore write permission so the run-owned cleanup can remove the tree.
    try {
      chmodSync(readOnly, 0o700);
    } catch {
      /* best-effort restore */
    }
  }
};

const isolatedHomeExecutor = async (context) => {
  const home = join(context.paths.workRoot, 'owned-home');
  try {
    mkdirSync(home, { recursive: true });
    // `graph` needs a recognizable source project before it can exercise the
    // zero-init cache path. Keep OpenSIP itself uninitialized: this journey is
    // specifically proving that first-run state honors the supplied HOME.
    seedProject(context.paths.workRoot);
  } catch (error) {
    return fail('home-setup-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  // A first-run command must place its ephemeral user-cache state under the
  // supplied HOME, never the real one. We can only inspect the owned HOME.
  const result = await runCli(context, {
    args: ['graph', '--json'],
    cwd: context.paths.workRoot,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.state'),
      XDG_DATA_HOME: join(home, '.data'),
      XDG_CONFIG_HOME: join(home, '.config'),
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    },
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  const commandOutcome = assertCommand(
    context,
    result,
    { exitCode: 0, json: expectEnvelope({ tool: 'graph' }) },
    'isolated-home-command-failed',
  );
  if (commandOutcome.status !== 'pass') return commandOutcome;
  if (!hasAnyFile(home)) {
    return fail('home-not-honored', [
      context.assert.diagnostic('no state landed under the supplied HOME (isolation not honored)'),
    ]);
  }
  return pass();
};

const signalsExecutor = async (context) => {
  // Cancel the run mid-startup (CLI startup loads every tool module, so a short
  // abort always lands before completion). The tree must be torn down cleanly.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  let result;
  try {
    result = await runCli(context, {
      args: ['graph', '--json'],
      cwd: context.paths.workRoot,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const failures = [];
  if (result.cancelled !== true) failures.push('run was not reported cancelled after abort');
  if (result.cleanup.residualDescendants > 0)
    failures.push(`cancellation left ${result.cleanup.residualDescendants} descendant(s)`);
  return failures.length === 0
    ? pass()
    : fail(
        'signal-cancellation-failed',
        failures.map((f) => context.assert.diagnostic(f)),
      );
};

const timeoutCleanupExecutor = async (context) => {
  // A hard, short timeout must leave no residual descendant observed by the
  // POSIX process-group plus sampled process-table model.
  const result = await runCli(context, {
    args: ['graph', '--json'],
    cwd: context.paths.workRoot,
    timeoutMs: 25,
  });
  const failures = [];
  if (result.timedOut !== true)
    failures.push('run was not reported timed out under a 25ms timeout');
  if (result.cleanup.residualDescendants > 0)
    failures.push(`timeout left ${result.cleanup.residualDescendants} descendant(s)`);
  return failures.length === 0
    ? pass()
    : fail(
        'timeout-cleanup-failed',
        failures.map((f) => context.assert.diagnostic(f)),
      );
};

export const resilienceJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'resilience.spaces-unicode',
    category: 'resilience',
    value: {
      human: 'Works from odd project paths',
      agent: 'fit runs from a root with spaces and Unicode',
    },
    isolated: true,
    steps: [
      { label: 'seed a project under a spaces/Unicode root' },
      { label: 'run fit --json there' },
    ],
    executor: spacesUnicodeExecutor,
  }),
  defineJourney({
    id: 'resilience.symlink-root',
    category: 'resilience',
    value: {
      human: 'Works through a symlinked root',
      agent: 'fit runs when the project root is a symlink',
    },
    capabilities: ['symlink'],
    isolated: true,
    steps: [
      { label: 'symlink a seeded project root' },
      { label: 'run fit --json via the symlink' },
    ],
    executor: symlinkRootExecutor,
  }),
  defineJourney({
    id: 'resilience.permissions',
    category: 'resilience',
    value: {
      human: 'Fails cleanly on permission denied',
      agent: 'a write into a read-only dir fails with a reasoned non-zero exit',
    },
    capabilities: ['permissions'],
    isolated: true,
    steps: [
      { label: 'create a read-only directory' },
      { label: 'attempt init there' },
      { label: 'assert a graceful non-zero exit' },
    ],
    executor: permissionsExecutor,
  }),
  defineJourney({
    id: 'resilience.isolated-home',
    category: 'resilience',
    value: {
      human: 'Never touches the real HOME',
      agent: 'ephemeral state lands under the supplied HOME only',
    },
    isolated: true,
    steps: [
      { label: 'run a first-run command with an owned HOME' },
      { label: 'assert state landed under that HOME' },
    ],
    executor: isolatedHomeExecutor,
  }),
  defineJourney({
    id: 'resilience.signals',
    category: 'resilience',
    value: {
      human: 'Cancels cleanly',
      agent: 'an aborted run is cancelled with no observed residual descendants',
    },
    isolated: true,
    steps: [
      { label: 'abort a run mid-startup' },
      { label: 'assert cancelled + no observed residual descendants' },
    ],
    executor: signalsExecutor,
  }),
  defineJourney({
    id: 'resilience.timeout-cleanup',
    category: 'resilience',
    value: {
      human: 'Times out cleanly',
      agent: 'a timed-out run is timedOut with no observed residual descendants',
    },
    isolated: true,
    steps: [
      { label: 'run with a 25ms timeout' },
      { label: 'assert timedOut + no observed residual descendants' },
    ],
    executor: timeoutCleanupExecutor,
  }),
]);
