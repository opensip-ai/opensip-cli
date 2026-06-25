#!/usr/bin/env node
// Local release lane runner. This intentionally mirrors the tag-driven release
// workflow before publish and forces coverage tests to recompute instead of
// accepting Turbo cache hits.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_ORDER } from './release-package-order.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TARBALL_PREFIX = join(tmpdir(), 'opensip-cli-release-tarballs-');

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/core/package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') {
    throw new TypeError('packages/core/package.json has no string version');
  }
  return pkg.version;
}

function parseArgs(argv) {
  const out = {
    expectedVersion: `v${readVersion()}`,
    tarballDir: mkdtempSync(DEFAULT_TARBALL_PREFIX),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expected-version') {
      const value = argv[++i];
      if (!value) throw new Error('--expected-version requires a value');
      out.expectedVersion = value;
    } else if (arg === '--tarball-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--tarball-dir requires a value');
      out.tarballDir = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function run(label, command, args, opts = {}) {
  console.log(`\n[release-preflight] ${label}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: false,
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? '<signal>'}`);
  }
}

function pnpm(label, args) {
  run(label, 'pnpm', args);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  pnpm('install frozen lockfile', ['install', '--frozen-lockfile']);
  pnpm('clean package outputs', ['-r', 'run', 'clean']);
  run('build with injected workspace re-sync', 'node', ['scripts/build-ci.mjs']);
  pnpm('typecheck', ['typecheck']);
  pnpm('supply-chain policy', ['supply-chain:verify']);
  pnpm('lint', ['lint']);
  pnpm('test with fresh coverage thresholds', ['test:coverage:fresh']);
  pnpm('fit dogfood gate', ['fit:ci']);
  pnpm('graph dogfood gate', ['graph:ci']);
  pnpm('release consistency', ['verify-release', '--expected-version', args.expectedVersion]);

  rmSync(args.tarballDir, { recursive: true, force: true });
  mkdirSync(args.tarballDir, { recursive: true });
  for (const pkg of RELEASE_PACKAGE_ORDER) {
    pnpm(`pack ${pkg.filter}`, [
      '--filter',
      pkg.filter,
      'pack',
      '--pack-destination',
      args.tarballDir,
    ]);
  }

  run('packed tarball smoke', 'node', [
    'scripts/smoke-pack.mjs',
    '--dir',
    args.tarballDir,
    '--expected-version',
    args.expectedVersion,
  ]);
}

try {
  main();
} catch (error) {
  console.error(
    `[release-preflight] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
