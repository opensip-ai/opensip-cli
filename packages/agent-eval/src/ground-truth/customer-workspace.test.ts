import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerWorkspaceGroundTruth } from './customer-workspace.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/customer-workspace',
);

function readFixture(relativePath: string): string {
  return readFileSync(join(fixtureRoot, relativePath), 'utf8');
}

function fixtureFiles(directory = fixtureRoot): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(absolutePath) : [relative(fixtureRoot, absolutePath)];
  });
}

describe('customer-workspace fixture ground truth', () => {
  it('pins the pnpm declaration, lockfile, scripts, and four package manifests', () => {
    const rootManifest = JSON.parse(readFixture('package.json')) as {
      packageManager: string;
      scripts: { build: string; test: string };
    };
    const packageManifests = ['ws-api', 'ws-core', 'ws-tools', 'ws-web'].map(
      (directory) =>
        JSON.parse(readFixture(`packages/${directory}/package.json`)) as {
          dependencies?: Record<string, string>;
          name: string;
        },
    );

    expect(rootManifest.packageManager).toBe(
      customerWorkspaceGroundTruth.orientation.packageManagerDeclaration,
    );
    expect(rootManifest.scripts).toEqual({
      build: customerWorkspaceGroundTruth.orientation.buildCommand,
      test: customerWorkspaceGroundTruth.orientation.testCommand,
    });
    expect(existsSync(join(fixtureRoot, customerWorkspaceGroundTruth.orientation.lockfile))).toBe(
      true,
    );
    expect(readFixture('pnpm-workspace.yaml')).toContain("- 'packages/*'");
    expect(JSON.parse(readFixture('tsconfig.json'))).toMatchObject({
      compilerOptions: {
        paths: {
          '@fixture/ws-api': ['./packages/ws-api/src/index.ts'],
          '@fixture/ws-core': ['./packages/ws-core/src/index.ts'],
        },
      },
      extends: './tsconfig.base.json',
      include: ['packages/**/*.ts'],
    });
    expect(packageManifests.map(({ name }) => name).sort()).toEqual(
      [...customerWorkspaceGroundTruth.orientation.packageNames].sort(),
    );
    expect(packageManifests).toHaveLength(customerWorkspaceGroundTruth.orientation.packageCount);
    expect(packageManifests[0].dependencies).toEqual({
      '@fixture/ws-core': 'workspace:*',
    });
    expect(packageManifests[3].dependencies).toEqual({
      '@fixture/ws-api': 'workspace:*',
    });
  });

  it('pins every declared workspace dependency edge to package manifests', () => {
    const packageDirectories = new Map([
      ['@fixture/ws-api', 'ws-api'],
      ['@fixture/ws-core', 'ws-core'],
      ['@fixture/ws-web', 'ws-web'],
    ]);

    for (const edge of customerWorkspaceGroundTruth.orientation.workspaceDependencies ?? []) {
      const packageDirectory = packageDirectories.get(edge.fromPackage);
      expect(packageDirectory).toBeDefined();
      if (packageDirectory === undefined) continue;
      const manifest = JSON.parse(readFixture(`packages/${packageDirectory}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const section =
        edge.dependencyKind === 'dependency' ? manifest.dependencies : manifest.devDependencies;
      expect(section?.[edge.toPackage]).toBe('workspace:*');
    }
  });

  it('pins the web entrypoint and the API/core barrel chain', () => {
    const { entrypoint } = customerWorkspaceGroundTruth;

    expect(readFixture(entrypoint.entryFile)).toContain(`function ${entrypoint.entrySymbol}`);
    expect(readFixture(entrypoint.entryFile)).toContain('renderAccount(');
    expect(readFixture(entrypoint.implementationFile)).toContain(
      `function ${entrypoint.implementationSymbol}`,
    );
    expect(readFixture('packages/ws-api/src/index.ts')).toContain(
      "export { normalizeAccount } from '@fixture/ws-core'",
    );
    expect(readFixture('packages/ws-core/src/index.ts')).toContain(
      "export { normalizeAccount } from './normalize-account.js'",
    );
  });

  it('pins cross-package callers and the complete impacted package set', () => {
    const target = customerWorkspaceGroundTruth.impactTargets[0];

    expect(readFixture(target.targetFile)).toContain(`function ${target.targetSymbol}`);
    expect(target.callers).toEqual([
      {
        evidenceKind: 'cross-package',
        expectedConfidence: 'high',
        filePath: 'packages/ws-api/src/account-handler.ts',
        inTestFile: false,
        packageName: '@fixture/ws-api',
        symbol: 'normalizeRequest',
      },
      {
        evidenceKind: 'barrel-reexport',
        expectedConfidence: 'medium',
        filePath: 'packages/ws-web/src/account-view.ts',
        inTestFile: false,
        packageName: '@fixture/ws-web',
        symbol: 'renderAccount',
      },
      {
        evidenceKind: 'test-call',
        expectedConfidence: 'high',
        filePath: 'packages/ws-core/test/normalize-account.test.ts',
        inTestFile: true,
        packageName: '@fixture/ws-core',
        symbol: 'normalizeFixtureAccount',
      },
    ]);
    for (const caller of target.callers) {
      expect(readFixture(caller.filePath)).toContain(caller.symbol);
      expect(caller.packageName).toMatch(/^@fixture\/ws-/);
    }
    expect(readFixture('packages/ws-api/src/account-handler.ts')).toContain(
      'return normalizeAccount(input)',
    );
    expect(readFixture('packages/ws-web/src/account-view.ts')).toContain(
      'const account = normalizeAccount({ displayName, id })',
    );
    expect(target.impactedPackages).toEqual([
      '@fixture/ws-core',
      '@fixture/ws-api',
      '@fixture/ws-web',
    ]);
    expect(target.unimpactedPackages).toEqual(['@fixture/ws-tools']);
  });

  it('keeps the focused test mapping real and connected to the target', () => {
    const mapping = customerWorkspaceGroundTruth.testMappings[0];

    expect(mapping.testFiles).toEqual(['packages/ws-core/test/normalize-account.test.ts']);
    expect(readFixture(mapping.testFiles[0])).toContain('return normalizeAccount({');
    expect(mapping.fallbackCommand).toBe('pnpm test');
    expect(readFixture('vitest.config.ts')).toContain("'packages/**/test/**/*.test.ts'");
  });

  it('preserves fixture hardening and nested-workspace isolation', () => {
    const files = fixtureFiles();
    const forbiddenCredentials = [
      /AKIA[0-9A-Z]{16}/,
      /sk-[A-Za-z0-9]{20,}/,
      /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
      /api[_-]?key\s*[:=]/i,
      /client[_-]?secret\s*[:=]/i,
      /password\s*[:=]/i,
    ];

    expect(files).not.toContain('opensip-cli.config.yml');
    expect(files).not.toContain('Makefile');
    expect(files.some((file) => file.endsWith('.mjs'))).toBe(false);
    expect(files.some((file) => file.split('/').includes('opensip-cli'))).toBe(false);
    for (const file of files) {
      for (const forbiddenCredential of forbiddenCredentials) {
        expect(readFixture(file)).not.toMatch(forbiddenCredential);
      }
    }
  });
});
