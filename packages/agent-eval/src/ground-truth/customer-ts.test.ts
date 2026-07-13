import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerTsGroundTruth } from './customer-ts.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/customer-ts',
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

describe('customer-ts fixture ground truth', () => {
  it('keeps the stale Mocha README trap distinct from manifest truth', () => {
    const readme = readFixture('README.md');
    const manifest = JSON.parse(readFixture('package.json')) as {
      name: string;
      packageManager: string;
      scripts: { build: string; test: string };
    };

    expect(readme).toContain('Mocha');
    expect(readme).toContain('npx mocha "test/**/*.spec.ts"');
    expect(readme).not.toContain('npm test');
    expect(readme).not.toMatch(/stale|manifest is the authority/i);
    expect(manifest.scripts.test).toBe(customerTsGroundTruth.orientation.testCommand);
    expect(manifest.scripts.test).toBe('vitest run');
    expect(manifest.scripts.build).toBe(customerTsGroundTruth.orientation.buildCommand);
    expect(manifest.name).toBe(customerTsGroundTruth.orientation.packageNames[0]);
    expect(customerTsGroundTruth.orientation.packageNames).toEqual([manifest.name]);
    expect(customerTsGroundTruth.orientation.packageCount).toBe(1);
    expect(fixtureFiles().filter((path) => path.endsWith('package.json'))).toEqual([
      'package.json',
    ]);
    expect(customerTsGroundTruth.orientation.packageManager).toBe(
      manifest.packageManager.split('@')[0],
    );
    expect(manifest.packageManager).toBe(
      customerTsGroundTruth.orientation.packageManagerDeclaration,
    );
    expect(existsSync(join(fixtureRoot, customerTsGroundTruth.orientation.lockfile))).toBe(true);
  });

  it('pins the entrypoint and both re-export barrels to fixture bytes', () => {
    const { entrypoint } = customerTsGroundTruth;
    const entry = readFixture(entrypoint.entryFile);
    const implementation = readFixture(entrypoint.implementationFile);

    expect(entry).toContain(`function ${entrypoint.entrySymbol}`);
    expect(entry).toContain('submitInvoice(');
    expect(implementation).toContain(`function ${entrypoint.implementationSymbol}`);
    expect(readFixture(entrypoint.barrelFiles[0])).toContain('function submitInvoice');
    expect(readFixture(entrypoint.barrelFiles[1])).toContain('function priceInvoice');
    expect(readFixture('src/features/invoice/workflow.ts')).toContain('priceInvoice(input)');
  });

  it('pins the complete direct, barrel, dynamic, and test caller set', () => {
    const target = customerTsGroundTruth.impactTargets[0];

    expect(readFixture(target.targetFile)).toContain(`function ${target.targetSymbol}`);
    expect(target.callers).toEqual([
      {
        evidenceKind: 'barrel-reexport',
        expectedConfidence: 'medium',
        filePath: 'src/features/invoice/workflow.ts',
        inTestFile: false,
        symbol: 'runInvoiceWorkflow',
      },
      {
        evidenceKind: 'direct-call',
        expectedConfidence: 'high',
        filePath: 'src/jobs/reprice-job.ts',
        inTestFile: false,
        symbol: 'repriceInvoice',
      },
      {
        evidenceKind: 'dynamic-dispatch',
        expectedConfidence: 'unresolved',
        filePath: 'src/generated/invoice-handlers.ts',
        inTestFile: false,
        symbol: 'dispatchInvoiceHandler',
      },
      {
        evidenceKind: 'test-call',
        expectedConfidence: 'high',
        filePath: 'src/__tests__/calculate-invoice.test.ts',
        inTestFile: true,
        symbol: 'calculateStandardInvoice',
      },
    ]);
    for (const caller of target.callers) {
      expect(readFixture(caller.filePath)).toContain(caller.symbol);
    }
    expect(readFixture('src/jobs/reprice-job.ts')).toContain('calculateInvoice({');
    expect(readFixture('src/services/billing/index.ts')).toContain(
      'return calculateInvoice(input)',
    );
    expect(readFixture('src/generated/invoice-handlers.ts')).toContain(
      "'invoice.total': calculateInvoice",
    );
    expect(readFixture('src/generated/invoice-handlers.ts')).toContain('return handler(input)');
    expect(readFixture('src/__tests__/calculate-invoice.test.ts')).toContain(
      'return calculateInvoice({',
    );
    expect(readFixture('src/dispatch/payment-loader.ts')).toContain(
      "await import('../generated/payment-client.js')",
    );
    expect(target.impactedPackages).toEqual(['@fixture/customer-ts']);
  });

  it('keeps every mapped test on a real path that reaches the target', () => {
    const mapping = customerTsGroundTruth.testMappings[0];
    expect(mapping.irrelevantTestFiles).toEqual(['test/health.spec.ts']);
    expect(readFixture(mapping.irrelevantTestFiles[0])).not.toContain('calculateInvoice');

    for (const testFile of mapping.testFiles) {
      expect(existsSync(join(fixtureRoot, testFile))).toBe(true);
      expect(readFixture(testFile)).toMatch(/calculateInvoice|submitInvoice|handleInvoiceRequest/);
    }
    expect(mapping.fallbackCommand).toBe('pnpm test');
    expect(readFixture('vitest.config.ts')).toContain("'src/**/*.test.ts', 'test/**/*.spec.ts'");
  });

  it('proves both catalog-staleness mutations start from valid preconditions', () => {
    const staleness = customerTsGroundTruth.staleness;

    expect(staleness).toBeDefined();
    if (staleness === undefined) return;

    expect(readFixture(staleness.targetFile)).toContain(`function ${staleness.targetSymbol}`);
    expect(staleness.preEditCallerSymbols).toEqual(
      customerTsGroundTruth.impactTargets[0].callers.map(({ symbol }) => symbol),
    );
    expect(existsSync(join(fixtureRoot, staleness.addCaller.filePath))).toBe(false);
    expect(staleness.addCaller.content).toContain(`function ${staleness.addCaller.symbol}`);
    expect(staleness.addCaller.content).toContain(
      "from '../services/billing/calculate-invoice.js'",
    );
    expect(staleness.addCaller.content).toContain('return calculateInvoice({');
    expect(staleness.postAddCallerSymbols).toEqual([
      ...staleness.preEditCallerSymbols,
      staleness.addCaller.symbol,
    ]);
    expect(staleness.deleteTarget.filePath).toBe(staleness.targetFile);
    expect(staleness.deleteTarget.symbolExpectedAbsent).toBe(staleness.targetSymbol);
  });

  it('preserves the customer boundary and fixture hardening rules', () => {
    const files = fixtureFiles();
    const forbiddenGuidanceFiles = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
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
    expect(files.some((file) => forbiddenGuidanceFiles.has(file.split('/').at(-1) ?? ''))).toBe(
      false,
    );
    expect(files.some((file) => file.endsWith('.mjs'))).toBe(false);
    expect(files.some((file) => file.split('/').includes('opensip-cli'))).toBe(false);
    for (const file of files) {
      for (const forbiddenCredential of forbiddenCredentials) {
        expect(readFixture(file)).not.toMatch(forbiddenCredential);
      }
    }
  });
});
