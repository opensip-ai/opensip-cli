import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerPyGroundTruth } from './customer-py.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/customer-py',
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

describe('customer-py fixture ground truth', () => {
  it('pins Python orientation without a misleading package.json marker', () => {
    const pyproject = readFixture('pyproject.toml');

    expect(existsSync(join(fixtureRoot, 'package.json'))).toBe(false);
    expect(pyproject).toContain('name = "customer-py"');
    expect(pyproject).toContain('testpaths = ["tests"]');
    expect(readFixture('requirements.txt')).toContain('build==');
    expect(readFixture('requirements.txt')).toContain('pytest==');
    expect(customerPyGroundTruth.orientation).toMatchObject({
      packageManager: 'pip',
      packageManagerDeclaration: 'requirements.txt',
      lockfile: 'requirements.txt',
      packageCount: 1,
      packageNames: ['customer-py'],
      buildCommand: 'python -m build',
      testCommand: 'pytest',
      sourceRoots: ['ledger', 'tests'],
    });
  });

  it('pins the package entrypoint and __init__ re-export path', () => {
    const { entrypoint } = customerPyGroundTruth;

    expect(readFixture(entrypoint.entryFile)).toContain(`def ${entrypoint.entrySymbol}()`);
    expect(readFixture(entrypoint.entryFile)).toContain('process_order(');
    expect(readFixture(entrypoint.implementationFile)).toContain(
      `def ${entrypoint.implementationSymbol}(`,
    );
    expect(readFixture(entrypoint.barrelFiles[0])).toContain('from .core import g');
    expect(readFixture(entrypoint.barrelFiles[0])).toContain('from .workflow import process_order');
    expect(readFixture('ledger/workflow.py')).toContain('from ledger import g');
    expect(readFixture('ledger/workflow.py')).toContain('total = g(amounts)');
  });

  it('pins the re-export, dynamic-dispatch, and test callers of g', () => {
    const target = customerPyGroundTruth.impactTargets[0];

    expect(readFixture(target.targetFile)).toContain(`def ${target.targetSymbol}(`);
    expect(target.callers).toEqual([
      {
        evidenceKind: 'barrel-reexport',
        expectedConfidence: 'medium',
        filePath: 'ledger/workflow.py',
        inTestFile: false,
        symbol: 'process_order',
      },
      {
        evidenceKind: 'dynamic-dispatch',
        expectedConfidence: 'unresolved',
        filePath: 'ledger/registry.py',
        inTestFile: false,
        symbol: 'dispatch_operation',
      },
      {
        evidenceKind: 'test-call',
        expectedConfidence: 'low',
        filePath: 'tests/test_core.py',
        inTestFile: true,
        symbol: 'test_rounds_order_total',
      },
    ]);
    for (const caller of target.callers) {
      expect(readFixture(caller.filePath)).toContain(`def ${caller.symbol}(`);
    }
    expect(readFixture('ledger/registry.py')).toContain('"ledger.total": g');
    expect(readFixture('ledger/registry.py')).toContain('return handler(amounts)');
    expect(readFixture('tests/test_core.py')).toContain('assert g([');
    expect(target.impactedPackages).toEqual(['customer-py']);
  });

  it('keeps every mapped pytest file connected to the target path', () => {
    const mapping = customerPyGroundTruth.testMappings[0];
    expect(mapping.irrelevantTestFiles).toEqual(['tests/test_receipt.py']);
    expect(readFixture(mapping.irrelevantTestFiles[0])).not.toContain('from ledger import g');

    for (const testFile of mapping.testFiles) {
      expect(existsSync(join(fixtureRoot, testFile))).toBe(true);
      expect(readFixture(testFile)).toMatch(/\bg\(|process_order\(/);
    }
    expect(mapping.fallbackCommand).toBe(customerPyGroundTruth.orientation.testCommand);
  });

  it('preserves fixture hardening and init-detection boundaries', () => {
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
