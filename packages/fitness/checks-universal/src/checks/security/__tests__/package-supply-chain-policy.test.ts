import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterEach, describe, expect, it } from 'vitest';

import { packageSupplyChainPolicy } from '../package-supply-chain-policy.js';

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'supply-chain-policy-'));
}

function writeFixture(cwd: string, relPath: string, content: string): string {
  const abs = join(cwd, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

async function runPolicy(cwd: string) {
  return packageSupplyChainPolicy.run(cwd, {
    targetFiles: [join(cwd, 'package.json')],
  });
}

afterEach(() => {
  fileCache.clear();
});

describe('package-supply-chain-policy', () => {
  it('accepts a hardened pnpm project', async () => {
    const cwd = makeProject();
    try {
      writeFixture(
        cwd,
        'package.json',
        JSON.stringify(
          {
            name: 'clean-app',
            private: true,
            packageManager: 'pnpm@11.5.1+sha512.abc123',
            dependencies: { yaml: '^2.9.0' },
          },
          null,
          2,
        ),
      );
      writeFixture(
        cwd,
        'pnpm-lock.yaml',
        [
          "lockfileVersion: '9.0'",
          'packages:',
          '  yaml@2.9.0:',
          '    resolution: {integrity: sha512-clean}',
        ].join('\n'),
      );
      writeFixture(
        cwd,
        'pnpm-workspace.yaml',
        [
          'packages:',
          '  - "."',
          'allowBuilds:',
          '  esbuild: false',
          'minimumReleaseAge: 1440',
          'minimumReleaseAgeStrict: true',
          'minimumReleaseAgeIgnoreMissingTime: false',
          'trustPolicy: no-downgrade',
          'trustLockfile: false',
          'blockExoticSubdeps: true',
        ].join('\n'),
      );
      writeFixture(
        cwd,
        '.github/workflows/ci.yml',
        [
          'name: CI',
          'jobs:',
          '  test:',
          '    steps:',
          '      - run: pnpm install --frozen-lockfile',
        ].join('\n'),
      );

      const result = await runPolicy(cwd);
      expect(result.signals).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('flags missing pins, mutable installs, install hooks, tokens, and exotic dependencies', async () => {
    const cwd = makeProject();
    try {
      writeFixture(
        cwd,
        'package.json',
        JSON.stringify(
          {
            name: 'weak-app',
            version: '1.0.0',
            scripts: { postinstall: 'node setup.js' },
            dependencies: { 'left-pad': 'github:example/left-pad' },
          },
          null,
          2,
        ),
      );
      writeFixture(
        cwd,
        '.github/workflows/release.yml',
        [
          'name: Release',
          'jobs:',
          '  publish:',
          '    steps:',
          '      - run: npm install',
          '      - run: npm publish',
          '        env:',
          '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
        ].join('\n'),
      );

      const result = await runPolicy(cwd);
      const types = result.signals.map((signal) => signal.metadata.type);
      expect(types).toContain('package-manager-missing');
      expect(types).toContain('lockfile-missing');
      expect(types).toContain('exotic-dependency-source');
      expect(types).toContain('install-lifecycle-script');
      expect(types).toContain('ci-install-not-frozen');
      expect(types).toContain('trusted-publishing-missing-oidc');
      expect(types).toContain('publish-provenance-missing');
      expect(types).toContain('publish-token-exposure');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('flags remote package-lock entries that lack integrity', async () => {
    const cwd = makeProject();
    try {
      writeFixture(
        cwd,
        'package.json',
        JSON.stringify(
          {
            name: 'npm-app',
            private: true,
            packageManager: 'npm@11.16.0',
          },
          null,
          2,
        ),
      );
      writeFixture(cwd, '.npmrc', ['ignore-scripts=true', 'min-release-age=7'].join('\n'));
      writeFixture(
        cwd,
        'package-lock.json',
        JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              'node_modules/bad': {
                version: '1.0.0',
                resolved: 'https://registry.npmjs.org/bad/-/bad-1.0.0.tgz',
              },
            },
          },
          null,
          2,
        ),
      );
      writeFixture(
        cwd,
        '.github/workflows/ci.yml',
        ['name: CI', 'jobs:', '  test:', '    steps:', '      - run: npm ci'].join('\n'),
      );

      const result = await runPolicy(cwd);
      const types = result.signals.map((signal) => signal.metadata.type);
      expect(types).toContain('lockfile-entry-missing-integrity');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
