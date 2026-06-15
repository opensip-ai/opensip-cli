import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { sessions, sessionToolPayload } from '../schema/sessions.js';

describe('sessions schema', () => {
  it('declares the (tool, timestamp DESC) lookup index on sessions', () => {
    // getTableConfig() evaluates the table's index-builder callback, which is
    // otherwise dead from a coverage standpoint despite being load-bearing for
    // the `list newest-first by tool` query path in session-repo.
    const { indexes } = getTableConfig(sessions);
    const toolTimestampIdx = indexes.find(
      (idx) => idx.config.name === 'sessions_tool_timestamp_idx',
    );
    expect(toolTimestampIdx).toBeDefined();
    expect(toolTimestampIdx?.config.columns).toHaveLength(2);
  });

  it('keeps the sessions table free of tool-specific detail columns', () => {
    // The session split removed the fitness-shaped `summary` column; detail
    // lives in the opaque session_tool_payload table. Guard against a
    // regression that reintroduces domain vocabulary into the generic row.
    const { columns } = getTableConfig(sessions);
    const names = columns.map((c) => c.name);
    expect(names).not.toContain('summary');
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'tool',
        'timestamp',
        'cwd',
        'recipe',
        'score',
        'passed',
        'duration_ms',
      ]),
    );
  });

  it('wires the session_tool_payload -> sessions cascade foreign key', () => {
    // Foreign-key targets in Drizzle are lazy thunks (`() => sessions.id`).
    // Calling fk.reference() invokes them, both proving the cascade target
    // resolves and covering the otherwise-dead callback in coverage reports.
    const { foreignKeys, columns } = getTableConfig(sessionToolPayload);
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
    const ref = foreignKeys[0]?.reference();
    expect(ref?.foreignTable).toBe(sessions);
    // Opaque by construction: just the FK, the tool discriminator, and the blob.
    expect(columns.map((c) => c.name).sort()).toEqual([
      'payload',
      'payload_version',
      'session_id',
      'tool',
    ]);
  });
});
