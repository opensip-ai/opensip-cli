/**
 * output-plane render-failure branches (host-owned-run-timing §6.1). When the
 * single `renderOutcome` serialization seam rejects, each emit seam must (a)
 * surface — not swallow — the failure via a logged error, and (b) force a
 * non-success exit ONLY when the run had not already chosen a failure code
 * (specific codes like REPORT_FAILED must survive). `renderOutcome` is mocked
 * to reject so those catch arms are reachable without a real render crash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@opensip-cli/core';

const renderOutcome = vi.fn();
const renderRaw = vi.fn();

vi.mock('../../commands/render-outcome.js', () => ({
  renderOutcome: (...a: unknown[]) => renderOutcome(...a),
  renderRaw: (...a: unknown[]) => renderRaw(...a),
}));

const { createOutputPlane } = await import('../output-plane.js');

let savedExit: number | undefined;
let logged: Record<string, unknown>[];
let logger: Logger;

beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = 0;
  logged = [];
  logger = {
    error: (o: Record<string, unknown>) => logged.push(o),
  } as unknown as Logger;
  renderOutcome.mockReset();
  renderRaw.mockReset();
});

afterEach(() => {
  process.exitCode = savedExit;
  vi.restoreAllMocks();
});

/** Let the fire-and-forget `.catch` microtask settle. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('output-plane — render failure forces exit when the run had not failed', () => {
  it('emitJson logs and forces exit 1 from a clean run', async () => {
    renderOutcome.mockRejectedValue(new Error('render boom'));
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    plane.emits.emitJson({ type: 'x' });
    await tick();
    expect(plane.getExitCode()).toBe(1);
    expect(logged[0]).toMatchObject({ evt: 'cli.emit_json.render_failed' });
  });

  it('emitEnvelope logs and forces exit 1 from a clean run', async () => {
    renderOutcome.mockRejectedValue(new Error('render boom'));
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    plane.emits.emitEnvelope({ schemaVersion: 2 });
    await tick();
    expect(plane.getExitCode()).toBe(1);
    expect(logged[0]).toMatchObject({ evt: 'cli.emit_envelope.render_failed' });
  });

  it('preserves an already-chosen failure code instead of overwriting with 1', async () => {
    renderOutcome.mockRejectedValue('boom-string'); // also drives the non-Error coercion
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    plane.setExitCode(3); // a specific prior failure code (e.g. REPORT_FAILED)
    plane.emits.emitJson({ type: 'x' });
    await tick();
    expect(plane.getExitCode()).toBe(3); // not clobbered to 1
  });

  it('emitError forces exit 1 when the error detail itself indicated success (edge)', async () => {
    renderOutcome.mockRejectedValue(new Error('render boom'));
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    // detail.exitCode 0 → setExitCode(0) first; the catch then forces 1.
    plane.emits.emitError({ message: 'oops', exitCode: 0 });
    await tick();
    expect(plane.getExitCode()).toBe(1);
    expect(logged[0]).toMatchObject({ evt: 'cli.emit_error.render_failed' });
  });

  it('emitEnvelope preserves an already-chosen failure code', async () => {
    renderOutcome.mockRejectedValue(new Error('render boom'));
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    plane.setExitCode(4);
    plane.emits.emitEnvelope({ schemaVersion: 2 });
    await tick();
    expect(plane.getExitCode()).toBe(4);
  });

  it('emitError keeps the detail exit code when it already indicated failure', async () => {
    renderOutcome.mockRejectedValue(new Error('render boom'));
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    // detail.exitCode 2 → setExitCode(2); the catch sees a non-zero code and
    // does NOT clobber it to 1.
    plane.emits.emitError({ message: 'bad', exitCode: 2 });
    await tick();
    expect(plane.getExitCode()).toBe(2);
  });

  it('emitRaw routes through the renderRaw seam (no outcome wrapping)', () => {
    const plane = createOutputPlane({
      render: () => Promise.resolve(),
      logger,
    });
    plane.emits.emitRaw({ bare: true });
    expect(renderRaw).toHaveBeenCalledWith({ bare: true });
    expect(renderOutcome).not.toHaveBeenCalled();
  });
});
