/**
 * @fileoverview Shell-free invocation descriptors for Node-distributed CLIs.
 *
 * Windows npm installs expose `.cmd` launchers. Node's `spawn`/`execFile` cannot
 * execute those launchers with `shell: false`, and routing arbitrary argv
 * through `cmd.exe /c` would require a second, fragile quoting language. The
 * acceptance harness therefore invokes npm's installed JavaScript entrypoint
 * with the current Node executable. Installed OpenSIP `.cmd` shims are handled
 * the same way, using the already-validated package `jsEntrypoint` descriptor.
 *
 * Every returned invocation is an executable plus an argv prefix. Callers append
 * their own argv tokens without joining or quoting them, so spaces and Unicode
 * remain ordinary data and no shell is involved.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const ACCEPTANCE_NPM_CLI_ENV = 'OPENSIP_ACCEPTANCE_NPM_CLI';

/** A bounded error that does not disclose searched host paths. */
export class NodeCliInvocationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NodeCliInvocationError';
  }
}

function isNpmCliName(value) {
  const nativeName = value.split(/[\\/]/).at(-1);
  return nativeName?.toLowerCase() === 'npm-cli.js';
}

function usableRealPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || !isAbsolute(candidate)) {
    return null;
  }
  try {
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return null;
    const real = realpathSync(candidate);
    return isNpmCliName(real) ? real : null;
  } catch {
    return null;
  }
}

function isUnder(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a shell-free npm invocation.
 *
 * Every platform resolves npm's JavaScript entrypoint from an explicit seam or
 * the dedicated acceptance environment seam or current Node installation, then
 * runs it with `process.execPath`. Ambient PATH launchers are intentionally ignored.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {string} [options.npmCliPath] explicit test/embedding seam.
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.nodeExecPath]
 * @returns {{ command: string, prefixArgs: readonly string[] }}
 */
export function resolveNpmInvocation(options = {}) {
  const env = options.env ?? process.env;
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const nodeDir = dirname(nodeExecPath);
  const nodeRoot = dirname(nodeDir);
  const candidates = [];
  if (options.npmCliPath !== undefined) {
    const explicit = usableRealPath(options.npmCliPath);
    if (explicit === null) {
      throw new NodeCliInvocationError('explicit npm JavaScript entrypoint is invalid');
    }
    return Object.freeze({ command: nodeExecPath, prefixArgs: Object.freeze([explicit]) });
  }

  const configuredNpmCli = env[ACCEPTANCE_NPM_CLI_ENV];
  if (configuredNpmCli !== undefined) {
    const configured = usableRealPath(configuredNpmCli);
    if (configured === null) {
      throw new NodeCliInvocationError('configured npm JavaScript entrypoint is invalid');
    }
    return Object.freeze({ command: nodeExecPath, prefixArgs: Object.freeze([configured]) });
  }

  const ambientNpmCli = env.npm_execpath;
  if (typeof ambientNpmCli === 'string' && isNpmCliName(ambientNpmCli)) {
    const ambientReal = usableRealPath(ambientNpmCli);
    if (ambientReal !== null && isUnder(nodeRoot, ambientReal)) candidates.push(ambientReal);
  }

  candidates.push(
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  );

  for (const candidate of new Set(candidates)) {
    const npmCli = usableRealPath(candidate);
    if (npmCli !== null && isUnder(nodeRoot, npmCli)) {
      return Object.freeze({
        command: nodeExecPath,
        prefixArgs: Object.freeze([npmCli]),
      });
    }
  }
  throw new NodeCliInvocationError('npm JavaScript entrypoint is unavailable beside Node');
}

/**
 * Turn an installed OpenSIP descriptor into a shell-free invocation. POSIX
 * executes the installed shim. A `.cmd` shim uses the validated JS entrypoint
 * through Node, avoiding `cmd.exe` entirely.
 *
 * @param {{ installedBin?: {bin?: string}, jsEntrypoint?: {script?: string} }} installed
 * @param {string} [nodeExecPath]
 * @returns {{ command: string, prefixArgs: readonly string[] }}
 */
export function resolveInstalledCliInvocation(installed, nodeExecPath = process.execPath) {
  const bin = installed?.installedBin?.bin;
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new NodeCliInvocationError('installed CLI descriptor has no executable path');
  }
  if (!bin.toLowerCase().endsWith('.cmd')) {
    return Object.freeze({ command: bin, prefixArgs: Object.freeze([]) });
  }
  const script = installed?.jsEntrypoint?.script;
  if (typeof script !== 'string' || script.length === 0) {
    throw new NodeCliInvocationError('installed Windows CLI descriptor has no JS entrypoint');
  }
  return Object.freeze({
    command: nodeExecPath,
    prefixArgs: Object.freeze([script]),
  });
}
