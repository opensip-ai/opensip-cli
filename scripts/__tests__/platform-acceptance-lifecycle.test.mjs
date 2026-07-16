/**
 * @fileoverview Phase 6 residual coverage — the isolated install/upgrade/removal
 * state machine (`candidate-lifecycle.mjs`).
 *
 * Uses the `runChild` injection seam exclusively — NO real npm, NO network. A
 * deterministic fake npm/CLI materializes (and later removes) the run-owned
 * install state so the real state machine, descriptor capture, hermetic env, and
 * cleanup accounting run end to end. Proves: valid transitions + rejection of
 * invalid ones; a credential-free, run-rooted child env (POSIX + Windows keys)
 * with ambient auth/proxy/token config dropped; spaces/Unicode paths staying
 * single argv entries; install/upgrade/uninstall fault classification; that every
 * candidate CLI call uses the installed descriptor (never a bare `opensip`); and
 * that cleanup is attempted once and never targets an ancestor.
 *
 * Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { CANDIDATE_REASON_CODES } from '../platform-acceptance/candidate-source.mjs';
import {
  CANDIDATE_LIFECYCLE_STATES as S,
  CandidateLifecycle,
  LIFECYCLE_REASON_CODES as L,
} from '../platform-acceptance/candidate-lifecycle.mjs';
import { expectedTarballName } from '../lib/release-artifacts.mjs';
import { registryIntegrityDigest } from '../lib/registry-integrity-inventory.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const roots = [];
function tmpRoot(prefix = 'pa-lifecycle-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resolvedPacked(version) {
  const sourceRoot = tmpRoot('pa-lifecycle-packed-');
  const tarballs = [
    ['opensip-cli', `opensip-cli-${version}.tgz`],
    ['@opensip-cli/core', `opensip-cli-core-${version}.tgz`],
  ].map(([packageName, fileName]) => {
    const sourcePath = join(sourceRoot, fileName);
    const content = `${packageName}@${version}\n`;
    writeFileSync(sourcePath, content);
    return {
      packageName,
      sourcePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: Buffer.byteLength(content),
    };
  });
  return {
    ok: true,
    identity: {
      kind: 'packed-release',
      version,
      source: `packed@${version}`,
      digest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
    },
    install: {
      kind: 'packed-release',
      directory: '/synthetic',
      cliTarball: `/synthetic/opensip-cli-${version}.tgz`,
      overrides: {},
      verifiedTarballs: tarballs,
      version,
    },
  };
}

function publishedInventory(version) {
  const inventory = {
    schemaVersion: 1,
    registry: 'https://registry.npmjs.org/',
    releaseVersion: version,
    manifestDigest: 'b'.repeat(64),
    packages: RELEASE_PACKAGE_ORDER.map((entry) => {
      const tarball = expectedTarballName(entry, version);
      const bytes = Buffer.from(`${entry.name}@${version}\n`);
      return {
        name: entry.name,
        version,
        tarball,
        tarballUrl: `https://registry.npmjs.org/${entry.name}/-/${tarball}`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  };
  return inventory;
}

function resolvedPublished(version, inventory) {
  return {
    ok: true,
    identity: {
      kind: 'published-version',
      version,
      source: `npm:opensip-cli@${version}`,
      digest: 'd'.repeat(64),
      registry: inventory.registry,
      manifestDigest: inventory.manifestDigest,
      registryIntegrityDigest: registryIntegrityDigest(inventory),
    },
    install: {
      kind: 'published-version',
      spec: `opensip-cli@${version}`,
      version,
      registry: inventory.registry,
    },
  };
}

/**
 * A deterministic fake npm + installed-CLI. It materializes the run-owned install
 * layout on `npm install`, removes it on `npm uninstall`, and honors installed-bin
 * `init` / `uninstall --project` calls. `faults` override the result for a phase.
 */
function makeFakeNpm(runRoot, options = {}) {
  const sessionLists = Array.isArray(options.sessionLists) ? [...options.sessionLists] : [];
  const state = {
    installVersion: options.installVersion ?? '0.7.0',
    faults: options.faults ?? {},
    sessionRecord: null,
    sessionListCount: 0,
  };
  const platform = options.platform ?? 'linux';
  const npmCliPath = options.npmCliPath;
  const consumerCwd = join(runRoot, 'consumer');
  const packageDir = join(consumerCwd, 'node_modules', 'opensip-cli');
  const binDir = join(consumerCwd, 'node_modules', '.bin');
  const binPath = join(binDir, platform === 'win32' ? 'opensip.cmd' : 'opensip');
  const jsPath = join(packageDir, 'dist', 'index.js');
  const runtimeDependencyPath = join(consumerCwd, 'node_modules', 'runtime-dependency', 'index.js');
  const projectDir = join(runRoot, 'project');
  const invocations = [];

  const runChild = (command, args, opts) => {
    invocations.push({ command, args: [...args], cwd: opts?.cwd });
    let npmArgs = null;
    if (command === 'npm') npmArgs = args;
    else if (
      command === process.execPath &&
      (args[0] === npmCliPath || /(?:^|[\\/])npm-cli\.js$/u.test(args[0] ?? ''))
    ) {
      npmArgs = args.slice(1);
    }
    const installedJsPath = existsSync(jsPath) ? realpathSync(jsPath) : jsPath;
    const cliArgs =
      command === process.execPath && args[0] === installedJsPath ? args.slice(1) : args;
    if (npmArgs?.[0] === '--version') return { status: 0, stdout: '10.0.0\n', stderr: '' };
    if (npmArgs?.[0] === 'install') {
      if (state.faults.install) return state.faults.install;
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      writeFileSync(jsPath, '#!/usr/bin/env node\n');
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'opensip-cli',
          version: state.installVersion,
          bin: { opensip: 'dist/index.js' },
        }),
      );
      mkdirSync(dirname(runtimeDependencyPath), { recursive: true });
      writeFileSync(
        runtimeDependencyPath,
        `export const installedVersion = ${JSON.stringify(state.installVersion)};\n`,
      );
      mkdirSync(binDir, { recursive: true });
      rmSync(binPath, { force: true });
      if (platform === 'win32') writeFileSync(binPath, '@echo off\n');
      else symlinkSync(jsPath, binPath);
      const consumer = JSON.parse(readFileSync(join(consumerCwd, 'package.json'), 'utf8'));
      const packages = {
        '': { dependencies: consumer.dependencies },
        'node_modules/opensip-cli': {
          name: 'opensip-cli',
          version: state.installVersion,
          resolved: consumer.dependencies['opensip-cli'],
        },
      };
      for (const [packageName, resolved] of Object.entries(consumer.overrides ?? {})) {
        packages[`node_modules/${packageName}`] = {
          name: packageName,
          version: state.installVersion,
          resolved,
        };
      }
      options.lockTransform?.(packages);
      writeFileSync(
        join(consumerCwd, 'package-lock.json'),
        JSON.stringify({ lockfileVersion: 3, packages }),
      );
      options.installTreeTransform?.({
        nodeModulesDir: join(consumerCwd, 'node_modules'),
        packageDir,
        runtimeDependencyPath,
      });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (npmArgs?.[0] === 'uninstall') {
      if (state.faults.packageRemove) return state.faults.packageRemove;
      rmSync(binPath, { force: true });
      rmSync(jsPath, { force: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    // installed-bin calls (command is the absolute run-owned bin path)
    if (cliArgs[0] === 'init') {
      if (state.faults.init) return state.faults.init;
      mkdirSync(join(projectDir, 'opensip-cli', '.runtime'), {
        recursive: true,
      });
      writeFileSync(join(projectDir, 'opensip-cli.config.yml'), 'x: 1\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cliArgs[0] === 'uninstall' && cliArgs.includes('--project')) {
      if (state.faults.cliStateRemove) return state.faults.cliStateRemove;
      rmSync(join(projectDir, 'opensip-cli', '.runtime'), {
        recursive: true,
        force: true,
      });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cliArgs[0] === 'graph') {
      if (state.faults.seed) return state.faults.seed;
      state.sessionRecord ??= {
        id: 'session-representative',
        tool: 'graph',
        cwd: projectDir,
        score: 100,
        passed: true,
        runOutcome: 'passed',
        startedAt: '2026-07-15T00:00:00.000Z',
        completedAt: '2026-07-15T00:00:01.000Z',
        durationMs: 1000,
        cliVersion: state.installVersion,
        engineVersion: state.installVersion,
        payload: {
          summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
        },
      };
      return { status: 0, stdout: '{}', stderr: '' };
    }
    if (cliArgs[0] === 'sessions') {
      state.sessionListCount += 1;
      const scripted = sessionLists[state.sessionListCount - 1];
      if (scripted !== undefined) return scripted;
      return {
        status: 0,
        stdout: JSON.stringify({
          data: { sessions: state.sessionRecord ? [state.sessionRecord] : [] },
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };

  return {
    runChild: (command, args, opts) => {
      const result = runChild(command, args, opts);
      return {
        ...result,
        cleanup: result.cleanup ?? { residualDescendants: 0 },
      };
    },
    state,
    invocations,
    paths: {
      consumerCwd,
      packageDir,
      binDir,
      binPath,
      jsPath,
      runtimeDependencyPath,
      projectDir,
    },
  };
}

function makePublishedFakeNpm(runRoot, inventory, options = {}) {
  const prefix = join(runRoot, 'npm-prefix');
  const packageDir = join(prefix, 'lib', 'node_modules', 'opensip-cli');
  const binDir = join(prefix, 'bin');
  const jsPath = join(packageDir, 'dist', 'index.js');
  const binPath = join(binDir, 'opensip');
  const selectedNames = new Set(['opensip-cli', '@opensip-cli/core']);
  const invocations = [];
  const materializeInstall = (version = inventory.releaseVersion) => {
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(jsPath, '#!/usr/bin/env node\n');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'opensip-cli',
        version,
        bin: { opensip: 'dist/index.js' },
      }),
    );
    rmSync(binPath, { force: true });
    symlinkSync(jsPath, binPath);
  };
  const runChild = (command, args, opts) => {
    invocations.push({ command, args: [...args], opts });
    let npmArgs = null;
    if (command === process.execPath && /(?:^|[\\/])npm-cli\.js$/u.test(args[0] ?? '')) {
      npmArgs = args.slice(1);
    } else if (command === 'npm') {
      npmArgs = args;
    }
    if (command === '/bin/sh' && args[0] === options.canonicalInstallerPath) {
      materializeInstall(opts?.env?.OPENSIP_CLI_VERSION);
      if (options.tamperCanonicalInstaller === true) {
        writeFileSync(options.canonicalInstallerPath, '#!/bin/sh\nexit 9\n');
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (npmArgs?.[0] === 'install') {
      const requested = npmArgs.find((arg) => /^opensip-cli@\d+\.\d+\.\d+/u.test(arg));
      materializeInstall(requested?.slice('opensip-cli@'.length));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (npmArgs?.[0] === 'ls') {
      return {
        status: 0,
        stdout: JSON.stringify({
          dependencies: {
            'opensip-cli': {
              version: inventory.releaseVersion,
              dependencies: {
                '@opensip-cli/core': { version: inventory.releaseVersion },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    if (npmArgs?.[0] === 'pack') {
      const destination = npmArgs[npmArgs.indexOf('--pack-destination') + 1];
      for (const entry of inventory.packages.filter((row) => selectedNames.has(row.name))) {
        const bytes =
          options.corrupt === entry.name
            ? Buffer.from('substituted registry bytes\n')
            : Buffer.from(`${entry.name}@${inventory.releaseVersion}\n`);
        writeFileSync(join(destination, entry.tarball), bytes);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (npmArgs?.[0] === '--version') return { status: 0, stdout: '11.0.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    runChild: (command, args, opts) => {
      const result = runChild(command, args, opts);
      return {
        ...result,
        cleanup: result.cleanup ?? { residualDescendants: 0 },
      };
    },
    invocations,
  };
}

function newLifecycle(runRoot, fake, extra = {}) {
  return new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    runChild: fake.runChild,
    ...extra,
  });
}

test('drives the full happy-path state machine install→upgrade→cli-state→package→cleaned', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);

  const install = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(install.ok, true, JSON.stringify(install));
  assert.equal(lifecycle.state, S.INSTALLED);
  assert.equal(lifecycle.installed.resolvedVersion, '0.7.0');
  assert.equal(lifecycle.installed.lockfilePresent, true);
  assert.ok(lifecycle.installed.installedBin.bin.endsWith('/opensip'));
  assert.match(lifecycle.installed.jsEntrypoint.entrypointSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(lifecycle.installed.jsEntrypoint.packageJsonSha256, /^sha256:[a-f0-9]{64}$/u);

  const representative = await lifecycle.createRepresentativeState();
  assert.equal(representative.ok, true);
  assert.equal(existsSync(join(runRoot, 'project', 'tsconfig.json')), true);
  assert.deepEqual(
    representative.steps.map((step) => step.label),
    ['project-init', 'project-session-seed', 'project-session-list'],
  );
  for (const step of representative.steps) {
    for (const forbidden of ['argv', 'env', 'cwd', 'path', 'command']) {
      assert.equal(Object.hasOwn(step, forbidden), false);
    }
  }

  fake.state.installVersion = '0.7.1';
  const upgrade = await lifecycle.upgrade(resolvedPacked('0.7.1'));
  assert.equal(upgrade.ok, true, JSON.stringify(upgrade));
  assert.equal(lifecycle.state, S.UPGRADED);
  assert.equal(upgrade.facts.versionMigrated, true);
  assert.equal(upgrade.facts.stateMigrated, true);

  const cliState = await lifecycle.removeCliState();
  assert.equal(cliState.ok, true, JSON.stringify(cliState));
  assert.equal(lifecycle.state, S.CLI_STATE_REMOVED);
  assert.equal(cliState.facts.configPreserved, true);
  assert.equal(cliState.facts.packageIntact, true);

  const pkg = await lifecycle.removePackage();
  assert.equal(pkg.ok, true, JSON.stringify(pkg));
  assert.equal(lifecycle.state, S.PACKAGE_REMOVED);
  assert.equal(pkg.facts.shimAbsent, true);
  assert.equal(pkg.facts.entrypointAbsent, true);
  assert.equal(pkg.facts.ambientInvocations, 0);

  const cleanup = lifecycle.cleanup();
  assert.equal(cleanup.status, 'clean', JSON.stringify(cleanup));
  assert.equal(cleanup.residualDescendants, 0);
  assert.equal(lifecycle.state, S.CLEANED);
  assert.ok(lifecycle.events.every((event) => Object.isFrozen(event)));

  // Every candidate CLI call used the absolute installed descriptor — never a
  // bare `opensip` from ambient PATH.
  const bin = fake.paths.binDir + '/opensip';
  for (const invocation of fake.invocations) {
    assert.notEqual(invocation.command, 'opensip', 'a bare opensip was invoked from PATH');
    assert.ok(
      invocation.command === bin ||
        (invocation.command === process.execPath &&
          /(?:^|[\\/])npm-cli\.js$/u.test(invocation.args[0] ?? '')),
      `unexpected command ${invocation.command}`,
    );
  }
});

test('fails closed when a child result omits descendant-cleanup evidence', async () => {
  const runRoot = tmpRoot();
  const lifecycle = new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    runChild: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  const event = await lifecycle.install(resolvedPacked('0.7.0'));

  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, CANDIDATE_REASON_CODES.INSTALL_FAILED);
  assert.equal(event.steps[0].reasonCode, 'cleanup-failed');
  assert.equal(event.steps[0].residualDescendants, 1);
});

test('rejects every invalid transition with a typed LifecycleError', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);

  for (const call of [
    () => lifecycle.upgrade(resolvedPacked('0.7.0')),
    () => lifecycle.removeCliState(),
    () => lifecycle.removePackage(),
    () => lifecycle.createRepresentativeState(),
  ]) {
    await assert.rejects(
      call,
      (error) => error.name === 'LifecycleError' && error.reasonCode === L.INVALID_TRANSITION,
    );
  }

  const install = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(install.ok, true);
  // A second install from INSTALLED is invalid.
  await assert.rejects(() => lifecycle.install(resolvedPacked('0.7.0')), /invalid-transition/);
});

test('pins the installed entrypoint, package manifest, and customer shim identities', async () => {
  const entrypointRoot = tmpRoot();
  const entrypointFake = makeFakeNpm(entrypointRoot);
  const entrypointLifecycle = newLifecycle(entrypointRoot, entrypointFake);
  const entrypointInstall = await entrypointLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(entrypointInstall.ok, true);
  assert.deepEqual(entrypointLifecycle.verifyInstalledIntegrity(), {
    ok: true,
    reasonCode: null,
  });

  const manifestRoot = tmpRoot();
  const manifestFake = makeFakeNpm(manifestRoot);
  const manifestLifecycle = newLifecycle(manifestRoot, manifestFake);
  const manifestInstall = await manifestLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(manifestInstall.ok, true);
  const packageJsonPath = join(manifestFake.paths.packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  writeFileSync(packageJsonPath, JSON.stringify({ ...manifest, description: 'substituted' }));
  assert.deepEqual(manifestLifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });

  writeFileSync(entrypointFake.paths.jsPath, '#!/usr/bin/env node\n// substituted\n');
  assert.deepEqual(entrypointLifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });

  const shimRoot = tmpRoot();
  const shimFake = makeFakeNpm(shimRoot);
  const shimLifecycle = newLifecycle(shimRoot, shimFake);
  const shimInstall = await shimLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(shimInstall.ok, true);
  const alternate = join(shimFake.paths.packageDir, 'dist', 'alternate.js');
  writeFileSync(alternate, '#!/usr/bin/env node\n');
  rmSync(shimFake.paths.binPath, { force: true });
  symlinkSync(alternate, shimFake.paths.binPath);
  assert.deepEqual(shimLifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });
});

test('pins the closed installed runtime tree, including hoisted dependencies and symlink containment', async () => {
  const dependencyRoot = tmpRoot();
  const dependencyFake = makeFakeNpm(dependencyRoot);
  const dependencyLifecycle = newLifecycle(dependencyRoot, dependencyFake);
  const dependencyInstall = await dependencyLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(dependencyInstall.ok, true);
  writeFileSync(
    dependencyFake.paths.runtimeDependencyPath,
    "export const installedVersion = 'substituted';\n",
  );
  assert.deepEqual(dependencyLifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });

  const additionRoot = tmpRoot();
  const additionFake = makeFakeNpm(additionRoot);
  const additionLifecycle = newLifecycle(additionRoot, additionFake);
  const additionInstall = await additionLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(additionInstall.ok, true);
  writeFileSync(
    join(additionFake.paths.consumerCwd, 'node_modules', 'late-file.js'),
    'export {};\n',
  );
  assert.deepEqual(additionLifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });

  const escapeRoot = tmpRoot();
  const escapedTarget = join(escapeRoot, 'outside-runtime.js');
  writeFileSync(escapedTarget, 'export {};\n');
  const escapeFake = makeFakeNpm(escapeRoot, {
    installTreeTransform: ({ nodeModulesDir }) => {
      symlinkSync(escapedTarget, join(nodeModulesDir, 'escaped-runtime.js'));
    },
  });
  const escapeLifecycle = newLifecycle(escapeRoot, escapeFake);
  const escapedInstall = await escapeLifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(escapedInstall.ok, false);
  assert.equal(escapedInstall.reasonCode, CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT);
});

test('reuses captured runtime content hashes while rechecking the complete metadata tree', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const install = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(install.ok, true);

  const originalOpenSync = fs.openSync;
  let openCount = 0;
  fs.openSync = (...args) => {
    openCount += 1;
    return originalOpenSync(...args);
  };
  syncBuiltinESMExports();
  let verified;
  try {
    verified = lifecycle.verifyInstalledIntegrity();
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }

  assert.deepEqual(verified, { ok: true, reasonCode: null });
  assert.equal(
    openCount,
    2,
    'only the installed entrypoint and package manifest are reopened; runtime-tree digests are reused',
  );

  chmodSync(fake.paths.runtimeDependencyPath, 0o600);
  assert.deepEqual(lifecycle.verifyInstalledIntegrity(), {
    ok: false,
    reasonCode: 'installed-candidate-changed',
  });
});

test('the child env is credential-free and rooted under the run root on POSIX and Windows keys', () => {
  const runRoot = tmpRoot();
  // Ambient auth/proxy/token/user config that must be DROPPED entirely.
  const droppedSecrets = {
    NPM_TOKEN: 'token-canary',
    NODE_AUTH_TOKEN: 'auth-canary',
    HTTP_PROXY: 'proxy.canary:3128',
    npm_config_cache: '/ambient/cache/canary',
    '//evil.canary/:_authToken': 'authtoken-canary',
  };
  const previous = {};
  for (const [k, v] of Object.entries(droppedSecrets)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  // A poisoned ambient registry must be OVERRIDDEN with the pinned default.
  previous.npm_config_registry = process.env.npm_config_registry;
  process.env.npm_config_registry = 'https://user:pass@evil.canary/';
  previous.PATH = process.env.PATH;
  process.env.PATH = '/ambient/poisoned-node-first';
  try {
    const fake = makeFakeNpm(runRoot);
    const lifecycle = newLifecycle(runRoot, fake);
    const env = lifecycle.childEnv();

    // Ambient auth/proxy/token/user config is dropped (or overridden below).
    for (const key of Object.keys(droppedSecrets)) {
      if (key === 'npm_config_cache') continue; // re-pinned to the run-owned cache
      assert.equal(env[key], undefined, `sensitive key ${key} leaked into child env`);
    }
    // Every home/temp/app-data/cache/prefix/config var points under the run root.
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TMPDIR',
      'TEMP',
      'TMP',
      'npm_config_cache',
      'npm_config_prefix',
      'npm_config_userconfig',
      'npm_config_globalconfig',
    ]) {
      assert.ok(
        typeof env[key] === 'string' && env[key].startsWith(runRoot),
        `${key}=${env[key]} not under run root`,
      );
    }
    // The registry is pinned to the public default, not the poisoned ambient value.
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
    // npm and the installed POSIX shim must resolve the exact Node runtime whose
    // ABI was recorded by the host profile, never an ambient PATH shadow.
    assert.equal(env.PATH.split(delimiter)[0], dirname(process.execPath));
    assert.ok(env.PATH.endsWith('/ambient/poisoned-node-first'));
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('paths with spaces and Unicode stay single argv entries and single env values', async () => {
  const base = tmpRoot('pa-space-');
  const runRoot = join(base, 'wörk späce ✓');
  mkdirSync(runRoot, { recursive: true });
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const env = lifecycle.childEnv();
  assert.ok(env.HOME.includes('wörk späce ✓'));
  assert.equal(env.HOME, join(runRoot, 'home'));

  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  // npm install argv is exactly the flag array — the awkward path never leaks in
  // and no token is split into multiple entries.
  const install = fake.invocations.find(
    (invocation) => invocation.command === process.execPath && invocation.args[1] === 'install',
  );
  assert.deepEqual(install?.args.slice(1), [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'error',
  ]);
  for (const invocation of fake.invocations) {
    assert.ok(Array.isArray(invocation.args));
    for (const arg of invocation.args) assert.equal(typeof arg, 'string');
  }
});

test('Windows invokes npm and the installed CLI through Node without cmd.exe, preserving awkward paths', async () => {
  const base = tmpRoot('pa-win-space-');
  const runRoot = join(base, 'wörk späce ✓');
  const npmCliFile = join(runRoot, 'Nöde Toolchain', 'npm cli', 'npm-cli.js');
  mkdirSync(join(runRoot, 'Nöde Toolchain', 'npm cli'), { recursive: true });
  writeFileSync(npmCliFile, '// synthetic npm CLI\n');
  const npmCliPath = realpathSync(npmCliFile);

  const fake = makeFakeNpm(runRoot, { platform: 'win32', npmCliPath });
  const lifecycle = newLifecycle(runRoot, fake, {
    platform: 'win32',
    npmCliPath,
  });

  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  const installedJsPath = lifecycle.installed.jsEntrypoint.script;
  const representativeEvent = await lifecycle.createRepresentativeState();
  assert.equal(representativeEvent.ok, true);
  const cliRemovalEvent = await lifecycle.removeCliState();
  assert.equal(cliRemovalEvent.ok, true);
  const packageRemovalEvent = await lifecycle.removePackage();
  assert.equal(packageRemovalEvent.ok, true);

  const npmCalls = fake.invocations.filter((invocation) => invocation.args[0] === npmCliPath);
  assert.deepEqual(
    npmCalls.map((invocation) => invocation.args[1]),
    ['install', '--version', 'uninstall'],
  );
  for (const invocation of npmCalls) {
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], npmCliPath);
  }

  const cliCalls = fake.invocations.filter((invocation) => invocation.args[0] === installedJsPath);
  assert.ok(cliCalls.length >= 3);
  assert.equal(cliCalls[0].args[1], 'init');
  for (const invocation of cliCalls) {
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], installedJsPath);
  }
  assert.ok(fake.paths.binPath.endsWith('opensip.cmd'));
  assert.ok(
    !fake.invocations.some((invocation) => /(?:npm|opensip)\.cmd$/i.test(invocation.command)),
  );
});

test('classifies a registry-ish install failure as registry-unavailable and a generic one as install-failed', async () => {
  const registryRoot = tmpRoot();
  const registryFake = makeFakeNpm(registryRoot, {
    faults: {
      install: {
        status: 1,
        stdout: '',
        stderr: 'npm ERR! code E404\nnpm ERR! 404 registry not found',
      },
    },
  });
  const registryEvent = await newLifecycle(registryRoot, registryFake).install(
    resolvedPacked('0.7.0'),
  );
  assert.equal(registryEvent.ok, false);
  assert.equal(registryEvent.reasonCode, CANDIDATE_REASON_CODES.REGISTRY_UNAVAILABLE);

  const genericRoot = tmpRoot();
  const passwordField = ['pass', 'word'].join('');
  const passwordValue = ['plain', 'password', 'secret'].join('-');
  const genericFake = makeFakeNpm(genericRoot, {
    faults: {
      install: {
        status: 1,
        stdout: '',
        stderr:
          'npm ERR! ELIFECYCLE build script failed api_key=plain-api-secret ' +
          `client_secret: plain-client-secret ${passwordField}=${passwordValue} ` +
          'secret="quoted secret value"',
      },
    },
  });
  const genericEvent = await newLifecycle(genericRoot, genericFake).install(
    resolvedPacked('0.7.0'),
  );
  assert.equal(genericEvent.ok, false);
  assert.equal(genericEvent.reasonCode, CANDIDATE_REASON_CODES.INSTALL_FAILED);
  const diagnostic = genericEvent.diagnostics.join(' ');
  for (const leaked of [
    'plain-api-secret',
    'plain-client-secret',
    'plain-password-secret',
    'quoted secret value',
  ]) {
    assert.equal(diagnostic.includes(leaked), false, leaked);
  }
});

test('rejects a package version that does not match the resolved candidate identity', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot, { installVersion: '2.0.0' });
  const lifecycle = newLifecycle(runRoot, fake);

  const event = await lifecycle.install(resolvedPacked('1.0.0'));

  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, CANDIDATE_REASON_CODES.CANDIDATE_VERSION_MISMATCH);
  assert.equal(lifecycle.state, S.EMPTY);
});

test('upgrade rejects a candidate whose mode differs from the installed mode', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  const published = {
    ok: true,
    identity: {
      kind: 'published-version',
      version: '0.7.1',
      source: 'npm:opensip-cli@0.7.1',
      digest: 'b'.repeat(64),
      registry: 'https://registry.npmjs.org/',
      registryIntegrityDigest: 'c'.repeat(64),
    },
    install: {
      kind: 'published-version',
      spec: 'opensip-cli@0.7.1',
      version: '0.7.1',
      registry: 'https://registry.npmjs.org/',
    },
  };
  const event = await lifecycle.upgrade(published);
  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, CANDIDATE_REASON_CODES.INVALID_INPUT);
});

test('representative state fails closed when datastore seeding fails', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot, {
    faults: { seed: { status: 1, stdout: '', stderr: 'seed failed' } },
  });
  const lifecycle = newLifecycle(runRoot, fake);
  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);

  const event = await lifecycle.createRepresentativeState();

  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, L.REPRESENTATIVE_STATE_FAILED);
});

test('representative state rejects clean-but-empty and malformed session history', async () => {
  for (const listed of [
    {
      status: 0,
      stdout: JSON.stringify({ data: { sessions: [] } }),
      stderr: '',
    },
    { status: 0, stdout: '{not-json', stderr: '' },
  ]) {
    const runRoot = tmpRoot();
    const fake = makeFakeNpm(runRoot, { sessionLists: [listed] });
    const lifecycle = newLifecycle(runRoot, fake);
    const install = await lifecycle.install(resolvedPacked('0.7.0'));
    assert.equal(install.ok, true);
    const event = await lifecycle.createRepresentativeState();
    assert.equal(event.ok, false, JSON.stringify(event));
    assert.equal(event.reasonCode, L.REPRESENTATIVE_STATE_FAILED);
  }
});

test('upgrade rejects clean history that loses or corrupts the representative session', async () => {
  for (const postUpgrade of [
    {
      status: 0,
      stdout: JSON.stringify({ data: { sessions: [] } }),
      stderr: '',
    },
    { status: 0, stdout: '{broken', stderr: '' },
  ]) {
    const runRoot = tmpRoot();
    const fake = makeFakeNpm(runRoot, {
      sessionLists: [undefined, postUpgrade],
    });
    const lifecycle = newLifecycle(runRoot, fake);
    const install = await lifecycle.install(resolvedPacked('0.7.0'));
    assert.equal(install.ok, true);
    const representative = await lifecycle.createRepresentativeState();
    assert.equal(representative.ok, true);
    fake.state.installVersion = '0.7.1';
    const event = await lifecycle.upgrade(resolvedPacked('0.7.1'));
    assert.equal(event.ok, false);
    assert.equal(event.reasonCode, L.STATE_MIGRATION_FAILED);
  }
});

test('upgrade rejects a representative session whose persisted payload changed', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const install = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(install.ok, true);
  const representative = await lifecycle.createRepresentativeState();
  assert.equal(representative.ok, true);
  fake.state.sessionRecord.payload.summary.failed = 1;
  fake.state.installVersion = '0.7.1';

  const event = await lifecycle.upgrade(resolvedPacked('0.7.1'));

  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, L.STATE_MIGRATION_FAILED);
});

test('packed install snapshots verified bytes and rejects mutable or registry lock resolutions', async () => {
  const changedRoot = tmpRoot();
  const changedFake = makeFakeNpm(changedRoot);
  const changedLifecycle = newLifecycle(changedRoot, changedFake);
  const changed = resolvedPacked('0.7.0');
  writeFileSync(changed.install.verifiedTarballs[0].sourcePath, 'mutated after verification\n');
  const changedEvent = await changedLifecycle.install(changed);
  assert.equal(changedEvent.ok, false);
  assert.equal(changedEvent.reasonCode, CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH);

  const linkedRoot = tmpRoot();
  const linkedFake = makeFakeNpm(linkedRoot);
  const linked = resolvedPacked('0.7.0');
  const linkedArtifact = linked.install.verifiedTarballs[0];
  const replacementRoot = tmpRoot('pa-lifecycle-replacement-');
  const replacement = join(replacementRoot, 'replacement.tgz');
  writeFileSync(replacement, readFileSync(linkedArtifact.sourcePath));
  rmSync(linkedArtifact.sourcePath);
  symlinkSync(replacement, linkedArtifact.sourcePath);
  const linkedEvent = await newLifecycle(linkedRoot, linkedFake).install(linked);
  assert.equal(linkedEvent.ok, false);
  assert.equal(linkedEvent.reasonCode, CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH);

  const oversizedRoot = tmpRoot();
  const oversizedFake = makeFakeNpm(oversizedRoot);
  const oversized = resolvedPacked('0.7.0');
  oversized.install.verifiedTarballs[0].sizeBytes = 128 * 1024 * 1024 + 1;
  const oversizedEvent = await newLifecycle(oversizedRoot, oversizedFake).install(oversized);
  assert.equal(oversizedEvent.ok, false);
  assert.equal(oversizedEvent.reasonCode, CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH);

  const mixedRoot = tmpRoot();
  const mixedFake = makeFakeNpm(mixedRoot, {
    lockTransform: (packages) => {
      packages['node_modules/@opensip-cli/core'].resolved =
        'https://registry.npmjs.org/@opensip-cli/core/-/core-0.7.0.tgz';
    },
  });
  const mixedEvent = await newLifecycle(mixedRoot, mixedFake).install(resolvedPacked('0.7.0'));
  assert.equal(mixedEvent.ok, false);
  assert.equal(mixedEvent.reasonCode, CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH);
});

test('published install must bind the installed tree to exact offline cached tarball bytes', async () => {
  const version = '0.7.0';
  const inventory = publishedInventory(version);
  const runRoot = tmpRoot();
  const fake = makePublishedFakeNpm(runRoot, inventory);
  const lifecycle = new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    registryInventory: inventory,
    runChild: fake.runChild,
  });
  const installed = await lifecycle.install(resolvedPublished(version, inventory));
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.facts.registryBinding.inventoryDigest, registryIntegrityDigest(inventory));
  assert.equal(installed.facts.registryBinding.offlineReplayComplete, true);
  assert.equal(installed.facts.registryBinding.packageCount, 2);
  assert.deepEqual(installed.facts.registryBinding.packageNames, [
    '@opensip-cli/core',
    'opensip-cli',
  ]);
  assert.deepEqual(
    installed.steps.map((step) => step.label),
    ['candidate-install', 'registry-binding-list', 'registry-binding-pack', 'npm-version'],
  );

  const corruptRoot = tmpRoot();
  const corruptFake = makePublishedFakeNpm(corruptRoot, inventory, {
    corrupt: 'opensip-cli',
  });
  const corruptLifecycle = new CandidateLifecycle({
    runRoot: corruptRoot,
    platform: 'linux',
    registryInventory: inventory,
    runChild: corruptFake.runChild,
  });
  const rejected = await corruptLifecycle.install(resolvedPublished(version, inventory));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reasonCode, CANDIDATE_REASON_CODES.PUBLISHED_PROVENANCE_MISMATCH);

  const unboundRoot = tmpRoot();
  const unboundFake = makePublishedFakeNpm(unboundRoot, inventory);
  const unbound = await new CandidateLifecycle({
    runRoot: unboundRoot,
    platform: 'linux',
    runChild: unboundFake.runChild,
  }).install(resolvedPublished(version, inventory));
  assert.equal(unbound.ok, false);
  assert.equal(unbound.reasonCode, CANDIDATE_REASON_CODES.PUBLISHED_PROVENANCE_MISMATCH);
});

test('the exact published target installs through the canonical script in lifecycle-owned state', async () => {
  const version = '0.7.0';
  const inventory = publishedInventory(version);
  const runRoot = tmpRoot();
  const installerPath = join(runRoot, 'install.sh');
  writeFileSync(installerPath, '#!/bin/sh\nexit 0\n');
  const fake = makePublishedFakeNpm(runRoot, inventory, {
    canonicalInstallerPath: installerPath,
  });
  const resolved = resolvedPublished(version, inventory);
  const lifecycle = new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    registryInventory: inventory,
    canonicalInstaller: {
      scriptPath: installerPath,
      shellPath: '/bin/sh',
      targetCandidateDigest: resolved.identity.digest,
    },
    runChild: fake.runChild,
  });

  const installed = await lifecycle.install(resolved);

  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.facts.installChannel, 'canonical-installer');
  assert.equal(lifecycle.installed.installChannel, 'canonical-installer');
  assert.equal(installed.facts.registryBinding.offlineReplayComplete, true);
  const canonicalCall = fake.invocations.find((entry) => entry.command === '/bin/sh');
  assert.deepEqual(canonicalCall?.args, [installerPath]);
  assert.equal(canonicalCall?.opts.env.OPENSIP_CLI_VERSION, version);
  assert.equal(canonicalCall?.opts.env.NPM_CONFIG_PREFIX, join(runRoot, 'npm-prefix'));
  assert.equal(
    canonicalCall?.opts.env.PATH,
    `${join(runRoot, 'canonical-installer-toolchain')}:${dirname(process.execPath)}:${join(
      runRoot,
      'npm-prefix',
      'bin',
    )}:/usr/bin:/bin`,
  );
  assert.ok(canonicalCall?.opts.env.PATH.includes(join(runRoot, 'canonical-installer-toolchain')));
  assert.equal(
    fake.invocations.some(
      (entry) => entry.command === process.execPath && entry.args[1] === 'install',
    ),
    false,
  );
  assert.equal(installed.steps[0].label, 'candidate-install-canonical-installer');
});

test('an exact previous version installs directly before the target upgrades canonically', async () => {
  const targetVersion = '0.7.0';
  const previousVersion = '0.6.9';
  const inventory = publishedInventory(targetVersion);
  const runRoot = tmpRoot();
  const installerPath = join(runRoot, 'install.sh');
  writeFileSync(installerPath, '#!/bin/sh\nexit 0\n');
  const fake = makePublishedFakeNpm(runRoot, inventory, {
    canonicalInstallerPath: installerPath,
  });
  const target = resolvedPublished(targetVersion, inventory);
  const previous = {
    ok: true,
    identity: {
      kind: 'published-version',
      version: previousVersion,
      source: `npm:opensip-cli@${previousVersion}`,
      digest: 'e'.repeat(64),
      registry: inventory.registry,
    },
    install: {
      kind: 'published-version',
      spec: `opensip-cli@${previousVersion}`,
      version: previousVersion,
      registry: inventory.registry,
    },
  };
  const lifecycle = new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    registryInventory: inventory,
    canonicalInstaller: {
      scriptPath: installerPath,
      shellPath: '/bin/sh',
      targetCandidateDigest: target.identity.digest,
    },
    runChild: fake.runChild,
  });

  const installed = await lifecycle.install(previous);
  const upgraded = await lifecycle.upgrade(target);

  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.facts.installChannel, 'npm-direct');
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.facts.installChannel, 'canonical-installer');
  assert.equal(lifecycle.installed.resolvedVersion, targetVersion);
  const installCalls = fake.invocations.filter(
    (entry) => entry.command === process.execPath && entry.args.includes('install'),
  );
  assert.equal(installCalls.length, 1);
  assert.ok(installCalls[0].args.includes(`opensip-cli@${previousVersion}`));
  assert.equal(fake.invocations.filter((entry) => entry.command === '/bin/sh').length, 1);
});

test('canonical installer identity changes fail closed', async () => {
  const version = '0.7.0';
  const inventory = publishedInventory(version);
  const runRoot = tmpRoot();
  const installerPath = join(runRoot, 'install.sh');
  writeFileSync(installerPath, '#!/bin/sh\nexit 0\n');
  const fake = makePublishedFakeNpm(runRoot, inventory, {
    canonicalInstallerPath: installerPath,
    tamperCanonicalInstaller: true,
  });
  const resolved = resolvedPublished(version, inventory);
  const lifecycle = new CandidateLifecycle({
    runRoot,
    platform: 'linux',
    registryInventory: inventory,
    canonicalInstaller: {
      scriptPath: installerPath,
      targetCandidateDigest: resolved.identity.digest,
    },
    runChild: fake.runChild,
  });

  const event = await lifecycle.install(resolved);

  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, L.CANONICAL_INSTALLER_CHANGED);
  assert.equal(lifecycle.state, S.EMPTY);
});

test('package removal is incomplete when the shim survives the uninstall', async () => {
  const runRoot = tmpRoot();
  // uninstall reports success but performs no removal → the shim + entrypoint remain.
  const fake = makeFakeNpm(runRoot, {
    faults: { packageRemove: { status: 0, stdout: '', stderr: '' } },
  });
  const lifecycle = newLifecycle(runRoot, fake);
  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  const event = await lifecycle.removePackage();
  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, L.PACKAGE_REMOVAL_INCOMPLETE);
  assert.equal(event.facts.shimAbsent, false);
});

test('cleanup removes only run-owned descendants, leaves the run root ancestor, and is idempotent', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  await lifecycle.createRepresentativeState();

  const consumerCwd = fake.paths.consumerCwd;
  const homeDir = join(runRoot, 'home');
  assert.ok(existsSync(consumerCwd) && existsSync(homeDir));

  const first = lifecycle.cleanup();
  assert.equal(first.status, 'clean');
  assert.equal(first.residualDescendants, 0);
  assert.ok(first.removedRoots > 0);
  // Owned descendants are gone; the run root itself (an ancestor of #owned) is
  // never a deletion target here — the runner owns it.
  assert.equal(existsSync(consumerCwd), false);
  assert.equal(existsSync(homeDir), false);
  assert.equal(existsSync(runRoot), true);

  // A second cleanup returns the same cached result — no double removal.
  const second = lifecycle.cleanup();
  assert.deepEqual(second, first);
});

test('removeCliState removes only runtime state and preserves the authored config + package', async () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const installEvent = await lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(installEvent.ok, true);
  const event = await lifecycle.removeCliState();
  assert.equal(event.ok, true, JSON.stringify(event));
  assert.equal(event.facts.runtimeRemoved, true);
  assert.equal(event.facts.configPreserved, true);
  // The runtime dir is gone; the config file and the package survive.
  assert.equal(existsSync(join(fake.paths.projectDir, 'opensip-cli', '.runtime')), false);
  assert.equal(existsSync(join(fake.paths.projectDir, 'opensip-cli.config.yml')), true);
  assert.equal(existsSync(fake.paths.packageDir), true);
});
