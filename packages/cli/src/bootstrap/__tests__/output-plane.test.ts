/**
 * Narrow unit coverage for the output plane (host-owned-run-timing Phase 6 §6.1
 * / Task 6.2): the single `process.exitCode` write path and the four `--json`
 * emit seams. Each emit routes through the one `renderOutcome` serialization
 * seam, so these assert the JSON shape that reaches stdout.
 */

import {
  DEFAULT_BASELINE_IDENTITY,
  EXIT_CODES,
  type CommandOutcome,
  type CommandResult,
  type SignalEnvelope,
} from '@opensip-cli/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutputPlane } from '../output-plane.js';

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

function envelope(passed: boolean): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'run-test',
    createdAt: '2026-07-05T00:00:00.000Z',
    verdict: {
      score: passed ? 100 : 0,
      passed,
      summary: {
        total: 1,
        passed: passed ? 1 : 0,
        failed: passed ? 0 : 1,
        errors: passed ? 0 : 1,
        warnings: 0,
      },
    },
    units: [
      {
        slug: 'unit',
        passed,
        violationCount: passed ? 0 : 1,
        durationMs: 1,
      },
    ],
    signals: [],
    baselineIdentity: DEFAULT_BASELINE_IDENTITY,
  };
}

describe('createOutputPlane — exit code (single write path)', () => {
  let saved: typeof process.exitCode;
  beforeEach(() => {
    saved = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = saved;
  });

  it('setExitCode mirrors into process.exitCode and the captured value', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    expect(plane.getExitCode()).toBeUndefined();
    plane.setExitCode(2);
    expect(plane.getExitCode()).toBe(2);
    expect(process.exitCode).toBe(2);
  });
});

describe('createOutputPlane — emit seams', () => {
  let saved: typeof process.exitCode;
  beforeEach(() => {
    saved = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = saved;
  });

  it('emitJson serializes a CommandOutcome wrapping the value under .data', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitJson({ foo: 'bar' });
    } finally {
      restore();
    }
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]) as { data?: { foo?: string } };
    expect(parsed.data?.foo).toBe('bar');
    expect((parsed as CommandOutcome).exitCode).toBe(0);
    expect(out[0]).toMatch(/\n$/);
  });

  it('emitJson echoes the live exit holder when set', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    plane.setExitCode(3);
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitJson({ foo: 'bar' });
    } finally {
      restore();
    }
    const parsed = JSON.parse(out[0]) as CommandOutcome;
    expect(parsed.exitCode).toBe(3);
  });

  it('emitError sets the exit code and serializes a status:error outcome', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitError({ message: 'boom', exitCode: 3 });
    } finally {
      restore();
    }
    expect(plane.getExitCode()).toBe(3);
    const parsed = JSON.parse(out[0]) as { status?: string };
    expect(parsed.status).toBe('error');
  });

  it('emitRaw writes the bare value without the outcome wrapper', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitRaw({ bare: true });
    } finally {
      restore();
    }
    const parsed = JSON.parse(out[0]) as {
      bare?: boolean;
      data?: unknown;
      status?: unknown;
    };
    expect(parsed.bare).toBe(true);
    expect(parsed.data).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it('emitEnvelope nests the envelope under .envelope in human-render-inert json mode', () => {
    const rendered: CommandResult[] = [];
    const plane = createOutputPlane({
      render: (r) => {
        rendered.push(r);
        return Promise.resolve();
      },
    });
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitEnvelope(envelope(true));
    } finally {
      restore();
    }
    // --json path serializes; the human renderer is inert here.
    expect(rendered).toHaveLength(0);
    const parsed = JSON.parse(out[0]) as CommandOutcome;
    expect(parsed.envelope?.tool).toBe('fit');
    expect(parsed.exitCode).toBe(0);
  });

  it('emitEnvelope echoes the live exit holder when set', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    plane.setExitCode(4);
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitEnvelope(envelope(false));
    } finally {
      restore();
    }
    const parsed = JSON.parse(out[0]) as CommandOutcome;
    expect(parsed.exitCode).toBe(4);
  });

  it('emitEnvelope derives a failing exit when the holder is unset', () => {
    const plane = createOutputPlane({ render: () => Promise.resolve() });
    const { out, restore } = captureStdout();
    try {
      plane.emits.emitEnvelope(envelope(false));
    } finally {
      restore();
    }
    const parsed = JSON.parse(out[0]) as CommandOutcome;
    expect(parsed.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
  });
});
