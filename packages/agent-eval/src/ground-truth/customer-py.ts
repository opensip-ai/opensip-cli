import type { FixtureGroundTruth } from './types.js';

/** Committed facts for the dynamic Python customer project. */
export const customerPyGroundTruth = {
  fixture: 'customer-py',
  language: 'python',
  orientation: {
    packageManager: 'pip',
    // requirements.txt is the pinned installer input; pyproject.toml marks the project.
    packageManagerDeclaration: 'requirements.txt',
    lockfile: 'requirements.txt',
    packageCount: 1,
    packageNames: ['customer-py'],
    buildCommand: 'python -m build',
    testCommand: 'pytest',
    sourceRoots: ['ledger', 'tests'],
  },
  entrypoint: {
    feature: 'ledger order processing',
    // app.py imports process_order from the package barrel.
    entryFile: 'app.py',
    entrySymbol: 'main',
    implementationFile: 'ledger/core.py',
    implementationSymbol: 'g',
    barrelFiles: ['ledger/__init__.py'],
  },
  impactTargets: [
    {
      targetFile: 'ledger/core.py',
      targetSymbol: 'g',
      callers: [
        {
          // workflow.py imports g only from ledger/__init__.py.
          filePath: 'ledger/workflow.py',
          symbol: 'process_order',
          evidenceKind: 'barrel-reexport',
          expectedConfidence: 'medium',
          inTestFile: false,
        },
        {
          // registry.py chooses g at runtime through a string-keyed mapping.
          filePath: 'ledger/registry.py',
          symbol: 'dispatch_operation',
          evidenceKind: 'dynamic-dispatch',
          expectedConfidence: 'unresolved',
          inTestFile: false,
        },
        {
          filePath: 'tests/test_core.py',
          symbol: 'test_rounds_order_total',
          evidenceKind: 'test-call',
          expectedConfidence: 'low',
          inTestFile: true,
        },
      ],
      impactedPackages: ['customer-py'],
    },
  ],
  testMappings: [
    {
      irrelevantTestFiles: ['tests/test_receipt.py'],
      targetFile: 'ledger/core.py',
      targetSymbol: 'g',
      testFiles: ['tests/test_core.py', 'tests/test_workflow.py'],
      fallbackCommand: 'pytest',
    },
  ],
} as const satisfies FixtureGroundTruth;
