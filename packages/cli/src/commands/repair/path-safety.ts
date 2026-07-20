import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { err, ok, type Result } from '@opensip-cli/core';

import type { RepairError } from './types.js';

export const MAX_REPAIR_FILE_BYTES = 1024 * 1024;

export interface SafeRepairPath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface SafeTextFile extends SafeRepairPath {
  readonly content: string;
  readonly hash: string;
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeRelativePath(value: string): string {
  return value.split('\\').join('/');
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function repairError(code: string, message: string): RepairError {
  return { code, message };
}

export function resolveRepairTargetPath(
  projectRoot: string,
  rawPath: string,
): Result<SafeRepairPath, RepairError> {
  if (rawPath.trim() === '' || rawPath.includes('\0')) {
    return err(repairError('invalid-target', 'repair action target filePath is invalid'));
  }

  const root = realpathSync(resolve(projectRoot));
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  if (!isInsideRoot(root, absolutePath)) {
    return err(
      repairError('unsafe-path', `repair action target escapes the project root: ${rawPath}`),
    );
  }

  if (existsSync(absolutePath)) {
    const realPath = realpathSync(absolutePath);
    if (!isInsideRoot(root, realPath)) {
      return err(
        repairError(
          'unsafe-path',
          `repair action target resolves outside the project root: ${rawPath}`,
        ),
      );
    }
  }

  return ok({
    absolutePath,
    relativePath: normalizeRelativePath(relative(root, absolutePath)),
  });
}

export function readSafeTextFile(
  projectRoot: string,
  rawPath: string,
): Result<SafeTextFile, RepairError> {
  const resolved = resolveRepairTargetPath(projectRoot, rawPath);
  if (!resolved.ok) return resolved;

  if (!existsSync(resolved.value.absolutePath)) {
    return err(
      repairError('file-not-found', `repair target does not exist: ${resolved.value.relativePath}`),
    );
  }

  const stat = statSync(resolved.value.absolutePath);
  if (!stat.isFile()) {
    return err(
      repairError('invalid-target', `repair target is not a file: ${resolved.value.relativePath}`),
    );
  }
  if (stat.size > MAX_REPAIR_FILE_BYTES) {
    return err(
      repairError(
        'file-too-large',
        `repair target exceeds ${MAX_REPAIR_FILE_BYTES.toString()} bytes: ${resolved.value.relativePath}`,
      ),
    );
  }

  const content = readFileSync(resolved.value.absolutePath, 'utf8');
  return ok({ ...resolved.value, content, hash: sha256Text(content) });
}
