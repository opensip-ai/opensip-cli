import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerStalenessGroundTruth as truth } from './customer-staleness.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/customer-staleness',
);

function readFixture(path: string): string {
  return readFileSync(join(fixtureRoot, path), 'utf8');
}

describe('customer-staleness ground truth', () => {
  it('pins a complete direct-call baseline and both edit preconditions', () => {
    expect(readFixture(truth.targetFile)).toContain(`function ${truth.targetSymbol}`);
    for (const caller of truth.preEditCallers) {
      expect(readFixture(caller.filePath)).toContain(`function ${caller.symbol}`);
      expect(readFixture(caller.filePath)).toContain(`${truth.targetSymbol}(`);
    }
    expect(existsSync(join(fixtureRoot, truth.addCaller.filePath))).toBe(false);
    expect(truth.addCaller.content).toContain(`function ${truth.addCaller.symbol}`);
    expect(truth.addCaller.content).toContain(`${truth.targetSymbol}(`);
    expect(existsSync(join(fixtureRoot, truth.deleteTarget.filePath))).toBe(true);
  });
});
