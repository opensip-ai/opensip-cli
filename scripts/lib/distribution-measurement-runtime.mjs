import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';

import { killProcessTree } from '../perf/process-tree-rss.mjs';

export const DISTRIBUTION_CHILD_TAIL_BYTES = 64 * 1024;
export const DISTRIBUTION_JSON_CAPTURE_BYTES = 16 * 1024 * 1024;
export const DISTRIBUTION_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DISTRIBUTION_COMMAND_TIMEOUT_MS = 30 * 1000;
export const DISTRIBUTION_TERMINATION_GRACE_MS = 1000;
export const DISTRIBUTION_FORCE_KILL_SETTLEMENT_MS = 1000;

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

  const environment = {};
  for (const key of SAFE_INHERITED_ENV) {
    const value = input.baseEnvironment[key];
    if (typeof value === 'string') environment[key] = value;
  }
  Object.assign(environment, {
    CI: '1',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    OPENSIP_NO_UPDATE: '1',
    OTEL_SDK_DISABLED: 'true',
    HOME: input.directories.home,
    XDG_CACHE_HOME: input.directories.cache,
    XDG_CONFIG_HOME: input.directories.config,
    XDG_DATA_HOME: input.directories.data,
    XDG_STATE_HOME: input.directories.state,
    COREPACK_HOME: join(input.directories.cache, 'corepack'),
    PNPM_HOME: join(input.directories.data, 'pnpm'),
    npm_config_cache: join(input.directories.cache, 'npm'),
    npm_config_globalconfig: join(input.directories.config, 'global-npmrc'),
    npm_config_registry: input.registryOrigin,
    npm_config_userconfig: join(input.directories.config, 'npmrc'),
  });
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
  const lines = [
    'packages:',
    "  - '.'",
    'onlyBuiltDependencies:',
    '  - better-sqlite3',
    'overrides:',
  ];
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
      identities.set(`${safeName}\0${safeVersion}`, { name: safeName, version: safeVersion });
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
      command: [input.bin, ...scenario.arguments],
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
  const terminateProcessTree = input.terminateProcessTree ?? killProcessTree;
  const terminationGraceMs = input.terminationGraceMs ?? DISTRIBUTION_TERMINATION_GRACE_MS;
  const forceKillSettlementMs =
    input.forceKillSettlementMs ?? DISTRIBUTION_FORCE_KILL_SETTLEMENT_MS;
  const child = spawnChild(command, args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let timedOut = false;
  let commandTimeout;
  let terminationTimeout;
  let forceKillSettlementTimeout;
  const exit = await new Promise((resolveExit) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(commandTimeout);
      clearTimeout(terminationTimeout);
      clearTimeout(forceKillSettlementTimeout);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveExit(result);
    };
    const signalTree = (signal) => {
      if (child.pid === undefined) return;
      try {
        Promise.resolve(terminateProcessTree(child.pid, signal)).catch(() => false);
      } catch {
        // Termination is best-effort; the settlement deadline remains authoritative.
      }
    };
    const forceKill = () => {
      forceKillSettlementTimeout = setTimeout(
        () => settle({ code: undefined, error: undefined }),
        forceKillSettlementMs,
      );
      child.stdout?.destroy?.();
      try {
        child.kill?.('SIGKILL');
      } catch {
        // The root may already be gone; the tree-wide escalation remains best-effort.
      }
      signalTree('SIGKILL');
    };
    const terminate = () => {
      clearTimeout(commandTimeout);
      terminationTimeout = setTimeout(forceKill, terminationGraceMs);
      signalTree('SIGTERM');
    };
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > input.maxBytes) {
        if (!overflow && !timedOut) {
          overflow = true;
          terminate();
        }
        return;
      }
      chunks.push(buffer);
    }
    function onError(error) {
      settle({ code: undefined, error });
    }
    function onClose(code) {
      // `close` follows stdio closure; `exit` can precede the final stdout data
      // and would make a complete bounded JSON document look truncated.
      settle({ code, error: undefined });
    }

    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
    commandTimeout = setTimeout(() => {
      if (overflow || timedOut) return;
      timedOut = true;
      terminate();
    }, input.timeoutMs);
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
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('offline measurement sentinel\n');
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
    close: async () => {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
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
