/**
 * Narrow unit coverage for the output plane (host-owned-run-timing Phase 6 §6.1
 * / Task 6.2): the single `process.exitCode` write path and the four `--json`
 * emit seams. Each emit routes through the one `renderOutcome` serialization
 * seam, so these assert the JSON shape that reaches stdout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutputPlane } from '../output-plane.js';

import type { CommandResult } from '@opensip-cli/contracts';

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

describe('createOutputPlane — exit code (single write path)', () => {
  let saved: number | undefined;
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
  let saved: number | undefined;
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
    expect(out[0]).toMatch(/\n$/);
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
    const parsed = JSON.parse(out[0]) as { bare?: boolean; data?: unknown; status?: unknown };
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
      plane.emits.emitEnvelope({ schemaVersion: 1, tool: 'fit', signals: [] });
    } finally {
      restore();
    }
    // --json path serializes; the human renderer is inert here.
    expect(rendered).toHaveLength(0);
    const parsed = JSON.parse(out[0]) as { envelope?: { tool?: string } };
    expect(parsed.envelope?.tool).toBe('fit');
  });
});
