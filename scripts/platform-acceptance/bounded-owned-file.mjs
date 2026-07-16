/**
 * @fileoverview Race-resistant bounded reads of candidate-produced side files.
 *
 * A path/realpath/stat/read sequence is vulnerable to replacement between the
 * checks and the read. This helper opens the asserted path with O_NOFOLLOW on
 * POSIX, fstats that exact descriptor, compares its device/inode to the prior
 * contained realpath observation, and reads at most `maxBytes + 1` from the fd.
 * A post-read fstat rejects in-place size/metadata changes during the read.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const DEFAULT_DEPENDENCIES = Object.freeze({
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
});

function isUnderOrEqual(root, target) {
  if (root === target) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function failure(prefix, suffix) {
  return Object.freeze({ ok: false, reasonCode: `${prefix}-${suffix}` });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(left, right) {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Open and read one bounded regular file without following a final symlink.
 * Unlike the owned-text helper this accepts relative paths and returns bytes;
 * it is used by hostile-input-facing repository utilities and verifiers.
 */
export function readBoundedFileBytes(input, dependencies = {}) {
  const fs = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const prefix = input.reasonPrefix ?? 'bounded-file';
  if (
    typeof input.path !== 'string' ||
    input.path.length === 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0
  ) {
    return failure(prefix, 'path-invalid');
  }
  let descriptor;
  try {
    const pathStat = fs.lstatSync(input.path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return failure(prefix, 'not-regular');
    }
    if (!Number.isSafeInteger(pathStat.size) || pathStat.size > input.maxBytes) {
      return failure(prefix, 'too-large');
    }
    const noFollow =
      process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number'
        ? 0
        : constants.O_NOFOLLOW;
    const nonBlock =
      process.platform === 'win32' || typeof constants.O_NONBLOCK !== 'number'
        ? 0
        : constants.O_NONBLOCK;
    descriptor = fs.openSync(input.path, constants.O_RDONLY | noFollow | nonBlock);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) return failure(prefix, 'not-regular');
    if (!sameFile(pathStat, openedStat)) return failure(prefix, 'changed-before-open');
    if (!Number.isSafeInteger(openedStat.size) || openedStat.size > input.maxBytes) {
      return failure(prefix, 'too-large');
    }
    const buffer = Buffer.alloc(input.maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > input.maxBytes) return failure(prefix, 'too-large');
    const completedStat = fs.fstatSync(descriptor);
    const completedPathStat = fs.lstatSync(input.path);
    if (
      !unchangedFile(openedStat, completedStat) ||
      completedStat.size !== offset ||
      !completedPathStat.isFile() ||
      completedPathStat.isSymbolicLink() ||
      !unchangedFile(completedStat, completedPathStat)
    ) {
      return failure(prefix, 'changed-during-read');
    }
    if (input.requireNonEmpty === true && offset === 0) return failure(prefix, 'empty');
    return Object.freeze({
      ok: true,
      buffer: Buffer.from(buffer.subarray(0, offset)),
      byteLength: offset,
    });
  } catch {
    return failure(prefix, 'unreadable');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The result is already fail-closed; close remains best-effort.
      }
    }
  }
}

/**
 * Read one absolute, regular, physically-owned file through the descriptor that
 * was actually checked. The return reason vocabulary is `<prefix>-...`.
 */
export function readBoundedOwnedTextFile(input, dependencies = {}) {
  const fs = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const prefix = input.reasonPrefix ?? 'owned-file';
  if (
    typeof input.path !== 'string' ||
    !isAbsolute(input.path) ||
    typeof input.root !== 'string' ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0
  ) {
    return failure(prefix, 'path-invalid');
  }

  let descriptor;
  try {
    const rootReal = fs.realpathSync(input.root);
    const fileReal = fs.realpathSync(input.path);
    if (!isUnderOrEqual(rootReal, fileReal)) return failure(prefix, 'path-escaped');

    const pathStat = fs.statSync(fileReal);
    if (!pathStat.isFile()) return failure(prefix, 'not-regular');
    if (!Number.isSafeInteger(pathStat.size) || pathStat.size > input.maxBytes) {
      return failure(prefix, 'too-large');
    }

    const noFollow =
      process.platform === 'win32' || typeof constants.O_NOFOLLOW !== 'number'
        ? 0
        : constants.O_NOFOLLOW;
    const nonBlock =
      process.platform === 'win32' || typeof constants.O_NONBLOCK !== 'number'
        ? 0
        : constants.O_NONBLOCK;
    descriptor = fs.openSync(input.path, constants.O_RDONLY | noFollow | nonBlock);
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile()) return failure(prefix, 'not-regular');
    if (!sameFile(pathStat, openedStat)) return failure(prefix, 'changed-before-open');
    if (!Number.isSafeInteger(openedStat.size) || openedStat.size > input.maxBytes) {
      return failure(prefix, 'too-large');
    }

    // Allocate one extra byte so growth beyond the bound is observed without an
    // unbounded read or trusting a mutable path stat.
    const buffer = Buffer.alloc(input.maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = fs.readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > input.maxBytes) return failure(prefix, 'too-large');

    const completedStat = fs.fstatSync(descriptor);
    const completedReal = fs.realpathSync(input.path);
    const completedPathStat = fs.statSync(completedReal);
    if (
      !unchangedFile(openedStat, completedStat) ||
      completedStat.size !== offset ||
      completedReal !== fileReal ||
      !completedPathStat.isFile() ||
      !unchangedFile(completedStat, completedPathStat)
    ) {
      return failure(prefix, 'changed-during-read');
    }
    if (input.requireNonEmpty === true && offset === 0) return failure(prefix, 'empty');
    return Object.freeze({
      ok: true,
      text: buffer.subarray(0, offset).toString('utf8'),
    });
  } catch {
    return failure(prefix, 'unreadable');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The read result is already fail-closed; close remains best-effort.
      }
    }
  }
}
