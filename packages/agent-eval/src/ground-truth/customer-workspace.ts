import type { FixtureGroundTruth } from './types.js';

const NORMALIZE_ACCOUNT_FILE = 'packages/ws-core/src/normalize-account.ts';
const WS_API_PACKAGE = '@fixture/ws-api';
const WS_CORE_PACKAGE = '@fixture/ws-core';
const WS_WEB_PACKAGE = '@fixture/ws-web';
const WS_TOOLS_PACKAGE = '@fixture/ws-tools';

/** Committed facts for the four-package pnpm customer workspace. */
export const customerWorkspaceGroundTruth = {
  fixture: 'customer-workspace',
  language: 'typescript',
  orientation: {
    packageManager: 'pnpm',
    packageManagerDeclaration: 'pnpm@11.10.0',
    lockfile: 'pnpm-lock.yaml',
    packageCount: 4,
    packageNames: [WS_API_PACKAGE, WS_CORE_PACKAGE, WS_TOOLS_PACKAGE, WS_WEB_PACKAGE],
    buildCommand: 'pnpm -r build',
    testCommand: 'vitest run',
    sourceRoots: [
      'packages/ws-core/src',
      'packages/ws-api/src',
      'packages/ws-tools/src',
      'packages/ws-web/src',
    ],
    workspaceFile: 'pnpm-workspace.yaml',
    workspaceDependencies: [
      {
        fromPackage: WS_API_PACKAGE,
        toPackage: WS_CORE_PACKAGE,
        dependencyKind: 'dependency',
      },
      {
        fromPackage: WS_WEB_PACKAGE,
        toPackage: WS_API_PACKAGE,
        dependencyKind: 'dependency',
      },
    ],
  },
  entrypoint: {
    feature: 'account rendering',
    entryFile: 'packages/ws-web/src/index.ts',
    entrySymbol: 'main',
    implementationFile: NORMALIZE_ACCOUNT_FILE,
    implementationSymbol: 'normalizeAccount',
    barrelFiles: ['packages/ws-api/src/index.ts', 'packages/ws-core/src/index.ts'],
  },
  impactTargets: [
    {
      targetFile: NORMALIZE_ACCOUNT_FILE,
      targetSymbol: 'normalizeAccount',
      callers: [
        {
          filePath: 'packages/ws-api/src/account-handler.ts',
          symbol: 'normalizeRequest',
          evidenceKind: 'cross-package',
          expectedConfidence: 'high',
          inTestFile: false,
          packageName: WS_API_PACKAGE,
        },
        {
          // ws-web reaches the core target through ws-api's public re-export.
          filePath: 'packages/ws-web/src/account-view.ts',
          symbol: 'renderAccount',
          evidenceKind: 'barrel-reexport',
          expectedConfidence: 'medium',
          inTestFile: false,
          packageName: WS_WEB_PACKAGE,
        },
        {
          filePath: 'packages/ws-core/test/normalize-account.test.ts',
          symbol: 'normalizeFixtureAccount',
          evidenceKind: 'test-call',
          expectedConfidence: 'high',
          inTestFile: true,
          packageName: WS_CORE_PACKAGE,
        },
      ],
      impactedPackages: [WS_CORE_PACKAGE, WS_API_PACKAGE, WS_WEB_PACKAGE],
      unimpactedPackages: [WS_TOOLS_PACKAGE],
    },
  ],
  testMappings: [
    {
      targetFile: NORMALIZE_ACCOUNT_FILE,
      targetSymbol: 'normalizeAccount',
      testFiles: ['packages/ws-core/test/normalize-account.test.ts'],
      fallbackCommand: 'pnpm test',
    },
  ],
} as const satisfies FixtureGroundTruth;
