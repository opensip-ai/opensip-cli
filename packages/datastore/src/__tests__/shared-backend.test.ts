import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSqliteDataStore } from '../backends/shared.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ds-shared-backend-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('buildSqliteDataStore', () => {
  it('runs write operations without a lock context on file-backed stores', () => {
    const path = join(tmp, 'unlocked.sqlite');
    const handle = buildSqliteDataStore(path);
    expect(handle.withWriteLock('probe', () => 42)).toBe(42);
    handle.close();
  });
});
