import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  CANDIDATE_FIXTURE_PEERS,
  CandidatePeerBridgeError,
  createCandidatePeerBridge,
  removeCandidatePeerBridge,
  verifyCandidatePeerBridge,
  verifyCandidatePeerResolution,
} from '../platform-acceptance/candidate-peer-bridge.mjs';

const roots = new Set();
test.afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function tempRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-peer-bridge-')));
  roots.add(root);
  return root;
}

function writePackage(root, name, version = '0.7.0') {
  const packageRoot = join(root, ...name.split('/'));
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name, version, type: 'module', main: './dist/index.js' }),
  );
  writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const fixture = true;\n');
  return packageRoot;
}

function candidate(layout) {
  const runRoot = tempRoot();
  let packageDir;
  let dependencyRoot;
  let globalPrefix;
  if (layout === 'packed') {
    const consumer = join(runRoot, 'consumer');
    packageDir = join(consumer, 'node_modules', 'opensip-cli');
    dependencyRoot = join(consumer, 'node_modules');
  } else {
    globalPrefix = join(runRoot, 'npm-prefix');
    packageDir = join(globalPrefix, 'lib', 'node_modules', 'opensip-cli');
    dependencyRoot = join(packageDir, 'node_modules');
  }
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'opensip-cli', version: '0.7.0', type: 'module' }),
  );
  const entrypoint = join(packageDir, 'dist', 'index.js');
  writeFileSync(entrypoint, 'export {};\n');
  const packages = new Map(
    CANDIDATE_FIXTURE_PEERS.map((name) => [name, writePackage(dependencyRoot, name)]),
  );
  return {
    runRoot,
    packages,
    installed: {
      mode: layout === 'packed' ? 'packed-release' : 'published-version',
      packageDir,
      ...(globalPrefix === undefined ? {} : { globalPrefix }),
      resolvedVersion: '0.7.0',
      jsEntrypoint: { script: entrypoint },
    },
  };
}

for (const layout of ['packed', 'global']) {
  test(`bridges exact ${layout} candidate peers into ordinary journey resolution`, () => {
    const fixture = candidate(layout);
    const bridge = createCandidatePeerBridge({
      installed: fixture.installed,
      runRoot: fixture.runRoot,
    });

    assert.equal(bridge.links.length, CANDIDATE_FIXTURE_PEERS.length);
    for (const link of bridge.links) {
      assert.equal(lstatSync(link.linkPath).isSymbolicLink(), true);
      assert.equal(realpathSync(link.linkPath), fixture.packages.get(link.name));
    }
    const resolutionAnchor = join(
      fixture.runRoot,
      'journeys',
      'shared',
      'opensip-cli',
      '.runtime',
      'plugins',
      'fit',
      'node_modules',
      '@opensip-cli-fixture',
      'fit-pack-demo',
      'index.js',
    );
    const requireFromPlugin = createRequire(resolutionAnchor);
    for (const packageName of CANDIDATE_FIXTURE_PEERS) {
      assert.ok(
        realpathSync(requireFromPlugin.resolve(packageName)).startsWith(
          `${fixture.packages.get(packageName)}/`,
        ),
      );
    }
    assert.equal(verifyCandidatePeerBridge(bridge), bridge);
    assert.equal(verifyCandidatePeerResolution(bridge, { anchor: resolutionAnchor }), bridge);

    removeCandidatePeerBridge(bridge, { runRoot: fixture.runRoot });
    assert.equal(lstatSync(fixture.packages.get('@opensip-cli/core')).isDirectory(), true);
  });
}

test('uses a Windows junction request without weakening link identity checks', () => {
  const fixture = candidate('global');
  const linkTypes = [];
  const fs = {
    existsSync: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync: (target, path, type) => {
      linkTypes.push(type);
      symlinkSync(target, path, 'dir');
    },
  };

  createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
    platform: 'win32',
    fs,
  });

  assert.deepEqual(linkTypes, ['junction', 'junction', 'junction']);
});

test('rejects a peer whose identity does not match the pinned candidate', () => {
  const fixture = candidate('packed');
  const manifestPath = join(fixture.packages.get('@opensip-cli/fitness'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.6.0' }));

  assert.throws(
    () =>
      createCandidatePeerBridge({
        installed: fixture.installed,
        runRoot: fixture.runRoot,
      }),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'candidate-invalid',
  );
  assert.equal(
    (() => {
      try {
        lstatSync(join(fixture.runRoot, 'node_modules'));
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
});

test('rejects a resolver target outside the pinned runtime', () => {
  const fixture = candidate('packed');
  const outside = tempRoot();
  const outsideCore = writePackage(outside, '@opensip-cli/core');

  assert.throws(
    () =>
      createCandidatePeerBridge({
        installed: fixture.installed,
        runRoot: fixture.runRoot,
        resolvePackage: (name) =>
          name === '@opensip-cli/core'
            ? join(outsideCore, 'dist', 'index.js')
            : join(fixture.packages.get(name), 'dist', 'index.js'),
      }),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'candidate-invalid',
  );
});

test('detects link substitution before a later extension journey consumes it', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const link = bridge.links[0];
  rmSync(link.linkPath);
  symlinkSync(fixture.packages.get('@opensip-cli/fitness'), link.linkPath, 'dir');

  assert.throws(
    () => verifyCandidatePeerBridge(bridge),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});

test('detects bridge-root substitution even when every replacement link has the exact target', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const outsideRoot = tempRoot();
  for (const link of bridge.links) {
    const replacement = join(outsideRoot, link.name);
    mkdirSync(join(replacement, '..'), { recursive: true });
    symlinkSync(link.targetRealpath, replacement, 'dir');
  }
  rmSync(bridge.root, { recursive: true });
  symlinkSync(outsideRoot, bridge.root, 'dir');

  assert.throws(
    () => verifyCandidatePeerBridge(bridge),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});

test('detects bridge-scope substitution even when every replacement link has the exact target', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const scope = bridge.scopeIdentities[0];
  const outsideScope = tempRoot();
  for (const link of bridge.links) {
    symlinkSync(link.targetRealpath, join(outsideScope, link.name.split('/').at(-1)), 'dir');
  }
  rmSync(scope.path, { recursive: true });
  symlinkSync(outsideScope, scope.path, 'dir');

  assert.throws(
    () => verifyCandidatePeerBridge(bridge),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});

test('rejects a nearer node_modules package that shadows an otherwise valid bridge', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const anchor = join(
    fixture.runRoot,
    'journeys',
    'shared',
    'opensip-cli',
    '.runtime',
    'plugins',
    'fit',
    'node_modules',
    '@opensip-cli-fixture',
    'fit-pack-demo',
    'index.js',
  );
  const shadowRoot = join(fixture.runRoot, 'journeys', 'node_modules');
  writePackage(shadowRoot, '@opensip-cli/core');

  assert.throws(
    () => verifyCandidatePeerResolution(bridge, { anchor }),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});

test('rejects a conditional-export shadow even when its require target reaches the candidate', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const anchor = join(
    fixture.runRoot,
    'journeys',
    'shared',
    'opensip-cli',
    '.runtime',
    'plugins',
    'fit',
    'node_modules',
    '@opensip-cli-fixture',
    'fit-pack-demo',
    'index.js',
  );
  const coreLink = bridge.links.find(({ name }) => name === '@opensip-cli/core');
  const shadow = join(dirname(anchor), 'node_modules', '@opensip-cli', 'core');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(
    join(shadow, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli/core',
      version: '0.7.0',
      type: 'module',
      exports: { import: './poison.mjs', require: './candidate.cjs' },
    }),
  );
  symlinkSync(join(coreLink.targetRealpath, 'dist', 'index.js'), join(shadow, 'candidate.cjs'));
  writeFileSync(join(shadow, 'poison.mjs'), 'export const loaded = "POISON";\n');

  assert.ok(
    realpathSync(createRequire(anchor).resolve('@opensip-cli/core')).startsWith(
      `${coreLink.targetRealpath}/`,
    ),
  );
  assert.throws(
    () => verifyCandidatePeerResolution(bridge, { anchor }),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});

test('refuses to erase a substituted link during bridge removal', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  const link = bridge.links[0];
  rmSync(link.linkPath);
  symlinkSync(fixture.packages.get('@opensip-cli/fitness'), link.linkPath, 'dir');

  assert.throws(
    () => removeCandidatePeerBridge(bridge, { runRoot: fixture.runRoot }),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
  assert.equal(lstatSync(bridge.root).isDirectory(), true);
});

test('classifies a missing bridge link as root-state tampering', () => {
  const fixture = candidate('packed');
  const bridge = createCandidatePeerBridge({
    installed: fixture.installed,
    runRoot: fixture.runRoot,
  });
  rmSync(bridge.links[0].linkPath);

  assert.throws(
    () => verifyCandidatePeerBridge(bridge),
    (error) => error instanceof CandidatePeerBridgeError && error.kind === 'root-escape',
  );
});
