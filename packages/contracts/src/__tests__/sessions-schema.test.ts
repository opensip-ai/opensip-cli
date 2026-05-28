import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import {
  sessionChecks,
  sessionFindings,
  sessions,
} from '../persistence/schema/sessions.js';

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

  it('wires the session_checks -> sessions cascade foreign key', () => {
    // Foreign-key targets in Drizzle are lazy thunks (`() => sessions.id`).
    // Calling fk.reference() invokes them, both proving the cascade target
    // resolves and covering the otherwise-dead callback in coverage reports.
    const { foreignKeys, indexes } = getTableConfig(sessionChecks);
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
    const ref = foreignKeys[0]?.reference();
    expect(ref?.foreignTable).toBe(sessions);
    expect(indexes.some((idx) => idx.config.name === 'session_checks_session_idx')).toBe(
      true,
    );
  });

  it('wires the session_findings -> session_checks cascade foreign key', () => {
    const { foreignKeys, indexes } = getTableConfig(sessionFindings);
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0]?.onDelete).toBe('cascade');
    const ref = foreignKeys[0]?.reference();
    expect(ref?.foreignTable).toBe(sessionChecks);
    expect(
      indexes.some((idx) => idx.config.name === 'session_findings_check_idx'),
    ).toBe(true);
  });
});
