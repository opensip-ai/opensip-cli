import module, { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CapabilityBridgeResourceDecision } from '@opensip-cli/core';

const require = createRequire(import.meta.url);

function hasResource(
  resourceDecision: CapabilityBridgeResourceDecision,
  resource: 'filesystem' | 'network' | 'subprocess',
): boolean {
  return resourceDecision.allowedResources.some((requirement) => requirement.resource === resource);
}

/**
 * Stop a capability worker from using a resource its manifest did not declare.
 *
 * @throws {Error} always; this is the patched builtin failure path.
 */
function denied(resource: string): never {
  throw new Error(`capability worker denied undeclared ${resource} access`);
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
    ['node:dns', ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveTxt']],
  ] as const) {
    const target = require(moduleName) as Record<string, unknown>;
    for (const key of keys) patchMethod(target, key, 'network');
  }
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
  ]) {
    fs[key] = wrap(fs[key]);
    fsPromises[key] = wrap(fsPromises[key]);
  }
}

export function isCapabilityFilesystemPathAllowed(
  pathLike: unknown,
  roots: readonly string[],
): boolean {
  const path = pathLikeToPathString(pathLike);
  if (path === undefined) return true;
  const absolute = resolve(path);
  return roots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`));
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
