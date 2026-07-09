import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { runs, runSteps } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';

describe('run ledger schema', () => {
  it('declares lookup indexes on runs', () => {
    const { indexes } = getTableConfig(runs);
    expect(indexes.map((idx) => idx.config.name).sort()).toEqual([
      'runs_completed_at_idx',
      'runs_legacy_suite_run_id_idx',
      'runs_source_completed_at_idx',
    ]);
  });

  it('keeps run rows host-generic', () => {
    const { columns } = getTableConfig(runs);
    const names = columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'source',
        'correlation_run_id',
        'cwd',
        'started_at',
        'completed_at',
        'duration_ms',
        'exit_code',
        'aggregate',
        'legacy_suite_run_id',
      ]),
    );
    expect(names).not.toContain('check_slug');
    expect(names).not.toContain('finding');
  });

  it('wires run_steps to runs and optionally sessions', () => {
    const { columns, foreignKeys, indexes } = getTableConfig(runSteps);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'run_id',
        'logical_step_key',
        'ordinal',
        'attempt',
        'tool',
        'command',
        'stable_id',
        'session_id',
        'evidence',
      ]),
    );
    expect(indexes.map((idx) => idx.config.name).sort()).toEqual([
      'run_steps_run_order_idx',
      'run_steps_session_id_idx',
      'run_steps_stable_id_idx',
    ]);
    expect(foreignKeys).toHaveLength(2);
    const refs = foreignKeys.map((fk) => fk.reference());
    expect(refs.map((ref) => ref.foreignTable)).toEqual(expect.arrayContaining([runs, sessions]));
  });
});
