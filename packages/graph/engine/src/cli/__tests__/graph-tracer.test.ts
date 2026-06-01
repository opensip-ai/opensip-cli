/**
 * `spanRunStage` — the span-emitting RunStage used by shard workers.
 *
 * Like the rest of the graph telemetry tests, these assert the standalone
 * no-op contract (no SDK is registered in the graph package) plus the wiring
 * that the stage result flows into `attrsFn`. Span-CAPTURE for the sharded
 * path (real spans, nested under the parent build via TRACEPARENT) lives in
 * `opensip-tools`, where the SDK legitimately lives.
 */

import { describe, it, expect, vi } from 'vitest';

import { spanRunStage } from '../graph-tracer.js';

describe('spanRunStage (sharded-worker stage spans)', () => {
  it('runs fn and returns its value with no SDK registered (no-op span)', () => {
    const run = spanRunStage({ 'opensip_tools.graph.shard_id': 's1' });
    const result = run('parse', undefined, undefined, () => 'OUT');
    expect(result).toBe('OUT');
  });

  it('passes the stage result to attrsFn so per-stage attributes are derived', () => {
    const run = spanRunStage();
    const attrsFn = vi.fn(() => ({ 'opensip_tools.graph.file_count': 3 }));
    const out = { files: [1, 2, 3] };
    run('discover', undefined, undefined, () => out, undefined, attrsFn);
    expect(attrsFn).toHaveBeenCalledWith(out);
  });

  it('tolerates base attrs + a no-op span without throwing', () => {
    const run = spanRunStage({ 'opensip_tools.graph.shard_id': 's2' });
    expect(() => run('resolve', undefined, undefined, () => undefined)).not.toThrow();
  });
});
