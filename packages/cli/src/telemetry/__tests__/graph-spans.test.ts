/**
 * Graph stage-span CAPTURE test — the in-process counterpart to Phase 4's
 * real-collector validation.
 *
 * This lives in `opensip-tools` because the OTel SDK + InMemorySpanExporter
 * legitimately live here (the application boundary), keeping the SDK out of the
 * `@opensip-tools/graph` tool package. We register an in-memory provider, run
 * `runGraph` over a synthetic fixture, and assert:
 *
 *   1. enabled ⇒ one `opensip_tools.graph.<stage>` span per GRAPH_STAGES entry
 *      is produced, in GRAPH_STAGES order, each carrying the
 *      `opensip_tools.graph.stage` attribute, plus the orchestrator-level
 *      attributes (file_count on discover, cache_hit on index, rule/signal
 *      counts on rules);
 *   2. parent nesting ⇒ under an active parent context, all stage spans share
 *      the parent's trace id (proving consumer TRACEPARENT propagation works);
 *   3. disabled (no provider) ⇒ a run produces zero spans (standalone no-op).
 *
 * What this validates IN-PROCESS vs what a real collector still needs:
 *   - IN-PROCESS (here): span production, names, order, attributes, parent-trace
 *     nesting, and the standalone no-op — using InMemorySpanExporter.
 *   - REQUIRES A REAL COLLECTOR (Phase 4, not runnable in CI): OTLP/HTTP export
 *     over the wire to an `otel-collector`, end-to-end resource-attribute
 *     propagation from a spawned subprocess (OTEL_RESOURCE_ATTRIBUTES +
 *     TRACEPARENT env), and the no-network-attempt guarantee in standalone mode.
 *     Those are documented in docs/plans/ready/telemetry-opt-in/phase-4-validation.md.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithScope, type RunScope } from '@opensip-tools/core';
import { makeTestScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { currentAdapterRegistry, graphTool, type GraphLanguageAdapter } from '@opensip-tools/graph';
import { runGraph, GRAPH_STAGES } from '@opensip-tools/graph/internal';
import {
  ROOT_CONTEXT,
  context as otelContext,
  defaultTextMapGetter,
  trace,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GRAPH_TRACER_PREFIX = 'opensip_tools.graph.';

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'fake',
    discoverFiles: () => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts'), join(projectDir, 'src', 'b.ts')],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: () => ({ project: { token: 'parsed' }, parseErrors: [] }),
    walkProject: () => ({ occurrences: {}, callSites: [], parseErrors: [] }),
    resolveCallSites: () => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'fake-key-1',
    ruleHints: undefined,
  };
}

function makeGraphScope(): RunScope {
  const scope = makeTestScope();
  Object.assign(scope, graphTool.contributeScope?.() ?? {});
  return scope;
}

const FIXTURE_DIR = join(tmpdir(), 'graph-spans-fixture');

/** Drive `runGraph` over the synthetic fixture, optionally under a parent ctx. */
async function runOverFixture(parent?: Context): Promise<void> {
  await runWithScope(makeGraphScope(), async () => {
    currentAdapterRegistry().register(fakeAdapter(FIXTURE_DIR));
    const exec = (): Promise<unknown> => runGraph({ cwd: FIXTURE_DIR, noCache: true, rules: [] });
    await (parent ? otelContext.with(parent, exec) : exec());
  });
}

describe('graph stage spans — in-process capture (in-memory exporter)', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    exporter.reset();
  });

  it('produces one stage span per GRAPH_STAGES entry in canonical order with the stage attribute', async () => {
    await runOverFixture();

    const spans = exporter.getFinishedSpans();
    const stageSpans = spans.filter((s) => s.name.startsWith(GRAPH_TRACER_PREFIX));
    // Spans finish in the order each stage's fn returns, i.e. GRAPH_STAGES order.
    const names = stageSpans.map((s) => s.name);
    expect(names).toEqual(GRAPH_STAGES.map((stage) => `${GRAPH_TRACER_PREFIX}${stage}`));

    // Every stage span carries the stage attribute.
    for (const span of stageSpans) {
      expect(span.attributes['opensip_tools.graph.stage']).toBeTypeOf('string');
    }
  });

  it('attaches orchestrator-level attributes (file_count, cache_hit, rule/signal counts)', async () => {
    await runOverFixture();
    const byName = new Map(exporter.getFinishedSpans().map((s) => [s.name, s.attributes] as const));

    expect(byName.get('opensip_tools.graph.discover')?.['opensip_tools.graph.file_count']).toBe(2);
    expect(byName.get('opensip_tools.graph.index')?.['opensip_tools.graph.cache_hit']).toBe(false);
    expect(byName.get('opensip_tools.graph.rules')?.['opensip_tools.graph.rule_count']).toBe(0);
    expect(byName.get('opensip_tools.graph.rules')?.['opensip_tools.graph.signal_count']).toBe(0);
  });

  it('nests every stage span under a parent trace (TRACEPARENT propagation)', async () => {
    // Simulate the embedding consumer's TRACEPARENT.
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const parent = new W3CTraceContextPropagator().extract(
      ROOT_CONTEXT,
      { traceparent },
      defaultTextMapGetter,
    );

    await runOverFixture(parent);

    const stageSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith(GRAPH_TRACER_PREFIX));
    expect(stageSpans).toHaveLength(GRAPH_STAGES.length);
    for (const span of stageSpans) {
      expect(span.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    }
  });

  it('emits NOTHING when no provider is registered (standalone no-op)', async () => {
    // Tear down the provider so the global tracer is the API no-op facade.
    await provider.shutdown();
    trace.disable();
    const standaloneExporter = new InMemorySpanExporter();

    await runOverFixture();

    // Nothing was exported anywhere.
    expect(standaloneExporter.getFinishedSpans()).toHaveLength(0);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
