/**
 * Cross-tool envelope-shape equivalence (ADR-0011, Phase 10 Task 10.2).
 *
 * fit, graph, and sim must all emit ONE envelope with the SAME top-level shape.
 * `json-contract.test.ts` asserts the shape at the *type* level (does it
 * compile); this asserts it at the *runtime* level: feeding each tool's run
 * data through the shared `buildSignalEnvelope` (the single funnel all three
 * tools converge on — the plan's "three per-tool CliOutput builders collapse
 * into buildSignalEnvelope") yields a structurally identical envelope, and
 * `--json | jq '.verdict.passed'` / `.verdict.score` are present and
 * machine-readable for every tool.
 *
 * Deterministic: fixed `runId`/`createdAt`, no clock / id generation here
 * (formatter-purity contract — those arrive on the input).
 */
import { buildSignalEnvelope, type SignalEnvelope } from '@opensip-tools/contracts';
import { createSignal, type Signal, type ToolShortId } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

const RUN = { runId: 'run_shape0001', createdAt: '2026-06-04T00:00:00.000Z' };

/** A signal as each tool would emit it (source === unit slug). */
function signalFor(slug: string, severity: Signal['severity']): Signal {
  return createSignal({
    source: slug,
    ruleId: slug,
    severity,
    message: `finding from ${slug}`,
    code: { file: 'src/x.ts', line: 1, column: 1 },
  });
}

/** Build a representative envelope for a tool: one failing unit, one passing. */
function envelopeFor(tool: ToolShortId, slugA: string, slugB: string): SignalEnvelope {
  return buildSignalEnvelope({
    tool,
    recipe: 'example',
    runId: RUN.runId,
    createdAt: RUN.createdAt,
    units: [
      { slug: slugA, passed: false, violationCount: 1, durationMs: 12 },
      { slug: slugB, passed: true, violationCount: 0, durationMs: 4 },
    ],
    signals: [signalFor(slugA, 'high')],
  });
}

/** The three first-party tools, each with its own unit-slug vocabulary. */
const ENVELOPES: Record<ToolShortId, SignalEnvelope> = {
  fit: envelopeFor('fit', 'no-todo-comments', 'no-hardcoded-secrets'),
  graph: envelopeFor('graph', 'graph.dead-code.orphan-subtree', 'graph.architecture.cycle'),
  sim: envelopeFor('sim', 'login-burst', 'steady-state'),
};

/** Reduce an envelope to its top-level structural shape (sorted key set). */
function topLevelKeys(env: SignalEnvelope): string[] {
  return Object.keys(env)
    .filter((k) => (env as Record<string, unknown>)[k] !== undefined)
    .sort();
}

describe('cross-tool envelope shape', () => {
  const tools = Object.keys(ENVELOPES) as ToolShortId[];

  it('all three tools emit the same top-level key set', () => {
    const shapes = tools.map((t) => topLevelKeys(ENVELOPES[t]));
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
    // The contracted shape, explicitly.
    expect(shapes[0]).toEqual(['createdAt', 'recipe', 'runId', 'schemaVersion', 'signals', 'tool', 'units', 'verdict']);
  });

  it.each(tools)('%s envelope is schemaVersion 2 with verdict / units[] / signals[]', (tool) => {
    const env = ENVELOPES[tool];
    expect(env.schemaVersion).toBe(2);
    expect(env.tool).toBe(tool);
    expect(Array.isArray(env.units)).toBe(true);
    expect(Array.isArray(env.signals)).toBe(true);
    expect(env.verdict).toMatchObject({
      score: expect.any(Number),
      passed: expect.any(Boolean),
      summary: {
        total: expect.any(Number),
        passed: expect.any(Number),
        failed: expect.any(Number),
        errors: expect.any(Number),
        warnings: expect.any(Number),
      },
    });
  });

  it.each(tools)('%s verdict.passed / .score survive JSON round-trip (jq-able)', (tool) => {
    // Emulate `--json | jq '.verdict.passed'` / `.verdict.score`: serialize,
    // re-parse, and read the verdict fields as a downstream tool would. The
    // JSON serialize/parse IS the point here (the `--json` wire trip), so
    // structuredClone is not a substitute.
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentional JSON wire round-trip, not a deep clone
    const parsed = JSON.parse(JSON.stringify(ENVELOPES[tool])) as SignalEnvelope;
    expect(typeof parsed.verdict.passed).toBe('boolean');
    expect(typeof parsed.verdict.score).toBe('number');
    // One high-severity signal ⇒ the run failed for every tool.
    expect(parsed.verdict.passed).toBe(false);
    expect(parsed.verdict.summary.errors).toBe(1);
  });

  it('the verdict computation is tool-agnostic (identical for identical inputs)', () => {
    // Same units + signals → same verdict regardless of `tool`. Proves the
    // shared funnel, not per-tool verdict logic.
    const a = envelopeFor('fit', 'u1', 'u2');
    const b = envelopeFor('graph', 'u1', 'u2');
    expect(a.verdict).toEqual(b.verdict);
  });
});
