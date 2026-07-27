import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDeterministicEnv } from './env.js';
import { HarnessPrerequisiteError, spawnProcess } from './spawn.js';

const DEFAULT_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GIT_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const GRAPH_RELEVANT_IGNORED_PATHS = [
  '*.c',
  '*.cc',
  '*.cjs',
  '*.cpp',
  '*.cts',
  '*.cxx',
  '*.go',
  '*.h',
  '*.hh',
  '*.hpp',
  '*.hxx',
  '*.java',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.mts',
  '*.py',
  '*.pyi',
  '*.rs',
  '*.ts',
  '*.tsx',
  'CMakeLists.txt',
  'Cargo.lock',
  'Cargo.toml',
  'build.gradle',
  'build.gradle.kts',
  'compile_commands.json',
  'go.mod',
  'go.sum',
  'go.work',
  'gradle.lockfile',
  'meson.build',
  'opensip-cli.config.yml',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements*.txt',
  'settings.gradle*',
  'setup.cfg',
  'setup.py',
  'tsconfig*.json',
  ':(exclude)node_modules/**',
  ':(exclude)**/node_modules/**',
  ':(exclude)dist/**',
  ':(exclude)**/dist/**',
  ':(exclude)build/**',
  ':(exclude)**/build/**',
  ':(exclude)**/__fixtures__/**',
  ':(exclude)**/.runtime/**',
  ':(exclude)**/.turbo/**',
  ':(exclude)**/coverage/**',
  ':(exclude)packages/agent-eval/results/**',
];

export interface GitProvenance {
  readonly gitSha: string;
  readonly worktreeDirty: boolean;
}

type GitProvenanceSpawn = typeof spawnProcess;

export interface GitProvenanceOptions {
  readonly spawn?: GitProvenanceSpawn;
}

/**
 * Parse bounded Git status and ignored-source inventories into provenance.
 *
 * @throws {HarnessPrerequisiteError} When the status has no valid Git revision.
 */
export function parseGitProvenance(output: string, ignoredSourceOutput = ''): GitProvenance {
  const lines = output.split(/\r?\n/gu).filter((line) => line.length > 0);
  const oidLine = lines.find((line) => line.startsWith('# branch.oid '));
  const gitSha = oidLine?.slice('# branch.oid '.length).trim() ?? '';
  if (!/^[0-9a-f]{7,40}$/iu.test(gitSha)) {
    throw new HarnessPrerequisiteError(
      'Git revision is unavailable; run agent-eval from a built repository checkout.',
    );
  }
  return {
    gitSha: gitSha.slice(0, 12),
    worktreeDirty: ignoredSourceOutput.length > 0 || lines.some((line) => !line.startsWith('# ')),
  };
}

/**
 * Require one bounded Git subprocess result.
 *
 * @throws {HarnessPrerequisiteError} When Git fails, times out, or exceeds its output bound.
 */
function gitQueryFailure(result: Awaited<ReturnType<typeof spawnProcess>>): string | undefined {
  if (result.timedOut) return 'timed out';
  if (result.outputLimitExceeded) return 'exceeded its output bound';
  if (result.error !== undefined) {
    const code = result.errorCode === undefined ? '' : ` (${result.errorCode})`;
    return `could not start${code}`;
  }
  if (result.exitCode === null) {
    return result.signal === null
      ? 'closed without an exit code'
      : `was terminated by ${result.signal}`;
  }
  if (result.exitCode !== 0) return `exited with code ${String(result.exitCode)}`;
  return undefined;
}

function requireGitProvenanceOutput(
  result: Awaited<ReturnType<typeof spawnProcess>>,
  query: 'ignored-source inventory' | 'status',
): string {
  const failure = gitQueryFailure(result);
  if (failure !== undefined) {
    throw new HarnessPrerequisiteError(`Git ${query} query ${failure}.`);
  }
  return result.stdout;
}

/** Resolve bounded Git revision/worktree and graph-relevant ignored-source snapshots. */
export function resolveGitProvenance(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  dependencies: GitProvenanceOptions = {},
): Promise<GitProvenance> {
  const spawnOptions = {
    cwd: repositoryRoot,
    env: buildDeterministicEnv(),
    maxOutputBytes: GIT_OUTPUT_BYTES,
    timeoutMs: GIT_TIMEOUT_MS,
  };
  const execute = dependencies.spawn ?? spawnProcess;
  return Promise.all([
    execute(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      spawnOptions,
    ),
    execute(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ...GRAPH_RELEVANT_IGNORED_PATHS,
      ],
      spawnOptions,
    ),
  ]).then(([status, ignoredSources]) =>
    parseGitProvenance(
      requireGitProvenanceOutput(status, 'status'),
      requireGitProvenanceOutput(ignoredSources, 'ignored-source inventory'),
    ),
  );
}
