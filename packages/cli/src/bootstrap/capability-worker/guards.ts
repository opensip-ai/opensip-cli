/**
 * Capability-worker resource guards — ADVISORY defense-in-depth, NOT a
 * containment boundary (plan 09 Phase 3, settled posture).
 *
 * In-process monkey-patching cannot be made sound in Node against malicious
 * code in the same isolate: a fresh `import('node:fs')` specifier variant,
 * `Reflect`-based prototype restoration, `worker_threads`, `vm`, or an
 * unpatched child process all recover original primitives, and Node documents
 * no in-process security boundary. The ENFORCED boundary is capability-pack
 * ADMISSION (operator trust + provenance binding in
 * `load-tool-capabilities.ts`); these patches are best-effort protection
 * against ACCIDENTAL overreach by operator-admitted code. True containment is
 * deferred to the process-level plugin-isolation roadmap.
 */

import { existsSync } from 'node:fs';
import module, { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPathInside } from '@opensip-cli/core';

import type { CapabilityBridgeResourceDecision } from '@opensip-cli/core';

const require = createRequire(import.meta.url);

function hasResource(
  resourceDecision: CapabilityBridgeResourceDecision,
  resource: 'filesystem' | 'network' | 'subprocess',
): boolean {
  return resourceDecision.allowedResources.some((requirement) => requirement.resource === resource);
}

/**
 * Best-effort block of a resource the pack's manifest did not declare. The
 * message is explicit that this is the advisory guard, not enforcement — the
 * admission decision is the boundary.
 *
 * @throws {Error} always; this is the patched builtin failure path.
 */
function denied(resource: string): never {
  throw new Error(
    `capability worker denied undeclared ${resource} access ` +
      '(advisory guard — admission is the enforced boundary)',
  );
}

function patchMethod<T extends Record<string, unknown>>(
  target: T,
  key: keyof T,
  resource: string,
): void {
  if (typeof target[key] === 'function') {
    target[key] = (() => denied(resource)) as T[keyof T];
  }
}

function patchSubprocess(): void {
  const childProcess = require('node:child_process') as Record<string, unknown>;
  for (const key of [
    'exec',
    'execFile',
    'execFileSync',
    'execSync',
    'fork',
    'spawn',
    'spawnSync',
  ]) {
    patchMethod(childProcess, key, 'subprocess');
  }
}

function patchNetwork(): void {
  for (const [moduleName, keys] of [
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:http', ['get', 'request']],
    ['node:https', ['get', 'request']],
    ['node:http2', ['connect']],
    ['node:dgram', ['createSocket']],
    ['node:dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveTxt']],
  ] as const) {
    const target = require(moduleName) as Record<string, unknown>;
    for (const key of keys) patchMethod(target, key, 'network');
  }
  // Global fetch is the modern outbound primitive — the old denylist omitted
  // it entirely, so a pack with network denied could still exfiltrate.
  globalThis.fetch = (() => denied('network')) as typeof fetch;
}

function patchFilesystem(cwd: string, packageDir: string): void {
  const fs = require('node:fs') as Record<string, unknown>;
  const fsPromises = require('node:fs/promises') as Record<string, unknown>;
  const roots = [resolve(cwd), resolve(packageDir)];
  const wrap = (fn: unknown): unknown =>
    typeof fn === 'function'
      ? (pathLike: unknown, ...rest: unknown[]) => {
          if (!isCapabilityFilesystemPathAllowed(pathLike, roots)) denied('filesystem');
          return (fn as (...args: unknown[]) => unknown)(pathLike, ...rest);
        }
      : fn;
  // The destructive APIs the old list omitted (rm/unlink/rename/mkdir/chmod/
  // createWriteStream) are exactly the ones an accidental overreach hurts
  // with most — they are patched alongside the read/write set. Keys missing
  // from a surface (e.g. no createWriteStream on fs/promises) are skipped by
  // the typeof guard in wrap().
  for (const key of [
    'readFileSync',
    'writeFileSync',
    'appendFileSync',
    'readdirSync',
    'statSync',
    'lstatSync',
    'openSync',
    'readFile',
    'writeFile',
    'appendFile',
    'readdir',
    'stat',
    'lstat',
    'open',
    'rm',
    'rmSync',
    'rmdir',
    'rmdirSync',
    'unlink',
    'unlinkSync',
    'rename',
    'renameSync',
    'mkdir',
    'mkdirSync',
    'chmod',
    'chmodSync',
    'createWriteStream',
    'createReadStream',
    'copyFile',
    'copyFileSync',
    'cp',
    'cpSync',
    'truncate',
    'truncateSync',
  ]) {
    fs[key] = wrap(fs[key]);
    fsPromises[key] = wrap(fsPromises[key]);
  }
}

/**
 * Realpath-based containment (Task 3.4): a symlink inside the allowed root
 * must not escape it, so the logical `resolve()+startsWith` check is gone.
 * A path whose leaf does not exist yet (a pack creating a new file) is
 * checked at its deepest EXISTING ancestor — the not-yet-existing suffix
 * cannot contain a symlink, and `resolve()` already normalized `..` away.
 * Unresolvable paths fail closed, consistent with `isPathInside`'s contract.
 */
export function isCapabilityFilesystemPathAllowed(
  pathLike: unknown,
  roots: readonly string[],
): boolean {
  const path = pathLikeToPathString(pathLike);
  if (path === undefined) return true;
  const anchor = deepestExistingAncestor(resolve(path));
  if (anchor === undefined) return false;
  return roots.some((root) => isPathInside(anchor, root));
}

/** The deepest ancestor of `absolute` that exists on disk (or `absolute` itself). */
function deepestExistingAncestor(absolute: string): string | undefined {
  let current = absolute;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current || basename(current) === '') return undefined;
    current = parent;
  }
}

function pathLikeToPathString(pathLike: unknown): string | undefined {
  if (typeof pathLike === 'string') return pathLike;
  if (Buffer.isBuffer(pathLike)) return pathLike.toString('utf8');
  if (pathLike instanceof URL && pathLike.protocol === 'file:') return fileURLToPath(pathLike);
  return undefined;
}

export function installCapabilityWorkerGuards(args: {
  readonly cwd: string;
  readonly packageDir: string;
  readonly resourceDecision: CapabilityBridgeResourceDecision;
}): void {
  if (!hasResource(args.resourceDecision, 'subprocess')) patchSubprocess();
  if (!hasResource(args.resourceDecision, 'network')) patchNetwork();
  if (!hasResource(args.resourceDecision, 'filesystem')) {
    patchFilesystem(args.cwd, args.packageDir);
  }
  module.syncBuiltinESMExports();
}
