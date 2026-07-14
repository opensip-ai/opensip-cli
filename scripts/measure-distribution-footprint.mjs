#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { arch, platform, release as osRelease, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createDistributionFootprintReport,
  DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
  DISTRIBUTION_COMMAND_TIMEOUT_MS,
  DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES,
  DISTRIBUTION_FOOTPRINT_CAVEATS,
  DISTRIBUTION_INSTALL_TIMEOUT_MS,
  collectReleaseTarballRows,
  distributionMeasureHelp,
  groupLanguageFamilyFootprints,
  languageFamilyForPackage,
  normalizeDistributionVersion,
  parseDistributionMeasureArgs,
  scanPhysicalTree,
  scanResolvedPackage,
  summarizeDurationSamples,
} from './lib/distribution-footprint.mjs';
import {
  buildDistributionChildEnvironment,
  buildDistributionConsumerManifest,
  DISTRIBUTION_COMMAND_TIMEOUT_MS as RUNTIME_COMMAND_TIMEOUT_MS,
  DISTRIBUTION_INSTALL_TIMEOUT_MS as RUNTIME_INSTALL_TIMEOUT_MS,
  DISTRIBUTION_JSON_CAPTURE_BYTES,
  distributionNodeInstallationDirectory,
  flattenInstalledDependencyList,
  hashDistributionArtifactSet,
  measureInstalledCliStartup,
  renderDistributionConsumerWorkspace,
  resolveDistributionNpmCommand,
  runBoundedJsonCommand,
  startDistributionNetworkSentinel,
  validateDistributionInstalledCli,
  writeDistributionReportAtomic,
} from './lib/distribution-measurement-runtime.mjs';
import {
  assertDistributionLockSubset,
  cloneDistributionRegistryMetadata,
  defaultDistributionPnpmCacheDirectory,
  expectedDistributionPnpmVersion,
  resolveDistributionPnpmCommand,
} from './lib/distribution-offline-preparation.mjs';
import { cloneDistributionWindowsNodeGypDevDir } from './lib/distribution-node-gyp-devdir.mjs';
import { sha256File } from './lib/release-artifacts.mjs';
import {
  parentSignalCoordinator,
  reserveParentSignalCleanup,
} from './perf/child-process-lifecycle.mjs';
import { runMeasuredCommand } from './perf/run-command.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_INTERVAL_MS = 50;
const CONTROL_CHARACTER = /\p{Cc}/u;

function assertRunnerConstantsAgree() {
  if (
    DISTRIBUTION_COMMAND_TIMEOUT_MS !== RUNTIME_COMMAND_TIMEOUT_MS ||
    DISTRIBUTION_INSTALL_TIMEOUT_MS !== RUNTIME_INSTALL_TIMEOUT_MS ||
    DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES !== DISTRIBUTION_JSON_CAPTURE_BYTES
  ) {
    throw new Error('Distribution measurement resource constants are inconsistent.');
  }
}

function runtimeDependencies(overrides) {
  return {
    architecture: arch,
    baseEnvironment: process.env,
    collectReleaseTarballRows,
    cloneWindowsNodeGypDevDir: cloneDistributionWindowsNodeGypDevDir,
    cloneRegistryMetadata: cloneDistributionRegistryMetadata,
    cwd: process.cwd(),
    filesystem: fs,
    now: () => new Date().toISOString(),
    operatingSystemPlatform: platform,
    operatingSystemRelease: osRelease,
    parentSignalCoordinator,
    parseArgs: parseDistributionMeasureArgs,
    processExecutable: process.execPath,
    removeTemporaryRoot: async (root, filesystem) =>
      await filesystem.rm(root, { recursive: true, force: true }),
    runBoundedJsonCommand,
    runMeasuredCommand,
    scanPhysicalTree,
    scanResolvedPackage,
    sha256File,
    startNetworkSentinel: startDistributionNetworkSentinel,
    validateInstalledCli: validateDistributionInstalledCli,
    assertLockSubset: assertDistributionLockSubset,
    defaultPnpmCacheDirectory: defaultDistributionPnpmCacheDirectory,
    resolvePnpmCommand: resolveDistributionPnpmCommand,
    resolveNpmCommand: resolveDistributionNpmCommand,
    stderr: (line) => process.stderr.write(`${line}\n`),
    temporaryDirectory: tmpdir,
    writeReport: writeDistributionReportAtomic,
    ...overrides,
  };
}

function emitStage(runtime, message) {
  try {
    runtime.stderr(`[distribution-measure] ${message}`);
  } catch {
    // Progress output is explicitly non-authoritative and must not invalidate
    // an otherwise complete measurement or a safely published report.
  }
}

async function settleConcurrent(operations) {
  const results = await Promise.allSettled(operations);
  const values = [];
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    values.push(result.value);
  }
  return values;
}

function isPathInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function successfulCommand(result, label) {
  if (result.timedOut || result.status !== 0 || result.error !== undefined) {
    throw new Error(`${label} failed.`);
  }
  return result;
}

async function readCommandIdentity(runtime, input) {
  const result = successfulCommand(
    await runtime.runMeasuredCommand({
      command: input.command,
      cwd: input.cwd,
      env: input.environment,
      timeoutMs: DISTRIBUTION_COMMAND_TIMEOUT_MS,
      stdoutTailBytes: 4096,
      stderrTailBytes: 0,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    }),
    input.label,
  );
  const value = result.stdoutTail.trim();
  if (
    value.length === 0 ||
    value.length > 256 ||
    CONTROL_CHARACTER.test(value) ||
    (input.pattern !== undefined && !input.pattern.test(value))
  ) {
    throw new Error(`${input.label} returned an invalid identity.`);
  }
  return value;
}

function consumerTarballRows(tarballRows) {
  return tarballRows.map((row) => ({
    packageName: row.packageName,
    filePath: posix.join('..', 'artifacts', row.fileName),
  }));
}

async function stageConsumerTarballs(runtime, directories, options, tarballRows) {
  for (const row of tarballRows) {
    await runtime.filesystem.copyFile(
      join(options.artifactDir, row.fileName),
      join(directories.artifacts, row.fileName),
    );
    const staged = await runtime.filesystem.stat(join(directories.artifacts, row.fileName));
    if (!staged.isFile() || staged.size !== row.compressedBytes) {
      throw new Error('A staged release tarball changed during consumer preparation.');
    }
  }
}

async function prepareConsumer(runtime, temporaryRoot, options, tarballRows) {
  const nodeGypDevDirectory = join(temporaryRoot, 'node-gyp-devdir');
  const directories = {
    artifacts: join(temporaryRoot, 'artifacts'),
    consumer: join(temporaryRoot, 'consumer'),
    home: join(temporaryRoot, 'home'),
    cache: join(temporaryRoot, 'cache'),
    config: join(temporaryRoot, 'config'),
    data: join(temporaryRoot, 'data'),
    lockPreparationStore: join(temporaryRoot, 'lock-preparation-store'),
    state: join(temporaryRoot, 'state'),
    coldStore: join(temporaryRoot, 'cold-store'),
  };
  await settleConcurrent(
    Object.values(directories).map((directory) =>
      runtime.filesystem.mkdir(directory, { recursive: true }),
    ),
  );
  const rootManifest = JSON.parse(
    await runtime.filesystem.readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const repositoryVersion = normalizeDistributionVersion(
    rootManifest.version,
    'repository package version',
  );
  if (repositoryVersion !== options.expectedVersion) {
    throw new Error('--expected-version must match the repository package version.');
  }
  const manifest = buildDistributionConsumerManifest(
    consumerTarballRows(tarballRows),
    rootManifest.packageManager,
  );
  await stageConsumerTarballs(runtime, directories, options, tarballRows);
  await settleConcurrent([
    runtime.filesystem.writeFile(
      join(directories.consumer, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
    runtime.filesystem.writeFile(
      join(directories.consumer, 'pnpm-workspace.yaml'),
      renderDistributionConsumerWorkspace(manifest),
      { mode: 0o600 },
    ),
    runtime.filesystem.writeFile(join(directories.config, 'npmrc'), '', {
      mode: 0o600,
    }),
    runtime.filesystem.writeFile(join(directories.config, 'global-npmrc'), '', {
      mode: 0o600,
    }),
  ]);
  return {
    directories,
    nodeGypDevDirectory,
    packageManager: rootManifest.packageManager,
  };
}

export function buildDistributionLockPreparationCommand(pnpmCommand, directories, registryOrigin) {
  return [
    ...pnpmCommand,
    'install',
    '--prod',
    '--offline',
    '--lockfile-only',
    '--no-frozen-lockfile',
    '--trust-lockfile',
    '--reporter=silent',
    '--store-dir',
    directories.lockPreparationStore,
    '--registry',
    registryOrigin,
  ];
}

export function buildDistributionInstallCommand(pnpmCommand, options, directories, registryOrigin) {
  const storeDir = options.mode === 'offline-cache' ? options.storeDir : directories.coldStore;
  return [
    ...pnpmCommand,
    'install',
    '--prod',
    ...(options.mode === 'offline-cache'
      ? ['--offline', '--frozen-lockfile', '--trust-lockfile']
      : ['--no-frozen-lockfile']),
    '--reporter=silent',
    '--store-dir',
    storeDir,
    '--registry',
    registryOrigin,
  ];
}

function assertNoSentinelRequests(sentinel) {
  if (sentinel !== undefined && sentinel.requestCount() !== 0) {
    throw new Error('offline-cache attempted a registry request.');
  }
}

async function prepareOfflineConsumer(input) {
  const rootLockPath = join(REPO_ROOT, 'pnpm-lock.yaml');
  const consumerLockPath = join(input.directories.consumer, 'pnpm-lock.yaml');
  const rootLockText = await input.runtime.filesystem.readFile(rootLockPath, 'utf8');
  await settleConcurrent([
    input.runtime.filesystem.copyFile(rootLockPath, consumerLockPath),
    input.runtime.cloneRegistryMetadata({
      packageManager: input.packageManager,
      sourceCacheDirectory: input.runtime.defaultPnpmCacheDirectory({
        environment: input.runtime.baseEnvironment,
        platform: input.runtime.operatingSystemPlatform(),
      }),
      destinationCacheDirectory: input.directories.cache,
      destinationRegistryOrigin: input.registryOrigin,
      filesystem: input.runtime.filesystem,
    }),
  ]);
  successfulCommand(
    await input.runtime.runMeasuredCommand({
      command: buildDistributionLockPreparationCommand(
        input.pnpmCommand,
        input.directories,
        input.registryOrigin,
      ),
      cwd: input.directories.consumer,
      env: input.environment,
      timeoutMs: DISTRIBUTION_INSTALL_TIMEOUT_MS,
      stdoutTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
      stderrTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    }),
    'offline lock preparation',
  );
  assertNoSentinelRequests(input.sentinel);
  input.runtime.assertLockSubset({
    rootLockText,
    consumerLockText: await input.runtime.filesystem.readFile(consumerLockPath, 'utf8'),
    releaseTarballs: input.tarballRows.map(({ packageName, fileName }) => ({
      packageName,
      fileName,
    })),
  });
}

async function packageLookupRoot(runtime, consumerRoot, packageName, locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`Installed package ${packageName} has no resolved location.`);
  }
  const [realConsumer, location] = await settleConcurrent([
    runtime.filesystem.realpath(consumerRoot),
    runtime.filesystem.realpath(resolve(locations[0])),
  ]);
  if (!isPathInside(realConsumer, location)) {
    throw new Error(`Installed package ${packageName} resolves outside the consumer.`);
  }
  const segments = packageName.split('/');
  if (!location.endsWith(`${sep}${join(...segments)}`)) {
    throw new Error(`Installed package ${packageName} has a mismatched location.`);
  }
  let root = location;
  for (const segment of segments) {
    if (segment.length === 0) throw new Error('Installed package name is invalid.');
    root = dirname(root);
  }
  return root;
}

async function collectResolvedFamilyRows(runtime, directories, tarballRows, locations) {
  const rows = [];
  for (const tarball of tarballRows) {
    if (languageFamilyForPackage(tarball.packageName) === undefined) continue;
    const root = await packageLookupRoot(
      runtime,
      directories.consumer,
      tarball.packageName,
      locations.get(tarball.packageName),
    );
    rows.push(await runtime.scanResolvedPackage(root, tarball.packageName));
  }
  return rows;
}

/** Run the explicit repository-only packed-distribution measurement. */
export async function runDistributionMeasurement(argv = process.argv.slice(2), dependencies = {}) {
  assertRunnerConstantsAgree();
  const baseRuntime = runtimeDependencies(dependencies);
  const options = baseRuntime.parseArgs(argv, { cwd: baseRuntime.cwd });
  if (options.help) return { help: true, text: distributionMeasureHelp() };

  let interruptedSignal;
  const runnerSignalReservation = reserveParentSignalCleanup(baseRuntime.parentSignalCoordinator);
  runnerSignalReservation.activate((signal) => {
    interruptedSignal ??= signal;
  });
  const assertNotInterrupted = () => {
    if (interruptedSignal !== undefined) {
      throw new Error(
        `Distribution measurement interrupted by parent ${String(interruptedSignal)}.`,
      );
    }
  };
  const activeChildCalls = new Set();
  const trackChildCall = (start) => {
    assertNotInterrupted();
    const childCall = Promise.resolve(start());
    activeChildCalls.add(childCall);
    const release = () => activeChildCalls.delete(childCall);
    childCall.then(release, release);
    return childCall;
  };
  const runtime = {
    ...baseRuntime,
    runBoundedJsonCommand: (input) =>
      trackChildCall(() =>
        baseRuntime.runBoundedJsonCommand({
          ...input,
          parentSignalCoordinator: baseRuntime.parentSignalCoordinator,
        }),
      ),
    runMeasuredCommand: (input) =>
      trackChildCall(() =>
        baseRuntime.runMeasuredCommand({
          ...input,
          parentSignalCoordinator: baseRuntime.parentSignalCoordinator,
        }),
      ),
  };
  let temporaryRoot;
  let sentinel;
  let completedReport;
  try {
    assertNotInterrupted();
    const tarballRows = runtime.collectReleaseTarballRows(
      options.artifactDir,
      options.expectedVersion,
    );
    temporaryRoot = await runtime.filesystem.mkdtemp(
      join(runtime.temporaryDirectory(), 'opensip-distribution-measure-'),
    );
    assertNotInterrupted();
    emitStage(runtime, 'validating the complete local release set');
    const prepared = await prepareConsumer(runtime, temporaryRoot, options, tarballRows);
    assertNotInterrupted();
    const { directories, nodeGypDevDirectory, packageManager } = prepared;
    const expectedPnpmVersion = expectedDistributionPnpmVersion(packageManager);
    const operatingSystemPlatform = runtime.operatingSystemPlatform();
    const operatingSystemArchitecture = runtime.architecture();
    const [pnpmCommand, npmCommand] = await settleConcurrent([
      runtime.resolvePnpmCommand({
        environment: runtime.baseEnvironment,
        filesystem: runtime.filesystem,
        packageManager,
        platform: operatingSystemPlatform,
        processExecutable: runtime.processExecutable,
      }),
      runtime.resolveNpmCommand({
        filesystem: runtime.filesystem,
        platform: operatingSystemPlatform,
        processExecutable: runtime.processExecutable,
      }),
    ]);
    assertNotInterrupted();
    if (options.mode === 'offline-cache') sentinel = await runtime.startNetworkSentinel();
    assertNotInterrupted();
    const registryOrigin =
      options.mode === 'offline-cache' ? sentinel.origin : options.registryOrigin;
    let nodeDirectory;
    let isolatedNodeGypDevDirectory;
    if (options.mode === 'offline-cache') {
      if (operatingSystemPlatform === 'win32') {
        emitStage(runtime, 'cloning the exact-version Windows node-gyp cache');
        isolatedNodeGypDevDirectory = await runtime.cloneWindowsNodeGypDevDir({
          architecture: operatingSystemArchitecture,
          destinationRoot: nodeGypDevDirectory,
          environment: runtime.baseEnvironment,
          filesystem: runtime.filesystem,
          nodeVersion: process.versions.node,
        });
        assertNotInterrupted();
      } else {
        nodeDirectory = distributionNodeInstallationDirectory({
          platform: operatingSystemPlatform,
          processExecutable: runtime.processExecutable,
        });
      }
    }
    const environment = buildDistributionChildEnvironment({
      baseEnvironment: runtime.baseEnvironment,
      directories,
      mode: options.mode,
      platform: operatingSystemPlatform,
      ...(options.mode === 'offline-cache'
        ? {
            ...(operatingSystemPlatform === 'win32'
              ? { nodeGypDevDirectory: isolatedNodeGypDevDirectory }
              : { nodeDirectory }),
          }
        : {}),
      registryOrigin,
    });

    const [pnpmVersion, npmVersion, gitSha, artifactHash] = await settleConcurrent([
      readCommandIdentity(runtime, {
        command: [...pnpmCommand, '--version'],
        cwd: directories.consumer,
        environment,
        label: 'pnpm --version',
      }),
      readCommandIdentity(runtime, {
        command: [...npmCommand, '--version'],
        cwd: directories.consumer,
        environment,
        label: 'npm --version',
      }),
      readCommandIdentity(runtime, {
        command: ['git', 'rev-parse', 'HEAD'],
        cwd: REPO_ROOT,
        environment,
        label: 'git revision',
        pattern: /^[a-f0-9]{40}$/u,
      }),
      hashDistributionArtifactSet({
        artifactDir: directories.artifacts,
        tarballRows,
        sha256File: runtime.sha256File,
      }),
    ]);
    assertNotInterrupted();
    if (pnpmVersion !== expectedPnpmVersion) {
      throw new Error('The active pnpm runtime does not match packageManager.');
    }

    if (options.mode === 'offline-cache') {
      emitStage(runtime, 'preparing the isolated offline lock and metadata mirror');
      await prepareOfflineConsumer({
        directories,
        environment,
        packageManager,
        pnpmCommand,
        registryOrigin,
        runtime,
        sentinel,
        tarballRows,
      });
      assertNotInterrupted();
    }

    emitStage(
      runtime,
      "package-manager lifecycle behavior runs with the current user's authority; this is not a sandbox",
    );
    emitStage(runtime, 'installing the isolated packed consumer');
    const install = successfulCommand(
      await runtime.runMeasuredCommand({
        command: buildDistributionInstallCommand(pnpmCommand, options, directories, registryOrigin),
        cwd: directories.consumer,
        env: environment,
        timeoutMs: DISTRIBUTION_INSTALL_TIMEOUT_MS,
        stdoutTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
        stderrTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      }),
      'packed consumer install',
    );
    assertNotInterrupted();
    assertNoSentinelRequests(sentinel);

    const installedCli = await runtime.validateInstalledCli({
      consumerRoot: directories.consumer,
      filesystem: runtime.filesystem,
      platform: operatingSystemPlatform,
      processExecutable: runtime.processExecutable,
    });
    const installedCliCommand = installedCli.command;
    assertNotInterrupted();
    const installedCliVersion = await readCommandIdentity(runtime, {
      command: [...pnpmCommand, 'exec', 'opensip', '--version'],
      cwd: directories.consumer,
      environment,
      label: 'installed opensip bin --version',
    });
    assertNotInterrupted();
    if (installedCliVersion.replace(/^v/u, '') !== options.expectedVersion) {
      throw new Error('Installed opensip version does not match the release input.');
    }
    const dependencyJson = await runtime.runBoundedJsonCommand({
      command: [...pnpmCommand, 'list', '--prod', '--depth', 'Infinity', '--json'],
      cwd: directories.consumer,
      env: environment,
      timeoutMs: DISTRIBUTION_COMMAND_TIMEOUT_MS,
      maxBytes: DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES,
    });
    assertNotInterrupted();
    const dependenciesResult = flattenInstalledDependencyList(dependencyJson);
    const nodeModules = join(directories.consumer, 'node_modules');
    const tree = await runtime.scanPhysicalTree(nodeModules);
    assertNotInterrupted();
    const familyPackages = await collectResolvedFamilyRows(
      runtime,
      directories,
      tarballRows,
      dependenciesResult.locations,
    );
    assertNotInterrupted();

    emitStage(runtime, 'measuring fresh-process startup');
    const startup = await measureInstalledCliStartup({
      command: installedCliCommand,
      cwd: directories.consumer,
      environment,
      repeats: options.repeats,
      runCommand: runtime.runMeasuredCommand,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      summarize: summarizeDurationSamples,
    });
    assertNotInterrupted();
    assertNoSentinelRequests(sentinel);
    const lockfileSha256 = await runtime.sha256File(join(directories.consumer, 'pnpm-lock.yaml'));
    assertNotInterrupted();

    completedReport = createDistributionFootprintReport({
      generatedAt: runtime.now(),
      environment: {
        nodeVersion: process.version,
        pnpmVersion,
        npmVersion,
        platform: operatingSystemPlatform,
        architecture: operatingSystemArchitecture,
        osRelease: runtime.operatingSystemRelease(),
      },
      release: {
        cliVersion: options.expectedVersion,
        gitSha,
        artifactSetSha256: artifactHash,
        tarballs: tarballRows,
      },
      measurement: {
        mode: options.mode,
        repeats: options.repeats,
        ...(options.mode === 'registry-cold' ? { registryOrigin: options.registryOrigin } : {}),
      },
      install: {
        durationMs: install.durationMs,
        maxRssBytes: install.maxRssBytes,
        tree,
        dependencyCount: dependenciesResult.closure.length,
        dependencyClosure: dependenciesResult.closure,
        lockfileSha256,
      },
      startup,
      languageFamilies: groupLanguageFamilyFootprints(tarballRows, familyPackages),
      caveats: DISTRIBUTION_FOOTPRINT_CAVEATS,
    });
  } finally {
    try {
      await Promise.allSettled([...activeChildCalls]);
      await sentinel?.close();
      assertNoSentinelRequests(sentinel);
    } finally {
      try {
        if (temporaryRoot !== undefined) {
          await runtime.removeTemporaryRoot(temporaryRoot, runtime.filesystem);
        }
      } finally {
        runnerSignalReservation.complete();
      }
    }
  }
  assertNotInterrupted();
  await runtime.writeReport(options.outputPath, completedReport, {
    filesystem: runtime.filesystem,
  });
  emitStage(
    runtime,
    `complete: ${String(completedReport.install.tree.bytes)} installed bytes, ${String(completedReport.install.dependencyCount)} dependencies`,
  );
  return { help: false, report: completedReport };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const result = await runDistributionMeasurement();
    if (result.help) process.stdout.write(`${result.text}\n`);
  } catch (error) {
    // Surface the fail-loud reason from pure/arg/runtime layers. Do not dump
    // stacks or environment values here — the message is the operator signal.
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[distribution-measure] failed; no report was written. ${detail}\n`,
    );
    process.exitCode = 1;
  }
}
