import { createHash } from 'node:crypto';

import { err, ok } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { CatalogFreshnessController } from '../catalog-freshness-controller.js';
import {
  catalogGenerationKey,
  createGeneration,
  generationImpactIndex,
  GraphGenerationController,
  type GenerationControllerDeps,
} from '../catalog-generation.js';

import type { DataStore } from '@opensip-cli/datastore';
import type { Catalog, CatalogIdentity, FreshnessVerification } from '@opensip-cli/graph/read';

const identity = {
  language: 'typescript',
  cacheKey: 'ck',
  filesFingerprint: 'fp',
  builtAt: '2026-07-09T00:00:00.000Z',
};

describe('catalogGenerationKey', () => {
  it('returns g1: plus lowercase sha256 of the fixed tuple', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'opensip:mcp:catalog-generation',
          1,
          identity.language,
          identity.cacheKey,
          identity.filesFingerprint,
          identity.builtAt,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(catalogGenerationKey(identity)).toBe(`g1:${expected}`);
  });

  it('changes when any identity field drifts', () => {
    const base = catalogGenerationKey(identity);
    expect(catalogGenerationKey({ ...identity, language: 'python' })).not.toBe(base);
    expect(catalogGenerationKey({ ...identity, cacheKey: 'other' })).not.toBe(base);
    expect(catalogGenerationKey({ ...identity, filesFingerprint: 'x' })).not.toBe(base);
    expect(
      catalogGenerationKey({
        ...identity,
        builtAt: '2020-01-01T00:00:00.000Z',
      }),
    ).not.toBe(base);
  });

  it('safely encodes delimiter, control, and Unicode string components', () => {
    const hostile = {
      language: 'ts\u0000',
      cacheKey: 'café|cache',
      filesFingerprint: 'a|b\n路径|1|2',
      builtAt: identity.builtAt,
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'opensip:mcp:catalog-generation',
          1,
          hostile.language,
          hostile.cacheKey,
          hostile.filesFingerprint,
          hostile.builtAt,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(catalogGenerationKey(hostile)).toBe(`g1:${expected}`);
  });
});

describe('createGeneration', () => {
  it('stamps key and source', () => {
    const catalog: Catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: identity.builtAt,
      cacheKey: 'ck',
      filesFingerprint: 'fp',
      functions: {},
    };
    const gen = createGeneration(catalog, 'initial-load', identity);
    expect(gen.key).toBe(catalogGenerationKey(identity));
    expect(gen.source).toBe('initial-load');
    expect(gen.indexes).toBeDefined();
    expect(gen).not.toHaveProperty('identity');
  });

  it('builds one impact index per immutable generation and isolates requester cancellation', async () => {
    const firstGeneration = createGeneration(catalog('01'), 'initial-load');
    const [first, joined] = await Promise.all([
      generationImpactIndex(firstGeneration),
      generationImpactIndex(firstGeneration),
    ]);
    expect(joined).toBe(first);
    expect(firstGeneration.derived.impactIndex).toBe(first);
    expect(await generationImpactIndex(firstGeneration)).toBe(first);

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(generationImpactIndex(firstGeneration, cancelled.signal)).rejects.toMatchObject({
      name: 'ComputeImpactCancelledError',
    });
    expect(await generationImpactIndex(firstGeneration)).toBe(first);

    const nextGeneration = createGeneration(catalog('02'), 'persisted-auto-swap');
    expect(await generationImpactIndex(nextGeneration)).not.toBe(first);
  });

  it('keeps a shared impact build alive for an active waiter when its peer cancels', async () => {
    const generation = createGeneration(impactCatalog('03'), 'initial-load');
    const cancelled = new AbortController();
    const cancelledPending = generationImpactIndex(generation, cancelled.signal);
    const livePending = generationImpactIndex(generation);
    const flight = generation.derived.impactIndexBuild;

    expect(flight?.waiters).toBe(2);
    cancelled.abort();
    expect(flight?.controller.signal.aborted).toBe(false);

    await expect(cancelledPending).rejects.toMatchObject({
      name: 'ComputeImpactCancelledError',
    });
    const live = await livePending;
    expect(generation.derived.impactIndex).toBe(live);
    expect(generation.derived.impactIndexBuild).toBeUndefined();
    expect(await generationImpactIndex(generation)).toBe(live);
  });

  it('aborts after the final waiter cancels and lets a replacement flight cache', async () => {
    const generation = createGeneration(impactCatalog('04'), 'initial-load');
    const first = new AbortController();
    const second = new AbortController();
    const firstPending = generationImpactIndex(generation, first.signal);
    const secondPending = generationImpactIndex(generation, second.signal);
    const abandonedFlight = generation.derived.impactIndexBuild;

    first.abort();
    expect(abandonedFlight?.controller.signal.aborted).toBe(false);
    second.abort();
    expect(abandonedFlight?.controller.signal.aborted).toBe(true);
    expect(generation.derived.impactIndexBuild).toBeUndefined();
    expect(generation.derived.impactIndex).toBeUndefined();

    const replacementPending = generationImpactIndex(generation);
    const replacementFlight = generation.derived.impactIndexBuild;
    expect(replacementFlight).not.toBe(abandonedFlight);
    await expect(firstPending).rejects.toMatchObject({
      name: 'ComputeImpactCancelledError',
    });
    await expect(secondPending).rejects.toMatchObject({
      name: 'ComputeImpactCancelledError',
    });
    await expect(abandonedFlight?.promise).rejects.toMatchObject({
      name: 'ComputeImpactCancelledError',
    });

    const replacement = await replacementPending;
    expect(generation.derived.impactIndex).toBe(replacement);
    expect(await generationImpactIndex(generation)).toBe(replacement);
  });

  it('clears a failed impact build so a corrected generation can retry', async () => {
    const generation = createGeneration(impactCatalog('05', 1), 'initial-load');
    const occurrences = generation.catalog.functions.f0;
    expect(occurrences).toHaveLength(1);
    const original = occurrences?.[0];
    if (original === undefined || occurrences === undefined) return;
    const mutableOccurrences = occurrences as CatalogOccurrence[];
    mutableOccurrences[0] = { ...original, calls: undefined as never };

    await expect(generationImpactIndex(generation)).rejects.toBeInstanceOf(TypeError);
    expect(generation.derived.impactIndexBuild).toBeUndefined();
    expect(generation.derived.impactIndex).toBeUndefined();

    mutableOccurrences[0] = original;
    const retry = await generationImpactIndex(generation);
    expect(generation.derived.impactIndex).toBe(retry);
    expect(await generationImpactIndex(generation)).toBe(retry);
  });
});

const FRESH: FreshnessVerification = {
  fresh: true,
  verifiedAt: '2026-07-10T00:00:00.000Z',
  verification: 'complete',
};

function catalog(suffix: string): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: `2026-07-${suffix.padStart(2, '0')}T00:00:00.000Z`,
    cacheKey: `cache-${suffix}`,
    filesFingerprint: `files-${suffix}`,
    functions: {},
  };
}

type CatalogOccurrence = NonNullable<Catalog['functions'][string]>[number];

function impactCatalog(suffix: string, functionCount = 2048): Catalog {
  const functions: Record<string, CatalogOccurrence[]> = {};
  for (let index = 0; index < functionCount; index++) {
    const calls: CatalogOccurrence['calls'] =
      index === 0
        ? []
        : [
            {
              to: [`hash-${String(index - 1)}`],
              line: 1,
              column: 0,
              resolution: 'static',
              confidence: 'high',
              text: `f${String(index - 1)}()`,
            },
          ];
    functions[`f${String(index)}`] = [
      {
        bodyHash: `hash-${String(index)}`,
        simpleName: `f${String(index)}`,
        qualifiedName: `f${String(index)}`,
        filePath: `src/f${String(index)}.ts`,
        line: 1,
        column: 0,
        endLine: 2,
        kind: 'function-declaration',
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        visibility: 'module-local',
        inTestFile: false,
        definedInGenerated: false,
        calls,
      },
    ];
  }
  return { ...catalog(suffix), functions };
}

function identityOf(value: Catalog): CatalogIdentity {
  return {
    language: value.language,
    cacheKey: value.cacheKey,
    filesFingerprint: value.filesFingerprint ?? '',
    builtAt: value.builtAt,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function harness(initial = catalog('01')) {
  let persisted: Catalog | null = initial;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const verify = vi.fn<GenerationControllerDeps['verify']>(() => Promise.resolve(ok(FRESH)));
  const rebuild = vi.fn<GenerationControllerDeps['rebuild']>(() => {
    const value = catalog('09');
    persisted = value;
    return Promise.resolve(ok(value));
  });
  const controller = new GraphGenerationController({
    store: {} as DataStore,
    projectRoot: '/project',
    adapters: {
      size: 0,
      getAll: () => [],
      getById: () => undefined,
    },
    readIdentity: () => ok(persisted === null ? null : identityOf(persisted)),
    loadCatalog: () => ok(persisted),
    verify,
    rebuild,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return {
    controller,
    verify,
    rebuild,
    logs,
    persist(value: Catalog | null) {
      persisted = value;
    },
  };
}

describe('CatalogFreshnessController', () => {
  it('does not reuse a cache entry timestamped in the future after clock rollback', async () => {
    const generation = createGeneration(catalog('01'), 'initial-load');
    const verify = vi.fn(() => Promise.resolve(ok(FRESH)));
    const controller = new CatalogFreshnessController({
      projectRoot: '/project',
      adapters: {
        size: 0,
        getAll: () => [],
        getById: () => undefined,
      },
      verify,
      isCurrentGeneration: () => true,
    });
    controller.restore({
      key: generation.key,
      verifiedAtMs: Date.now() + 60_000,
      verdict: FRESH,
    });

    const result = await controller.verify(generation);

    expect(result.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

describe('GraphGenerationController', () => {
  it('preserves typed identity and load error arms', async () => {
    const common = {
      store: {} as DataStore,
      projectRoot: '/project',
      adapters: { size: 0, getAll: () => [], getById: () => undefined },
      verify: () => Promise.resolve(ok(FRESH)),
      rebuild: () => Promise.resolve(ok(catalog('09'))),
    } satisfies Omit<GenerationControllerDeps, 'readIdentity' | 'loadCatalog'>;
    const identityFailure = new GraphGenerationController({
      ...common,
      readIdentity: () => err({ code: 'IDENTITY_FAILED', message: 'private database path' }),
      loadCatalog: () => ok(null),
    });
    const identityResult = await identityFailure.capture();
    expect(identityResult.ok).toBe(false);
    if (!identityResult.ok) expect(identityResult.error.code).toBe('graph-read-failed');

    const value = catalog('01');
    const loadFailure = new GraphGenerationController({
      ...common,
      readIdentity: () => ok(identityOf(value)),
      loadCatalog: () => err({ code: 'LOAD_FAILED', message: 'private database path' }),
    });
    const loadResult = await loadFailure.capture();
    expect(loadResult.ok).toBe(false);
    if (!loadResult.ok) expect(loadResult.error.code).toBe('graph-read-failed');
  });

  it('retains the prior generation when a changed JSON payload fails structural load', async () => {
    const first = catalog('01');
    const second = catalog('02');
    let changed = false;
    const controller = new GraphGenerationController({
      store: {} as DataStore,
      projectRoot: '/project',
      adapters: { size: 0, getAll: () => [], getById: () => undefined },
      readIdentity: () => ok(identityOf(changed ? second : first)),
      loadCatalog: () =>
        changed
          ? err({
              code: 'GRAPH.READ.CATALOG_GENERATION',
              message: 'bounded load failure',
            })
          : ok(first),
      verify: () => Promise.resolve(ok(FRESH)),
      rebuild: () => Promise.resolve(ok(catalog('09'))),
    });
    const initial = await controller.capture();
    expect(initial.ok && initial.value).toBeDefined();
    const priorKey = initial.ok ? initial.value?.key : undefined;
    changed = true;
    const failed = await controller.capture();
    expect(failed.ok).toBe(false);
    expect(controller.peek()?.key).toBe(priorKey);
  });

  it.each([
    ['control', { language: 'ts\u0085' }],
    ['oversize', { cacheKey: 'x'.repeat(8193) }],
    ['fingerprint-control', { filesFingerprint: '\u0000private' }],
    ['timestamp', { builtAt: 'invalid' }],
    ['type', { cacheKey: 42 }],
  ])(
    'rejects hostile persisted %s identity and retains the prior opaque generation',
    async (_case, partial) => {
      const value = catalog('01');
      let hostile = false;
      const controller = new GraphGenerationController({
        store: {} as DataStore,
        projectRoot: '/project',
        adapters: { size: 0, getAll: () => [], getById: () => undefined },
        readIdentity: () =>
          ok(
            hostile ? ({ ...identityOf(value), ...partial } as CatalogIdentity) : identityOf(value),
          ),
        loadCatalog: () => ok(value),
        verify: () => Promise.resolve(ok(FRESH)),
        rebuild: () => Promise.resolve(ok(catalog('09'))),
      });
      const initial = await controller.capture();
      expect(initial.ok && initial.value).toBeDefined();
      const priorKey = initial.ok ? initial.value?.key : undefined;
      hostile = true;
      const failed = await controller.capture();
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('catalog-identity-invalid');
      expect(controller.peek()?.key).toBe(priorKey);
      expect(controller.peek()).not.toHaveProperty('identity');
    },
  );

  it('coalesces verification by generation without stale-flight cache corruption', async () => {
    const setup = harness();
    const verifyA = deferred<Awaited<ReturnType<GenerationControllerDeps['verify']>>>();
    const verifyB = deferred<Awaited<ReturnType<GenerationControllerDeps['verify']>>>();
    setup.verify.mockImplementation(({ catalog: value }) =>
      value.cacheKey === 'cache-01' ? verifyA.promise : verifyB.promise,
    );

    const capturedA = await setup.controller.capture();
    expect(capturedA.ok).toBe(true);
    if (!capturedA.ok || capturedA.value === undefined) return;
    const firstA = setup.controller.verifyCurrent(capturedA.value);
    const joinedA = setup.controller.verifyCurrent(capturedA.value);

    setup.persist(catalog('02'));
    const capturedB = await setup.controller.capture();
    expect(capturedB.ok).toBe(true);
    if (!capturedB.ok || capturedB.value === undefined) return;
    const firstB = setup.controller.verifyCurrent(capturedB.value);

    verifyB.resolve(ok({ ...FRESH, verifiedAt: '2026-07-10T00:00:02.000Z' }));
    const firstBResult = await firstB;
    expect(firstBResult.ok).toBe(true);
    const cachedB = await setup.controller.verifyCurrent(capturedB.value);
    expect(cachedB.ok).toBe(true);
    verifyA.resolve(ok({ ...FRESH, verifiedAt: '2026-07-10T00:00:01.000Z' }));
    await Promise.all([firstA, joinedA]);

    expect(setup.verify).toHaveBeenCalledTimes(2);
    const stillCachedB = await setup.controller.verifyCurrent(capturedB.value);
    expect(stillCachedB.ok).toBe(true);
    expect(setup.verify).toHaveBeenCalledTimes(2);
  });

  it('bypasses a completed freshness burst verdict when freshness is required', async () => {
    const setup = harness();
    const captured = await setup.controller.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok || captured.value === undefined) return;

    const first = await setup.controller.verifyCurrent(captured.value);
    const reused = await setup.controller.verifyCurrent(captured.value);
    expect(first.ok && reused.ok).toBe(true);
    expect(setup.verify).toHaveBeenCalledTimes(1);

    const fresh = await setup.controller.verifyCurrent(captured.value, {
      forceFresh: true,
    });
    expect(fresh.ok).toBe(true);
    expect(setup.verify).toHaveBeenCalledTimes(2);
  });

  it('emits one bounded freshness event for coalesced verification', async () => {
    const setup = harness();
    setup.verify.mockResolvedValueOnce(
      ok({
        ...FRESH,
        fresh: false,
        reasonCode: 'files-changed',
        changes: { added: 2, modified: 3, deleted: 1, sample: ['src/a.ts'] },
      }),
    );
    const captured = await setup.controller.capture();
    expect(captured.ok && captured.value).toBeDefined();
    if (!captured.ok || captured.value === undefined) return;

    await Promise.all([
      setup.controller.verifyCurrent(captured.value),
      setup.controller.verifyCurrent(captured.value),
    ]);

    const events = setup.logs.filter((entry) => entry.event.startsWith('mcp.graph.freshness.'));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'mcp.graph.freshness.complete',
      fields: {
        reasonCode: 'files-changed',
        verification: 'complete',
        resolutionMode: 'exact',
        engineMode: 'unknown',
        added: 2,
        modified: 3,
        deleted: 1,
        durationMs: expect.any(Number),
        fresh: false,
      },
    });
    expect(JSON.stringify(events)).not.toMatch(
      /project|catalog|cursor|query|symbol|package|filePath|specifier|src\/a\.ts/u,
    );
  });

  it('maps a thrown verifier to a typed error and permits retry', async () => {
    const setup = harness();
    setup.verify.mockRejectedValueOnce(new Error('private verifier failure'));
    const captured = await setup.controller.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok || captured.value === undefined) return;

    const failed = await setup.controller.verifyCurrent(captured.value);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('graph-read-failed');
    expect(setup.logs).toContainEqual({
      event: 'mcp.graph.freshness.failed',
      fields: {
        reasonCode: 'GRAPH.CATALOG.UNREADABLE',
        verification: 'failed',
        resolutionMode: 'exact',
        engineMode: 'unknown',
        durationMs: expect.any(Number),
        outcome: 'failed',
      },
    });
    expect(JSON.stringify(setup.logs)).not.toContain('private verifier failure');
    const retried = await setup.controller.verifyCurrent(captured.value);
    expect(retried.ok).toBe(true);
    expect(setup.verify).toHaveBeenCalledTimes(2);
  });

  it('latches a forced waiter onto an in-flight non-forced refresh', async () => {
    const setup = harness();
    const verification = deferred<Awaited<ReturnType<GenerationControllerDeps['verify']>>>();
    setup.verify.mockImplementation(() => verification.promise);

    const ordinary = setup.controller.refresh(false);
    await vi.waitFor(() => expect(setup.verify).toHaveBeenCalledTimes(1));
    const forced = setup.controller.refresh(true);
    verification.resolve(ok(FRESH));

    const [ordinaryResult, forcedResult] = await Promise.all([ordinary, forced]);
    expect(ordinaryResult.ok && ordinaryResult.value.action).toBe('rebuilt');
    expect(forcedResult.ok && forcedResult.value.action).toBe('rebuilt');
    expect(setup.rebuild).toHaveBeenCalledTimes(1);
  });

  it('reports initial persisted load as reloaded and subsequent refresh as no-op', async () => {
    const setup = harness();
    const first = await setup.controller.refresh();
    const second = await setup.controller.refresh();
    expect(first.ok && first.value.action).toBe('reloaded');
    expect(second.ok && second.value.action).toBe('no-op');
    expect(setup.rebuild).not.toHaveBeenCalled();
  });

  it('returns verify failure without rebuilding and retains a synced generation', async () => {
    const setup = harness();
    setup.verify.mockResolvedValueOnce(
      err({
        code: 'GRAPH.CATALOG.UNREADABLE',
        message: 'bounded verify failure',
      }),
    );
    const refreshed = await setup.controller.refresh();
    expect(refreshed.ok).toBe(false);
    if (refreshed.ok) return;
    expect(refreshed.error).toMatchObject({
      code: 'graph-refresh-failed',
      details: {
        failedPhase: 'verify',
        priorGenerationAvailable: true,
      },
    });
    expect(refreshed.error.details?.priorGenerationKey).toBe(setup.controller.peek()?.key);
    expect(refreshed.error.details?.currentGenerationKey).toBe(setup.controller.peek()?.key);
    expect(setup.rebuild).not.toHaveBeenCalled();
    expect(setup.controller.peek()).toBeDefined();
  });

  it('retains the prior generation when rebuild fails after persisted deletion', async () => {
    const setup = harness();
    const initial = await setup.controller.capture();
    expect(initial.ok && initial.value).toBeDefined();
    setup.persist(null);
    setup.rebuild.mockResolvedValueOnce(
      err({ code: 'rebuild-failed', message: 'bounded rebuild failure' }),
    );

    const refreshed = await setup.controller.refresh(true);
    expect(refreshed.ok).toBe(false);
    expect(setup.controller.peek()?.key).toBe(initial.ok ? initial.value?.key : undefined);
  });

  it('retains a successfully persisted forced rebuild on the next capture', async () => {
    const setup = harness();
    const rebuilt = await setup.controller.refresh(true);
    expect(rebuilt.ok && rebuilt.value.action).toBe('rebuilt');
    expect(setup.logs).toContainEqual({
      event: 'mcp.graph.generation.swapped',
      fields: {
        source: 'refresh-rebuild',
        mode: 'exact',
        priorAvailable: true,
        durationMs: expect.any(Number),
      },
    });
    const rebuiltKey = rebuilt.ok ? rebuilt.value.generation.key : undefined;
    const captured = await setup.controller.capture();
    expect(captured.ok && captured.value?.key).toBe(rebuiltKey);
    expect(setup.controller.peek()?.key).toBe(rebuiltKey);
  });

  it('restores the prior generation when persisted identity keeps churning', async () => {
    const a = catalog('01');
    const c = catalog('03');
    const d = catalog('04');
    const e = catalog('05');
    const sequence: { value?: Catalog[] } = {};
    let index = 0;
    let last = a;
    const events: string[] = [];
    const controller = new GraphGenerationController({
      store: {} as DataStore,
      projectRoot: '/project',
      adapters: { size: 0, getAll: () => [], getById: () => undefined },
      readIdentity: () => {
        const catalogs = sequence.value;
        last = catalogs?.[Math.min(index++, catalogs.length - 1)] ?? a;
        return ok(identityOf(last));
      },
      loadCatalog: () => ok(last),
      verify: () => Promise.resolve(ok(FRESH)),
      rebuild: () => Promise.resolve(ok(catalog('09'))),
      log: (event) => events.push(event),
    });
    const initial = await controller.capture();
    expect(initial.ok && initial.value?.key).toBe(catalogGenerationKey(identityOf(a)));
    events.length = 0;
    sequence.value = [c, c, d, d, e];
    index = 0;

    const churned = await controller.capture();
    expect(churned.ok).toBe(false);
    if (!churned.ok) expect(churned.error.code).toBe('catalog-churn');
    expect(controller.peek()?.key).toBe(catalogGenerationKey(identityOf(a)));
    expect(events).toEqual([]);
  });

  it('restores the prior generation when the final churn probe observes deletion', async () => {
    const a = catalog('01');
    const c = catalog('03');
    const sequence: { value?: readonly (Catalog | null)[] } = {};
    let index = 0;
    let last = a;
    const controller = new GraphGenerationController({
      store: {} as DataStore,
      projectRoot: '/project',
      adapters: { size: 0, getAll: () => [], getById: () => undefined },
      readIdentity: () => {
        const values = sequence.value;
        const next = values?.[Math.min(index++, values.length - 1)] ?? a;
        if (next === null) return ok(null);
        last = next;
        return ok(identityOf(next));
      },
      loadCatalog: () => ok(last),
      verify: () => Promise.resolve(ok(FRESH)),
      rebuild: () => Promise.resolve(ok(catalog('09'))),
    });
    const initial = await controller.capture();
    expect(initial.ok && initial.value?.key).toBe(catalogGenerationKey(identityOf(a)));

    // Load and confirm C, see C again on the retry probe, then observe a
    // deletion on the final stability probe. That is writer churn, not a
    // stable removal, so the already-served A generation must remain active.
    sequence.value = [c, c, c, null];
    index = 0;
    const churned = await controller.capture();

    expect(churned.ok).toBe(false);
    if (!churned.ok) expect(churned.error.code).toBe('catalog-churn');
    expect(controller.peek()?.key).toBe(catalogGenerationKey(identityOf(a)));
  });

  it('emits generation events only for successful transitions', async () => {
    const changing = [catalog('01'), catalog('02'), catalog('03'), catalog('04'), catalog('05')];
    let read = 0;
    const events: string[] = [];
    const controller = new GraphGenerationController({
      store: {} as DataStore,
      projectRoot: '/project',
      adapters: { size: 0, getAll: () => [], getById: () => undefined },
      readIdentity: () => ok(identityOf(changing[Math.min(read++, changing.length - 1)])),
      loadCatalog: () => ok(changing[Math.min(read, changing.length - 1)]),
      verify: () => Promise.resolve(ok(FRESH)),
      rebuild: () => Promise.resolve(ok(catalog('09'))),
      log: (event) => events.push(event),
    });

    const result = await controller.capture();
    expect(result.ok).toBe(false);
    expect(events.filter((event) => event.startsWith('mcp.graph.generation.'))).toEqual([]);
  });
});
