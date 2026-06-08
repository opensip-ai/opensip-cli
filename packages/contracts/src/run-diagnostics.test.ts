/**
 * RunDiagnostics shape — serialization-safety + lifecycle-phase coverage.
 *
 * The contract is "JSON-emittable diagnostics carried on a CommandOutcome", so the
 * load-bearing guarantee is a clean JSON round-trip (no functions / class
 * instances leak in) and that every lifecycle phase is expressible.
 */

import { describe, it, expect } from 'vitest';

import type {
  RunDiagnostics,
  DiagnosticEvent,
  DiagnosticPhase,
} from './run-diagnostics.js';

const ALL_PHASES: readonly DiagnosticPhase[] = [
  'discover',
  'load',
  'validate',
  'execute',
  'render',
  'deliver',
  'persist',
];

describe('RunDiagnostics', () => {
  it('expresses an event in every lifecycle phase', () => {
    const events: DiagnosticEvent[] = ALL_PHASES.map((phase) => ({
      phase,
      level: 'info',
      message: `${phase} ran`,
      at: '2026-06-07T00:00:00.000Z',
    }));
    expect(events).toHaveLength(7);
    expect(events.map((e) => e.phase)).toEqual(ALL_PHASES);
  });

  it('round-trips through JSON unchanged (serialization-safe)', () => {
    const diagnostics: RunDiagnostics = {
      runId: 'run_abc',
      events: [
        { phase: 'load', level: 'debug', message: 'loaded 3 plugins', at: '2026-06-07T00:00:00.000Z', data: { count: 3 } },
        { phase: 'validate', level: 'warn', message: 'unknown key ignored', at: '2026-06-07T00:00:01.000Z' },
      ],
      metrics: { 'plugins.loaded': 3 },
      trace: { traceId: 'abcd', spanId: 'ef01' },
    };
    // Genuine serialize→parse round-trip (not a deep clone): proves nothing
    // unserializable leaks into the shape.
    const wire = JSON.stringify(diagnostics);
    expect(JSON.parse(wire)).toEqual(diagnostics);
  });

  it('is valid with only the required fields (empty run)', () => {
    const diagnostics: RunDiagnostics = { runId: 'run_empty', events: [] };
    const wire = JSON.stringify(diagnostics);
    expect(JSON.parse(wire)).toEqual(diagnostics);
  });
});
