import { describe, expect, it } from 'vitest';

import { analyzeChunkedBulkInsert } from '../../../../opensip-cli/fit/checks/chunked-bulk-insert.mjs';

const PERSISTENCE_PATH = 'packages/datastore/src/write.ts';

describe('chunked-bulk-insert local check', () => {
  it('flags a multi-line mapped row set inserted in one values call', () => {
    const source = [
      'const rows = entries',
      '  .map((entry) => ({',
      '    id: entry.id,',
      '  }))',
      'await db.insert(table).values(rows)',
    ].join('\n');

    expect(analyzeChunkedBulkInsert(source, PERSISTENCE_PATH)).toHaveLength(1);
  });

  it('flags a mapped row set when the values call is split across lines', () => {
    const source = [
      'const rows = entries.map((entry) => ({ id: entry.id }))',
      'await db.insert(table).values(',
      '  rows',
      ')',
    ].join('\n');

    expect(analyzeChunkedBulkInsert(source, PERSISTENCE_PATH)).toHaveLength(1);
  });

  it('does not flag the compliant per-chunk loop binding', () => {
    const source = [
      'const rows = entries.map((entry) => ({ id: entry.id }))',
      'for (const chunk of chunkRows(rows, 500)) {',
      '  await db.insert(table).values(chunk)',
      '}',
    ].join('\n');

    expect(analyzeChunkedBulkInsert(source, PERSISTENCE_PATH)).toHaveLength(0);
  });

  it('does not flag obviously bounded row sets', () => {
    const source = [
      'const sampled = entries.slice(0, 100).map((entry) => ({ id: entry.id }))',
      'await db.insert(table).values(sampled)',
      'await db.insert(table).values([{ id: "one" }, { id: "two" }].map((row) => row))',
    ].join('\n');

    expect(analyzeChunkedBulkInsert(source, PERSISTENCE_PATH)).toHaveLength(0);
  });
});
