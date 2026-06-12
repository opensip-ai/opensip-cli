/**
 * @fileoverview Toy fixture tool — the ADR-0036 "ratchet is free for plugins"
 * proof (enforcement guard 1).
 *
 * A brand-new tool that merely EMITS signals inherits `--gate-save` /
 * `--gate-compare` with ZERO tool-authored persistence, diff, or fingerprint
 * code: its gate handler imports only `@opensip-tools/core` + the `cli` baseline
 * seams. It declares NO `fingerprintStrategy`, so the host's
 * `defaultFingerprintStrategy` keys its baseline. The host owns BaselineRepo, the
 * diff, and the exit.
 *
 * NOTE: this file imports NO `@opensip-tools/datastore`, no diff, no fingerprint
 * hashing — that absence IS the proof. Lives under `__tests__/fixtures/` so the
 * dogfood checks (host-owned-verdict, no-local-exit) correctly exempt it.
 */

import {
  createSignal,
  defaultFingerprintStrategy,
  defineCommand,
  stampFingerprints,
  type Signal,
  type Tool,
  type ToolCliContext,
} from '@opensip-tools/core';

import type { SignalEnvelope } from '@opensip-tools/contracts';

/** The toy tool's id — the per-tool scope key for the host baseline plane. */
export const TOY_TOOL_ID = 'toy';

/**
 * A deterministic toy signal set, stamped with the HOST DEFAULT fingerprint (the
 * toy declares no strategy). `extra` injects net-new findings for the
 * degraded-path test.
 */
export function buildToyEnvelope(extra: readonly Signal[] = []): SignalEnvelope {
  const base: Signal[] = [
    createSignal({
      source: 'toy',
      severity: 'high',
      ruleId: 'toy:rule-a',
      message: 'finding a',
      code: { file: 'src/x.ts', line: 1, column: 0 },
    }),
    createSignal({
      source: 'toy',
      severity: 'medium',
      ruleId: 'toy:rule-b',
      message: 'finding b',
      code: { file: 'src/y.ts', line: 2, column: 0 },
    }),
  ];
  // The tool stamps at envelope-construction time — the plane never fingerprints.
  const signals = stampFingerprints([...base, ...extra], defaultFingerprintStrategy);
  return {
    schemaVersion: 2,
    tool: TOY_TOOL_ID as SignalEnvelope['tool'],
    runId: 'toy-run',
    createdAt: '1970-01-01T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals,
  };
}

/** Build a single extra toy signal (net-new for the degraded path). */
export function toyNetNewSignal(): Signal {
  return createSignal({
    source: 'toy',
    severity: 'high',
    ruleId: 'toy:rule-c',
    message: 'net-new finding',
    code: { file: 'src/z.ts', line: 3, column: 0 },
  });
}

/**
 * The toy tool. Its gate handler does NOTHING but build an envelope and call the
 * host seams — no datastore, no diff, no fingerprint code. That is the entire
 * "free ratchet" surface a new tool must author.
 */
export const toyTool: Tool = {
  metadata: { id: TOY_TOOL_ID, version: '0.0.0', description: 'Toy tool (ratchet proof)' },
  commandSpecs: [
    defineCommand<unknown, ToolCliContext>({
      name: 'toy',
      description: 'Toy tool gate (ADR-0036 zero-code ratchet proof)',
      scope: 'project',
      commonFlags: ['cwd'],
      options: [
        { flag: '--gate-save', description: 'Save the toy baseline' },
        { flag: '--gate-compare', description: 'Compare against the toy baseline' },
      ],
      handler: async (rawOpts, cli): Promise<void> => {
        const opts = rawOpts as { gateSave?: boolean; gateCompare?: boolean; cwd?: string };
        const envelope = buildToyEnvelope();
        if (opts.gateSave === true) {
          await cli.saveBaseline(TOY_TOOL_ID, envelope);
          return;
        }
        const result = await cli.compareBaseline(TOY_TOOL_ID, envelope);
        // ADR-0035: the HOST derives the gate exit — the tool passes the ratchet
        // verdict as the deliverSignals runFailed override; it NEVER calls
        // setExitCode for the gate path.
        await cli.deliverSignals(envelope, { cwd: opts.cwd ?? '.', runFailed: result.degraded });
      },
    }),
  ],
  // NO fingerprintStrategy — inherits the host default. NO persistence/diff code.
};
