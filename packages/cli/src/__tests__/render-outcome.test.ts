/**
 * render-outcome — the single serialization seam. Pins: `--json` emits the WHOLE
 * outcome wrapper (with the byte-identical `.envelope`); human mode renders the
 * inner payload and never serializes; a pure error/bootstrap outcome renders
 * nothing in human mode.
 *
 * ADR-0175: residual unserializable outcomes still write a fallback JSON document
 * (never zero stdout) and rethrow so the host exit plane can mark failure.
 */

import {
  buildSignalEnvelope,
  EXIT_CODES,
  type CommandOutcome,
  type CommandResult,
} from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK, runEmbeddedRender } from '@opensip-cli/core';
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  OUTCOME_SERIALIZE_FAILED_CODE,
  renderOutcome,
  renderRaw,
} from '../commands/render-outcome.js';

const ENVELOPE = buildSignalEnvelope({
  tool: 'fit',
  runId: 'run_1',
  createdAt: '2026-06-07T00:00:00.000Z',
  units: [{ slug: 'a', passed: true, durationMs: 1 }],
  signals: [],
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
});

let stdout: string[];

function spyStdout(): void {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderOutcome — --json', () => {
  it('writes the whole CommandOutcome wrapper with the byte-identical envelope under .envelope', async () => {
    spyStdout();
    const render = vi.fn<(r: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const outcome: CommandOutcome = {
      kind: 'fit.run',
      status: 'ok',
      exitCode: 0,
      envelope: ENVELOPE,
    };

    await renderOutcome(outcome, { jsonRequested: true, render });

    expect(render).not.toHaveBeenCalled(); // JSON never renders Ink
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]) as CommandOutcome;
    expect(parsed.kind).toBe('fit.run');
    expect(parsed.envelope).toEqual(ENVELOPE); // the envelope is unchanged, just nested
  });

  it('writes nothing while embedded so a suite remains the sole output owner', async () => {
    spyStdout();
    const render = vi.fn<(r: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const outcome: CommandOutcome = {
      kind: 'history',
      status: 'ok',
      exitCode: 0,
      data: { type: 'help' },
    };

    await runEmbeddedRender(() => renderOutcome(outcome, { jsonRequested: true, render }));

    expect(render).not.toHaveBeenCalled();
    expect(stdout).toHaveLength(0);
  });
});

describe('renderOutcome — human', () => {
  it('renders the inner envelope and writes no JSON', async () => {
    spyStdout();
    const render = vi.fn<(r: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const outcome: CommandOutcome = {
      kind: 'fit.run',
      status: 'ok',
      exitCode: 0,
      envelope: ENVELOPE,
    };

    await renderOutcome(outcome, { jsonRequested: false, render });

    expect(render).toHaveBeenCalledWith(ENVELOPE);
    expect(stdout).toHaveLength(0);
  });

  it('renders the inner data result when there is no envelope', async () => {
    spyStdout();
    const data = { type: 'history' } as unknown as CommandResult;
    const render = vi.fn<(r: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const outcome: CommandOutcome = {
      kind: 'history',
      status: 'ok',
      exitCode: 0,
      data,
    };

    await renderOutcome(outcome, { jsonRequested: false, render });

    expect(render).toHaveBeenCalledWith(data);
  });

  it('renders nothing for a pure error outcome (its human presentation is owned elsewhere)', async () => {
    spyStdout();
    const render = vi.fn<(r: CommandResult) => Promise<void>>().mockResolvedValue(undefined);
    const outcome: CommandOutcome = {
      kind: 'bootstrap.error',
      status: 'error',
      exitCode: 2,
      errors: [{ message: 'no project' }],
    };

    await renderOutcome(outcome, { jsonRequested: false, render });

    expect(render).not.toHaveBeenCalled();
    expect(stdout).toHaveLength(0);
  });
});

/** Task 2 contract: renderOutcome + the emit* seams produce uniform outcomes. */
describe('renderOutcome contract — uniform across emitJson / emitEnvelope / emitError / result paths', () => {
  it('json path (used by emitJson/emitEnvelope under --json, emitError) always serializes the full wrapper', async () => {
    spyStdout();
    const render = vi.fn();
    const outcome: CommandOutcome = {
      kind: 'x.run',
      status: 'ok',
      exitCode: 0,
      data: { type: 'x' },
    };
    await renderOutcome(outcome, { jsonRequested: true, render });
    expect(stdout[0]).toContain('"kind": "x.run"');
    expect(render).not.toHaveBeenCalled();
  });
});

/**
 * OBS-JSON / ADR-0175 — on main, unguarded JSON.stringify throws, output-plane
 * catches, and a successful --json run emits zero stdout + RUNTIME_ERROR.
 */
describe('renderOutcome — guaranteed JSON fallback (ADR-0175)', () => {
  it('writes a fallback outcome document then rethrows when primary serialization fails', async () => {
    spyStdout();
    const render = vi.fn();
    // Intentionally hostile residual payload — envelope/data are not emit-normalized.
    const circular = { type: 'hostile' } as unknown as CommandResult & { self?: unknown };
    circular.self = circular;
    const outcome: CommandOutcome = {
      kind: 'fit.run',
      status: 'ok',
      exitCode: 0,
      data: circular,
    };

    await expect(renderOutcome(outcome, { jsonRequested: true, render })).rejects.toThrow(
      /circular|Converting circular/i,
    );
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]) as CommandOutcome;
    expect(parsed.kind).toBe('fit.run');
    expect(parsed.status).toBe('error');
    expect(parsed.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(parsed.errors?.[0]?.code).toBe(OUTCOME_SERIALIZE_FAILED_CODE);
    expect(parsed.envelope).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });

  it('renderRaw writes a compact fallback then rethrows on unserializable values', () => {
    spyStdout();
    expect(() => renderRaw(1n)).toThrow(/BigInt/i);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]) as {
      error: { code: string; message: string; valueType: string };
    };
    expect(parsed.error.code).toBe(OUTCOME_SERIALIZE_FAILED_CODE);
    expect(parsed.error.valueType).toBe('bigint');
  });
});
