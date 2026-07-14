import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertDistributionLockSubset,
  cloneDistributionRegistryMetadata,
  defaultDistributionPnpmCacheDirectory,
  distributionLockPackageKeys,
  distributionSentinelMetadataKey,
  expectedDistributionPnpmVersion,
  resolveDistributionPnpmCommand,
} from '../lib/distribution-offline-preparation.mjs';

test('pinned pnpm runtime resolution uses only a local JavaScript entrypoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-pnpm-runtime-'));
  const runtime = join(root, 'v1', 'pnpm', '11.10.0', 'bin', 'pnpm.mjs');
  try {
    mkdirSync(join(runtime, '..'), { recursive: true });
    writeFileSync(runtime, '#!/usr/bin/env node\n', 'utf8');
    assert.equal(
      expectedDistributionPnpmVersion(`pnpm@11.10.0+sha512.${'a'.repeat(16)}`),
      '11.10.0',
    );
    assert.deepEqual(
      await resolveDistributionPnpmCommand({
        environment: { COREPACK_HOME: root },
        packageManager: 'pnpm@11.10.0',
        platform: 'linux',
        processExecutable: '/runtime/node',
      }),
      ['/runtime/node', runtime],
    );
    assert.throws(() => expectedDistributionPnpmVersion('pnpm@^11'), /pin an exact pnpm/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('win32 pnpm runtime resolution uses the LOCALAPPDATA Corepack default', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const runtime = String.raw`C:\Users\person\AppData\Local\node\corepack\v1\pnpm\11.10.0\bin\pnpm.mjs`;
  const probed = [];
  const command = await resolveDistributionPnpmCommand({
    environment: { LOCALAPPDATA: String.raw`C:\Users\person\AppData\Local` },
    filesystem: {
      stat: async (path) => {
        probed.push(path);
        return { isFile: () => path === runtime };
      },
    },
    packageManager: 'pnpm@11.10.0',
    platform: 'win32',
    processExecutable: node,
  });
  assert.deepEqual(command, [node, runtime]);
  assert.deepEqual(probed, [runtime]);
});

test('win32 Corepack resolution falls back to homedir AppData with win32 separators', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const runtime = String.raw`C:\Users\person\AppData\Local\node\corepack\v1\pnpm\11.10.0\bin\pnpm.mjs`;
  const command = await resolveDistributionPnpmCommand({
    environment: {},
    filesystem: {
      stat: async (path) => ({ isFile: () => path === runtime }),
    },
    homeDirectory: String.raw`C:\Users\person`,
    packageManager: 'pnpm@11.10.0',
    platform: 'win32',
    processExecutable: node,
  });
  assert.deepEqual(command, [node, runtime]);
});

test('sentinel metadata keys accept only a bounded IPv4 loopback origin with a port', () => {
  assert.equal(distributionSentinelMetadataKey('http://127.0.0.1:43123'), '127.0.0.1+43123');
  for (const origin of [
    'https://127.0.0.1:43123',
    'http://localhost:43123',
    'http://127.0.0.1',
    'http://127.0.0.1:43123/path',
  ]) {
    assert.throws(() => distributionSentinelMetadataKey(origin), /IPv4 loopback origin/u);
  }
});

test('default pnpm cache discovery is platform-specific and configuration-independent', () => {
  assert.equal(
    defaultDistributionPnpmCacheDirectory({
      environment: { HOME: '/home/person', XDG_CACHE_HOME: '/cache' },
      platform: 'linux',
    }),
    '/cache/pnpm',
  );
  assert.equal(
    defaultDistributionPnpmCacheDirectory({
      environment: { HOME: '/Users/person' },
      platform: 'darwin',
    }),
    '/Users/person/Library/Caches/pnpm',
  );
  assert.equal(
    defaultDistributionPnpmCacheDirectory({
      environment: { LOCALAPPDATA: String.raw`C:\Users\person\AppData\Local` },
      platform: 'win32',
    }),
    String.raw`C:\Users\person\AppData\Local\pnpm-cache`,
  );
  assert.equal(
    defaultDistributionPnpmCacheDirectory({
      environment: {},
      homeDirectory: String.raw`C:\Users\person`,
      platform: 'win32',
    }),
    String.raw`C:\Users\person\AppData\Local\pnpm-cache`,
  );
});

test('lock package parsing and subset proof admit only staged release artifacts plus root keys', () => {
  const rootLockText = [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    "  '@scope/pkg@2.0.0':",
    '    resolution: {integrity: sha512-scope}',
    '',
    '  kleur@4.1.5:',
    '    resolution: {integrity: sha512-kleur}',
    '',
    'snapshots:',
  ].join('\n');
  const consumerLockText = [
    "lockfileVersion: '9.0'",
    '',
    'packages:',
    '',
    "  '@opensip-cli/core@file:../artifacts/opensip-cli-core-0.6.0.tgz':",
    '    resolution: {integrity: sha512-local}',
    '',
    '  kleur@4.1.5:',
    '    resolution: {integrity: sha512-kleur}',
  ].join('\n');
  assert.deepEqual(distributionLockPackageKeys(rootLockText), ['@scope/pkg@2.0.0', 'kleur@4.1.5']);
  assert.doesNotThrow(() =>
    assertDistributionLockSubset({
      rootLockText,
      consumerLockText,
      releaseTarballs: [
        {
          packageName: '@opensip-cli/core',
          fileName: 'opensip-cli-core-0.6.0.tgz',
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertDistributionLockSubset({
        rootLockText,
        consumerLockText: consumerLockText.replace('kleur@4.1.5', 'kleur@5.0.0'),
        releaseTarballs: [
          {
            packageName: '@opensip-cli/core',
            fileName: 'opensip-cli-core-0.6.0.tgz',
          },
        ],
      }),
    /outside the repository lock/u,
  );
  assert.throws(
    () =>
      assertDistributionLockSubset({
        rootLockText,
        consumerLockText: consumerLockText.replace(
          'opensip-cli-core-0.6.0.tgz',
          'attacker-selected.tgz',
        ),
        releaseTarballs: [
          {
            packageName: '@opensip-cli/core',
            fileName: 'opensip-cli-core-0.6.0.tgz',
          },
        ],
      }),
    /outside the repository lock/u,
  );
  const workspaceOpenSipKey = '@opensip-cli/core@file:packages/core';
  assert.throws(
    () =>
      assertDistributionLockSubset({
        rootLockText: rootLockText.replace(
          'packages:\n',
          `packages:\n\n  '${workspaceOpenSipKey}':\n    resolution: {directory: packages/core}\n`,
        ),
        consumerLockText: consumerLockText.replace(
          '@opensip-cli/core@file:../artifacts/opensip-cli-core-0.6.0.tgz',
          workspaceOpenSipKey,
        ),
        releaseTarballs: [
          {
            packageName: '@opensip-cli/core',
            fileName: 'opensip-cli-core-0.6.0.tgz',
          },
        ],
      }),
    /outside the repository lock/u,
  );
});

test('metadata cloning copies a bounded public mirror and rejects symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opensip-pnpm-metadata-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const registry = join(source, 'v11', 'metadata', 'registry.npmjs.org');
  try {
    mkdirSync(join(registry, '@scope'), { recursive: true });
    writeFileSync(join(registry, 'kleur.jsonl'), '{"name":"kleur"}\n', 'utf8');
    writeFileSync(join(registry, '@scope', 'pkg.jsonl'), '{"name":"@scope/pkg"}\n', 'utf8');
    const cloned = await cloneDistributionRegistryMetadata({
      packageManager: 'pnpm@11.10.0',
      sourceCacheDirectory: source,
      destinationCacheDirectory: destination,
      destinationRegistryOrigin: 'http://127.0.0.1:43123',
    });
    assert.equal(cloned.fileCount, 2);
    assert.equal(
      readFileSync(
        join(destination, 'pnpm', 'v11', 'metadata', '127.0.0.1+43123', 'kleur.jsonl'),
        'utf8',
      ),
      '{"name":"kleur"}\n',
    );

    symlinkSync(join(registry, 'kleur.jsonl'), join(registry, 'linked.jsonl'));
    await assert.rejects(
      () =>
        cloneDistributionRegistryMetadata({
          packageManager: 'pnpm@11.10.0',
          sourceCacheDirectory: source,
          destinationCacheDirectory: join(root, 'rejected'),
          destinationRegistryOrigin: 'http://127.0.0.1:43123',
        }),
      /only regular files and directories/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('metadata cloning bounds directory entries before materializing an unbounded listing', async () => {
  const handle = {
    close: async () => true,
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index <= 8192; index += 1) {
        yield {
          name: `directory-${String(index)}`,
          isDirectory: () => true,
          isFile: () => false,
        };
      }
    },
  };

  await assert.rejects(
    () =>
      cloneDistributionRegistryMetadata({
        packageManager: 'pnpm@11.10.0',
        sourceCacheDirectory: '/cache',
        destinationCacheDirectory: '/destination',
        destinationRegistryOrigin: 'http://127.0.0.1:43123',
        filesystem: { opendir: async () => handle },
      }),
    /bounded entry limit/u,
  );
});
