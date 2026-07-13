import assert from 'node:assert/strict';
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
import { basename, join } from 'node:path';
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
  buildDistributionInstallCommand,
  runDistributionMeasurement,
} from '../measure-distribution-footprint.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
const SHA256 = 'a'.repeat(64);

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
  if (options.preExistingOutput) writeFileSync(output, 'preserved-report', 'utf8');

  const events = [];
  const measuredCalls = [];
  const jsonCalls = [];
  const removedRoots = [];
  const logs = [];
  const capture = {};
  let sentinelClosed = false;
  let installedVersionRead = false;
  let startupCall = 0;

  const runMeasuredCommand = async (input) => {
    measuredCalls.push(input);
    const [command, firstArgument] = input.command;
    if (command === 'pnpm' && firstArgument === '--version') {
      events.push('identity:pnpm');
      return successfulResult({ stdoutTail: '11.10.0\n' });
    }
    if (command === 'npm' && firstArgument === '--version') {
      events.push('identity:npm');
      return successfulResult({ stdoutTail: '11.0.0\n' });
    }
    if (command === 'git') {
      events.push('identity:git');
      return successfulResult({ stdoutTail: `${'c'.repeat(40)}\n` });
    }
    if (command === 'pnpm' && firstArgument === 'install') {
      events.push('install');
      capture.installInput = input;
      capture.manifest = JSON.parse(readFileSync(join(input.cwd, 'package.json'), 'utf8'));
      capture.workspace = readFileSync(join(input.cwd, 'pnpm-workspace.yaml'), 'utf8');
      capture.installEnvironment = input.env;
      const coldStoreIndex = input.command.indexOf('--store-dir') + 1;
      capture.storeDir = input.command[coldStoreIndex];
      capture.storeEntries = readdirSync(capture.storeDir);
      await Promise.all(
        installedOpenSipPackageNames().map((name) =>
          fs.mkdir(join(input.cwd, 'node_modules', ...name.split('/')), { recursive: true }),
        ),
      );
      if (!options.missingBin) {
        await fs.mkdir(join(input.cwd, 'node_modules', '.bin'), { recursive: true });
        await fs.writeFile(join(input.cwd, 'node_modules', '.bin', 'opensip'), '#!/bin/sh\n');
      }
      if (!options.missingLockfile) {
        await fs.writeFile(join(input.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      }
      return successfulResult(options.installResult);
    }
    if (typeof command === 'string' && command.endsWith('/node_modules/.bin/opensip')) {
      if (!installedVersionRead && firstArgument === '--version') {
        installedVersionRead = true;
        events.push('identity:opensip');
        return successfulResult({ stdoutTail: `${VERSION}\n` });
      }
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
    VERSION,
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
    architecture: () => 'test-arch',
    baseEnvironment: options.baseEnvironment ?? { PATH: process.env.PATH ?? '' },
    collectReleaseTarballRows: () => {
      events.push('release');
      return releaseRows();
    },
    cwd: root,
    filesystem: fs,
    now: () => '2026-07-13T00:00:00.000Z',
    operatingSystemPlatform: () => 'test-platform',
    operatingSystemRelease: () => 'test-release',
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
      if (basename(path) === 'pnpm-lock.yaml') {
        events.push('lockfile');
        if (options.missingLockfile) throw new Error('lockfile missing');
      }
      return SHA256;
    },
    startNetworkSentinel: async () => {
      events.push('sentinel:start');
      return {
        origin: 'http://127.0.0.1:43123',
        requestCount: () => options.sentinelRequests ?? 0,
        close: async () => {
          events.push('sentinel:close');
          sentinelClosed = true;
          if (options.sentinelCloseFailure) throw new Error('sentinel close failed');
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
    assert.deepEqual(install.command.slice(0, 4), [
      'pnpm',
      'install',
      '--prod',
      '--no-frozen-lockfile',
    ]);
    assert.ok(install.command.includes('--offline'));
    assert.ok(install.command.includes('--store-dir'));
    assert.ok(install.command.includes('http://127.0.0.1:43123'));
    assert.equal(install.timeoutMs, DISTRIBUTION_INSTALL_TIMEOUT_MS);
    assert.equal(install.stdoutTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
    assert.equal(install.stderrTailBytes, DISTRIBUTION_CHILD_TAIL_MAX_BYTES);
    assert.equal(harness.capture.installEnvironment.NPM_TOKEN, undefined);
    assert.equal(harness.capture.installEnvironment.HTTPS_PROXY, undefined);
    assert.notEqual(harness.capture.installEnvironment.HOME, '/private/home');

    assert.equal('overrides' in harness.capture.manifest, false);
    assert.ok(Object.keys(harness.capture.manifest.pnpm.overrides).length > 0);
    assert.match(harness.capture.workspace, /onlyBuiltDependencies:\n {2}- better-sqlite3/u);
    assert.match(harness.capture.workspace, /^overrides:/mu);

    assert.equal(harness.jsonCalls.length, 1);
    assert.deepEqual(harness.jsonCalls[0].command, [
      'pnpm',
      'list',
      '--prod',
      '--depth',
      'Infinity',
      '--json',
    ]);
    assert.equal(harness.jsonCalls[0].timeoutMs, DISTRIBUTION_COMMAND_TIMEOUT_MS);
    assert.equal(harness.jsonCalls[0].maxBytes, DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES);

    const installedCliCalls = harness.measuredCalls.filter((call) =>
      String(call.command[0]).endsWith('/node_modules/.bin/opensip'),
    );
    assert.equal(installedCliCalls.length, 7, 'one version identity check plus six startup runs');
    const startupCalls = installedCliCalls.slice(1);
    assert.equal(startupCalls.length, 6);
    for (const call of startupCalls) {
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

for (const failure of [
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
  { name: 'missing bin', options: { missingBin: true }, pattern: /ENOENT/u },
  { name: 'malformed dependency JSON', options: { jsonFailure: true }, pattern: /malformed/u },
  { name: 'tree scan', options: { scanFailure: true }, pattern: /tree scan failed/u },
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
  { name: 'missing lockfile', options: { missingLockfile: true }, pattern: /lockfile missing/u },
  { name: 'final rename', options: { writeFailure: true }, pattern: /final rename failed/u },
  {
    name: 'sentinel close',
    options: { sentinelCloseFailure: true },
    pattern: /sentinel close failed/u,
  },
]) {
  test(`${failure.name} failure cleans the consumer and preserves an existing report`, async () => {
    const harness = createHarness({ ...failure.options, preExistingOutput: true });
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
  const harness = createHarness({ sentinelRequests: 1, preExistingOutput: true });
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

test('install command construction is argv-only and exhaustively mode-specific', () => {
  const directories = { coldStore: '/isolated/cold-store' };
  const offline = buildDistributionInstallCommand(
    { mode: 'offline-cache', storeDir: '/prewarmed/store' },
    directories,
    'http://127.0.0.1:43123',
  );
  assert.equal(offline[offline.indexOf('--store-dir') + 1], '/prewarmed/store');
  assert.equal(offline[offline.indexOf('--registry') + 1], 'http://127.0.0.1:43123');
  assert.equal(offline.at(-1), '--offline');
  const cold = buildDistributionInstallCommand(
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
  ].join('\n');
  assert.doesNotMatch(
    source,
    /from\s+['"][^'"]*(?:opentelemetry|session-store|datastore|tool-state|baseline|cloud|delivery)[^'"]*['"]/iu,
  );
});
