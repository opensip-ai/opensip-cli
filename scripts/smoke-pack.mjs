#!/usr/bin/env node
//
// Post-pack / pre-publish smoke test for opensip-tools releases.
//
// Installs the freshly-packed tarballs *together* into a throwaway
// consumer project and actually loads the CLI. This is the gate that
// catches inter-package export/ABI mismatches — the class of bug that
// version-string and dependency-range checks (verify-release.mjs)
// structurally cannot see.
//
// It exists because of the 2.0.0 incident: @opensip-tools/cli-ui@2.0.0
// was published from a stale build that did not export `RunFooterHints`,
// while @opensip-tools/fitness@2.0.0 imported it. Every version string
// said "2.0.0" and every dep range resolved — but the CLI crashed on
// startup with `SyntaxError: ... does not provide an export named
// 'RunFooterHints'`. The only thing that catches that is loading the
// packed bytes together.
//
// Why install from local tarballs instead of the registry: the versions
// we are about to publish are not on npm yet. A normal
// `npm install @opensip-tools/cli` would pull the *previously* published
// versions — i.e. test the wrong bytes. We force every @opensip-tools/*
// dependency (direct and transitive) to resolve to its freshly-packed
// tarball via npm `overrides`, so the test exercises exactly what will
// be published.
//
// Why `--version` is sufficient: tool registration runs at CLI startup,
// before argument parsing, and transitively imports every tool module
// (fitness/simulation/graph) and the shared cli-ui primitives. So merely
// loading the binary walks the whole import graph — which is precisely
// where the 2.0.0 crash occurred.
//
// Usage:
//   node scripts/smoke-pack.mjs                                  # /tmp/tarballs, version from packages/core
//   node scripts/smoke-pack.mjs --dir <path> --expected-version vX.Y.Z
//
// Exits 0 on success, 1 on any failure (so it gates the publish step).

import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = '@opensip-tools/';
const TARBALL_PREFIX = 'opensip-tools-';

// ---------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------

let tarballDir = '/tmp/tarballs';
let expectedVersion = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') tarballDir = argv[++i];
  else if (argv[i] === '--expected-version') expectedVersion = argv[++i];
}
if (expectedVersion?.startsWith('v')) expectedVersion = expectedVersion.slice(1);

const info = (msg) => console.log(`[smoke-pack] ${msg}`);
const fail = (msg) => {
  console.error(`[smoke-pack] ✗ ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------
// Resolve the consensus version (default: packages/core)
// ---------------------------------------------------------------------

if (expectedVersion === null) {
  const corePkg = JSON.parse(
    await fs.readFile(join(REPO_ROOT, 'packages/core/package.json'), 'utf8'),
  );
  expectedVersion = corePkg.version;
}
info(`expected version: ${expectedVersion}`);

// ---------------------------------------------------------------------
// Discover the packed tarballs
// ---------------------------------------------------------------------

if (!existsSync(tarballDir)) {
  fail(`tarball directory not found: ${tarballDir} (run the pack step first)`);
}

const tarballSuffix = `-${expectedVersion}.tgz`;
const tarballs = readdirSync(tarballDir).filter(
  (f) => f.startsWith(TARBALL_PREFIX) && f.endsWith(tarballSuffix),
);
if (tarballs.length === 0) {
  fail(`no ${TARBALL_PREFIX}*${tarballSuffix} tarballs found in ${tarballDir}`);
}

// pnpm pack names scoped packages `opensip-tools-<unscoped-name>-<version>.tgz`
// and the unscoped CLI package (`opensip-tools`) just `opensip-tools-<version>.tgz`.
// All packages share one version (verify-release.mjs enforces this), so the
// suffix is deterministic. The CLI tarball is the install entry point; every
// other tarball is a scoped transitive dep we force via `overrides`.
const cliFileName = `opensip-tools-${expectedVersion}.tgz`;
const overrides = {};
let cliTarball;
for (const file of tarballs) {
  if (file === cliFileName) {
    cliTarball = `file:${join(tarballDir, file)}`;
    continue;
  }
  const unscoped = file.slice(TARBALL_PREFIX.length, -tarballSuffix.length);
  overrides[`${SCOPE}${unscoped}`] = `file:${join(tarballDir, file)}`;
}
info(`discovered ${Object.keys(overrides).length} @opensip-tools/* tarball(s) + the opensip-tools CLI`);

if (!cliTarball) {
  fail(`opensip-tools tarball (${cliFileName}) missing from ${tarballDir} — cannot smoke-test the entry point`);
}

// ---------------------------------------------------------------------
// Build a throwaway consumer project and install the packed set
// ---------------------------------------------------------------------

const workDir = await fs.mkdtemp(join(tmpdir(), 'ost-smoke-'));
info(`consumer project: ${workDir}`);

// `dependencies` pulls cli from its local tarball; `overrides` forces
// every transitive @opensip-tools/* dep to the matching local tarball
// instead of the registry, so we test the about-to-publish bytes.
const consumerPkg = {
  name: 'opensip-tools-smoke',
  version: '0.0.0',
  private: true,
  dependencies: { 'opensip-tools': cliTarball },
  overrides,
};
await fs.writeFile(
  join(workDir, 'package.json'),
  `${JSON.stringify(consumerPkg, null, 2)}\n`,
);

// Run the installed CLI and surface its own stderr on failure. We catch
// rather than let execFileSync throw raw, so an import/ABI break shows up
// as a clean smoke-pack diagnostic (with the child's error) instead of a
// node stack trace — which is what a release engineer needs to read.
const runCli = (bin, cliArgs, label) => {
  try {
    // Capture stderr (don't forward to our stderr) so a failure is
    // reported once, through fail(), rather than also dumped live.
    return execFileSync(bin, cliArgs, {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const childErr = (err.stderr || err.stdout || err.message || '').toString().trim();
    fail(`${label} failed — the packed artifacts do not load together:\n${childErr}`);
  }
};

try {
  info('installing packed tarballs (this resolves the full inter-package graph)…');
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: workDir,
      stdio: 'inherit',
    });
  } catch {
    fail('npm install of the packed tarballs failed — a tarball is broken or a dep is unresolvable.');
  }

  // The real consumer entry point: the bin shim npm created.
  const bin = join(workDir, 'node_modules', '.bin', 'opensip-tools');
  if (!existsSync(bin)) {
    fail(`installed CLI bin not found at ${bin} — the cli package did not install correctly`);
  }

  // 1. --version: loads the full module graph (tool registration imports
  //    every tool + cli-ui at startup). This is exactly where 2.0.0 died.
  const version = runCli(bin, ['--version'], 'CLI --version').trim();
  if (version !== expectedVersion) {
    fail(`CLI --version reported "${version}", expected "${expectedVersion}"`);
  }
  info(`✓ CLI loads and reports ${version}`);

  // 2. --help: forces Commander to mount every tool's subcommands, a
  //    second, broader exercise of the same import graph. Exit 0 = the
  //    whole command tree assembled without an unresolved export.
  runCli(bin, ['--help'], 'CLI --help');
  info('✓ CLI --help mounts the full command tree');

  info('all packed-artifact smoke checks passed — safe to publish.');
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
