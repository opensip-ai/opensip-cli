import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_CHILD_TAIL_BYTES,
  DISTRIBUTION_COMMAND_TIMEOUT_MS,
  buildDistributionChildEnvironment,
  buildDistributionConsumerManifest,
  flattenInstalledDependencyList,
  measureInstalledCliStartup,
  renderDistributionConsumerWorkspace,
  runBoundedJsonCommand,
  sensitivePackageEnvironmentKeys,
  startDistributionNetworkSentinel,
  writeDistributionReportAtomic,
} from '../lib/distribution-measurement-runtime.mjs';
import { runMeasuredCommand } from '../perf/run-command.mjs';

const HOSTILE_CHILD_SOURCE = [
  "process.on('SIGTERM', () => process.stdout.write('term\\n'));",
  'process.stdout.write(`ready:${process.pid}\\n`);',
  'setInterval(() => {}, 1000);',
].join('');

function isolatedDirectories(root = '/isolated') {
  return {
    home: `${root}/home`,
    cache: `${root}/cache`,
    config: `${root}/config`,
    data: `${root}/data`,
    state: `${root}/state`,
  };
}

test('child environments strip offline credentials and reject inherited cold-network state', () => {
  const inherited = {
    PATH: '/safe/bin',
    LANG: 'C.UTF-8',
    HOME: '/private/home',
    XDG_CACHE_HOME: '/private/cache',
    npm_config_registry: 'https://private.registry.invalid',
    NPM_TOKEN: 'private-token',
    HTTPS_PROXY: ['http:', '//private.proxy.invalid'].join(''),
    PNPM_CONFIG_STORE_DIR: '/private/store',
  };
  assert.deepEqual(sensitivePackageEnvironmentKeys(inherited), [
    'HTTPS_PROXY',
    'NPM_TOKEN',
    'PNPM_CONFIG_STORE_DIR',
    'npm_config_registry',
  ]);

  const directories = isolatedDirectories();
  const offline = buildDistributionChildEnvironment({
    baseEnvironment: inherited,
    directories,
    mode: 'offline-cache',
    registryOrigin: 'http://127.0.0.1:43123',
  });
  assert.equal(offline.PATH, '/safe/bin');
  assert.equal(offline.HOME, directories.home);
  assert.equal(offline.XDG_CACHE_HOME, directories.cache);
  assert.equal(offline.npm_config_registry, 'http://127.0.0.1:43123');
  assert.equal(offline.npm_config_userconfig, `${directories.config}/npmrc`);
  for (const key of ['NPM_TOKEN', 'HTTPS_PROXY', 'PNPM_CONFIG_STORE_DIR']) {
    assert.equal(key in offline, false);
  }
  assert.equal(Object.isFrozen(offline), true);

  assert.throws(
    () =>
      buildDistributionChildEnvironment({
        baseEnvironment: inherited,
        directories,
        mode: 'registry-cold',
        registryOrigin: 'https://registry.example',
      }),
    /refuses inherited package-manager auth\/proxy\/registry overrides/u,
  );
  const cold = buildDistributionChildEnvironment({
    baseEnvironment: { PATH: '/safe/bin' },
    directories,
    mode: 'registry-cold',
    registryOrigin: 'https://registry.example',
  });
  assert.equal(cold.npm_config_registry, 'https://registry.example');
  assert.equal(cold.HOME, directories.home);
});

test('consumer metadata uses root pnpm overrides and workspace lifecycle policy', () => {
  const manifest = buildDistributionConsumerManifest(
    [
      { packageName: 'opensip-cli', filePath: '/artifacts/opensip-cli.tgz' },
      { packageName: '@opensip-cli/core', filePath: '/artifacts/core.tgz' },
      { packageName: '@opensip-cli/lang-go', filePath: '/artifacts/lang-go.tgz' },
    ],
    'pnpm@11.10.0',
  );
  assert.deepEqual(manifest.dependencies, {
    'opensip-cli': 'file:/artifacts/opensip-cli.tgz',
  });
  assert.deepEqual(manifest.pnpm.overrides, {
    '@opensip-cli/core': 'file:/artifacts/core.tgz',
    '@opensip-cli/lang-go': 'file:/artifacts/lang-go.tgz',
  });
  assert.equal('overrides' in manifest, false, 'npm-style top-level overrides are forbidden');

  const workspace = renderDistributionConsumerWorkspace(manifest);
  assert.match(workspace, /onlyBuiltDependencies:\n {2}- better-sqlite3/u);
  assert.match(workspace, /overrides:\n {2}"@opensip-cli\/core": "file:\/artifacts\/core.tgz"/u);
  assert.ok(
    workspace.indexOf('@opensip-cli/core') < workspace.indexOf('@opensip-cli/lang-go'),
    'workspace overrides use raw deterministic ordering',
  );
});

test('dependency flattening returns bounded identity rows and private deterministic locations', () => {
  const flattened = flattenInstalledDependencyList([
    {
      dependencies: {
        'opensip-cli': {
          version: '0.6.0',
          path: '/consumer/node_modules/opensip-cli',
          dependencies: {
            kleur: { version: '4.1.5', path: '/consumer/node_modules/kleur' },
          },
        },
        '@opensip-cli/core': {
          version: '0.6.0',
          path: '/consumer/node_modules/@opensip-cli/core',
          optionalDependencies: {
            kleur: { version: '4.1.5', path: '/consumer/node_modules/.pnpm/kleur' },
          },
        },
      },
    },
  ]);
  assert.deepEqual(flattened.closure, [
    { name: '@opensip-cli/core', version: '0.6.0' },
    { name: 'kleur', version: '4.1.5' },
    { name: 'opensip-cli', version: '0.6.0' },
  ]);
  assert.deepEqual(flattened.locations.get('kleur'), [
    '/consumer/node_modules/.pnpm/kleur',
    '/consumer/node_modules/kleur',
  ]);
  assert.throws(() => flattenInstalledDependencyList([]), /exactly one consumer project/u);
  assert.throws(
    () => flattenInstalledDependencyList([{ dependencies: { broken: { version: '1\n2' } } }]),
    /version is invalid/u,
  );

  let nested = { leaf: { version: '1.0.0' } };
  for (let depth = 0; depth < 65; depth += 1) {
    nested = { [`node-${String(depth)}`]: { version: '1.0.0', dependencies: nested } };
  }
  assert.throws(
    () => flattenInstalledDependencyList([{ dependencies: nested }]),
    /dependency depth exceeds 64/u,
  );
});

test('startup measurement uses bounded argv-only fresh processes and rejects failures', async () => {
  const calls = [];
  const startup = await measureInstalledCliStartup({
    bin: '/consumer/node_modules/.bin/opensip',
    cwd: '/consumer',
    environment: Object.freeze({ PATH: '/safe/bin' }),
    repeats: 2,
    sampleIntervalMs: 50,
    runCommand: async (input) => {
      calls.push(input);
      return { status: 0, timedOut: false, durationMs: calls.length };
    },
    summarize: (samples) => ({ samplesMs: samples }),
  });
  assert.deepEqual(startup.version.samplesMs, [1, 2]);
  assert.deepEqual(startup.help.samplesMs, [3, 4]);
  assert.deepEqual(startup.initHelp.samplesMs, [5, 6]);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(Array.isArray(call.command), true);
    assert.equal(call.timeoutMs, DISTRIBUTION_COMMAND_TIMEOUT_MS);
    assert.equal(call.stdoutTailBytes, DISTRIBUTION_CHILD_TAIL_BYTES);
    assert.equal(call.stderrTailBytes, DISTRIBUTION_CHILD_TAIL_BYTES);
  }

  await assert.rejects(
    () =>
      measureInstalledCliStartup({
        bin: '/consumer/opensip',
        cwd: '/consumer',
        environment: {},
        repeats: 1,
        sampleIntervalMs: 50,
        runCommand: async () => ({ status: 1, timedOut: false, durationMs: 1 }),
        summarize: (samples) => samples,
      }),
    /opensip --version failed/u,
  );
});

function jsonChild(payload, exitCode, options) {
  return spawn(
    process.execPath,
    [
      '--eval',
      `process.stdout.write(${JSON.stringify(payload)}); process.exitCode = ${String(exitCode)};`,
    ],
    { ...options, cwd: process.cwd() },
  );
}

test('bounded JSON commands disable shells, cap output, and reject malformed children', async () => {
  let spawnInput;
  const parsed = await runBoundedJsonCommand({
    command: ['pnpm', 'list', '--json'],
    cwd: '/consumer',
    env: { PATH: '/safe/bin' },
    timeoutMs: 30_000,
    maxBytes: 1024,
    spawnChild: (command, args, options) => {
      spawnInput = { command, args, options };
      return jsonChild('[{"name":"consumer"}]', 0, options);
    },
  });
  assert.deepEqual(parsed, [{ name: 'consumer' }]);
  assert.equal(spawnInput.command, 'pnpm');
  assert.deepEqual(spawnInput.args, ['list', '--json']);
  assert.equal(spawnInput.options.shell, false);
  assert.deepEqual(spawnInput.options.stdio, ['ignore', 'pipe', 'ignore']);

  await assert.rejects(
    () =>
      runBoundedJsonCommand({
        command: ['pnpm'],
        timeoutMs: 100,
        maxBytes: 4,
        spawnChild: (_command, _args, options) => jsonChild('{"too":"large"}', 0, options),
      }),
    /output exceeds 4 bytes/u,
  );
  await assert.rejects(
    () =>
      runBoundedJsonCommand({
        command: ['pnpm'],
        timeoutMs: 100,
        maxBytes: 100,
        spawnChild: (_command, _args, options) => jsonChild('{broken', 0, options),
      }),
    /malformed JSON/u,
  );
});

test('bounded JSON commands reject within a hard bound when a hostile child never closes', async () => {
  // ChildProcess and its stdout stream expose EventEmitter rather than EventTarget.
  // eslint-disable-next-line unicorn/prefer-event-target
  const child = new EventEmitter();
  child.pid = 42_424;
  // eslint-disable-next-line unicorn/prefer-event-target
  child.stdout = new EventEmitter();
  const terminationSignals = [];
  const hardDeadlineMs = 500;
  let hardDeadline;
  const hardFailure = new Promise((_, reject) => {
    hardDeadline = setTimeout(
      () => reject(new Error(`bounded JSON command exceeded ${String(hardDeadlineMs)} ms`)),
      hardDeadlineMs,
    );
  });

  try {
    await Promise.race([
      assert.rejects(
        () =>
          runBoundedJsonCommand({
            command: ['hostile-child'],
            timeoutMs: 10,
            terminationGraceMs: 20,
            forceKillSettlementMs: 20,
            maxBytes: 100,
            spawnChild: () => child,
            terminateProcessTree: (_pid, signal) => {
              terminationSignals.push(signal);
              return new Promise(() => {
                // Deliberately model a termination helper that never settles.
              });
            },
          }),
        /exceeded 10 ms/u,
      ),
      hardFailure,
    ]);
  } finally {
    clearTimeout(hardDeadline);
  }

  assert.deepEqual(terminationSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  child.emit('close', 0);
});

test('real children that ignore SIGTERM are force-killed within measured command bounds', async () => {
  let jsonPid;
  let measuredPid;
  const killIfAlive = (pid) => {
    if (pid === undefined) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The bounded helper already reaped the child.
    }
  };
  const assertGone = (pid) => {
    assert.equal(typeof pid, 'number');
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === 'ESRCH',
    );
  };
  const within = async (promise, milliseconds) => {
    let deadline;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`hostile child exceeded ${String(milliseconds)} ms`)),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  };

  try {
    await within(
      assert.rejects(
        () =>
          runBoundedJsonCommand({
            command: [process.execPath, '--eval', HOSTILE_CHILD_SOURCE],
            timeoutMs: 200,
            terminationGraceMs: 50,
            forceKillSettlementMs: 100,
            maxBytes: 1024,
            spawnChild: (command, args, options) => {
              const child = spawn(command, args, options);
              jsonPid = child.pid;
              return child;
            },
          }),
        /exceeded 200 ms/u,
      ),
      2000,
    );
    assertGone(jsonPid);

    const measured = await within(
      runMeasuredCommand({
        command: [process.execPath, '--eval', HOSTILE_CHILD_SOURCE],
        timeoutMs: 200,
        terminationGraceMs: 50,
        forceKillSettlementMs: 100,
        stdoutTailBytes: 1024,
        stderrTailBytes: 1024,
        sampleIntervalMs: 50,
        spawnChild: (command, args, options) => {
          const child = spawn(command, args, options);
          measuredPid = child.pid;
          return child;
        },
      }),
      2000,
    );
    assert.equal(measured.timedOut, true);
    const pidMatch = /ready:(\d+)\nterm\n/u.exec(measured.stdoutTail);
    assert.notEqual(pidMatch, null);
    assert.equal(Number(pidMatch?.[1]), measuredPid);
    assertGone(measuredPid);
    assert.equal(measured.signal, 'SIGKILL');
  } finally {
    killIfAlive(jsonPid);
    killIfAlive(measuredPid);
  }
});

test('the offline sentinel begins with zero requests', async () => {
  const sentinel = await startDistributionNetworkSentinel();
  try {
    assert.match(sentinel.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(sentinel.requestCount(), 0);
  } finally {
    await sentinel.close();
  }
});

test('atomic report writes use mode 0600 and preserve existing output on failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-distribution-atomic-'));
  const output = join(root, 'report.json');
  try {
    await writeDistributionReportAtomic(output, { schemaVersion: 1 }, { makeId: () => 'success' });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { schemaVersion: 1 });
    assert.equal(statSync(output).mode & 0o777, 0o600);

    writeFileSync(output, 'preserved', 'utf8');
    await assert.rejects(
      () =>
        writeDistributionReportAtomic(
          output,
          { schemaVersion: 2 },
          {
            filesystem: {
              mkdir: fs.mkdir,
              open: fs.open,
              rename: async () => {
                throw new Error('rename failed');
              },
              rm: fs.rm,
            },
            makeId: () => 'rename-failure',
          },
        ),
      /rename failed/u,
    );
    assert.equal(readFileSync(output, 'utf8'), 'preserved');
    await assert.rejects(() => fs.access(join(root, '.report.json.rename-failure.tmp')));

    const victim = join(root, 'victim');
    writeFileSync(victim, 'untouched', 'utf8');
    symlinkSync(victim, join(root, '.report.json.precreated.tmp'));
    await assert.rejects(
      () => writeDistributionReportAtomic(output, { unsafe: true }, { makeId: () => 'precreated' }),
      /EEXIST/u,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
