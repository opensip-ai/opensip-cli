import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import test from 'node:test';

import {
  DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
  DISTRIBUTION_COMMAND_TIMEOUT_MS,
  DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES,
  DISTRIBUTION_INSTALL_TIMEOUT_MS,
  languageFamilyForPackage,
} from '../lib/distribution-footprint.mjs';
import { writeDistributionReportAtomic } from '../lib/distribution-measurement-runtime.mjs';
import { expectedTarballEntries } from '../lib/release-artifacts.mjs';
import {
  buildDistributionLockPreparationCommand,
  buildDistributionInstallCommand,
  runDistributionMeasurement,
} from '../measure-distribution-footprint.mjs';
import { createParentSignalCoordinator } from '../perf/child-process-lifecycle.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const SHA256 = 'a'.repeat(64);
const PNPM_COMMAND = Object.freeze([process.execPath, '/runtime/pnpm.mjs']);
const NPM_COMMAND = Object.freeze([process.execPath, '/runtime/npm-cli.js']);

function releaseRows() {
  return expectedTarballEntries(VERSION).map((entry, index) => ({
    ...entry,
    version: VERSION,
    compressedBytes: index + 1,
  }));
}

function installedOpenSipPackageNames() {
  return [
    'opensip-cli',
    ...releaseRows()
      .map((row) => row.packageName)
      .filter((name) => languageFamilyForPackage(name) !== undefined),
  ];
}

function installedDependencyJson(consumerRoot) {
  const dependencies = Object.fromEntries(
    installedOpenSipPackageNames().map((name) => [
      name,
      {
        version: VERSION,
        path: join(consumerRoot, 'node_modules', ...name.split('/')),
      },
    ]),
  );
  dependencies.kleur = {
    version: '4.1.5',
    path: join(consumerRoot, 'node_modules', 'kleur'),
  };
  return [{ name: 'consumer', version: '0.0.0', dependencies }];
}

function successfulResult(overrides = {}) {
  return {
    status: 0,
    timedOut: false,
    error: undefined,
    durationMs: 7,
    maxRssBytes: 4096,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  };
}

function createHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opensip-distribution-runner-'));
  const artifacts = join(root, 'artifacts');
  const store = join(root, 'store');
  const temporaryParent = join(root, 'temporary');
  const output = join(root, 'report.json');
  for (const directory of [artifacts, store, temporaryParent]) mkdirSync(directory);
  for (const row of releaseRows()) {
    writeFileSync(join(artifacts, row.fileName), Buffer.alloc(row.compressedBytes));
  }
  if (options.preExistingOutput) writeFileSync(output, 'preserved-report', 'utf8');

  const events = [];
  const measuredCalls = [];
  const jsonCalls = [];
  const removedRoots = [];
  const logs = [];
  const capture = {};
  let sentinelClosed = false;
  let sentinelRequests = options.sentinelRequests ?? 0;
  let startupCall = 0;

  const runMeasuredCommand = async (input) => {
    measuredCalls.push(input);
    const intercepted = await options.onMeasuredCommand?.(input, events);
    if (intercepted !== undefined) return intercepted;
    const [command, entrypoint, firstArgument] = input.command;
    if (
      command === PNPM_COMMAND[0] &&
      entrypoint === PNPM_COMMAND[1] &&
      firstArgument === '--version'
    ) {
      events.push('identity:pnpm');
      return successfulResult({ stdoutTail: '11.10.0\n' });
    }
    if (
      command === NPM_COMMAND[0] &&
      entrypoint === NPM_COMMAND[1] &&
      firstArgument === '--version'
    ) {
      events.push('identity:npm');
      return successfulResult({ stdoutTail: '11.0.0\n' });
    }
    if (command === 'git' && entrypoint === 'rev-parse') {
      events.push('identity:git');
      return successfulResult({ stdoutTail: `${'c'.repeat(40)}\n` });
    }
    if (
      command === PNPM_COMMAND[0] &&
      entrypoint === PNPM_COMMAND[1] &&
      firstArgument === 'install'
    ) {
      if (input.command.includes('--lockfile-only')) {
        events.push('lock:prepare');
        capture.lockPreparationInput = input;
        if (options.lockPreparationResult !== undefined) {
          return successfulResult(options.lockPreparationResult);
        }
        await fs.writeFile(
          join(input.cwd, 'pnpm-lock.yaml'),
          "lockfileVersion: '9.0'\n\npackages:\n\n  kleur@3.0.3:\n    resolution: {integrity: sha512-test}\n",
        );
        return successfulResult();
      }
      events.push('install');
      capture.installInput = input;
      capture.manifest = JSON.parse(readFileSync(join(input.cwd, 'package.json'), 'utf8'));
      capture.workspace = readFileSync(join(input.cwd, 'pnpm-workspace.yaml'), 'utf8');
      capture.installEnvironment = input.env;
      capture.stagedArtifactFiles = readdirSync(join(input.cwd, '..', 'artifacts')).sort();
      const coldStoreIndex = input.command.indexOf('--store-dir') + 1;
      capture.storeDir = input.command[coldStoreIndex];
      capture.storeEntries = readdirSync(capture.storeDir);
      await Promise.all(
        installedOpenSipPackageNames().map((name) =>
          fs.mkdir(join(input.cwd, 'node_modules', ...name.split('/')), {
            recursive: true,
          }),
        ),
      );
      const cliRoot = join(input.cwd, 'node_modules', 'opensip-cli');
      if (!options.missingPackageManifest) {
        await fs.writeFile(
          join(cliRoot, 'package.json'),
          `${JSON.stringify({
            name: 'opensip-cli',
            bin: { opensip: options.binTarget ?? './dist/index.js' },
          })}\n`,
        );
      }
      if (!options.missingBinTarget) {
        await fs.mkdir(join(input.cwd, 'node_modules', 'opensip-cli', 'dist'), {
          recursive: true,
        });
        await fs.writeFile(
          join(input.cwd, 'node_modules', 'opensip-cli', 'dist', 'index.js'),
          options.emptyBinTarget ? '' : '#!/usr/bin/env node\n',
        );
      }
      if (!options.missingBinShim) {
        const shimRoot = join(input.cwd, 'node_modules', '.bin');
        await fs.mkdir(shimRoot, { recursive: true });
        let shimContents = '#!/bin/sh\n';
        if (options.emptyBinShim) shimContents = '';
        else if (options.garbageBinShim) shimContents = 'exit 1\n';
        await fs.writeFile(join(shimRoot, 'opensip'), shimContents, {
          mode: options.nonExecutableBinShim ? 0o644 : 0o755,
        });
      }
      if (options.missingLockfile) {
        await fs.rm(join(input.cwd, 'pnpm-lock.yaml'), { force: true });
      } else if (!existsSync(join(input.cwd, 'pnpm-lock.yaml'))) {
        await fs.writeFile(join(input.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      }
      return successfulResult(options.installResult);
    }
    if (
      command === PNPM_COMMAND[0] &&
      entrypoint === PNPM_COMMAND[1] &&
      firstArgument === 'exec' &&
      input.command[3] === 'opensip' &&
      input.command[4] === '--version'
    ) {
      events.push('identity:opensip-bin');
      if (options.garbageBinShim) return successfulResult({ status: 1 });
      return successfulResult({ stdoutTail: `${options.installedBinVersion ?? VERSION}\n` });
    }
    if (
      command === process.execPath &&
      typeof entrypoint === 'string' &&
      entrypoint.endsWith('/node_modules/opensip-cli/dist/index.js')
    ) {
      startupCall += 1;
      events.push(`startup:${String(startupCall)}`);
      if (options.startupFailureAt === startupCall) {
        return successfulResult(options.startupResult ?? { status: 1 });
      }
      return successfulResult({ durationMs: startupCall });
    }
    throw new Error(`unexpected measured command: ${input.command.join(' ')}`);
  };

  const mode = options.mode ?? 'offline-cache';
  const argv = [
    '--dir',
    artifacts,
    '--expected-version',
    options.expectedVersion ?? VERSION,
    '--out',
    output,
    '--repeats',
    '2',
    '--mode',
    mode,
    ...(mode === 'offline-cache'
      ? ['--store-dir', store]
      : ['--registry', 'https://registry.example/', '--allow-registry']),
  ];
  const dependencies = {
    architecture: () => options.architecture ?? 'test-arch',
    baseEnvironment: options.baseEnvironment ?? {
      PATH: process.env.PATH ?? '',
    },
    ...(options.platform === 'win32'
      ? {
          validateInstalledCli: async (input) => {
            capture.installedCliValidationInput = input;
            return {
              command: [
                process.execPath,
                join(input.consumerRoot, 'node_modules', 'opensip-cli', 'dist', 'index.js'),
              ],
            };
          },
        }
      : {}),
    collectReleaseTarballRows: () => {
      events.push('release');
      return releaseRows();
    },
    cloneWindowsNodeGypDevDir: async (input) => {
      events.push('node-gyp:clone');
      capture.nodeGypCloneInput = input;
      return String.raw`C:\measurement\node-gyp-devdir`;
    },
    cloneRegistryMetadata: async () => {
      events.push('metadata:clone');
      options.onCloneRegistryMetadata?.(events);
      if (options.metadataCloneFailure) throw new Error('metadata clone failed');
      return { fileCount: 1 };
    },
    cwd: root,
    filesystem: fs,
    now: () => '2026-07-13T00:00:00.000Z',
    operatingSystemPlatform: () => options.platform ?? 'test-platform',
    operatingSystemRelease: () => 'test-release',
    processExecutable: process.execPath,
    removeTemporaryRoot: async (temporaryRoot, filesystem) => {
      events.push('cleanup');
      removedRoots.push(temporaryRoot);
      await filesystem.rm(temporaryRoot, { recursive: true, force: true });
    },
    runBoundedJsonCommand: async (input) => {
      events.push('dependencies');
      jsonCalls.push(input);
      if (options.jsonFailure) throw new Error('JSON child returned malformed JSON.');
      return installedDependencyJson(input.cwd);
    },
    runMeasuredCommand,
    resolveNpmCommand: async () => NPM_COMMAND,
    resolvePnpmCommand: async (input) => {
      capture.pnpmResolutionInput = input;
      return PNPM_COMMAND;
    },
    scanPhysicalTree: async () => {
      events.push('scan:physical');
      if (options.scanFailure) throw new Error('physical tree scan failed');
      return { bytes: 8192, fileCount: 16, entryCount: 20 };
    },
    scanResolvedPackage: async (_root, packageName) => {
      events.push(`scan:package:${packageName}`);
      return { packageName, unpackedBytes: 128, fileCount: 2, entryCount: 2 };
    },
    sha256File: async (path) => {
      capture.shaPaths = [...(capture.shaPaths ?? []), path];
      if (basename(path) === 'pnpm-lock.yaml') {
        events.push('lockfile');
        if (options.missingLockfile) throw new Error('lockfile missing');
      } else {
        await options.onArtifactHash?.(path, events);
      }
      return SHA256;
    },
    startNetworkSentinel: async () => {
      events.push('sentinel:start');
      return {
        origin: 'http://127.0.0.1:43123',
        requestCount: () => sentinelRequests,
        close: async () => {
          events.push('sentinel:close');
          sentinelClosed = true;
          if (options.sentinelCloseFailure) throw new Error('sentinel close failed');
          sentinelRequests += options.sentinelRequestsOnClose ?? 0;
        },
      };
    },
    stderr: (line) => logs.push(line),
    temporaryDirectory: () => temporaryParent,
    writeReport: async (path, report, dependencies_) => {
      events.push('write');
      if (options.writeFailure) throw new Error('final rename failed');
      await writeDistributionReportAtomic(path, report, dependencies_);
    },
  };

  return {
    argv,
    artifacts,
    capture,
    dependencies,
    events,
    jsonCalls,
    logs,
    measuredCalls,
    output,
    removedRoots,
    root,
    sentinelWasClosed: () => sentinelClosed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function attachParentSignalFixture(harness) {
  // eslint-disable-next-line unicorn/prefer-event-target -- coordinator deliberately accepts the process EventEmitter seam.
  const signalSource = new EventEmitter();
  const relayedSignals = [];
  let resolveRelay;
  const relayed = new Promise((resolve) => {
    resolveRelay = resolve;
  });
  const coordinator = createParentSignalCoordinator({
    cleanupTimeoutMs: 1000,
    signalSource,
    reraiseSignal: (signal) => {
      harness.events.push(`relay:${signal}`);
      relayedSignals.push(signal);
      resolveRelay(signal);
    },
  });
  harness.dependencies.parentSignalCoordinator = coordinator;
  return { coordinator, relayed, relayedSignals, signalSource };
}

function assertChildCallsUseCoordinator(harness, coordinator) {
  const childCalls = [...harness.measuredCalls, ...harness.jsonCalls];
  assert.ok(childCalls.length > 0);
  for (const call of childCalls) {
    assert.equal(call.parentSignalCoordinator, coordinator);
  }
}

test('successful offline orchestration is bounded, pinned, atomic, and cleaned before publish', async () => {
  const harness = createHarness({
    baseEnvironment: {
      PATH: process.env.PATH ?? '',
      HOME: '/private/home',
      npm_config_registry: 'https://private.invalid',
      NPM_TOKEN: 'private',
      HTTPS_PROXY: ['http:', '//private.invalid'].join(''),
    },
  });
  try {
    const result = await runDistributionMeasurement(harness.argv, harness.dependencies);
    assert.equal(result.help, false);
    assert.deepEqual(JSON.parse(readFileSync(harness.output, 'utf8')), result.report);
    assert.equal(harness.sentinelWasClosed(), true);
    assert.equal(harness.removedRoots.length, 1);
    assert.equal(existsSync(harness.removedRoots[0]), false);
    assert.ok(harness.events.indexOf('cleanup') < harness.events.indexOf('write'));

    const install = harness.capture.installInput;
    assert.equal(Array.isArray(install.command), true);
    assert.deepEqual(install.command.slice(0, 5), [
      ...PNPM_COMMAND,
      'install',
      '--prod',
      '--offline',
    ]);
    assert.ok(install.command.includes('--offline'));
    assert.ok(install.command.includes('--frozen-lockfile'));
    assert.ok(install.command.includes('--trust-lockfile'));
    assert.equal(install.command.includes('--no-frozen-lockfile'), false);
    assert.ok(install.command.includes('--store-dir'));
    assert.ok(install.command.includes('http://127.0.0.1:43123'));
    assert.equal(install.timeoutMs, DISTRIBUTION_INSTALL_TIMEOUT_MS);
    assert.equal(install.stdoutTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
    assert.equal(install.stderrTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
    assert.equal(harness.capture.installEnvironment.NPM_TOKEN, undefined);
    assert.equal(harness.capture.installEnvironment.HTTPS_PROXY, undefined);
    assert.equal(
      harness.capture.installEnvironment.npm_config_https_proxy,
      'http://127.0.0.1:43123',
    );
    assert.equal(harness.capture.installEnvironment.npm_config_proxy, 'http://127.0.0.1:43123');
    assert.equal(harness.capture.installEnvironment.npm_config_build_from_source, 'true');
    assert.equal(harness.capture.installEnvironment.npm_config_offline, 'true');
    assert.equal(
      harness.capture.installEnvironment.npm_config_nodedir,
      dirname(dirname(process.execPath)),
    );
    assert.equal(harness.capture.installEnvironment.COREPACK_ENABLE_NETWORK, '0');
    assert.notEqual(harness.capture.installEnvironment.HOME, '/private/home');
    assert.equal(harness.capture.pnpmResolutionInput.platform, 'test-platform');

    assert.equal('overrides' in harness.capture.manifest, false);
    assert.ok(Object.keys(harness.capture.manifest.pnpm.overrides).length > 0);
    assert.match(harness.capture.workspace, /allowBuilds:\n {2}better-sqlite3: true/u);
    assert.match(harness.capture.workspace, /^overrides:/mu);
    assert.match(
      harness.capture.manifest.dependencies['opensip-cli'],
      /^file:\.\.\/artifacts\/opensip-cli-/u,
    );
    assert.equal(harness.capture.stagedArtifactFiles.length, releaseRows().length);
    assert.ok(
      harness.capture.shaPaths
        .filter((path) => basename(path) !== 'pnpm-lock.yaml')
        .every((path) => path.includes(`${sep}artifacts${sep}`)),
    );

    const preparation = harness.capture.lockPreparationInput;
    assert.ok(preparation.command.includes('--lockfile-only'));
    assert.ok(preparation.command.includes('--offline'));
    assert.ok(preparation.command.includes('--no-frozen-lockfile'));
    assert.ok(preparation.command.includes('--trust-lockfile'));
    assert.equal(preparation.command.includes('--frozen-lockfile'), false);
    assert.ok(
      preparation.command[preparation.command.indexOf('--store-dir') + 1].includes(
        'lock-preparation-store',
      ),
    );
    assert.equal(harness.events.filter((event) => event === 'metadata:clone').length, 1);
    assert.ok(harness.events.indexOf('lock:prepare') < harness.events.indexOf('install'));

    assert.equal(harness.jsonCalls.length, 1);
    assert.deepEqual(harness.jsonCalls[0].command, [
      ...PNPM_COMMAND,
      'list',
      '--prod',
      '--depth',
      'Infinity',
      '--json',
    ]);
    assert.equal(harness.jsonCalls[0].timeoutMs, DISTRIBUTION_COMMAND_TIMEOUT_MS);
    assert.equal(harness.jsonCalls[0].maxBytes, DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES);

    const installedBinCalls = harness.measuredCalls.filter(
      (call) =>
        call.command[0] === PNPM_COMMAND[0] &&
        call.command[1] === PNPM_COMMAND[1] &&
        call.command[2] === 'exec' &&
        call.command[3] === 'opensip',
    );
    assert.equal(installedBinCalls.length, 1);
    assert.deepEqual(installedBinCalls[0].command, [
      ...PNPM_COMMAND,
      'exec',
      'opensip',
      '--version',
    ]);

    const installedCliCalls = harness.measuredCalls.filter((call) =>
      String(call.command[1]).endsWith('/node_modules/opensip-cli/dist/index.js'),
    );
    assert.equal(installedCliCalls.length, 6, 'two repeats across three startup scenarios');
    for (const call of installedCliCalls) {
      assert.equal(call.timeoutMs, DISTRIBUTION_COMMAND_TIMEOUT_MS);
      assert.equal(call.stdoutTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
      assert.equal(call.stderrTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
    }
    assert.equal(result.report.measurement.registryOrigin, null);
    assert.ok(result.report.install.dependencyClosure.some((row) => row.name === 'opensip-cli'));
    assert.ok(result.report.install.dependencyClosure.some((row) => row.name === 'kleur'));

    assert.ok(harness.logs.some((line) => line.includes("current user's authority")));
    assert.ok(harness.logs.some((line) => line.includes('complete:')));
    const logText = harness.logs.join('\n');
    assert.doesNotMatch(logText, /private|NPM_TOKEN|npmrc|cache|@opensip-cli|opensip-cli\.tgz/u);

    const reportText = JSON.stringify(result.report);
    assert.doesNotMatch(
      reportText,
      /targetTuple|offlineBundleIndex|installReceipt|activation|rollback|ociReference|mirrorCredential|mirrorPolicy/iu,
    );
    assert.equal(
      readdirSync(harness.root, { recursive: true }).some((path) =>
        /(?:sqlite|\.db$)/iu.test(path),
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test(
  'parent signal waits for a pending child and runner cleanup before relaying',
  { timeout: 3000 },
  async () => {
    let fixture;
    const harness = createHarness({
      preExistingOutput: true,
      onMeasuredCommand: (input, events) => {
        if (!input.command.includes('--prod') || input.command.includes('--lockfile-only')) {
          return;
        }

        let resolveChild;
        const childResult = new Promise((resolve) => {
          resolveChild = resolve;
        });
        const unregister = input.parentSignalCoordinator.register(async (signal) => {
          events.push(`child:terminate:${signal}`);
          await Promise.resolve();
          events.push('child:settled');
          resolveChild(
            successfulResult({
              error: new Error('child interrupted by parent signal'),
              status: null,
            }),
          );
        });
        events.push('child:pending');
        fixture.signalSource.emit('SIGTERM');
        return childResult.finally(unregister);
      },
    });
    fixture = attachParentSignalFixture(harness);

    try {
      await assert.rejects(
        () => runDistributionMeasurement(harness.argv, harness.dependencies),
        /(?:interrupted|packed consumer install failed)/u,
      );
      await fixture.relayed;

      assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
      assert.equal(harness.events.includes('write'), false);
      assert.equal(harness.sentinelWasClosed(), true);
      assert.equal(harness.removedRoots.length, 1);
      assert.equal(existsSync(harness.removedRoots[0]), false);
      assert.equal(harness.jsonCalls.length, 0);
      assertChildCallsUseCoordinator(harness, fixture.coordinator);

      const relayIndex = harness.events.indexOf('relay:SIGTERM');
      assert.ok(harness.events.indexOf('child:pending') < harness.events.indexOf('child:settled'));
      for (const event of ['child:settled', 'sentinel:close', 'cleanup']) {
        assert.ok(harness.events.indexOf(event) < relayIndex, `${event} must precede relay`);
      }
      assert.deepEqual(fixture.relayedSignals, ['SIGTERM']);
      assert.equal(harness.events.filter((event) => event.startsWith('relay:')).length, 1);
      assert.equal(fixture.signalSource.listenerCount('SIGINT'), 0);
      assert.equal(fixture.signalSource.listenerCount('SIGTERM'), 0);
    } finally {
      harness.cleanup();
    }
  },
);

test(
  'parent signal between child stages prevents the next child and publishes nothing',
  { timeout: 3000 },
  async () => {
    let fixture;
    const harness = createHarness({
      preExistingOutput: true,
      onCloneRegistryMetadata: (events) => {
        events.push('between-stages:signal');
        fixture.signalSource.emit('SIGINT');
      },
    });
    fixture = attachParentSignalFixture(harness);

    try {
      await assert.rejects(
        () => runDistributionMeasurement(harness.argv, harness.dependencies),
        /interrupted by parent SIGINT/u,
      );
      await fixture.relayed;

      assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
      assert.equal(harness.sentinelWasClosed(), true);
      assert.equal(harness.removedRoots.length, 1);
      assert.equal(existsSync(harness.removedRoots[0]), false);
      assert.equal(harness.measuredCalls.length, 3, 'only the three identity children may start');
      assert.equal(harness.jsonCalls.length, 0);
      assertChildCallsUseCoordinator(harness, fixture.coordinator);
      for (const event of ['lock:prepare', 'install', 'dependencies', 'write']) {
        assert.equal(harness.events.includes(event), false, `${event} must not run`);
      }

      const signalIndex = harness.events.indexOf('between-stages:signal');
      for (const event of ['identity:pnpm', 'identity:npm', 'identity:git']) {
        assert.ok(harness.events.indexOf(event) < signalIndex, `${event} must finish first`);
      }
      const relayIndex = harness.events.indexOf('relay:SIGINT');
      for (const event of ['sentinel:close', 'cleanup']) {
        assert.ok(harness.events.indexOf(event) < relayIndex, `${event} must precede relay`);
      }
      assert.deepEqual(fixture.relayedSignals, ['SIGINT']);
      assert.equal(harness.events.filter((event) => event.startsWith('relay:')).length, 1);
      assert.equal(fixture.signalSource.listenerCount('SIGINT'), 0);
      assert.equal(fixture.signalSource.listenerCount('SIGTERM'), 0);
    } finally {
      harness.cleanup();
    }
  },
);

test(
  'parent signal waits for a concurrent artifact hash before cleanup and relay',
  { timeout: 3000 },
  async () => {
    let fixture;
    let firstArtifact = true;
    const harness = createHarness({
      preExistingOutput: true,
      onArtifactHash: async (_path, events) => {
        if (!firstArtifact) return;
        firstArtifact = false;
        events.push('hash:pending');
        fixture.signalSource.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push('hash:settled');
      },
    });
    fixture = attachParentSignalFixture(harness);

    try {
      await assert.rejects(
        () => runDistributionMeasurement(harness.argv, harness.dependencies),
        /interrupted by parent SIGTERM/u,
      );
      await fixture.relayed;

      assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
      assert.equal(harness.events.includes('write'), false);
      assert.equal(harness.sentinelWasClosed(), true);
      assert.equal(harness.removedRoots.length, 1);
      assert.equal(existsSync(harness.removedRoots[0]), false);
      for (const event of ['hash:settled', 'sentinel:close', 'cleanup']) {
        assert.ok(
          harness.events.indexOf(event) < harness.events.indexOf('relay:SIGTERM'),
          `${event} must precede relay`,
        );
      }
      assert.deepEqual(fixture.relayedSignals, ['SIGTERM']);
    } finally {
      harness.cleanup();
    }
  },
);

test('Windows offline orchestration clones exact node-gyp inputs before installing', async () => {
  const harness = createHarness({ architecture: 'x64', platform: 'win32' });
  try {
    await runDistributionMeasurement(harness.argv, harness.dependencies);

    assert.equal(harness.capture.nodeGypCloneInput.architecture, 'x64');
    assert.equal(harness.capture.nodeGypCloneInput.nodeVersion, process.versions.node);
    assert.ok(harness.capture.nodeGypCloneInput.destinationRoot.endsWith('node-gyp-devdir'));
    assert.equal(
      harness.capture.installEnvironment.npm_config_devdir,
      String.raw`C:\measurement\node-gyp-devdir`,
    );
    assert.equal(harness.capture.installEnvironment.npm_config_nodedir, undefined);
    assert.ok(harness.events.indexOf('node-gyp:clone') < harness.events.indexOf('lock:prepare'));
    assert.ok(harness.events.indexOf('node-gyp:clone') < harness.events.indexOf('install'));
  } finally {
    harness.cleanup();
  }
});

test('registry-cold uses its authorized origin and fresh isolated roots', async () => {
  const harness = createHarness({ mode: 'registry-cold' });
  try {
    const result = await runDistributionMeasurement(harness.argv, harness.dependencies);
    const install = harness.capture.installInput;
    assert.equal(install.command.includes('--offline'), false);
    assert.equal(install.command.at(-1), 'https://registry.example');
    assert.ok(install.command.includes('--store-dir'));
    assert.deepEqual(harness.capture.storeEntries, []);
    assert.ok(harness.capture.storeDir.includes('cold-store'));
    assert.ok(harness.capture.installEnvironment.HOME.includes('opensip-distribution-measure-'));
    assert.ok(harness.capture.installEnvironment.XDG_CACHE_HOME.includes('temporary'));
    assert.equal(result.report.measurement.registryOrigin, 'https://registry.example');
    assert.equal(harness.events.includes('sentinel:start'), false);
    assert.equal(harness.events.includes('metadata:clone'), false);
    assert.equal(harness.events.includes('lock:prepare'), false);
  } finally {
    harness.cleanup();
  }
});

test('registry-cold rejects inherited network state before spawning and preserves output', async () => {
  const harness = createHarness({
    mode: 'registry-cold',
    preExistingOutput: true,
    baseEnvironment: { PATH: process.env.PATH ?? '', NPM_TOKEN: 'private' },
  });
  try {
    await assert.rejects(
      () => runDistributionMeasurement(harness.argv, harness.dependencies),
      /refuses inherited package-manager/u,
    );
    assert.equal(harness.measuredCalls.length, 0);
    assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
    assert.equal(harness.removedRoots.length, 1);
    assert.equal(existsSync(harness.removedRoots[0]), false);
  } finally {
    harness.cleanup();
  }
});

test('measurement rejects tarballs for a version other than the repository version', async () => {
  const harness = createHarness({
    expectedVersion: '9.9.9',
    preExistingOutput: true,
  });
  try {
    await assert.rejects(
      () => runDistributionMeasurement(harness.argv, harness.dependencies),
      /must match the repository package version/u,
    );
    assert.equal(harness.measuredCalls.length, 0);
    assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
    assert.equal(harness.removedRoots.length, 1);
  } finally {
    harness.cleanup();
  }
});

for (const failure of [
  {
    name: 'metadata clone',
    options: { metadataCloneFailure: true },
    pattern: /metadata clone failed/u,
  },
  {
    name: 'lock preparation nonzero',
    options: { lockPreparationResult: { status: 1 } },
    pattern: /lock preparation failed/u,
  },
  {
    name: 'install nonzero',
    options: { installResult: { status: 1 } },
    pattern: /install failed/u,
  },
  {
    name: 'install timeout',
    options: { installResult: { timedOut: true } },
    pattern: /install failed/u,
  },
  {
    name: 'missing package manifest',
    options: { missingPackageManifest: true },
    pattern: /ENOENT/u,
  },
  {
    name: 'wrong package bin mapping',
    options: { binTarget: './dist/other.js' },
    pattern: /must declare bin\.opensip/u,
  },
  { name: 'missing bin target', options: { missingBinTarget: true }, pattern: /ENOENT/u },
  {
    name: 'empty bin target',
    options: { emptyBinTarget: true },
    pattern: /bin target must be a bounded non-empty/u,
  },
  { name: 'missing bin shim', options: { missingBinShim: true }, pattern: /ENOENT/u },
  {
    name: 'empty bin shim',
    options: { emptyBinShim: true },
    pattern: /bounded non-empty/u,
  },
  {
    name: 'non-executable bin shim',
    options: { nonExecutableBinShim: true },
    pattern: /EACCES/u,
  },
  {
    name: 'unusable bin shim',
    options: { garbageBinShim: true },
    pattern: /installed opensip bin --version failed/u,
  },
  {
    name: 'mismatched bin version',
    options: { installedBinVersion: '9.9.9' },
    pattern: /does not match the release input/u,
  },
  {
    name: 'malformed dependency JSON',
    options: { jsonFailure: true },
    pattern: /malformed/u,
  },
  {
    name: 'tree scan',
    options: { scanFailure: true },
    pattern: /tree scan failed/u,
  },
  {
    name: 'startup nonzero',
    options: { startupFailureAt: 1, startupResult: { status: 1 } },
    pattern: /opensip --version failed/u,
  },
  {
    name: 'startup timeout',
    options: { startupFailureAt: 1, startupResult: { timedOut: true } },
    pattern: /opensip --version failed/u,
  },
  {
    name: 'missing lockfile',
    options: { missingLockfile: true },
    pattern: /lockfile missing/u,
  },
  {
    name: 'final rename',
    options: { writeFailure: true },
    pattern: /final rename failed/u,
  },
  {
    name: 'sentinel close',
    options: { sentinelCloseFailure: true },
    pattern: /sentinel close failed/u,
  },
]) {
  test(`${failure.name} failure cleans the consumer and preserves an existing report`, async () => {
    const harness = createHarness({
      ...failure.options,
      preExistingOutput: true,
    });
    try {
      await assert.rejects(
        () => runDistributionMeasurement(harness.argv, harness.dependencies),
        failure.pattern,
      );
      assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
      assert.equal(harness.removedRoots.length, 1);
      assert.equal(existsSync(harness.removedRoots[0]), false);
    } finally {
      harness.cleanup();
    }
  });
}

test('offline sentinel requests fail closed without publishing a report', async () => {
  const harness = createHarness({
    sentinelRequests: 1,
    preExistingOutput: true,
  });
  try {
    await assert.rejects(
      () => runDistributionMeasurement(harness.argv, harness.dependencies),
      /attempted a registry request/u,
    );
    assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
    assert.equal(harness.sentinelWasClosed(), true);
  } finally {
    harness.cleanup();
  }
});

test('a sentinel request accepted during close still fails before report publication', async () => {
  const harness = createHarness({
    sentinelRequestsOnClose: 1,
    preExistingOutput: true,
  });
  try {
    await assert.rejects(
      () => runDistributionMeasurement(harness.argv, harness.dependencies),
      /attempted a registry request/u,
    );
    assert.equal(readFileSync(harness.output, 'utf8'), 'preserved-report');
    assert.equal(harness.sentinelWasClosed(), true);
    assert.equal(harness.removedRoots.length, 1);
    assert.equal(existsSync(harness.removedRoots[0]), false);
    assert.equal(harness.events.includes('write'), false);
  } finally {
    harness.cleanup();
  }
});

test('install command construction is argv-only and exhaustively mode-specific', () => {
  const directories = { coldStore: '/isolated/cold-store' };
  const preparation = buildDistributionLockPreparationCommand(
    ['node', '/runtime/pnpm.mjs'],
    { lockPreparationStore: '/isolated/lock-preparation-store' },
    'http://127.0.0.1:43123',
  );
  assert.deepEqual(preparation.slice(0, 3), ['node', '/runtime/pnpm.mjs', 'install']);
  assert.ok(preparation.includes('--lockfile-only'));
  assert.ok(preparation.includes('--no-frozen-lockfile'));
  assert.ok(preparation.includes('--trust-lockfile'));
  assert.equal(
    preparation[preparation.indexOf('--store-dir') + 1],
    '/isolated/lock-preparation-store',
  );
  const offline = buildDistributionInstallCommand(
    ['node', '/runtime/pnpm.mjs'],
    { mode: 'offline-cache', storeDir: '/prewarmed/store' },
    directories,
    'http://127.0.0.1:43123',
  );
  assert.equal(offline[offline.indexOf('--store-dir') + 1], '/prewarmed/store');
  assert.equal(offline[offline.indexOf('--registry') + 1], 'http://127.0.0.1:43123');
  assert.ok(offline.includes('--offline'));
  assert.ok(offline.includes('--frozen-lockfile'));
  assert.ok(offline.includes('--trust-lockfile'));
  const cold = buildDistributionInstallCommand(
    ['node', '/runtime/pnpm.mjs'],
    { mode: 'registry-cold' },
    directories,
    'https://registry.example',
  );
  assert.equal(cold.includes('--offline'), false);
  assert.equal(cold[cold.indexOf('--store-dir') + 1], '/isolated/cold-store');
});

test('runner modules do not import product persistence, telemetry, or delivery planes', () => {
  const source = [
    readFileSync(new URL('../measure-distribution-footprint.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../lib/distribution-measurement-runtime.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../lib/distribution-offline-preparation.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(
    source,
    /from\s+['"][^'"]*(?:opentelemetry|session-store|datastore|tool-state|baseline|cloud|delivery)[^'"]*['"]/iu,
  );
});
