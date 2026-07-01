import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
  'utf8',
);

describe('datastore public barrel (ADR-0107)', () => {
  it('does not export DrizzleDataStore or requireDrizzleHandle', () => {
    expect(indexSource).not.toMatch(/\bDrizzleDataStore\b/);
    expect(indexSource).not.toMatch(/\brequireDrizzleHandle\b/);
    expect(indexSource).not.toMatch(/\bDrizzleHandle\b/);
  });
});