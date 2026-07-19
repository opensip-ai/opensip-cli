/**
 * Stable filesystem identity facts used to bind no-init cache generations.
 *
 * All reads are bounded and failure degrades to path-only identity; mutable
 * workspace content never participates in the generation digest.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

interface StableDirectoryFact {
  readonly role: 'root' | 'gitdir';
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs?: string;
}

/** Compute the internal SHA-256 identity used by project path derivation. */
export function sha256PathIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableDirectoryFact(
  path: string,
  role: StableDirectoryFact['role'],
): StableDirectoryFact | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.dev <= 0n || stat.ino <= 0n) return undefined;
    return {
      role,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      ...(stat.birthtimeNs > 0n ? { birthtimeNs: stat.birthtimeNs.toString() } : {}),
    };
  } catch {
    // @swallow-ok An unavailable filesystem fact falls back to the weaker cache identity.
    return undefined;
  }
}

/** Read a small gitfile without allowing an atomic replacement to grow the read. */
function readBoundedGitFile(path: string): string | undefined {
  const limit = 4096;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return bytesRead > limit ? undefined : buffer.toString('utf8', 0, bytesRead);
  } catch {
    // @swallow-ok An unreadable gitfile cannot strengthen the project identity.
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // @swallow-ok Descriptor cleanup cannot strengthen or invalidate the root fact.
        // Identity discovery is read-only and degrades to the root fact.
      }
    }
  }
}

type GitDirectoryResolution =
  | { readonly status: 'absent' }
  | { readonly status: 'resolved'; readonly path: string }
  | { readonly status: 'unreliable' };

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function resolveGitDirectory(projectDir: string): GitDirectoryResolution {
  const dotGit = join(projectDir, '.git');
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      try {
        return { status: 'resolved', path: realpathSync(dotGit) };
      } catch {
        return { status: 'unreliable' };
      }
    }
    if (!stat.isFile()) return { status: 'unreliable' };
  } catch (error) {
    return isMissingPathError(error) ? { status: 'absent' } : { status: 'unreliable' };
  }

  const raw = readBoundedGitFile(dotGit);
  const match = raw?.match(/^\s*gitdir:\s*(.+?)\s*$/iu);
  if (match?.[1] === undefined || match[1].includes('\0')) return { status: 'unreliable' };
  const candidate = isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]);
  try {
    return { status: 'resolved', path: realpathSync(candidate) };
  } catch {
    return { status: 'unreliable' };
  }
}

/** Resolve a generation digest from reliable pre-existing root and gitdir facts. */
export function resolveGenerationDigest(projectDir: string): string | undefined {
  const root = stableDirectoryFact(projectDir, 'root');
  if (root === undefined) return undefined;

  const gitDirectory = resolveGitDirectory(projectDir);
  if (gitDirectory.status === 'unreliable') return undefined;
  if (gitDirectory.status === 'absent') {
    return sha256PathIdentity(`opensip-project-generation-v1\0${JSON.stringify([root])}`);
  }
  const gitdir = stableDirectoryFact(gitDirectory.path, 'gitdir');
  if (gitdir === undefined) return undefined;
  const facts = [root, gitdir];
  return sha256PathIdentity(`opensip-project-generation-v1\0${JSON.stringify(facts)}`);
}
