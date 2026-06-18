/**
 * Narrow unit coverage for the egress plane (host-owned-run-timing Phase 6 §6.1
 * / Task 6.2). The plane is a thin delegator to `deliver-envelope`; these tests
 * mock that module and assert the two `ToolCliContext` egress seams forward the
 * right arguments — crucially that the output plane's `setExitCode` is threaded
 * into delivery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deliverEnvelope = vi.fn(() => Promise.resolve({ delivered: true }));
const writeEnvelopeSarif = vi.fn(() => Promise.resolve());

vi.mock('../deliver-envelope.js', () => ({
  deliverEnvelope: (...args: unknown[]) => deliverEnvelope(...args),
  writeEnvelopeSarif: (...args: unknown[]) => writeEnvelopeSarif(...args),
}));

// Import after the mock is registered.
const { createEgressPlane } = await import('../io-plane.js');

describe('createEgressPlane', () => {
  beforeEach(() => {
    deliverEnvelope.mockClear();
    writeEnvelopeSarif.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deliverSignals forwards mapped opts + the threaded setExitCode', async () => {
    const setExitCode = vi.fn();
    const plane = createEgressPlane({ setExitCode });
    const envelope = { tool: 'fit', signals: [] };

    await plane.deliverSignals(envelope, {
      cwd: '/proj',
      reportTo: 'cloud',
      apiKey: 'k',
      runFailed: true,
    });

    expect(deliverEnvelope).toHaveBeenCalledOnce();
    const [passedEnvelope, opts] = deliverEnvelope.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(passedEnvelope).toBe(envelope);
    expect(opts.cwd).toBe('/proj');
    expect(opts.reportTo).toBe('cloud');
    expect(opts.apiKey).toBe('k');
    expect(opts.runFailed).toBe(true);
    // The single exit-code authority from the output plane is threaded through.
    expect(opts.setExitCode).toBe(setExitCode);
  });

  it('writeSarif forwards (envelope, path) to the file sink', async () => {
    const plane = createEgressPlane({ setExitCode: vi.fn() });
    const envelope = { tool: 'graph', signals: [] };
    const sarifPath = 'reports/graph.sarif';

    await plane.writeSarif(envelope, sarifPath);

    expect(writeEnvelopeSarif).toHaveBeenCalledOnce();
    expect(writeEnvelopeSarif).toHaveBeenCalledWith(envelope, sarifPath);
  });
});
