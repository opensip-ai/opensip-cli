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
function requireGitProvenanceOutput(result: Awaited<ReturnType<typeof spawnProcess>>): string {
  if (
    result.error !== undefined ||
    result.exitCode !== 0 ||
    result.outputLimitExceeded ||
    result.timedOut
  ) {
    throw new HarnessPrerequisiteError(
      'Git revision is unavailable; run agent-eval from a built repository checkout.',
    );
  }
  return result.stdout;
}

/** Resolve bounded Git revision/worktree and graph-relevant ignored-source snapshots. */
export function resolveGitProvenance(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<GitProvenance> {
  const options = {
    cwd: repositoryRoot,
    env: buildDeterministicEnv(),
    maxOutputBytes: GIT_OUTPUT_BYTES,
    timeoutMs: GIT_TIMEOUT_MS,
  };
  return Promise.all([
    spawnProcess(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      options,
    ),
    spawnProcess(
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
      options,
    ),
  ]).then(([status, ignoredSources]) => {
    try {
      return parseGitProvenance(
        requireGitProvenanceOutput(status),
        requireGitProvenanceOutput(ignoredSources),
      );
    } catch {
      throw new HarnessPrerequisiteError(
        'Git revision is unavailable; run agent-eval from a built repository checkout.',
      );
    }
  });
}
