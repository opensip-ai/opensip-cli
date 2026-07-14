import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, posix, win32 } from 'node:path';

import {
  createChildProcessTerminator,
  parentSignalCoordinator,
  reserveParentSignalCleanup,
} from '../perf/child-process-lifecycle.mjs';

export const DISTRIBUTION_CHILD_TAIL_BYTES = 64 * 1024;
export const DISTRIBUTION_JSON_CAPTURE_BYTES = 16 * 1024 * 1024;
export const DISTRIBUTION_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DISTRIBUTION_COMMAND_TIMEOUT_MS = 30 * 1000;
export const DISTRIBUTION_TERMINATION_GRACE_MS = 1000;
export const DISTRIBUTION_FORCE_KILL_SETTLEMENT_MS = 1000;
export const DISTRIBUTION_SENTINEL_CLOSE_TIMEOUT_MS = 1000;
export const DISTRIBUTION_INSTALLED_MANIFEST_MAX_BYTES = 64 * 1024;

const DISTRIBUTION_DESCENDANT_CAPTURE_INTERVAL_MS = 50;
const DISTRIBUTION_INSTALLED_BIN_TARGET_MAX_BYTES = 16 * 1024 * 1024;

const MAX_DEPENDENCY_ROWS = 20_000;
const MAX_DEPENDENCY_DEPTH = 64;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SAFE_INHERITED_ENV = new Set([
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
]);

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function pathApiForPlatform(platform) {
  return platform === 'win32' ? win32 : posix;
}

function validAbsoluteRuntimePath(value, pathApi) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    pathApi.isAbsolute(value) &&
    !CONTROL_CHARACTER.test(value)
  );
}

function safeNpmCliEntrypoint(candidate, pathApi) {
  return (
    validAbsoluteRuntimePath(candidate, pathApi) &&
    pathApi.basename(candidate).toLowerCase() === 'npm-cli.js'
  );
}

/** Resolve npm's local JavaScript entrypoint without relying on a shell shim. */
export async function resolveDistributionNpmCommand(input) {
  const filesystem = input.filesystem ?? fs;
  const pathApi = pathApiForPlatform(input.platform);
  if (!validAbsoluteRuntimePath(input.processExecutable, pathApi)) {
    throw new Error('The active Node executable path is invalid.');
  }
  const executableDirectory = pathApi.dirname(input.processExecutable);
  const candidates = [
    pathApi.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    pathApi.join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => safeNpmCliEntrypoint(candidate, pathApi));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const stats = await filesystem.stat(candidate);
      if (stats.isFile()) return Object.freeze([input.processExecutable, candidate]);
    } catch {
      // Try the next local npm runtime candidate. No shell or package manager is started here.
    }
  }
  throw new Error('The npm JavaScript runtime for the active Node installation is unavailable.');
}

/** Build the installed CLI command as Node + its portable JavaScript entrypoint. */
export function buildDistributionInstalledCliCommand(input) {
  const pathApi = pathApiForPlatform(input.platform);
  if (
    !validAbsoluteRuntimePath(input.processExecutable, pathApi) ||
    !validAbsoluteRuntimePath(input.consumerRoot, pathApi)
  ) {
    throw new Error('Installed CLI command paths must be absolute.');
  }
  return Object.freeze([
    input.processExecutable,
    pathApi.join(input.consumerRoot, 'node_modules', 'opensip-cli', 'dist', 'index.js'),
  ]);
}

async function requireDistributionRegularFile(filesystem, path, label) {
  const stats = await filesystem.stat(path);
  if (!stats.isFile()) throw new Error(`Installed CLI ${label} must be a regular file.`);
  return stats;
}

async function readDistributionBoundedRegularFile(filesystem, path, label, maxBytes) {
  let handle;
  try {
    handle = await filesystem.open(path, 'r');
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      !Number.isSafeInteger(stats.size) ||
      stats.size === 0 ||
      stats.size > maxBytes
    ) {
      throw new Error(`Installed CLI ${label} must be a 1-${String(maxBytes)}-byte regular file.`);
    }
    const buffer = Buffer.alloc(stats.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const finalStats = await handle.stat();
    if (offset !== stats.size || finalStats.size !== stats.size) {
      throw new Error(`Installed CLI ${label} changed while it was being validated.`);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle?.close();
  }
}

/**
 * Validate npm's installed `opensip` bin contract before measuring its JS target.
 *
 * The measurement invokes Node + the declared target so the argv-only process
 * path is portable across POSIX shims and Windows `.cmd` wrappers. Requiring the
 * generated shim as well prevents a broken published bin from passing merely
 * because the implementation file exists.
 */
export async function validateDistributionInstalledCli(input) {
  const filesystem = input.filesystem ?? fs;
  const pathApi = pathApiForPlatform(input.platform);
  const command = buildDistributionInstalledCliCommand(input);
  const packageRoot = pathApi.join(input.consumerRoot, 'node_modules', 'opensip-cli');
  const manifestPath = pathApi.join(packageRoot, 'package.json');
  const shimPath = pathApi.join(
    input.consumerRoot,
    'node_modules',
    '.bin',
    input.platform === 'win32' ? 'opensip.cmd' : 'opensip',
  );
  const manifestText = await readDistributionBoundedRegularFile(
    filesystem,
    manifestPath,
    'package manifest',
    DISTRIBUTION_INSTALLED_MANIFEST_MAX_BYTES,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('Installed CLI package manifest is not valid JSON.');
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.name !== 'opensip-cli' ||
    manifest.bin === null ||
    typeof manifest.bin !== 'object' ||
    Array.isArray(manifest.bin) ||
    manifest.bin.opensip !== './dist/index.js'
  ) {
    throw new Error('Installed CLI package manifest must declare bin.opensip as ./dist/index.js.');
  }
  const targetStats = await requireDistributionRegularFile(filesystem, command[1], 'bin target');
  if (
    !Number.isSafeInteger(targetStats.size) ||
    targetStats.size === 0 ||
    targetStats.size > DISTRIBUTION_INSTALLED_BIN_TARGET_MAX_BYTES
  ) {
    throw new Error('Installed CLI bin target must be a bounded non-empty file.');
  }
  const shimStats = await requireDistributionRegularFile(
    filesystem,
    shimPath,
    'generated bin shim',
  );
  if (
    !Number.isSafeInteger(shimStats.size) ||
    shimStats.size === 0 ||
    shimStats.size > DISTRIBUTION_INSTALLED_MANIFEST_MAX_BYTES
  ) {
    throw new Error('Installed CLI generated bin shim must be a bounded non-empty file.');
  }
  if (input.platform !== 'win32') await filesystem.access(shimPath, fsConstants.X_OK);
  return Object.freeze({ command, manifestPath, shimPath });
}

/** Locate the active Node installation prefix used by node-gyp. */
export function distributionNodeInstallationDirectory(input) {
  const pathApi = pathApiForPlatform(input.platform);
  if (!validAbsoluteRuntimePath(input.processExecutable, pathApi)) {
    throw new Error('The active Node executable path is invalid.');
  }
  const executableDirectory = pathApi.dirname(input.processExecutable);
  return input.platform === 'win32' ? executableDirectory : pathApi.dirname(executableDirectory);
}

function isSensitivePackageEnvironmentKey(key) {
  const normalized = key.toUpperCase();
  return (
    /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/u.test(normalized) ||
    /^(?:NODE_AUTH_TOKEN|NPM_TOKEN|PNPM_TOKEN|COREPACK_NPM_TOKEN)$/u.test(normalized) ||
    /^(?:NPM|PNPM)_CONFIG_.*(?:AUTH|TOKEN|PASSWORD|USERNAME|REGISTRY|PROXY|USERCONFIG|GLOBALCONFIG|STORE_DIR|CACHE_DIR|CONFIG_DIR|STATE_DIR|GLOBAL_DIR|VIRTUAL_STORE_DIR)/u.test(
      normalized,
    )
  );
}

export function sensitivePackageEnvironmentKeys(environment) {
  return Object.keys(environment)
    .filter((key) => isSensitivePackageEnvironmentKey(key))
    .sort(compareStrings);
}

/** Build a secret-free child environment with caller-independent config roots. */
export function buildDistributionChildEnvironment(input) {
  const sensitiveKeys = sensitivePackageEnvironmentKeys(input.baseEnvironment);
  if (input.mode === 'registry-cold' && sensitiveKeys.length > 0) {
    throw new Error(
      `registry-cold refuses inherited package-manager auth/proxy/registry overrides: ${sensitiveKeys.join(', ')}`,
    );
  }

  const platform = input.platform ?? process.platform;
  const pathApi = pathApiForPlatform(platform);
  const environment = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = input.baseEnvironment[key];
    if (typeof value === 'string') environment[key] = value;
  }
  Object.assign(environment, {
    CI: '1',
    COREPACK_ENABLE_NETWORK: '0',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    OPENSIP_NO_UPDATE: '1',
    OTEL_SDK_DISABLED: 'true',
    HOME: input.directories.home,
    XDG_CACHE_HOME: input.directories.cache,
    XDG_CONFIG_HOME: input.directories.config,
    XDG_DATA_HOME: input.directories.data,
    XDG_STATE_HOME: input.directories.state,
    COREPACK_HOME: pathApi.join(input.directories.cache, 'corepack'),
    PNPM_HOME: pathApi.join(input.directories.data, 'pnpm'),
    npm_config_cache: pathApi.join(input.directories.cache, 'npm'),
    npm_config_globalconfig: pathApi.join(input.directories.config, 'global-npmrc'),
    npm_config_registry: input.registryOrigin,
    npm_config_userconfig: pathApi.join(input.directories.config, 'npmrc'),
  });
  if (input.mode === 'offline-cache') {
    const nodeDirectory = input.nodeDirectory;
    const nodeGypDevDirectory = input.nodeGypDevDirectory;
    const nativeBuildDirectory = platform === 'win32' ? nodeGypDevDirectory : nodeDirectory;
    if (
      typeof nativeBuildDirectory !== 'string' ||
      nativeBuildDirectory.length === 0 ||
      nativeBuildDirectory.length > 4096 ||
      !pathApi.isAbsolute(nativeBuildDirectory) ||
      CONTROL_CHARACTER.test(nativeBuildDirectory) ||
      (platform === 'win32' ? nodeDirectory !== undefined : nodeGypDevDirectory !== undefined)
    ) {
      throw new Error('offline-cache requires one platform-appropriate local Node build root.');
    }
    Object.assign(environment, {
      // better-sqlite3 is the only admitted lifecycle build. Force its
      // prebuild-install branch to fall through without contacting GitHub,
      // then make node-gyp use isolated, exact-version local headers.
      npm_config_build_from_source: 'true',
      ...(platform === 'win32'
        ? { npm_config_devdir: nodeGypDevDirectory }
        : { npm_config_nodedir: nodeDirectory }),
      npm_config_offline: 'true',
      // npm lifecycle clients (including prebuild-install) honor these forms;
      // pnpm 11 does not use them for registry resolution. Any attempted
      // lifecycle download therefore reaches the same counted sentinel.
      npm_config_https_proxy: input.registryOrigin,
      npm_config_proxy: input.registryOrigin,
    });
  }
  return Object.freeze(environment);
}

function safeTarballRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('A complete non-empty tarball row set is required.');
  }
  const names = new Set();
  return rows.map((row) => {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.packageName !== 'string' ||
      typeof row.filePath !== 'string' ||
      names.has(row.packageName)
    ) {
      throw new Error('Tarball rows must have unique packageName/filePath pairs.');
    }
    names.add(row.packageName);
    return { packageName: row.packageName, filePath: row.filePath };
  });
}

/** Create the disposable consumer manifest; pnpm settings stay under `pnpm`. */
export function buildDistributionConsumerManifest(rows, packageManager) {
  const safeRows = safeTarballRows(rows);
  const cli = safeRows.find((row) => row.packageName === 'opensip-cli');
  if (cli === undefined) throw new Error('The opensip-cli release tarball is required.');
  const overrides = Object.fromEntries(
    safeRows
      .filter((row) => row.packageName.startsWith('@opensip-cli/'))
      .map((row) => [row.packageName, `file:${row.filePath}`]),
  );
  return {
    name: 'opensip-cli-distribution-measurement',
    version: '0.0.0',
    private: true,
    ...(packageManager === undefined ? {} : { packageManager }),
    dependencies: { 'opensip-cli': `file:${cli.filePath}` },
    pnpm: { overrides },
  };
}

/** pnpm 11 reads lifecycle/override workspace settings from this root file. */
export function renderDistributionConsumerWorkspace(manifest) {
  const overrides = manifest?.pnpm?.overrides;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Consumer manifest must contain pnpm.overrides.');
  }
  const lines = ['packages:', "  - '.'", 'allowBuilds:', '  better-sqlite3: true', 'overrides:'];
  for (const [name, target] of Object.entries(overrides).sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(target)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Hash the canonical artifact identities without exposing caller-selected paths. */
export async function hashDistributionArtifactSet(input) {
  const aggregate = createHash('sha256');
  for (const row of input.tarballRows) {
    const digest = await input.sha256File(join(input.artifactDir, row.fileName));
    aggregate.update(row.fileName);
    aggregate.update('\0');
    aggregate.update(String(row.compressedBytes));
    aggregate.update('\0');
    aggregate.update(digest);
    aggregate.update('\n');
  }
  return aggregate.digest('hex');
}

function validDependencyText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`Installed dependency ${label} is invalid.`);
  }
  return value;
}

/** Project pnpm's recursive dependency JSON into bounded identity rows and private locations. */
export function flattenInstalledDependencyList(raw) {
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error('pnpm list must return exactly one consumer project.');
  }
  const project = raw[0];
  if (project === null || typeof project !== 'object') {
    throw new Error('pnpm list returned an invalid consumer project.');
  }
  const identities = new Map();
  const locations = new Map();
  let visited = 0;

  const walk = (dependencies, depth) => {
    if (dependencies === undefined) return;
    if (depth > MAX_DEPENDENCY_DEPTH) {
      throw new Error(`Installed dependency depth exceeds ${MAX_DEPENDENCY_DEPTH}.`);
    }
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error('pnpm list returned an invalid dependency map.');
    }
    for (const name of Object.keys(dependencies).sort()) {
      visited += 1;
      if (visited > MAX_DEPENDENCY_ROWS) {
        throw new Error(`Installed dependency rows exceed ${MAX_DEPENDENCY_ROWS}.`);
      }
      const node = dependencies[name];
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error('pnpm list returned an invalid dependency node.');
      }
      const safeName = validDependencyText(name, 'name');
      const safeVersion = validDependencyText(node.version, 'version');
      identities.set(`${safeName}\0${safeVersion}`, {
        name: safeName,
        version: safeVersion,
      });
      if (typeof node.path === 'string' && node.path.length > 0) {
        const paths = locations.get(safeName) ?? new Set();
        paths.add(node.path);
        locations.set(safeName, paths);
      }
      walk(node.dependencies, depth + 1);
      walk(node.optionalDependencies, depth + 1);
    }
  };

  walk(project.dependencies, 1);
  walk(project.optionalDependencies, 1);
  const closure = [...identities.values()].sort((left, right) => {
    const nameOrder = compareStrings(left.name, right.name);
    return nameOrder === 0 ? compareStrings(left.version, right.version) : nameOrder;
  });
  if (closure.length === 0) throw new Error('Installed dependency closure is empty.');
  return {
    closure: Object.freeze(closure),
    locations: new Map(
      [...locations.entries()].map(([name, paths]) => [name, Object.freeze([...paths].sort())]),
    ),
  };
}

function requireSuccessfulStartup(result, label) {
  if (result.timedOut || result.status !== 0 || result.error !== undefined) {
    throw new Error(`${label} failed.`);
  }
  return result.durationMs;
}

async function measureStartupScenario(input, scenario) {
  const samples = [];
  for (let index = 0; index < input.repeats; index += 1) {
    const result = await input.runCommand({
      command: [...input.command, ...scenario.arguments],
      cwd: input.cwd,
      env: input.environment,
      timeoutMs: DISTRIBUTION_COMMAND_TIMEOUT_MS,
      stdoutTailBytes: DISTRIBUTION_CHILD_TAIL_BYTES,
      stderrTailBytes: DISTRIBUTION_CHILD_TAIL_BYTES,
      sampleIntervalMs: input.sampleIntervalMs,
    });
    samples.push(requireSuccessfulStartup(result, scenario.label));
  }
  return input.summarize(samples);
}

/** Measure each supported installed-CLI startup path in fresh sequential processes. */
export async function measureInstalledCliStartup(input) {
  return {
    version: await measureStartupScenario(input, {
      arguments: ['--version'],
      label: 'opensip --version',
    }),
    help: await measureStartupScenario(input, {
      arguments: ['--help'],
      label: 'opensip --help',
    }),
    initHelp: await measureStartupScenario(input, {
      arguments: ['init', '--help'],
      label: 'opensip init --help',
    }),
  };
}

/** Execute one bounded JSON child without a shell or unbounded stdout buffer. */
export async function runBoundedJsonCommand(input) {
  const [command, ...args] = input.command;
  if (command === undefined) throw new Error('A JSON child command is required.');
  const spawnChild = input.spawnChild ?? spawn;
  const useProcessGroup = input.useProcessGroup ?? process.platform !== 'win32';
  const terminationGraceMs = input.terminationGraceMs ?? DISTRIBUTION_TERMINATION_GRACE_MS;
  const forceKillSettlementMs =
    input.forceKillSettlementMs ?? DISTRIBUTION_FORCE_KILL_SETTLEMENT_MS;
  const descendantCaptureIntervalMs =
    input.descendantCaptureIntervalMs ?? DISTRIBUTION_DESCENDANT_CAPTURE_INTERVAL_MS;
  if (!Number.isSafeInteger(descendantCaptureIntervalMs) || descendantCaptureIntervalMs <= 0) {
    throw new RangeError('descendantCaptureIntervalMs must be a positive safe integer');
  }
  const parentReservation = reserveParentSignalCleanup(
    input.parentSignalCoordinator ?? parentSignalCoordinator,
  );
  if (parentReservation.interrupted()) {
    const signal = parentReservation.signal();
    parentReservation.complete();
    throw new Error(`JSON command interrupted by parent ${String(signal)} before spawn.`);
  }
  let child;
  try {
    child = spawnChild(command, args, {
      cwd: input.cwd,
      detached: useProcessGroup,
      env: input.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    parentReservation.complete();
    throw error;
  }
  const terminator = createChildProcessTerminator({
    captureProcessDescendants: input.captureProcessDescendants,
    child,
    killProcess: input.killProcess,
    killProcessTree: input.terminateProcessTree,
    platform: input.platform,
    useProcessGroup,
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let timedOut = false;
  let commandTimeout;
  let terminationTimeout;
  let forceKillSettlementTimeout;
  const descendantCaptureHandle = setInterval(() => {
    terminator.capture();
  }, descendantCaptureIntervalMs);
  terminator.capture();
  const exit = await new Promise((resolveExit) => {
    let settled = false;
    let closeResult;
    let forceSignalPromise;
    let terminationReason;
    let resolveTerminationComplete;
    const terminationComplete = new Promise((resolveComplete) => {
      resolveTerminationComplete = resolveComplete;
    });
    const cleanup = () => {
      clearTimeout(commandTimeout);
      clearTimeout(terminationTimeout);
      clearTimeout(forceKillSettlementTimeout);
      clearInterval(descendantCaptureHandle);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      parentReservation.complete();
      terminator.dispose();
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveTerminationComplete();
      resolveExit(result);
    };
    const forceKill = (rootClosed = false) => {
      if (forceSignalPromise !== undefined) return forceSignalPromise;
      clearTimeout(terminationTimeout);
      forceKillSettlementTimeout = setTimeout(
        () => settle(closeResult ?? { code: undefined, error: undefined }),
        forceKillSettlementMs,
      );
      child.stdout?.destroy?.();
      forceSignalPromise = Promise.resolve()
        .then(() =>
          rootClosed ? terminator.signalAfterRootClose('SIGKILL') : terminator.signal('SIGKILL'),
        )
        .catch(() => false);
      return forceSignalPromise;
    };
    const beginTermination = (reason) => {
      if (terminationReason !== undefined) return terminationComplete;
      terminationReason = reason;
      clearTimeout(commandTimeout);
      timedOut = reason === 'timeout';
      overflow = reason === 'overflow';
      terminationTimeout = setTimeout(forceKill, terminationGraceMs);
      Promise.resolve()
        .then(() => terminator.signal('SIGTERM'))
        .catch(() => false);
      return terminationComplete;
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > input.maxBytes) {
        beginTermination('overflow');
        return;
      }
      chunks.push(buffer);
    }
    function onError(error) {
      clearTimeout(commandTimeout);
      clearInterval(descendantCaptureHandle);
      terminator.markRootClosed();
      closeResult = { code: undefined, error };
      forceKill().finally(() => settle(closeResult));
    }
    function onClose(code) {
      // `close` follows stdio closure; `exit` can precede the final stdout data
      // and would make a complete bounded JSON document look truncated.
      clearTimeout(commandTimeout);
      clearInterval(descendantCaptureHandle);
      terminator.markRootClosed();
      closeResult = { code, error: undefined };
      forceKill(true).finally(() => settle(closeResult));
    }

    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
    parentReservation.activate(() => beginTermination('parent-signal'));
    commandTimeout = setTimeout(() => beginTermination('timeout'), input.timeoutMs);
  });
  if (overflow) throw new Error(`JSON child output exceeds ${input.maxBytes} bytes.`);
  if (timedOut) throw new Error(`JSON child exceeded ${input.timeoutMs} ms.`);
  if (exit.error !== undefined || exit.code !== 0) {
    throw new Error('JSON child command failed.');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error('JSON child returned malformed JSON.');
  }
  return parsed;
}

/** Start a zero-data loopback registry sentinel for the offline proof. */
export async function startDistributionNetworkSentinel() {
  let requestCount = 0;
  let closePromise;
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('offline measurement sentinel\n');
  });
  server.on('connection', (socket) => {
    // A TCP connection is already an attempted registry interaction, even if
    // the client stalls before emitting an HTTP request.
    requestCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind the offline network sentinel.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requestCount: () => requestCount,
    close: () => {
      closePromise ??= new Promise((resolveClose, rejectClose) => {
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error === undefined) resolveClose();
          else rejectClose(error);
        };
        const deadline = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          settle(new Error('offline network sentinel cleanup exceeded its deadline.'));
        }, DISTRIBUTION_SENTINEL_CLOSE_TIMEOUT_MS);
        server.close((error) => settle(error));
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

/** Atomically replace a JSON artifact through an exclusive, mode-0600 sibling. */
export async function writeDistributionReportAtomic(outputPath, value, dependencies = {}) {
  const filesystem = dependencies.filesystem ?? fs;
  const makeId = dependencies.makeId ?? randomUUID;
  await filesystem.mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${makeId()}.tmp`);
  let handle;
  try {
    handle = await filesystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await filesystem.rename(temporaryPath, outputPath);
  } catch (error) {
    await handle?.close().catch(() => false);
    await filesystem.rm(temporaryPath, { force: true }).catch(() => false);
    throw error;
  }
}
