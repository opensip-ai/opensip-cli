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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CANDIDATE_REASON_CODES } from '../platform-acceptance/candidate-source.mjs';
import {
  CANDIDATE_LIFECYCLE_STATES as S,
  CandidateLifecycle,
  LIFECYCLE_REASON_CODES as L,
} from '../platform-acceptance/candidate-lifecycle.mjs';

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
  return {
    ok: true,
    identity: {
      kind: 'packed-release',
      version,
      source: `packed@${version}`,
      digest: 'a'.repeat(64),
    },
    install: {
      kind: 'packed-release',
      directory: '/synthetic',
      cliTarball: `/synthetic/opensip-cli-${version}.tgz`,
      overrides: {},
      version,
    },
  };
}

/**
 * A deterministic fake npm + installed-CLI. It materializes the run-owned install
 * layout on `npm install`, removes it on `npm uninstall`, and honors installed-bin
 * `init` / `uninstall --project` calls. `faults` override the result for a phase.
 */
function makeFakeNpm(runRoot, options = {}) {
  const state = { installVersion: options.installVersion ?? '0.7.0', faults: options.faults ?? {} };
  const consumerCwd = join(runRoot, 'consumer');
  const packageDir = join(consumerCwd, 'node_modules', 'opensip-cli');
  const binDir = join(consumerCwd, 'node_modules', '.bin');
  const projectDir = join(runRoot, 'project');
  const invocations = [];

  const runChild = (command, args, opts) => {
    invocations.push({ command, args: [...args], cwd: opts?.cwd });
    const isNpm = command === 'npm' || command === 'npm.cmd';
    if (isNpm && args[0] === '--version') return { status: 0, stdout: '10.0.0\n', stderr: '' };
    if (isNpm && args[0] === 'install') {
      if (state.faults.install) return state.faults.install;
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      writeFileSync(join(packageDir, 'dist', 'index.js'), '#!/usr/bin/env node\n');
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: 'opensip-cli',
          version: state.installVersion,
          bin: { opensip: 'dist/index.js' },
        }),
      );
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'opensip'), 'shim\n');
      writeFileSync(join(consumerCwd, 'package-lock.json'), '{}');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (isNpm && args[0] === 'uninstall') {
      if (state.faults.packageRemove) return state.faults.packageRemove;
      rmSync(join(binDir, 'opensip'), { force: true });
      rmSync(join(packageDir, 'dist', 'index.js'), { force: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    // installed-bin calls (command is the absolute run-owned bin path)
    if (args[0] === 'init') {
      if (state.faults.init) return state.faults.init;
      mkdirSync(join(projectDir, 'opensip-cli', '.runtime'), { recursive: true });
      writeFileSync(join(projectDir, 'opensip-cli.config.yml'), 'x: 1\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'uninstall' && args.includes('--project')) {
      if (state.faults.cliStateRemove) return state.faults.cliStateRemove;
      rmSync(join(projectDir, 'opensip-cli', '.runtime'), { recursive: true, force: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };

  return { runChild, state, invocations, paths: { consumerCwd, packageDir, binDir, projectDir } };
}

function newLifecycle(runRoot, fake, extra = {}) {
  return new CandidateLifecycle({ runRoot, platform: 'linux', runChild: fake.runChild, ...extra });
}

test('drives the full happy-path state machine install→upgrade→cli-state→package→cleaned', () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);

  const install = lifecycle.install(resolvedPacked('0.7.0'));
  assert.equal(install.ok, true);
  assert.equal(lifecycle.state, S.INSTALLED);
  assert.equal(lifecycle.installed.resolvedVersion, '0.7.0');
  assert.equal(lifecycle.installed.lockfilePresent, true);
  assert.ok(lifecycle.installed.installedBin.bin.endsWith('/opensip'));

  assert.equal(lifecycle.createRepresentativeState().ok, true);

  fake.state.installVersion = '0.7.1';
  const upgrade = lifecycle.upgrade(resolvedPacked('0.7.1'));
  assert.equal(upgrade.ok, true, JSON.stringify(upgrade));
  assert.equal(lifecycle.state, S.UPGRADED);
  assert.equal(upgrade.facts.versionMigrated, true);
  assert.equal(upgrade.facts.stateMigrated, true);

  const cliState = lifecycle.removeCliState();
  assert.equal(cliState.ok, true, JSON.stringify(cliState));
  assert.equal(lifecycle.state, S.CLI_STATE_REMOVED);
  assert.equal(cliState.facts.configPreserved, true);
  assert.equal(cliState.facts.packageIntact, true);

  const pkg = lifecycle.removePackage();
  assert.equal(pkg.ok, true, JSON.stringify(pkg));
  assert.equal(lifecycle.state, S.PACKAGE_REMOVED);
  assert.equal(pkg.facts.shimAbsent, true);
  assert.equal(pkg.facts.entrypointAbsent, true);
  assert.equal(pkg.facts.ambientInvocations, 0);

  const cleanup = lifecycle.cleanup();
  assert.equal(cleanup.status, 'clean', JSON.stringify(cleanup));
  assert.equal(cleanup.residualDescendants, 0);
  assert.equal(lifecycle.state, S.CLEANED);

  // Every candidate CLI call used the absolute installed descriptor — never a
  // bare `opensip` from ambient PATH.
  const bin = fake.paths.binDir + '/opensip';
  for (const invocation of fake.invocations) {
    assert.notEqual(invocation.command, 'opensip', 'a bare opensip was invoked from PATH');
    assert.ok(
      invocation.command === 'npm' || invocation.command === bin,
      `unexpected command ${invocation.command}`,
    );
  }
});

test('rejects every invalid transition with a typed LifecycleError', () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);

  for (const call of [
    () => lifecycle.upgrade(resolvedPacked('0.7.0')),
    () => lifecycle.removeCliState(),
    () => lifecycle.removePackage(),
    () => lifecycle.createRepresentativeState(),
  ]) {
    assert.throws(
      call,
      (error) => error.name === 'LifecycleError' && error.reasonCode === L.INVALID_TRANSITION,
    );
  }

  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  // A second install from INSTALLED is invalid.
  assert.throws(() => lifecycle.install(resolvedPacked('0.7.0')), /invalid-transition/);
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
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('paths with spaces and Unicode stay single argv entries and single env values', () => {
  const base = tmpRoot('pa-space-');
  const runRoot = join(base, 'wörk späce ✓');
  mkdirSync(runRoot, { recursive: true });
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  const env = lifecycle.childEnv();
  assert.ok(env.HOME.includes('wörk späce ✓'));
  assert.equal(env.HOME, join(runRoot, 'home'));

  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  // npm install argv is exactly the flag array — the awkward path never leaks in
  // and no token is split into multiple entries.
  const install = fake.invocations.find((i) => i.command === 'npm' && i.args[0] === 'install');
  assert.deepEqual(install.args, ['install', '--no-audit', '--no-fund', '--loglevel', 'error']);
  for (const invocation of fake.invocations) {
    assert.ok(Array.isArray(invocation.args));
    for (const arg of invocation.args) assert.equal(typeof arg, 'string');
  }
});

test('classifies a registry-ish install failure as registry-unavailable and a generic one as install-failed', () => {
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
  const registryEvent = newLifecycle(registryRoot, registryFake).install(resolvedPacked('0.7.0'));
  assert.equal(registryEvent.ok, false);
  assert.equal(registryEvent.reasonCode, CANDIDATE_REASON_CODES.REGISTRY_UNAVAILABLE);

  const genericRoot = tmpRoot();
  const genericFake = makeFakeNpm(genericRoot, {
    faults: {
      install: { status: 1, stdout: '', stderr: 'npm ERR! ELIFECYCLE build script failed' },
    },
  });
  const genericEvent = newLifecycle(genericRoot, genericFake).install(resolvedPacked('0.7.0'));
  assert.equal(genericEvent.ok, false);
  assert.equal(genericEvent.reasonCode, CANDIDATE_REASON_CODES.INSTALL_FAILED);
});

test('upgrade rejects a candidate whose mode differs from the installed mode', () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  const published = {
    ok: true,
    identity: {
      kind: 'published-version',
      version: '0.7.1',
      source: 'npm:opensip-cli@0.7.1',
      digest: 'b'.repeat(64),
    },
    install: {
      kind: 'published-version',
      spec: 'opensip-cli@0.7.1',
      version: '0.7.1',
      registry: 'https://registry.npmjs.org/',
    },
  };
  const event = lifecycle.upgrade(published);
  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, CANDIDATE_REASON_CODES.INVALID_INPUT);
});

test('package removal is incomplete when the shim survives the uninstall', () => {
  const runRoot = tmpRoot();
  // uninstall reports success but performs no removal → the shim + entrypoint remain.
  const fake = makeFakeNpm(runRoot, {
    faults: { packageRemove: { status: 0, stdout: '', stderr: '' } },
  });
  const lifecycle = newLifecycle(runRoot, fake);
  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  const event = lifecycle.removePackage();
  assert.equal(event.ok, false);
  assert.equal(event.reasonCode, L.PACKAGE_REMOVAL_INCOMPLETE);
  assert.equal(event.facts.shimAbsent, false);
});

test('cleanup removes only run-owned descendants, leaves the run root ancestor, and is idempotent', () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  lifecycle.createRepresentativeState();

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

test('removeCliState removes only runtime state and preserves the authored config + package', () => {
  const runRoot = tmpRoot();
  const fake = makeFakeNpm(runRoot);
  const lifecycle = newLifecycle(runRoot, fake);
  assert.equal(lifecycle.install(resolvedPacked('0.7.0')).ok, true);
  const event = lifecycle.removeCliState();
  assert.equal(event.ok, true, JSON.stringify(event));
  assert.equal(event.facts.runtimeRemoved, true);
  assert.equal(event.facts.configPreserved, true);
  // The runtime dir is gone; the config file and the package survive.
  assert.equal(existsSync(join(fake.paths.projectDir, 'opensip-cli', '.runtime')), false);
  assert.equal(existsSync(join(fake.paths.projectDir, 'opensip-cli.config.yml')), true);
  assert.equal(existsSync(fake.paths.packageDir), true);
});
