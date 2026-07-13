import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { projectConfigIdentity } from '@opensip-cli/codebase';
import { resolveChangedFiles } from '@opensip-cli/core';

import type { TaskContextSourceIdentity } from '@opensip-cli/contracts';

const execFileAsync = promisify(execFile);
const MAX_GIT_METADATA_BYTES = 256 * 1024;
const MAX_WORKTREE_FILES = 2048;
const MAX_WORKTREE_CONTENT_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 5000;

class SourceIdentityUnavailable extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/** Stable identity of the entered, already-validated config document. */
export function taskContextConfigIdentity(
  document: Readonly<Record<string, unknown>> | undefined,
): string {
  return projectConfigIdentity(document);
}

async function git(cwd: string, args: readonly string[], maxBuffer: number): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function gitBytes(
  cwd: string,
  args: readonly string[],
  maxBuffer = MAX_GIT_METADATA_BYTES,
): Promise<Buffer> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    windowsHide: true,
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Resolve a Git-reported path beneath the canonical root without following it.
 *
 * @throws {SourceIdentityUnavailable} When the path is absolute, contains a NUL,
 * or escapes the canonical root.
 */
function safeEntryPath(root: string, gitPath: string): string {
  if (isAbsolute(gitPath) || gitPath.includes('\0')) {
    throw new SourceIdentityUnavailable('git-worktree-path-unsupported');
  }
  const absolute = resolve(root, gitPath);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new SourceIdentityUnavailable('git-worktree-path-unsupported');
  }
  return absolute;
}

function projectRelativeChangedPath(
  projectRoot: string,
  gitRoot: string,
  gitPath: string,
): string | undefined {
  const absolute = safeEntryPath(gitRoot, gitPath);
  const fromProject = relative(projectRoot, absolute);
  if (isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith(`..${sep}`)) {
    return undefined;
  }
  return fromProject.split(sep).join('/');
}

async function closeForRestat(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<string> {
  await handle.close();
  return path;
}

/**
 * Hash one regular file through a no-follow handle and verify it stayed stable.
 *
 * @throws {SourceIdentityUnavailable} When the content budget is exceeded or
 * the file changes while being read.
 * @throws {Error} When filesystem metadata, open, read, or close operations fail.
 */
async function hashRegularFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  budget: { bytes: number },
): Promise<void> {
  const before = await lstat(path);
  if (before.size > MAX_WORKTREE_CONTENT_BYTES - budget.bytes) {
    throw new SourceIdentityUnavailable('git-worktree-content-cap');
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  let observed = 0;
  let restatPath = path;
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    // @sequential-ok — one no-follow handle has an ordered cursor, and the
    // digest plus shared byte budget must observe chunks in file order.
    while (true) {
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      observed += read.bytesRead;
      budget.bytes += read.bytesRead;
      if (budget.bytes > MAX_WORKTREE_CONTENT_BYTES) {
        throw new SourceIdentityUnavailable('git-worktree-content-cap');
      }
      hash.update(chunk.subarray(0, read.bytesRead));
    }
  } finally {
    restatPath = await closeForRestat(handle, path);
  }
  // The close result supplies the path explicitly: post-read metadata must be
  // captured only after the file descriptor is released.
  const after = await lstat(restatPath);
  if (
    observed !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.ino !== before.ino
  ) {
    throw new SourceIdentityUnavailable('git-worktree-unstable');
  }
}

/**
 * Add one deterministic path/type/content record to the worktree digest.
 *
 * @throws {SourceIdentityUnavailable} When a path escapes the root, an entry
 * type is unsupported, a content cap is reached, or the file is unstable.
 * @throws {Error} When filesystem metadata, symlink, or file reads fail.
 */
async function hashEntry(
  hash: ReturnType<typeof createHash>,
  root: string,
  gitPath: string,
  budget: { bytes: number },
): Promise<void> {
  const path = safeEntryPath(root, gitPath);
  hash.update('\0path\0').update(gitPath, 'utf8');
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      hash.update('\0missing\0');
      return;
    }
    throw error;
  }
  hash.update('\0mode\0').update(String(stat.mode));
  if (stat.isSymbolicLink()) {
    hash.update('\0symlink\0').update(await readlink(path), 'utf8');
    return;
  }
  if (!stat.isFile()) {
    throw new SourceIdentityUnavailable('git-worktree-entry-unsupported');
  }
  hash.update('\0file\0');
  await hashRegularFile(hash, path, budget);
}

/**
 * Build the bounded, privacy-safe digest for changes inside one project root.
 *
 * @throws {SourceIdentityUnavailable} When changed-file discovery fails, a cap
 * is exceeded, a path is unsafe, or an entry cannot be hashed deterministically.
 * @throws {Error} When Git metadata or filesystem operations fail.
 */
async function worktreeState(
  cwd: string,
  projectRoot: string,
  gitRoot: string,
): Promise<{
  readonly identity: string;
  readonly dirty: boolean;
}> {
  const changed = resolveChangedFiles(gitRoot);
  if (!changed.ok) {
    throw new SourceIdentityUnavailable(`git-worktree-files-${changed.reason}`);
  }
  const [unstagedMetadata, stagedMetadata] = await Promise.all([
    gitBytes(cwd, ['diff', '--relative', '--no-ext-diff', '--raw', '--no-abbrev', '-z', '--', '.']),
    gitBytes(cwd, [
      'diff',
      '--relative',
      '--cached',
      '--no-ext-diff',
      '--raw',
      '--no-abbrev',
      '-z',
      '--',
      '.',
    ]),
  ]);
  const paths = [
    ...new Set(
      changed.files.flatMap((path) => {
        const projected = projectRelativeChangedPath(projectRoot, gitRoot, path);
        return projected === undefined ? [] : [projected];
      }),
    ),
  ].sort(compareCodePoint);
  if (paths.length > MAX_WORKTREE_FILES) {
    throw new SourceIdentityUnavailable('git-worktree-file-cap');
  }

  const hash = createHash('sha256');
  hash.update('opensip-task-context-worktree-v2\0');
  hash.update(unstagedMetadata);
  hash.update('\0staged\0');
  hash.update(stagedMetadata);
  const budget = { bytes: 0 };
  // @sequential-ok — the bounded path list feeds one digest and one cumulative
  // byte budget in canonical order; parallel writes would change both semantics.
  for (const path of paths) await hashEntry(hash, projectRoot, path, budget);
  return {
    identity: `sha256:${hash.digest('hex')}`,
    dirty: paths.length > 0 || unstagedMetadata.length > 0 || stagedMetadata.length > 0,
  };
}

/**
 * Capture bounded source identity without persisting paths, diffs, remotes, or
 * author data. Git failures are a typed unsupported state, never a thrown path.
 */
export async function captureTaskContextSourceIdentity(input: {
  readonly cwd: string;
  readonly configDocument?: Readonly<Record<string, unknown>>;
}): Promise<TaskContextSourceIdentity> {
  const configIdentity = taskContextConfigIdentity(input.configDocument);
  try {
    const [canonicalCwd, gitRoot] = await Promise.all([
      realpath(input.cwd),
      git(input.cwd, ['rev-parse', '--show-toplevel'], 4096),
    ]);
    const canonicalGitRoot = await realpath(gitRoot);
    const fromGitRoot = relative(canonicalGitRoot, canonicalCwd);
    if (isAbsolute(fromGitRoot) || fromGitRoot === '..' || fromGitRoot.startsWith(`..${sep}`)) {
      return {
        configIdentity,
        status: 'unsupported',
        reasonCodes: ['git-root-mismatch'],
      };
    }
    const [gitHead, worktree] = await Promise.all([
      git(input.cwd, ['rev-parse', 'HEAD'], 4096),
      worktreeState(input.cwd, canonicalCwd, canonicalGitRoot),
    ]);
    return {
      configIdentity,
      gitHead,
      worktreeIdentity: worktree.identity,
      dirty: worktree.dirty,
      status: 'captured',
      reasonCodes: [],
    };
  } catch (error) {
    return {
      configIdentity,
      status: 'unsupported',
      reasonCodes: [
        error instanceof SourceIdentityUnavailable ? error.reasonCode : 'git-unavailable',
      ],
    };
  }
}

export function taskContextSourceIdentityEqual(
  left: TaskContextSourceIdentity,
  right: TaskContextSourceIdentity,
): boolean {
  return (
    left.status === right.status &&
    left.configIdentity === right.configIdentity &&
    left.gitHead === right.gitHead &&
    left.worktreeIdentity === right.worktreeIdentity &&
    left.dirty === right.dirty
  );
}
