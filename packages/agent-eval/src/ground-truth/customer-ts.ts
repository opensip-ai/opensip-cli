import type { FixtureGroundTruth } from './types.js';

const CALCULATE_INVOICE_FILE = 'src/services/billing/calculate-invoice.ts';

/**
 * Committed facts for the deliberately imperfect TypeScript customer project.
 * Every path is relative to `__fixtures__/customer-ts`.
 */
export const customerTsGroundTruth = {
  fixture: 'customer-ts',
  language: 'typescript',
  orientation: {
    packageManager: 'pnpm',
    // package.json#packageManager
    packageManagerDeclaration: 'pnpm@11.10.0',
    // A lockfile is present so package-manager identification is evidence-backed.
    lockfile: 'pnpm-lock.yaml',
    packageCount: 1,
    packageNames: ['@fixture/customer-ts'],
    // package.json#scripts
    buildCommand: 'tsc -p tsconfig.json',
    testCommand: 'vitest run',
    sourceRoots: ['src', 'test'],
  },
  entrypoint: {
    feature: 'invoice submission',
    // Facade wrappers keep the entry-to-implementation path traversable while
    // preserving feature and billing barrel boundaries.
    entryFile: 'src/index.ts',
    entrySymbol: 'main',
    implementationFile: CALCULATE_INVOICE_FILE,
    implementationSymbol: 'calculateInvoice',
    barrelFiles: ['src/features/invoice/index.ts', 'src/services/billing/index.ts'],
  },
  impactTargets: [
    {
      targetFile: CALCULATE_INVOICE_FILE,
      targetSymbol: 'calculateInvoice',
      callers: [
        {
          // workflow.ts reaches calculateInvoice only through the priceInvoice alias.
          filePath: 'src/features/invoice/workflow.ts',
          symbol: 'runInvoiceWorkflow',
          evidenceKind: 'barrel-reexport',
          expectedConfidence: 'medium',
          inTestFile: false,
        },
        {
          // reprice-job.ts imports and calls calculateInvoice directly.
          filePath: 'src/jobs/reprice-job.ts',
          symbol: 'repriceInvoice',
          evidenceKind: 'direct-call',
          expectedConfidence: 'high',
          inTestFile: false,
        },
        {
          // A generated-shaped registry keeps staleness reads able to request a
          // clean production projection while impact reads can include it.
          filePath: 'src/generated/invoice-handlers.ts',
          symbol: 'dispatchInvoiceHandler',
          evidenceKind: 'dynamic-dispatch',
          expectedConfidence: 'unresolved',
          inTestFile: false,
        },
        {
          // The mixed-convention colocated test has a named direct caller.
          filePath: 'src/__tests__/calculate-invoice.test.ts',
          symbol: 'calculateStandardInvoice',
          evidenceKind: 'test-call',
          expectedConfidence: 'high',
          inTestFile: true,
        },
      ],
      impactedPackages: ['@fixture/customer-ts'],
    },
  ],
  testMappings: [
    {
      irrelevantTestFiles: ['test/health.spec.ts'],
      targetFile: CALCULATE_INVOICE_FILE,
      targetSymbol: 'calculateInvoice',
      // All three tests exercise the target directly or through the public entry path.
      testFiles: [
        'src/__tests__/calculate-invoice.test.ts',
        'test/invoice-workflow.spec.ts',
        'test/invoice-controller.spec.ts',
      ],
      fallbackCommand: 'pnpm test',
    },
  ],
  staleness: {
    targetFile: CALCULATE_INVOICE_FILE,
    targetSymbol: 'calculateInvoice',
    preEditCallerSymbols: [
      'runInvoiceWorkflow',
      'repriceInvoice',
      'dispatchInvoiceHandler',
      'calculateStandardInvoice',
    ],
    addCaller: {
      filePath: 'src/consumers/preview-invoice.ts',
      symbol: 'previewInvoice',
      content: `import { calculateInvoice } from '../services/billing/calculate-invoice.js';

export function previewInvoice(subtotalCents: number): number {
  return calculateInvoice({ subtotalCents, customerTier: 'standard' });
}
`,
    },
    postAddCallerSymbols: [
      'runInvoiceWorkflow',
      'repriceInvoice',
      'dispatchInvoiceHandler',
      'calculateStandardInvoice',
      'previewInvoice',
    ],
    deleteTarget: {
      filePath: CALCULATE_INVOICE_FILE,
      symbolExpectedAbsent: 'calculateInvoice',
    },
  },
} as const satisfies FixtureGroundTruth;
