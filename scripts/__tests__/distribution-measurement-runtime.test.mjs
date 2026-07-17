import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_CHILD_TAIL_BYTES,
  DISTRIBUTION_COMMAND_TIMEOUT_MS,
  DISTRIBUTION_INSTALLED_MANIFEST_MAX_BYTES,
  buildDistributionChildEnvironment,
  buildDistributionConsumerManifest,
  buildDistributionInstalledCliCommand,
  distributionNodeInstallationDirectory,
  flattenInstalledDependencyList,
  measureInstalledCliStartup,
  renderDistributionConsumerWorkspace,
  resolveDistributionNpmCommand,
  runBoundedJsonCommand,
  sensitivePackageEnvironmentKeys,
  startDistributionNetworkSentinel,
  validateDistributionInstalledCli,
  writeDistributionReportAtomic,
} from '../lib/distribution-measurement-runtime.mjs';
import { createParentSignalCoordinator } from '../perf/child-process-lifecycle.mjs';
import { runMeasuredCommand } from '../perf/run-command.mjs';

const HOSTILE_GRANDCHILD_SOURCE = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const HOSTILE_CHILD_SOURCE = [
  "const { spawn } = require('node:child_process');",
  `const grandchild = spawn(process.execPath, ['--eval', ${JSON.stringify(
    HOSTILE_GRANDCHILD_SOURCE,
  )}], { detached: true, stdio: 'ignore' });`,
  "process.on('SIGTERM', () => process.stdout.write('term\\n'));",
  'process.stdout.write(`ready:${process.pid}:${grandchild.pid}\\n`);',
  'setInterval(() => {}, 1000);',
].join('');
const SUCCESSFUL_DETACHED_CHILD_SOURCE = [
  "const { spawn } = require('node:child_process');",
  `const grandchild = spawn(process.execPath, ['--eval', ${JSON.stringify(
    'setInterval(() => {}, 1000);',
  )}], { detached: true, stdio: 'ignore' });`,
  'grandchild.unref();',
  'process.stdout.write(JSON.stringify({ rootPid: process.pid, grandchildPid: grandchild.pid }));',
  'setTimeout(() => process.exit(0), 150);',
].join('');
const INITIAL_PROCESS_SIGINT_LISTENERS = process.listenerCount('SIGINT');
const INITIAL_PROCESS_SIGTERM_LISTENERS = process.listenerCount('SIGTERM');

function killProcessIfAlive(pid) {
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The bounded helper already reaped the process.
  }
}

async function assertProcessGone(pid, label) {
  assert.equal(typeof pid, 'number');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${label} process ${String(pid)} survived bounded cleanup`);
}

function createSignalTestChild(pid, closeDelayMs = 0) {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stdout is an EventEmitter stream seam.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stderr is an EventEmitter stream seam.
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.stdout.destroy = () => {
    child.stdout.destroyed = true;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyed = true;
  };
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setTimeout(() => child.emit('close', null, signal), closeDelayMs);
    return true;
  };
  return { child, signals };
}

function createTestParentSignalCoordinator() {
  // eslint-disable-next-line unicorn/prefer-event-target -- coordinator deliberately accepts the process EventEmitter seam.
  const signalSource = new EventEmitter();
  let resolveRelay;
  const relayed = new Promise((resolve) => {
    resolveRelay = resolve;
  });
  const relayedSignals = [];
  const coordinator = createParentSignalCoordinator({
    cleanupTimeoutMs: 500,
    signalSource,
    reraiseSignal: (signal) => {
      relayedSignals.push(signal);
      resolveRelay(signal);
    },
  });
  return { coordinator, relayed, relayedSignals, signalSource };
}

function assertSignalTestChildReleased(child) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

function isolatedDirectories(root = '/isolated') {
  return {
    home: `${root}/home`,
    cache: `${root}/cache`,
    config: `${root}/config`,
    data: `${root}/data`,
    state: `${root}/state`,
  };
}

test('win32 commands use the active Node executable and JavaScript entrypoints', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const npmCli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  const consumer = String.raw`C:\measurement\consumer`;
  const probed = [];
  const npmCommand = await resolveDistributionNpmCommand({
    filesystem: {
      stat: async (path) => {
        probed.push(path);
        return { isFile: () => path === npmCli };
      },
    },
    platform: 'win32',
    processExecutable: node,
  });
  assert.deepEqual(npmCommand, [node, npmCli]);
  assert.deepEqual(probed, [npmCli]);
  assert.deepEqual(
    buildDistributionInstalledCliCommand({
      consumerRoot: consumer,
      platform: 'win32',
      processExecutable: node,
    }),
    [node, String.raw`C:\measurement\consumer\node_modules\opensip-cli\dist\index.js`],
  );
  assert.equal(
    distributionNodeInstallationDirectory({
      platform: 'win32',
      processExecutable: node,
    }),
    String.raw`C:\Program Files\nodejs`,
  );
});

test('installed CLI validation requires the declared target and generated platform shim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-installed-bin-'));
  const packageRoot = join(root, 'node_modules', 'opensip-cli');
  const shimRoot = join(root, 'node_modules', '.bin');
  const manifestPath = join(packageRoot, 'package.json');
  const entrypoint = join(packageRoot, 'dist', 'index.js');
  const shimPath = join(shimRoot, 'opensip');
  try {
    await Promise.all([
      fs.mkdir(join(packageRoot, 'dist'), { recursive: true }),
      fs.mkdir(shimRoot, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(
        manifestPath,
        `${JSON.stringify({ name: 'opensip-cli', bin: { opensip: './dist/index.js' } })}\n`,
      ),
      fs.writeFile(entrypoint, '#!/usr/bin/env node\n'),
      fs.writeFile(shimPath, '#!/bin/sh\n', { mode: 0o755 }),
    ]);

    const validated = await validateDistributionInstalledCli({
      consumerRoot: root,
      filesystem: fs,
      platform: 'linux',
      processExecutable: process.execPath,
    });
    assert.deepEqual(validated.command, [process.execPath, entrypoint]);
    assert.equal(validated.manifestPath, manifestPath);
    assert.equal(validated.shimPath, shimPath);

    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ name: 'opensip-cli', bin: { opensip: './dist/other.js' } })}\n`,
    );
    await assert.rejects(
      () =>
        validateDistributionInstalledCli({
          consumerRoot: root,
          filesystem: fs,
          platform: 'linux',
          processExecutable: process.execPath,
        }),
      /must declare bin\.opensip as \.\/dist\/index\.js/u,
    );

    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ name: 'opensip-cli', bin: { opensip: './dist/index.js' } })}\n`,
    );
    await fs.rm(shimPath);
    await assert.rejects(
      () =>
        validateDistributionInstalledCli({
          consumerRoot: root,
          filesystem: fs,
          platform: 'linux',
          processExecutable: process.execPath,
        }),
      /ENOENT/u,
    );

    await fs.writeFile(shimPath, '#!/bin/sh\n', { mode: 0o644 });
    await assert.rejects(
      () =>
        validateDistributionInstalledCli({
          consumerRoot: root,
          filesystem: fs,
          platform: 'linux',
          processExecutable: process.execPath,
        }),
      /EACCES/u,
    );

    await fs.writeFile(shimPath, '', { mode: 0o755 });
    await assert.rejects(
      () =>
        validateDistributionInstalledCli({
          consumerRoot: root,
          filesystem: fs,
          platform: 'linux',
          processExecutable: process.execPath,
        }),
      /bounded non-empty/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed CLI validation selects the Windows .cmd shim and bounds its manifest', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const consumer = String.raw`C:\measurement\consumer`;
  const manifestPath = String.raw`C:\measurement\consumer\node_modules\opensip-cli\package.json`;
  const entrypoint = String.raw`C:\measurement\consumer\node_modules\opensip-cli\dist\index.js`;
  const shimPath = String.raw`C:\measurement\consumer\node_modules\.bin\opensip.cmd`;
  const manifest = JSON.stringify({
    name: 'opensip-cli',
    bin: { opensip: './dist/index.js' },
  });
  const files = new Map([
    [manifestPath, manifest],
    [entrypoint, '#!/usr/bin/env node\n'],
    [shimPath, '@echo off\r\n'],
  ]);
  const filesystem = {
    open: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error('missing test file');
      const source = Buffer.from(value);
      return {
        close: async () => true,
        read: async (buffer, offset, length, position) => {
          const bytesRead = source.copy(buffer, offset, position, position + length);
          return { buffer, bytesRead };
        },
        stat: async () => ({ isFile: () => true, size: source.byteLength }),
      };
    },
    stat: async (path) => {
      const value = files.get(path);
      if (value === undefined) {
        const error = new Error('missing test file');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => true, size: Buffer.byteLength(value) };
    },
  };
  const validated = await validateDistributionInstalledCli({
    consumerRoot: consumer,
    filesystem,
    platform: 'win32',
    processExecutable: node,
  });
  assert.deepEqual(validated.command, [node, entrypoint]);
  assert.equal(validated.shimPath, shimPath);

  files.set(manifestPath, 'x'.repeat(DISTRIBUTION_INSTALLED_MANIFEST_MAX_BYTES + 1));
  await assert.rejects(
    () =>
      validateDistributionInstalledCli({
        consumerRoot: consumer,
        filesystem,
        platform: 'win32',
        processExecutable: node,
      }),
    /must be a 1-65536-byte regular file/u,
  );
});

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
    nodeDirectory: '/runtime/node-installation',
    platform: 'linux',
    registryOrigin: 'http://127.0.0.1:43123',
  });
  assert.equal(offline.PATH, '/safe/bin');
  assert.equal(offline.HOME, directories.home);
  assert.equal(offline.XDG_CACHE_HOME, directories.cache);
  assert.equal(offline.npm_config_registry, 'http://127.0.0.1:43123');
  assert.equal(offline.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(offline.HTTPS_PROXY, undefined);
  assert.equal(offline.npm_config_build_from_source, 'true');
  assert.equal(offline.npm_config_nodedir, '/runtime/node-installation');
  assert.equal(offline.npm_config_devdir, undefined);
  assert.equal(offline.npm_config_offline, 'true');
  assert.equal(offline.npm_config_https_proxy, 'http://127.0.0.1:43123');
  assert.equal(offline.npm_config_proxy, 'http://127.0.0.1:43123');
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
  assert.equal(cold.npm_config_build_from_source, undefined);
  assert.equal(cold.npm_config_nodedir, undefined);
  assert.equal(cold.npm_config_devdir, undefined);
  assert.equal(cold.npm_config_https_proxy, undefined);
  assert.equal(cold.HOME, directories.home);
});

test('Windows offline children use only the isolated exact-version node-gyp devdir', () => {
  const directories = {
    home: String.raw`C:\measurement\home`,
    cache: String.raw`C:\measurement\cache`,
    config: String.raw`C:\measurement\config`,
    data: String.raw`C:\measurement\data`,
    state: String.raw`C:\measurement\state`,
  };
  const nodeGypDevDirectory = String.raw`C:\measurement\node-gyp-devdir`;
  const environment = buildDistributionChildEnvironment({
    baseEnvironment: { PATH: String.raw`C:\Windows\System32` },
    directories,
    mode: 'offline-cache',
    nodeGypDevDirectory,
    platform: 'win32',
    registryOrigin: 'http://127.0.0.1:43123',
  });

  assert.equal(environment.npm_config_devdir, nodeGypDevDirectory);
  assert.equal(environment.npm_config_nodedir, undefined);
  assert.equal(environment.COREPACK_HOME, String.raw`C:\measurement\cache\corepack`);
  assert.equal(environment.npm_config_userconfig, String.raw`C:\measurement\config\npmrc`);
  assert.throws(
    () =>
      buildDistributionChildEnvironment({
        baseEnvironment: {},
        directories,
        mode: 'offline-cache',
        nodeDirectory: String.raw`C:\Program Files\nodejs`,
        nodeGypDevDirectory,
        platform: 'win32',
        registryOrigin: 'http://127.0.0.1:43123',
      }),
    /one platform-appropriate local Node build root/u,
  );
  assert.throws(
    () =>
      buildDistributionChildEnvironment({
        baseEnvironment: {},
        directories,
        mode: 'offline-cache',
        platform: 'win32',
        registryOrigin: 'http://127.0.0.1:43123',
      }),
    /one platform-appropriate local Node build root/u,
  );
});

test('consumer metadata uses root pnpm overrides and workspace lifecycle policy', () => {
  const manifest = buildDistributionConsumerManifest(
    [
      { packageName: 'opensip-cli', filePath: '/artifacts/opensip-cli.tgz' },
      { packageName: '@opensip-cli/core', filePath: '/artifacts/core.tgz' },
      {
        packageName: '@opensip-cli/lang-go',
        filePath: '/artifacts/lang-go.tgz',
      },
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
  assert.match(workspace, /allowBuilds:\n {2}better-sqlite3: true/u);
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
            kleur: {
              version: '4.1.5',
              path: '/consumer/node_modules/.pnpm/kleur',
            },
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
    nested = {
      [`node-${String(depth)}`]: { version: '1.0.0', dependencies: nested },
    };
  }
  assert.throws(
    () => flattenInstalledDependencyList([{ dependencies: nested }]),
    /dependency depth exceeds 64/u,
  );
});

test('startup measurement uses bounded argv-only fresh processes and rejects failures', async () => {
  const calls = [];
  const command = ['/runtime/node', '/consumer/node_modules/opensip-cli/dist/index.js'];
  const startup = await measureInstalledCliStartup({
    command,
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
  assert.deepEqual(calls[0].command, [...command, '--version']);
  assert.deepEqual(calls[2].command, [...command, '--help']);
  assert.deepEqual(calls[4].command, [...command, 'init', '--help']);
  for (const call of calls) {
    assert.equal(Array.isArray(call.command), true);
    assert.equal(call.timeoutMs, DISTRIBUTION_COMMAND_TIMEOUT_MS);
    assert.equal(call.stdoutTailBytes, DISTRIBUTION_CHILD_TAIL_BYTES);
    assert.equal(call.stderrTailBytes, DISTRIBUTION_CHILD_TAIL_BYTES);
  }

  await assert.rejects(
    () =>
      measureInstalledCliStartup({
        command: ['/runtime/node', '/consumer/opensip.js'],
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

  // Size-cap and JSON-parse failures must not race a tight wall clock: on
  // loaded macOS CI runners a real Node child can take >100ms to emit its first
  // stdout chunk, which previously flipped this case into `exceeded 100 ms`
  // and failed the lane before pack/acceptance could run.
  await assert.rejects(
    () =>
      runBoundedJsonCommand({
        command: ['pnpm'],
        timeoutMs: 5_000,
        maxBytes: 4,
        spawnChild: (_command, _args, options) => jsonChild('{"too":"large"}', 0, options),
      }),
    /output exceeds 4 bytes/u,
  );
  await assert.rejects(
    () =>
      runBoundedJsonCommand({
        command: ['pnpm'],
        timeoutMs: 5_000,
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
  let captureCalls = 0;
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
            processTableTimeoutMs: 100,
            readProcessTable: () => {
              captureCalls += 1;
              return new Promise(() => {
                // Deliberately model a descendant snapshot that never settles.
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

  assert.equal(captureCalls, 1, 'TERM and KILL share the one in-flight bounded snapshot');
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  child.emit('close', 0);
});

test(
  'successful POSIX commands reap an observed detached grandchild without changing results',
  { skip: process.platform === 'win32' },
  async () => {
    const captures = [{ output: '' }, { output: '' }];
    const spawnSuccessfulTree = (capture) => (command, args, options) => {
      const child = spawn(command, args, options);
      capture.child = child;
      capture.rootPid = child.pid;
      capture.onData = (chunk) => {
        capture.output += chunk.toString();
        const match = /"grandchildPid":(\d+)/u.exec(capture.output);
        if (match !== null) capture.grandchildPid = Number(match[1]);
      };
      child.stdout?.on('data', capture.onData);
      return child;
    };

    try {
      const parsed = await runBoundedJsonCommand({
        command: [process.execPath, '--eval', SUCCESSFUL_DETACHED_CHILD_SOURCE],
        timeoutMs: 2000,
        terminationGraceMs: 50,
        forceKillSettlementMs: 200,
        descendantCaptureIntervalMs: 20,
        maxBytes: 1024,
        spawnChild: spawnSuccessfulTree(captures[0]),
      });
      assert.equal(parsed.rootPid, captures[0].rootPid);
      assert.equal(parsed.grandchildPid, captures[0].grandchildPid);
      await assertProcessGone(parsed.rootPid, 'successful JSON root');
      await assertProcessGone(parsed.grandchildPid, 'successful JSON grandchild');

      const measured = await runMeasuredCommand({
        command: [process.execPath, '--eval', SUCCESSFUL_DETACHED_CHILD_SOURCE],
        timeoutMs: 2000,
        terminationGraceMs: 50,
        forceKillSettlementMs: 200,
        stdoutTailBytes: 1024,
        stderrTailBytes: 1024,
        sampleIntervalMs: 20,
        spawnChild: spawnSuccessfulTree(captures[1]),
      });
      const measuredPayload = JSON.parse(measured.stdoutTail);
      assert.equal(measured.status, 0);
      assert.equal(measured.timedOut, false);
      assert.equal(measured.signal, undefined);
      assert.equal(measuredPayload.rootPid, captures[1].rootPid);
      assert.equal(measuredPayload.grandchildPid, captures[1].grandchildPid);
      await assertProcessGone(measuredPayload.rootPid, 'successful measured root');
      await assertProcessGone(measuredPayload.grandchildPid, 'successful measured grandchild');
    } finally {
      for (const capture of captures) {
        capture.child?.stdout?.off('data', capture.onData);
        killProcessIfAlive(capture.grandchildPid);
        killProcessIfAlive(capture.rootPid);
      }
    }
  },
);

test('real children that ignore SIGTERM are force-killed within measured command bounds', async () => {
  let jsonGrandchildPid;
  let jsonOutput = '';
  let jsonPid;
  let measuredGrandchildPid;
  let measuredPid;
  const assertGone = async (pid) => {
    assert.equal(typeof pid, 'number');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`hostile process ${String(pid)} survived tree termination`);
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
            timeoutMs: 30_000,
            terminationGraceMs: 50,
            forceKillSettlementMs: 100,
            maxBytes: 4,
            spawnChild: (command, args, options) => {
              const child = spawn(command, args, options);
              jsonPid = child.pid;
              child.stdout?.on('data', (chunk) => {
                jsonOutput += chunk.toString();
              });
              return child;
            },
          }),
        /output exceeds 4 bytes/u,
      ),
      2000,
    );
    const jsonPidMatch = /ready:(\d+):(\d+)\n/u.exec(jsonOutput);
    assert.notEqual(jsonPidMatch, null);
    jsonGrandchildPid = Number(jsonPidMatch?.[2]);
    await assertGone(jsonPid);
    await assertGone(jsonGrandchildPid);

    const measured = await within(
      runMeasuredCommand({
        command: [process.execPath, '--eval', HOSTILE_CHILD_SOURCE],
        timeoutMs: 200,
        // Leave enough event-loop time for the deliberately trapped SIGTERM to
        // flush its marker even when the complete script suite is running in
        // parallel. Production uses a 1s grace; 50ms made this assertion depend
        // on host load rather than the TERM -> KILL behavior under test.
        terminationGraceMs: 250,
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
    const pidMatch = /ready:(\d+):(\d+)\nterm\n/u.exec(measured.stdoutTail);
    assert.notEqual(pidMatch, null);
    assert.equal(Number(pidMatch?.[1]), measuredPid);
    measuredGrandchildPid = Number(pidMatch?.[2]);
    await assertGone(measuredPid);
    await assertGone(measuredGrandchildPid);
    assert.equal(measured.signal, 'SIGKILL');
  } finally {
    killProcessIfAlive(jsonGrandchildPid);
    killProcessIfAlive(jsonPid);
    killProcessIfAlive(measuredGrandchildPid);
    killProcessIfAlive(measuredPid);
  }
});

test('a simulated parent signal cleans concurrent detached child trees before one relay', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- coordinator deliberately accepts the same on/off signal-source seam as process.
  const signalSource = new EventEmitter();
  const captures = [{ output: '' }, { output: '' }];
  const ready = captures.map(
    (capture) =>
      new Promise((resolveReady) => {
        capture.resolveReady = resolveReady;
      }),
  );
  let relayCount = 0;
  let resolveRelay;
  const relayed = new Promise((resolve) => {
    resolveRelay = resolve;
  });
  const coordinator = createParentSignalCoordinator({
    cleanupTimeoutMs: 1000,
    signalSource,
    reraiseSignal: (signal) => {
      relayCount += 1;
      resolveRelay(signal);
    },
  });
  const spawnHostile = (capture) => (command, args, options) => {
    const child = spawn(command, args, options);
    capture.rootPid = child.pid;
    child.stdout?.on('data', (chunk) => {
      capture.output += chunk.toString();
      const match = /ready:(\d+):(\d+)\n/u.exec(capture.output);
      if (match !== null && capture.grandchildPid === undefined) {
        capture.grandchildPid = Number(match[2]);
        capture.resolveReady();
      }
    });
    return child;
  };
  const assertGone = async (pid) => {
    assert.equal(typeof pid, 'number');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`interrupted process ${String(pid)} survived parent-signal cleanup`);
  };
  assert.equal(process.listenerCount('SIGINT'), INITIAL_PROCESS_SIGINT_LISTENERS);
  assert.equal(process.listenerCount('SIGTERM'), INITIAL_PROCESS_SIGTERM_LISTENERS);

  try {
    const jsonRun = runBoundedJsonCommand({
      command: [process.execPath, '--eval', HOSTILE_CHILD_SOURCE],
      timeoutMs: 30_000,
      terminationGraceMs: 50,
      forceKillSettlementMs: 100,
      maxBytes: 1024,
      parentSignalCoordinator: coordinator,
      spawnChild: spawnHostile(captures[0]),
    });
    const jsonRejected = assert.rejects(jsonRun, /JSON child command failed/u);
    const measuredRun = runMeasuredCommand({
      command: [process.execPath, '--eval', HOSTILE_CHILD_SOURCE],
      timeoutMs: 30_000,
      terminationGraceMs: 50,
      forceKillSettlementMs: 100,
      stdoutTailBytes: 1024,
      stderrTailBytes: 1024,
      sampleIntervalMs: 50,
      parentSignalCoordinator: coordinator,
      spawnChild: spawnHostile(captures[1]),
    });

    await Promise.all(ready);
    signalSource.emit('SIGINT');
    const [measured, relayedSignal] = await Promise.all([measuredRun, relayed, jsonRejected]);

    assert.equal(relayedSignal, 'SIGINT');
    assert.equal(relayCount, 1);
    assert.equal(measured.signal, 'SIGKILL');
    assert.equal(signalSource.listenerCount('SIGINT'), 0);
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
    assert.equal(process.listenerCount('SIGINT'), INITIAL_PROCESS_SIGINT_LISTENERS);
    assert.equal(process.listenerCount('SIGTERM'), INITIAL_PROCESS_SIGTERM_LISTENERS);
    for (const capture of captures) {
      await assertGone(capture.rootPid);
      await assertGone(capture.grandchildPid);
    }
  } finally {
    for (const capture of captures) {
      killProcessIfAlive(capture.grandchildPid);
      killProcessIfAlive(capture.rootPid);
    }
  }
});

test('late parent-signal cleanup registration joins active cleanup before relay', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- coordinator deliberately accepts the process EventEmitter seam.
  const signalSource = new EventEmitter();
  let firstCleanupCalls = 0;
  let lateCleanupCalls = 0;
  let relayCount = 0;
  let resolveFirstCleanup;
  let resolveLateCleanup;
  let resolveRelay;
  const firstCleanup = new Promise((resolve) => {
    resolveFirstCleanup = resolve;
  });
  const lateCleanup = new Promise((resolve) => {
    resolveLateCleanup = resolve;
  });
  const relayed = new Promise((resolve) => {
    resolveRelay = resolve;
  });
  const coordinator = createParentSignalCoordinator({
    cleanupTimeoutMs: 500,
    signalSource,
    reraiseSignal: (signal) => {
      relayCount += 1;
      resolveRelay(signal);
    },
  });
  coordinator.register((signal) => {
    assert.equal(signal, 'SIGTERM');
    firstCleanupCalls += 1;
    return firstCleanup;
  });

  signalSource.emit('SIGTERM');
  coordinator.register((signal) => {
    assert.equal(signal, 'SIGTERM');
    lateCleanupCalls += 1;
    return lateCleanup;
  });
  assert.equal(firstCleanupCalls, 1);
  assert.equal(lateCleanupCalls, 1, 'late registration starts cleanup synchronously');

  resolveFirstCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relayCount, 0, 'relay waits for the late cleanup');
  assert.equal(signalSource.listenerCount('SIGINT'), 1);
  assert.equal(signalSource.listenerCount('SIGTERM'), 1);

  resolveLateCleanup();
  assert.equal(await relayed, 'SIGTERM');
  assert.equal(relayCount, 1);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('a parent signal emitted synchronously during spawn reaches both reserved child cleanups', async () => {
  const jsonParent = createTestParentSignalCoordinator();
  const json = createSignalTestChild(51_001);
  const jsonRun = runBoundedJsonCommand({
    command: ['synchronous-signal-json'],
    timeoutMs: 1000,
    terminationGraceMs: 100,
    forceKillSettlementMs: 100,
    maxBytes: 128,
    useProcessGroup: false,
    readProcessTable: async () => [
      {
        pid: 51_001,
        ppid: 1,
        processGroupId: 51_001,
        sessionToken: '51_001',
        startedAt: 'json-root',
        command: '/usr/bin/node',
        rssBytes: 1,
      },
    ],
    parentSignalCoordinator: jsonParent.coordinator,
    spawnChild: () => {
      jsonParent.signalSource.emit('SIGTERM');
      return json.child;
    },
  });
  const [jsonRelayedSignal] = await Promise.all([
    jsonParent.relayed,
    assert.rejects(jsonRun, /JSON child command failed/u),
  ]);
  assert.equal(jsonRelayedSignal, 'SIGTERM');
  assert.deepEqual(jsonParent.relayedSignals, ['SIGTERM']);
  assert.deepEqual(json.signals, ['SIGTERM']);
  assert.equal(jsonParent.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(jsonParent.signalSource.listenerCount('SIGTERM'), 0);
  assertSignalTestChildReleased(json.child);

  const measuredParent = createTestParentSignalCoordinator();
  const measured = createSignalTestChild(51_002);
  const measuredRun = runMeasuredCommand({
    command: ['synchronous-signal-measured'],
    timeoutMs: 1000,
    terminationGraceMs: 100,
    forceKillSettlementMs: 100,
    stdoutTailBytes: 128,
    stderrTailBytes: 128,
    sampleIntervalMs: 20,
    useProcessGroup: false,
    readProcessTable: async () => [
      {
        pid: 51_002,
        ppid: 1,
        processGroupId: 51_002,
        sessionToken: '51_002',
        startedAt: 'measured-root',
        command: '/usr/bin/node',
        rssBytes: 1,
      },
    ],
    parentSignalCoordinator: measuredParent.coordinator,
    spawnChild: () => {
      measuredParent.signalSource.emit('SIGINT');
      return measured.child;
    },
  });
  const [measuredResult, measuredRelayedSignal] = await Promise.all([
    measuredRun,
    measuredParent.relayed,
  ]);
  assert.equal(measuredRelayedSignal, 'SIGINT');
  assert.deepEqual(measuredParent.relayedSignals, ['SIGINT']);
  assert.deepEqual(measured.signals, ['SIGTERM']);
  assert.equal(measuredResult.timedOut, false);
  assert.equal(measuredResult.signal, 'SIGTERM');
  assert.equal(measuredParent.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(measuredParent.signalSource.listenerCount('SIGTERM'), 0);
  assertSignalTestChildReleased(measured.child);
});

test('the first parent-signal termination reason survives a later command timeout', async () => {
  const jsonParent = createTestParentSignalCoordinator();
  const json = createSignalTestChild(52_001, 40);
  const jsonRun = runBoundedJsonCommand({
    command: ['parent-before-timeout-json'],
    timeoutMs: 5,
    terminationGraceMs: 100,
    forceKillSettlementMs: 100,
    maxBytes: 128,
    useProcessGroup: false,
    readProcessTable: async () => [
      {
        pid: 52_001,
        ppid: 1,
        processGroupId: 52_001,
        sessionToken: '52_001',
        startedAt: 'json-root',
        command: '/usr/bin/node',
        rssBytes: 1,
      },
    ],
    parentSignalCoordinator: jsonParent.coordinator,
    spawnChild: () => json.child,
  });
  jsonParent.signalSource.emit('SIGTERM');
  await Promise.all([
    jsonParent.relayed,
    assert.rejects(jsonRun, (error) => {
      assert.match(error.message, /JSON child command failed/u);
      assert.doesNotMatch(error.message, /exceeded 5 ms/u);
      return true;
    }),
  ]);
  assert.deepEqual(json.signals, ['SIGTERM']);
  assert.deepEqual(jsonParent.relayedSignals, ['SIGTERM']);
  assert.equal(jsonParent.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(jsonParent.signalSource.listenerCount('SIGTERM'), 0);
  assertSignalTestChildReleased(json.child);

  const measuredParent = createTestParentSignalCoordinator();
  const measured = createSignalTestChild(52_002, 40);
  const measuredRun = runMeasuredCommand({
    command: ['parent-before-timeout-measured'],
    timeoutMs: 5,
    terminationGraceMs: 100,
    forceKillSettlementMs: 100,
    stdoutTailBytes: 128,
    stderrTailBytes: 128,
    sampleIntervalMs: 20,
    useProcessGroup: false,
    readProcessTable: async () => [
      {
        pid: 52_002,
        ppid: 1,
        processGroupId: 52_002,
        sessionToken: '52_002',
        startedAt: 'measured-root',
        command: '/usr/bin/node',
        rssBytes: 1,
      },
    ],
    parentSignalCoordinator: measuredParent.coordinator,
    spawnChild: () => measured.child,
  });
  measuredParent.signalSource.emit('SIGINT');
  const [measuredResult] = await Promise.all([measuredRun, measuredParent.relayed]);
  assert.equal(measuredResult.timedOut, false);
  assert.equal(measuredResult.signal, 'SIGTERM');
  assert.deepEqual(measured.signals, ['SIGTERM']);
  assert.deepEqual(measuredParent.relayedSignals, ['SIGINT']);
  assert.equal(measuredParent.signalSource.listenerCount('SIGINT'), 0);
  assert.equal(measuredParent.signalSource.listenerCount('SIGTERM'), 0);
  assertSignalTestChildReleased(measured.child);
});

test('the offline sentinel counts HTTP and CONNECT attempts', async () => {
  const sentinel = await startDistributionNetworkSentinel();
  let stalledSocket;
  try {
    assert.match(sentinel.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.equal(sentinel.requestCount(), 0);
    await new Promise((resolveRequest, rejectRequest) => {
      const request = httpGet(`${sentinel.origin}/probe`, (response) => {
        response.resume();
        response.once('end', resolveRequest);
      });
      request.once('error', rejectRequest);
    });
    assert.equal(sentinel.requestCount(), 1);
    const url = new URL(sentinel.origin);
    await new Promise((resolveRequest, rejectRequest) => {
      const socket = connect(Number(url.port), url.hostname);
      socket.once('error', rejectRequest);
      socket.once('data', () => socket.end());
      socket.once('close', resolveRequest);
      socket.once('connect', () => {
        socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
      });
    });
    assert.equal(sentinel.requestCount(), 2);
    await new Promise((resolveConnection, rejectConnection) => {
      const url = new URL(sentinel.origin);
      stalledSocket = connect(Number(url.port), url.hostname);
      stalledSocket.once('error', rejectConnection);
      stalledSocket.once('connect', resolveConnection);
    });
    for (let attempt = 0; attempt < 20 && sentinel.requestCount() < 3; attempt += 1) {
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
    assert.equal(sentinel.requestCount(), 3);
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      const deadline = setTimeout(
        () => rejectClose(new Error('sentinel close was not bounded')),
        1500,
      );
      sentinel.close().then(
        () => {
          clearTimeout(deadline);
          resolveClose();
        },
        (error) => {
          clearTimeout(deadline);
          rejectClose(error);
        },
      );
    });
  }
  if (stalledSocket !== undefined && !stalledSocket.destroyed) {
    await new Promise((resolveClose, rejectClose) => {
      const deadline = setTimeout(
        () => rejectClose(new Error('stalled sentinel socket did not close')),
        500,
      );
      stalledSocket.once('close', () => {
        clearTimeout(deadline);
        resolveClose();
      });
    });
  }
  assert.equal(stalledSocket?.destroyed, true);
  await sentinel.close();
});

test('atomic report writes use mode 0600 and preserve existing output on failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-distribution-atomic-'));
  const output = join(root, 'report.json');
  try {
    await writeDistributionReportAtomic(output, { schemaVersion: 1 }, { makeId: () => 'success' });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      schemaVersion: 1,
    });
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
