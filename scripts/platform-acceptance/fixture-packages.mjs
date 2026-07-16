/**
 * @fileoverview Bounded, path-safe packing of the FIXED repository fixtures used
 * by the extension-lifecycle journeys.
 *
 * There are exactly three fixtures — the whole-Tool, the fit-pack, and the
 * sim-pack — and their identities are FIXED in the repo. This module never
 * accepts a caller-selected fixture path: the caller supplies only a repo root
 * and a run-owned destination directory. Each fixture directory is derived from
 * the repo root, realpath'd, and required to resolve UNDER the fixtures root, so
 * a symlink escape or an out-of-root path is rejected before `npm pack` runs.
 * The destination must be an absolute, run-owned directory.
 *
 * `npm pack` is spawned with an argv array (never a shell), with a bounded
 * timeout and output buffer. Each produced tarball is verified to exist under
 * the destination before its absolute path is returned.
 *
 * Dependency-free apart from Node built-ins so a release script and the Phase 3
 * runner can import it with no build step. It spawns `npm` (harness setup) but
 * NEVER prints; failures throw a typed, reason-coded error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename as pathBasename, isAbsolute, join, relative } from 'node:path';

import { resolveNpmInvocation } from './node-cli-invocation.mjs';

/** The closed reason-code vocabulary for fixture packing. */
export const FIXTURE_REASON_CODES = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  MISSING_FIXTURE: 'missing-fixture',
  FIXTURE_ESCAPE: 'fixture-escape',
  INVALID_DESTINATION: 'invalid-destination',
  PACK_FAILED: 'pack-failed',
  TARBALL_MISSING: 'tarball-missing',
});

const R = FIXTURE_REASON_CODES;

/** The three FIXED fixtures, by result key -> basename under the fixtures root. */
const FIXED_FIXTURES = Object.freeze({
  toolPluginTarball: 'tool-plugin',
  fitPackTarball: 'fit-pack-plugin',
  simPackTarball: 'sim-pack-plugin',
});

const FIXTURES_SUBPATH = ['packages', 'cli', 'src', '__tests__', 'fixtures'];

const DEFAULT_PACK_TIMEOUT_MS = 120_000;
const MAX_PACK_BUFFER = 16 * 1024 * 1024;

/** A typed, reason-coded packing error. */
export class FixturePackError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = 'FixturePackError';
    this.reasonCode = reasonCode;
  }
}

/** True when `target` is a strict descendant of `root` (both already realpath'd). */
function isUnderRoot(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function realFixturesRoot(repoRoot) {
  let repoReal;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    throw new FixturePackError(R.INVALID_INPUT, 'repoRoot does not exist');
  }
  const fixturesRoot = join(repoReal, ...FIXTURES_SUBPATH);
  if (!existsSync(fixturesRoot)) {
    throw new FixturePackError(
      R.MISSING_FIXTURE,
      'the repository fixtures directory was not found',
    );
  }
  return realpathSync(fixturesRoot);
}

/**
 * Resolve one FIXED fixture directory under the fixtures root, rejecting a
 * symlink escape. Returns the realpath'd absolute directory.
 */
function resolveFixtureDir(fixturesRoot, basename) {
  const dir = join(fixturesRoot, basename);
  if (!existsSync(dir)) {
    throw new FixturePackError(
      R.MISSING_FIXTURE,
      `fixture ${JSON.stringify(basename)} was not found`,
    );
  }
  const real = realpathSync(dir);
  if (real !== join(fixturesRoot, basename) && !isUnderRoot(fixturesRoot, real)) {
    throw new FixturePackError(
      R.FIXTURE_ESCAPE,
      `fixture ${JSON.stringify(basename)} resolves outside the fixtures root`,
    );
  }
  return real;
}

/**
 * `npm pack` one fixture directory into `destReal`, returning the absolute
 * tarball path. Parses the JSON filename npm reports and verifies it landed.
 */
function packOne(npm, fixtureDir, destReal, timeoutMs, env) {
  const result = spawnSync(
    npm.command,
    [...npm.prefixArgs, 'pack', '--json', '--pack-destination', destReal, fixtureDir],
    {
      cwd: destReal,
      env,
      shell: false,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_PACK_BUFFER,
    },
  );
  if (result.status !== 0) {
    throw new FixturePackError(R.PACK_FAILED, `npm pack failed for ${fixtureDir}`);
  }
  let filename;
  try {
    const parsed = JSON.parse(result.stdout ?? '');
    filename = Array.isArray(parsed) ? parsed[0]?.filename : undefined;
  } catch {
    // Fall back to the last non-empty stdout line (older npm without --json).
    filename = (result.stdout ?? '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .findLast(Boolean);
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new FixturePackError(
      R.PACK_FAILED,
      `npm pack did not report a tarball filename for ${fixtureDir}`,
    );
  }
  if (
    filename !== pathBasename(filename) ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new FixturePackError(R.PACK_FAILED, 'npm pack reported an unsafe tarball filename');
  }
  const tarball = join(destReal, filename);
  if (!existsSync(tarball)) {
    throw new FixturePackError(
      R.TARBALL_MISSING,
      `packed tarball ${JSON.stringify(filename)} did not land in the destination`,
    );
  }
  const tarballReal = realpathSync(tarball);
  if (!isUnderRoot(destReal, tarballReal)) {
    throw new FixturePackError(R.FIXTURE_ESCAPE, 'packed tarball resolved outside the destination');
  }
  return tarballReal;
}

/**
 * Pack all three FIXED fixtures into a run-owned destination directory.
 *
 * @param {object} options
 * @param {string} options.repoRoot   absolute path to the repository root.
 * @param {string} options.destDir    absolute, existing, run-owned destination directory.
 * @param {string} [options.platform] defaults to `process.platform`.
 * @param {string} [options.npmCliPath] explicit npm JS entrypoint seam for Windows tests/embedding.
 * @param {Record<string,string>} [options.env] deterministic child env (defaults to `process.env`).
 * @param {number} [options.timeoutMs] per-pack timeout (default 120s).
 * @returns {{ toolPluginTarball: string, fitPackTarball: string, simPackTarball: string }}
 */
export function packFixtures(options) {
  if (typeof options !== 'object' || options === null) {
    throw new FixturePackError(R.INVALID_INPUT, 'options must be an object');
  }
  const { repoRoot, destDir } = options;
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    throw new FixturePackError(R.INVALID_INPUT, 'repoRoot must be an absolute path');
  }
  if (typeof destDir !== 'string' || !isAbsolute(destDir)) {
    throw new FixturePackError(R.INVALID_DESTINATION, 'destDir must be an absolute path');
  }
  if (!existsSync(destDir)) {
    throw new FixturePackError(R.INVALID_DESTINATION, 'destDir must exist');
  }
  const destReal = realpathSync(destDir);

  const platform = options.platform ?? process.platform;
  let npm;
  try {
    npm = resolveNpmInvocation({
      platform,
      npmCliPath: options.npmCliPath,
      env: options.env ?? process.env,
    });
  } catch {
    throw new FixturePackError(R.PACK_FAILED, 'npm JavaScript entrypoint is unavailable');
  }
  const timeoutMs =
    typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_PACK_TIMEOUT_MS;
  const env = options.env ?? process.env;

  const fixturesRoot = realFixturesRoot(repoRoot);
  const out = {};
  for (const [key, basename] of Object.entries(FIXED_FIXTURES)) {
    const fixtureDir = resolveFixtureDir(fixturesRoot, basename);
    out[key] = packOne(npm, fixtureDir, destReal, timeoutMs, env);
  }
  return Object.freeze(out);
}
