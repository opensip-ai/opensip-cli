import { lstatSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { buildDeterministicEnv } from './env.js';
import { HarnessPrerequisiteError, spawnProcess } from './spawn.js';

import type { SpawnOptions, SpawnResult } from './spawn.js';

const MAX_FIXTURE_FILES = 10_000;
const MAX_GIT_INVENTORY_BYTES = 2 * 1024 * 1024;
// `git ls-files` normally completes in well under a second, but the workspace
// coverage lane runs every package's tests concurrently, and under that IO/CPU
// contention the spawn+walk can exceed a tight bound. A generous ceiling keeps
// the harness prerequisite from failing spuriously on a loaded CI runner while
// staying bounded (it is still a hard timeout, not an unbounded wait).
const GIT_INVENTORY_TIMEOUT_MS = 60_000;

/** One validated Git-visible regular file belonging to a fixture. */
export interface FixtureInventoryFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

type InventorySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export interface FixtureInventoryOptions {
  readonly spawn?: InventorySpawn;
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function containedPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`);
}

function containedDirectory(root: string, directory: string): boolean {
  return root === directory || containedPath(root, directory);
}

/**
 * Canonicalize the inventory roots and bind their Git-relative pathspec.
 *
 * @throws {HarnessPrerequisiteError} When either root is unavailable or containment fails.
 */
function canonicalRoots(
  fixtureDirectory: string,
  repositoryRoot: string,
): { readonly directory: string; readonly root: string; readonly relativeDirectory: string } {
  let directory: string;
  let root: string;
  try {
    directory = realpathSync(fixtureDirectory);
    root = realpathSync(repositoryRoot);
  } catch {
    throw new HarnessPrerequisiteError('Agent-eval fixture Git inventory root is unavailable.');
  }
  if (!lstatSync(directory).isDirectory() || !containedDirectory(root, directory)) {
    throw new HarnessPrerequisiteError('Agent-eval fixture is outside its Git inventory root.');
  }
  const child = relative(root, directory);
  return { directory, root, relativeDirectory: child.length === 0 ? '.' : portablePath(child) };
}

/**
 * Query one bounded Git-visible inventory.
 *
 * @throws {HarnessPrerequisiteError} When Git fails, times out, or exceeds its output bound.
 */
async function gitInventory(
  root: string,
  relativeDirectory: string,
  execute: InventorySpawn,
): Promise<string> {
  const result = await execute(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relativeDirectory],
    {
      cwd: root,
      env: buildDeterministicEnv(),
      maxOutputBytes: MAX_GIT_INVENTORY_BYTES,
      timeoutMs: GIT_INVENTORY_TIMEOUT_MS,
    },
  );
  if (
    result.error !== undefined ||
    result.exitCode !== 0 ||
    result.outputLimitExceeded ||
    result.timedOut
  ) {
    const stderrTail = result.stderr.trim().slice(0, 600);
    const errorPart = result.error === undefined ? '' : `, error=${result.error}`;
    const stderrPart = stderrTail.length === 0 ? '' : `, stderr=${stderrTail}`;
    throw new HarnessPrerequisiteError(
      'Agent-eval fixture Git inventory is unavailable ' +
        `(exitCode=${String(result.exitCode)}, signal=${String(result.signal)}, ` +
        `timedOut=${result.timedOut}, outputLimitExceeded=${result.outputLimitExceeded}` +
        `${errorPart}${stderrPart}).`,
    );
  }
  return result.stdout;
}

/**
 * Validate every Git-returned fixture path and regular-file identity.
 *
 * @throws {HarnessPrerequisiteError | Error} When the inventory is empty, oversized, or unsafe.
 */
function validateInventoryPaths(
  output: string,
  directory: string,
  root: string,
): readonly FixtureInventoryFile[] {
  const paths = [...new Set(output.split('\0').filter((path) => path.length > 0))].sort(
    compareCodePoints,
  );
  if (paths.length === 0 || paths.length > MAX_FIXTURE_FILES) {
    throw new HarnessPrerequisiteError('Agent-eval fixture Git inventory file count is invalid.');
  }
  return paths.map((path): FixtureInventoryFile => {
    if (path.length > 4096 || /\p{C}/u.test(path)) {
      throw new HarnessPrerequisiteError('Agent-eval fixture Git inventory path is invalid.');
    }
    const absolutePath = resolve(root, path);
    if (!containedPath(directory, absolutePath)) {
      throw new HarnessPrerequisiteError('Agent-eval fixture Git inventory path escapes its root.');
    }
    const status = lstatSync(absolutePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new HarnessPrerequisiteError(
        'Agent-eval fixture Git inventory must contain regular files only.',
      );
    }
    return {
      absolutePath,
      relativePath: portablePath(relative(directory, absolutePath)),
    };
  });
}

/**
 * Return the exact tracked plus non-ignored-untracked regular-file set admitted
 * to both fixture hashing and execution. Git discovery is time/output bounded.
 *
 * @throws {HarnessPrerequisiteError} When Git or any inventory entry is unavailable or unsafe.
 */
export async function listGitVisibleFixtureFiles(
  fixtureDirectory: string,
  repositoryRoot: string,
  options: FixtureInventoryOptions = {},
): Promise<readonly FixtureInventoryFile[]> {
  const { directory, root, relativeDirectory } = canonicalRoots(fixtureDirectory, repositoryRoot);
  const output = await gitInventory(root, relativeDirectory, options.spawn ?? spawnProcess);
  return validateInventoryPaths(output, directory, root);
}
