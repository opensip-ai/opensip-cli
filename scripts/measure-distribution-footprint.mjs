#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { arch, platform, release as osRelease, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  flattenInstalledDependencyList,
  hashDistributionArtifactSet,
  measureInstalledCliStartup,
  renderDistributionConsumerWorkspace,
  runBoundedJsonCommand,
  startDistributionNetworkSentinel,
  writeDistributionReportAtomic,
} from './lib/distribution-measurement-runtime.mjs';
import { sha256File } from './lib/release-artifacts.mjs';
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
    cwd: process.cwd(),
    filesystem: fs,
    now: () => new Date().toISOString(),
    operatingSystemPlatform: platform,
    operatingSystemRelease: osRelease,
    parseArgs: parseDistributionMeasureArgs,
    removeTemporaryRoot: async (root, filesystem) =>
      await filesystem.rm(root, { recursive: true, force: true }),
    runBoundedJsonCommand,
    runMeasuredCommand,
    scanPhysicalTree,
    scanResolvedPackage,
    sha256File,
    startNetworkSentinel: startDistributionNetworkSentinel,
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

function consumerTarballRows(options, tarballRows) {
  return tarballRows.map((row) => ({
    packageName: row.packageName,
    filePath: join(options.artifactDir, row.fileName),
  }));
}

async function prepareConsumer(runtime, temporaryRoot, options, tarballRows) {
  const directories = {
    consumer: join(temporaryRoot, 'consumer'),
    home: join(temporaryRoot, 'home'),
    cache: join(temporaryRoot, 'cache'),
    config: join(temporaryRoot, 'config'),
    data: join(temporaryRoot, 'data'),
    state: join(temporaryRoot, 'state'),
    coldStore: join(temporaryRoot, 'cold-store'),
  };
  await Promise.all(
    Object.values(directories).map((directory) =>
      runtime.filesystem.mkdir(directory, { recursive: true }),
    ),
  );
  const rootManifest = JSON.parse(
    await runtime.filesystem.readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const manifest = buildDistributionConsumerManifest(
    consumerTarballRows(options, tarballRows),
    rootManifest.packageManager,
  );
  await Promise.all([
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
    runtime.filesystem.writeFile(join(directories.config, 'npmrc'), '', { mode: 0o600 }),
    runtime.filesystem.writeFile(join(directories.config, 'global-npmrc'), '', { mode: 0o600 }),
  ]);
  return directories;
}

export function buildDistributionInstallCommand(options, directories, registryOrigin) {
  const storeDir = options.mode === 'offline-cache' ? options.storeDir : directories.coldStore;
  return [
    'pnpm',
    'install',
    '--prod',
    '--no-frozen-lockfile',
    '--reporter=silent',
    '--store-dir',
    storeDir,
    '--registry',
    registryOrigin,
    ...(options.mode === 'offline-cache' ? ['--offline'] : []),
  ];
}

async function packageLookupRoot(runtime, consumerRoot, packageName, locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`Installed package ${packageName} has no resolved location.`);
  }
  const [realConsumer, location] = await Promise.all([
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
  const runtime = runtimeDependencies(dependencies);
  const options = runtime.parseArgs(argv, { cwd: runtime.cwd });
  if (options.help) return { help: true, text: distributionMeasureHelp() };

  const tarballRows = runtime.collectReleaseTarballRows(
    options.artifactDir,
    options.expectedVersion,
  );
  const temporaryRoot = await runtime.filesystem.mkdtemp(
    join(runtime.temporaryDirectory(), 'opensip-distribution-measure-'),
  );
  let sentinel;
  let completedReport;
  try {
    emitStage(runtime, 'validating the complete local release set');
    const directories = await prepareConsumer(runtime, temporaryRoot, options, tarballRows);
    if (options.mode === 'offline-cache') sentinel = await runtime.startNetworkSentinel();
    const registryOrigin =
      options.mode === 'offline-cache' ? sentinel.origin : options.registryOrigin;
    const environment = buildDistributionChildEnvironment({
      baseEnvironment: runtime.baseEnvironment,
      directories,
      mode: options.mode,
      registryOrigin,
    });

    const [pnpmVersion, npmVersion, gitSha, artifactHash] = await Promise.all([
      readCommandIdentity(runtime, {
        command: ['pnpm', '--version'],
        cwd: directories.consumer,
        environment,
        label: 'pnpm --version',
      }),
      readCommandIdentity(runtime, {
        command: ['npm', '--version'],
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
        artifactDir: options.artifactDir,
        tarballRows,
        sha256File: runtime.sha256File,
      }),
    ]);

    emitStage(
      runtime,
      "package-manager lifecycle behavior runs with the current user's authority; this is not a sandbox",
    );
    emitStage(runtime, 'installing the isolated packed consumer');
    const install = successfulCommand(
      await runtime.runMeasuredCommand({
        command: buildDistributionInstallCommand(options, directories, registryOrigin),
        cwd: directories.consumer,
        env: environment,
        timeoutMs: DISTRIBUTION_INSTALL_TIMEOUT_MS,
        stdoutTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
        stderrTailBytes: DISTRIBUTION_CHILD_TAIL_MAX_BYTES,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      }),
      'packed consumer install',
    );
    if (sentinel !== undefined && sentinel.requestCount() !== 0) {
      throw new Error('offline-cache attempted a registry request.');
    }

    const bin = join(directories.consumer, 'node_modules', '.bin', 'opensip');
    await runtime.filesystem.access(bin);
    const installedCliVersion = await readCommandIdentity(runtime, {
      command: [bin, '--version'],
      cwd: directories.consumer,
      environment,
      label: 'installed opensip --version',
    });
    if (installedCliVersion.replace(/^v/u, '') !== options.expectedVersion) {
      throw new Error('Installed opensip version does not match the release input.');
    }
    const dependencyJson = await runtime.runBoundedJsonCommand({
      command: ['pnpm', 'list', '--prod', '--depth', 'Infinity', '--json'],
      cwd: directories.consumer,
      env: environment,
      timeoutMs: DISTRIBUTION_COMMAND_TIMEOUT_MS,
      maxBytes: DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES,
    });
    const dependenciesResult = flattenInstalledDependencyList(dependencyJson);
    const nodeModules = join(directories.consumer, 'node_modules');
    const tree = await runtime.scanPhysicalTree(nodeModules);
    const familyPackages = await collectResolvedFamilyRows(
      runtime,
      directories,
      tarballRows,
      dependenciesResult.locations,
    );

    emitStage(runtime, 'measuring fresh-process startup');
    const startup = await measureInstalledCliStartup({
      bin,
      cwd: directories.consumer,
      environment,
      repeats: options.repeats,
      runCommand: runtime.runMeasuredCommand,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      summarize: summarizeDurationSamples,
    });
    if (sentinel !== undefined && sentinel.requestCount() !== 0) {
      throw new Error('offline-cache attempted a registry request.');
    }
    const lockfileSha256 = await runtime.sha256File(join(directories.consumer, 'pnpm-lock.yaml'));

    completedReport = createDistributionFootprintReport({
      generatedAt: runtime.now(),
      environment: {
        nodeVersion: process.version,
        pnpmVersion,
        npmVersion,
        platform: runtime.operatingSystemPlatform(),
        architecture: runtime.architecture(),
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
      await sentinel?.close();
    } finally {
      await runtime.removeTemporaryRoot(temporaryRoot, runtime.filesystem);
    }
  }
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
  } catch {
    process.stderr.write(
      '[distribution-measure] failed; no report was written. Verify the documented prerequisites.\n',
    );
    process.exitCode = 1;
  }
}
