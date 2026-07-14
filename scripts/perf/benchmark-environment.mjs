import { execFile } from 'node:child_process';
import { arch, cpus, platform, release } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const METADATA_COMMAND_TIMEOUT_MS = 2000;
const METADATA_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
export const BENCHMARK_NODE_OPTIONS = '--max-old-space-size=8192';
const CLEAN_WALL_EXACT_ENV_KEYS = new Set([
  'BAGGAGE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'TRACEPARENT',
  'TRACESTATE',
]);

/**
 * Return a copy of an environment with every OpenTelemetry/profiling input removed.
 *
 * Matching is case-insensitive so the isolation also holds on Windows. Removing
 * every `OTEL_*` key avoids a signal-specific endpoint or header overriding a
 * sanitized base endpoint and accidentally enabling export during clean-wall runs.
 */
export function createCleanWallChildEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && !isCleanWallExcludedEnvKey(key),
    ),
  );
}

/** Collect bounded, best-effort facts needed to reproduce one benchmark report. */
export async function collectBenchmarkEnvironment(input = {}) {
  const environment = input.env ?? process.env;
  const processors = (input.cpus ?? cpus)();
  const execute = input.execFileAsync ?? execFileAsync;
  const pnpmFromUserAgent = parsePnpmVersion(environment.npm_config_user_agent);
  const [pnpmFromCommand, gitSha, gitBranch] = await Promise.all([
    pnpmFromUserAgent === undefined
      ? readCommandText(execute, 'pnpm', ['--version'], input.repoRoot)
      : undefined,
    readCommandText(execute, 'git', ['rev-parse', 'HEAD'], input.repoRoot),
    readCommandText(execute, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], input.repoRoot),
  ]);

  return {
    node: input.nodeVersion ?? process.version,
    pnpm: pnpmFromUserAgent ?? pnpmFromCommand ?? 'unavailable',
    arch: (input.arch ?? arch)(),
    platform: (input.platform ?? platform)(),
    release: (input.release ?? release)(),
    cpuModel: normalizeOptionalText(processors[0]?.model),
    cpuCount: processors.length,
    ci: environment.CI === 'true',
    gitSha,
    gitBranch,
  };
}

function isCleanWallExcludedEnvKey(key) {
  const canonical = key.toUpperCase();
  return (
    canonical.startsWith('OPENSIP_') ||
    canonical.startsWith('OTEL_') ||
    CLEAN_WALL_EXACT_ENV_KEYS.has(canonical)
  );
}

function parsePnpmVersion(userAgent) {
  if (typeof userAgent !== 'string') return;
  return /(?:^|\s)pnpm\/([^\s]+)/u.exec(userAgent)?.[1];
}

async function readCommandText(execute, command, args, cwd) {
  try {
    const result = await execute(command, args, {
      cwd,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: METADATA_COMMAND_MAX_BUFFER_BYTES,
      timeout: METADATA_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return normalizeOptionalText(result.stdout);
  } catch {
    return;
  }
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string') return;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
