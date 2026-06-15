#!/usr/bin/env node
//
// Post-pack / pre-publish smoke test for opensip-cli releases.
//
// Installs the freshly-packed tarballs *together* into a throwaway
// consumer project and actually loads the CLI. This is the gate that
// catches inter-package export/ABI mismatches — the class of bug that
// version-string and dependency-range checks (verify-release.mjs)
// structurally cannot see.
//
// It exists because version-string and dependency-range checks can still miss
// stale build output: every package can agree on a version while one tarball is
// missing an export another package imports. The only thing that catches that is
// loading the packed bytes together.
//
// Why install from local tarballs instead of the registry: the versions
// we are about to publish are not on npm yet. A normal
// `npm install @opensip-cli/cli` would pull the *previously* published
// versions — i.e. test the wrong bytes. We force every @opensip-cli/*
// dependency (direct and transitive) to resolve to its freshly-packed
// tarball via npm `overrides`, so the test exercises exactly what will
// be published.
//
// What runs after install: a command-level scenario set
// (`smoke-pack-scenarios.mjs`) driven through the shared, dependency-free
// CLI acceptance core (`cli-acceptance-core.mjs`) against the installed
// bin — the same core the in-repo Vitest harness uses, so scenario semantics
// are identical in both lanes. `--version` alone already walks the whole
// import graph (tool registration runs at CLI startup, before argument
// parsing, transitively importing every tool module + cli-ui — precisely
// where stale-build crashes occur); the broader scenario set additionally
// exercises init/fit/graph/dashboard/sessions and both plugin-install paths.
//
// Usage:
//   node scripts/smoke-pack.mjs                                  # /tmp/tarballs, version from packages/core
//   node scripts/smoke-pack.mjs --dir <path> --expected-version v<version>
//
// Exits 0 on success, 1 on any failure (so it gates the publish step).

import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenarios } from './cli-acceptance-core.mjs';
import { buildPackedSmokeScenarios } from './smoke-pack-scenarios.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = '@opensip-cli/';
const TARBALL_PREFIX = 'opensip-cli-';

// ---------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------

// The default is the agreed handoff path with release.yml's pack step
// (`pnpm pack --pack-destination /tmp/tarballs`). The publicly-writable-dir
// concern doesn't apply: this is a release smoke test that runs only in an
// ephemeral, single-tenant CI runner, and the path is overridable with --dir.
// eslint-disable-next-line sonarjs/publicly-writable-directories
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

// pnpm pack names scoped packages `opensip-cli-<unscoped-name>-<version>.tgz`
// and the unscoped CLI package (`opensip-cli`) just `opensip-cli-<version>.tgz`.
// All packages share one version (verify-release.mjs enforces this), so the
// suffix is deterministic. The CLI tarball is the install entry point; every
// other tarball is a scoped transitive dep we force via `overrides`.
const cliFileName = `opensip-cli-${expectedVersion}.tgz`;
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
info(`discovered ${Object.keys(overrides).length} @opensip-cli/* tarball(s) + the opensip-cli CLI`);

if (!cliTarball) {
  fail(
    `opensip-cli tarball (${cliFileName}) missing from ${tarballDir} — cannot smoke-test the entry point`,
  );
}

// ---------------------------------------------------------------------
// Build a throwaway consumer project and install the packed set
// ---------------------------------------------------------------------

const workDir = await fs.mkdtemp(join(tmpdir(), 'ost-smoke-'));
info(`consumer project: ${workDir}`);

// `dependencies` pulls cli from its local tarball; `overrides` forces
// every transitive @opensip-cli/* dep to the matching local tarball
// instead of the registry, so we test the about-to-publish bytes.
const consumerPkg = {
  name: 'opensip-cli-smoke',
  version: '0.0.0',
  private: true,
  dependencies: { 'opensip-cli': cliTarball },
  overrides,
};
await fs.writeFile(join(workDir, 'package.json'), `${JSON.stringify(consumerPkg, null, 2)}\n`);

// Pack a fixture plugin dir (under packages/cli/.../fixtures/) into a .tgz in
// the work dir and return the absolute tarball path. `npm pack` prints the
// produced filename on its last stdout line; we resolve it against the
// destination. Used to exercise the third-party plugin-install paths
// (kind:"tool" + kind:"fit-pack") with real packed bytes.
const packFixture = (fixtureDir, label) => {
  let out;
  try {
    out = execFileSync('npm', ['pack', '--pack-destination', workDir, fixtureDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const childErr = (error.stderr || error.stdout || error.message || '').toString().trim();
    fail(`failed to pack ${label} fixture (${fixtureDir}):\n${childErr}`);
  }
  const tarballName = out.trim().split('\n').pop().trim();
  return join(workDir, tarballName);
};

try {
  info('installing packed tarballs (this resolves the full inter-package graph)…');
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], {
      cwd: workDir,
      stdio: 'inherit',
    });
  } catch {
    fail(
      'npm install of the packed tarballs failed — a tarball is broken or a dep is unresolvable.',
    );
  }

  // The real consumer entry point: the bin shim npm created.
  const bin = join(workDir, 'node_modules', '.bin', 'opensip-cli');
  if (!existsSync(bin)) {
    fail(`installed CLI bin not found at ${bin} — the cli package did not install correctly`);
  }

  // Pack the two third-party plugin fixtures so the plugin-install scenarios
  // exercise real packed bytes (not a workspace symlink).
  const fixturesDir = join(REPO_ROOT, 'packages', 'cli', 'src', '__tests__', 'fixtures');
  const toolPluginTarball = packFixture(join(fixturesDir, 'tool-plugin'), 'tool-plugin');
  const fitPackTarball = packFixture(join(fixturesDir, 'fit-pack-plugin'), 'fit-pack-plugin');

  info('running command-level smoke scenarios against the installed bin…');
  const descriptor = { kind: 'installed-bin', bin };
  const scenarios = buildPackedSmokeScenarios({
    expectedVersion,
    consumerCwd: workDir,
    toolPluginTarball,
    fitPackTarball,
  });
  const { results } = runScenarios(descriptor, scenarios);

  // Strict version assertion (the scenario set only substring-matches the
  // version; the legacy gate demanded exact equality on the packed bytes).
  const versionResult = results.find((r) => r.name.startsWith('--version'));
  if (versionResult) {
    const reported = versionResult.result.stdout.trim();
    if (reported !== expectedVersion) {
      versionResult.ok = false;
      versionResult.failures = [
        ...versionResult.failures,
        `--version reported "${reported}", expected exactly "${expectedVersion}"`,
      ];
    }
  }

  const hardFailures = results.filter((r) => !r.ok);
  const passed = results.length - hardFailures.length;
  for (const r of results) {
    info(`${r.ok ? '✓' : '✗'} ${r.name}`);
  }

  if (hardFailures.length > 0) {
    for (const r of hardFailures) {
      const childErr = (r.result.stderr || '').toString().trim();
      console.error(`[smoke-pack] ✗ ${r.name}`);
      for (const f of r.failures) console.error(`[smoke-pack]     - ${f}`);
      if (childErr) console.error(`[smoke-pack]     child stderr:\n${childErr}`);
    }
    fail(
      `${hardFailures.length}/${results.length} packed-smoke scenario(s) failed — the packed artifacts do not behave correctly together.`,
    );
  }

  info(`all ${passed}/${results.length} packed-artifact smoke scenarios passed — safe to publish.`);
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
