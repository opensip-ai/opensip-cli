/**
 * @fileoverview Cross-process write-lock serialization (plan 09 Task 9.1.7).
 *
 * Do-not-regress for the Phase 5.4 busy-spin → yielding-wait swap: two
 * concurrent PROCESSES writing the same project SQLite DB under
 * `withWriteLock` must still serialize — each writer's batch lands as one
 * contiguous block, never interleaved. (The sync lock blocks its thread, so
 * the property is only observable across real processes.)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DataStoreFactory } from '../../factory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The built package dist — the child imports the same code production runs.
const DATASTORE_DIST = join(HERE, '..', '..', '..', 'dist', 'index.js');

const WRITER_SCRIPT = `
import { DataStoreFactory } from ${JSON.stringify(DATASTORE_DIST)};
const [dbPath, writerId] = process.argv.slice(2);
const store = DataStoreFactory.open({
  backend: 'sqlite',
  path: dbPath,
  lock: {
    policy: { waitMs: 10_000, staleMs: 30_000, heartbeatMs: 1_000 },
    runId: 'RUN_test_' + writerId,
    command: 'write-lock-serialization-test',
    cwdBasename: 'datastore',
  },
});
store.withWriteLock('serialization-test', () => {
  for (let i = 0; i < 25; i++) {
    store.db.$client
      .prepare('INSERT INTO tool_state (tool, key, payload, updated_at) VALUES (?, ?, ?, ?)')
      .run('locktest', writerId + '-' + String(i).padStart(2, '0'), '{}', Date.now());
  }
});
store.close();
`;

function runWriter(script: string, dbPath: string, writerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, dbPath, writerId], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
    child.on('error', reject);
  });
}

describe('datastore write lock — cross-process serialization', () => {
  it('serializes two concurrent writer processes into contiguous blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-write-lock-'));
    const dbPath = join(dir, 'datastore.sqlite');
    const scriptPath = join(dir, 'writer.mjs');
    writeFileSync(scriptPath, WRITER_SCRIPT);
    try {
      // Migrate once from the parent so both children race only on writes.
      DataStoreFactory.open({ backend: 'sqlite', path: dbPath }).close();

      const [codeA, codeB] = await Promise.all([
        runWriter(scriptPath, dbPath, 'A'),
        runWriter(scriptPath, dbPath, 'B'),
      ]);
      expect(codeA).toBe(0);
      expect(codeB).toBe(0);

      const store = DataStoreFactory.open({ backend: 'sqlite', path: dbPath });
      try {
        const rows = store.db.$client
          .prepare("SELECT key FROM tool_state WHERE tool = 'locktest' ORDER BY rowid")
          .all() as readonly { key: string }[];
        expect(rows).toHaveLength(50);
        // Serialization evidence: in rowid order, the writer id changes at
        // most once — each batch is one contiguous block, never interleaved.
        const writers = rows.map((row) => row.key[0]);
        let transitions = 0;
        for (let i = 1; i < writers.length; i++) {
          if (writers[i] !== writers[i - 1]) transitions++;
        }
        expect(transitions).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
