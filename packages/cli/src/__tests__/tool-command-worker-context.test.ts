/**
 * tool-command-worker-context — unit coverage for the worker-side
 * {@link ToolCliContext} shim builder (ADR-0054 M4-C). Verifies the three seam
 * strategies in isolation: FRR seams record into the accumulator, RPC seams
 * issue a typed upcall through the (stub) RPC client, and the host-only
 * live-view seams throw {@link UnsupportedSeamError}.
 */

import { RunScope, createRunTimer } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildWorkerContext,
  UnsupportedSeamError,
  type ResultAccumulator,
} from '../bootstrap/tool-command-worker-context.js';

import type { HostRpcCall } from '../bootstrap/tool-command-dispatch-types.js';
import type { WorkerRpcClient } from '../bootstrap/tool-command-worker-rpc.js';

function makeStubClient(): { client: WorkerRpcClient; calls: HostRpcCall[] } {
  const calls: HostRpcCall[] = [];
  const client: WorkerRpcClient = {
    call: (request) => {
      calls.push(request);
      return Promise.resolve({ echoed: request.seam });
    },
    dispose: vi.fn(),
  };
  return { client, calls };
}

function build(): {
  ctx: ReturnType<typeof buildWorkerContext>;
  acc: ResultAccumulator;
  calls: HostRpcCall[];
} {
  const acc: ResultAccumulator = {};
  const { client, calls } = makeStubClient();
  const scope = new RunScope({ runId: 'r' });
  const ctx = buildWorkerContext(scope, createRunTimer(), acc, client);
  return { ctx, acc, calls };
}

describe('buildWorkerContext — FRR seams', () => {
  it('rejects render payloads over the captured-output cap', () => {
    const acc: ResultAccumulator = {};
    const { client } = makeStubClient();
    const scope = new RunScope({ runId: 'r' });
    const ctx = buildWorkerContext(scope, createRunTimer(), acc, client, 32);
    expect(() => {
      void ctx.render({ blob: 'x'.repeat(200) });
    }).toThrow(/exceeds cap/);
  });

  it('records render / json / envelope / raw / error / exitCode into the accumulator', async () => {
    const { ctx, acc } = build();
    await ctx.render({ r: 1 });
    ctx.emitJson({ j: 1 });
    ctx.emitEnvelope({ e: 1 });
    ctx.emitRaw('raw');
    ctx.emitError({ message: 'm', exitCode: 2, suggestion: 's', code: 'c' });
    ctx.setExitCode(0);
    expect(acc.render).toEqual({ r: 1 });
    expect(acc.json).toEqual({ j: 1 });
    expect(acc.envelope).toEqual({ e: 1 });
    expect(acc.raw).toBe('raw');
    expect(acc.error).toEqual({
      message: 'm',
      exitCode: 2,
      suggestion: 's',
      code: 'c',
    });
    expect(acc.exitCode).toBe(0);
    expect(ctx.getExitCode?.()).toBe(0);
  });

  it('emitError omits suggestion/code when undefined (conditional-spread else arms)', () => {
    const { ctx, acc } = build();
    // Neither suggestion nor code supplied ⇒ both conditional spreads take the
    // `{}` arm, so the accumulated error carries only message + exitCode.
    ctx.emitError({ message: 'bare', exitCode: 3 });
    expect(acc.error).toEqual({ message: 'bare', exitCode: 3 });
  });
});

describe('buildWorkerContext — RPC seams upcall the client', () => {
  it('toolState.* / saveBaseline / deliverSignals / artifact seams / baseline exports / report build typed requests', async () => {
    const { ctx, calls } = build();
    await ctx.toolState.put('t', 'k', { v: 1 });
    await ctx.toolState.get('t', 'k');
    await ctx.toolState.delete('t', 'k');
    await ctx.toolState.list('t');
    await ctx.saveBaseline('t', { env: 1 });
    await ctx.compareBaseline('t', { env: 1 });
    await ctx.exportBaselineSarif('t', '/a.sarif');
    await ctx.exportBaselineFingerprints('t', '/a.json');
    await ctx.writeSarif({ env: 1 }, '/b.sarif');
    await ctx.writeArtifact('/artifact.json', '{"ok":true}\n');
    await ctx.deliverSignals(
      { env: 1 },
      { cwd: '/x', reportTo: 'https://h', apiKey: 'secret', runFailed: true },
    );
    await ctx.maybeOpenReport({ openRequested: true, jsonOutput: false });

    const seams = calls.map((c) => c.seam);
    expect(seams).toEqual([
      'toolState.put',
      'toolState.get',
      'toolState.delete',
      'toolState.list',
      'saveBaseline',
      'compareBaseline',
      'exportBaselineSarif',
      'exportBaselineFingerprints',
      'writeSarif',
      'writeArtifact',
      'deliverSignals',
      'maybeOpenReport',
    ]);
    const deliver = calls.find((c) => c.seam === 'deliverSignals');
    expect(deliver).toMatchObject({
      opts: {
        cwd: '/x',
        reportTo: 'https://h',
        apiKey: 'secret',
        runFailed: true,
      },
    });
    expect(calls.find((c) => c.seam === 'writeArtifact')).toEqual({
      seam: 'writeArtifact',
      path: '/artifact.json',
      bytes: '{"ok":true}\n',
    });
  });

  it('omits the optional deliverSignals opts when they are undefined (conditional-spread else arms)', async () => {
    const { ctx, calls } = build();
    // Only `cwd` is set ⇒ the reportTo / apiKey / runFailed conditional spreads
    // all take their `{}` (absent) arm, so the marshaled opts carry cwd alone.
    await ctx.deliverSignals({ env: 1 }, { cwd: '/only-cwd' });
    const deliver = calls.find((c) => c.seam === 'deliverSignals');
    expect(deliver).toEqual({
      seam: 'deliverSignals',
      envelope: { env: 1 },
      opts: { cwd: '/only-cwd' },
    });
  });

  it('routes hostPlanes.<plane>.<method> through a generic hostPlane upcall', async () => {
    const { ctx, calls } = build();
    await ctx.hostPlanes?.audit?.append('t', { e: 1 });
    await ctx.hostPlanes?.entitlements?.check('t', 'run');
    expect(calls).toContainEqual({
      seam: 'hostPlane',
      plane: 'audit',
      method: 'append',
      args: ['t', { e: 1 }],
    });
    expect(calls).toContainEqual({
      seam: 'hostPlane',
      plane: 'entitlements',
      method: 'check',
      args: ['t', 'run'],
    });
  });
});

describe('buildWorkerContext — host-only seams fail loud', () => {
  it('registerLiveView / renderLive throw UnsupportedSeamError', () => {
    const { ctx } = build();
    expect(() => ctx.registerLiveView('k', () => undefined)).toThrow(UnsupportedSeamError);
    expect(() => ctx.renderLive('k', {})).toThrow(UnsupportedSeamError);
  });
});
