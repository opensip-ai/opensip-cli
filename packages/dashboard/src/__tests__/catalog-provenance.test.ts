/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Explore-tab catalog provenance bar. The Explore views render from the single
 * cached catalog (the latest `graph` build, whatever its scope); this bar tells
 * the reader what that catalog covers, so a scoped/stale build (the
 * `graph packages/contracts` footgun) reads as "1 package" instead of looking
 * broken. Values are derived from the embedded catalog itself (ground truth).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface Env {
  renderCatalogProvenance: (host: HTMLElement, catalog: GraphCatalog | null) => void;
}

function loadEnv(): Env {
  // `renderCatalogProvenance` (with `el`, `packagesInCatalog`) now lives in the
  // typed client bundle (L4) and is exposed as a page global; `var sessions = []`
  // satisfies checks.ts's load-time `computeCheckStats()` read.
  const tail = `return { renderCatalogProvenance };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function('var sessions = [];\n' + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as Env;
}

function occ(pkg: string, name: string): GraphFunctionOccurrence {
  return {
    qualifiedName: name,
    simpleName: name,
    bodyHash: pkg + ':' + name,
    filePath: 'packages/' + pkg + '/src/' + name + '.ts',
    package: '@opensip-cli/' + pkg,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  } as unknown as GraphFunctionOccurrence;
}

function catalog(over: Partial<GraphCatalog>): GraphCatalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: new Date().toISOString(),
    functions: {},
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('catalog provenance bar', () => {
  it('shows a single-package scope (the scoped-run footgun) with the package name inline', () => {
    const env = loadEnv();
    const host = document.createElement('div');
    env.renderCatalogProvenance(
      host,
      catalog({
        cacheKey: 'eng=0.1.0|mode=exact|ts-x',
        functions: { a: [occ('contracts', 'a')], b: [occ('contracts', 'b')] },
      }),
    );
    const bar = host.querySelector('.catalog-provenance');
    expect(bar).not.toBeNull();
    const text = bar?.textContent ?? '';
    expect(text).toContain('1 package');
    expect(text).toContain('contracts');
    // 2 occurrences across the single package.
    expect(text).toContain('2');
    // engine parsed from the cache key.
    expect(text.toLowerCase()).toContain('exact');
  });

  it('shows the full multi-package scope as a count (not an inline list)', () => {
    const env = loadEnv();
    const host = document.createElement('div');
    const functions: Record<string, GraphFunctionOccurrence[]> = {};
    for (const p of ['core', 'cli', 'contracts', 'datastore', 'output', 'targeting']) {
      functions[p] = [occ(p, p + 'Fn')];
    }
    env.renderCatalogProvenance(
      host,
      catalog({ cacheKey: 'eng=0.1.0|mode=sharded|s-34', functions }),
    );
    const text = host.querySelector('.catalog-provenance')?.textContent ?? '';
    expect(text).toContain('6 packages');
    // Names are NOT inlined past the small-set threshold (kept compact).
    expect(text).not.toContain(': core,');
    expect(text.toLowerCase()).toContain('sharded');
  });

  it('flags fast (approximate) resolution and omits the flag for exact', () => {
    const env = loadEnv();
    const fastHost = document.createElement('div');
    env.renderCatalogProvenance(
      fastHost,
      catalog({
        cacheKey: 'eng=0.1.0|mode=exact|x',
        resolutionMode: 'fast',
        functions: { a: [occ('core', 'a')] },
      }),
    );
    expect(fastHost.querySelector('.catalog-provenance')?.textContent ?? '').toContain(
      'approximate',
    );

    const exactHost = document.createElement('div');
    env.renderCatalogProvenance(
      exactHost,
      catalog({
        cacheKey: 'eng=0.1.0|mode=exact|x',
        resolutionMode: 'exact',
        functions: { a: [occ('core', 'a')] },
      }),
    );
    expect(exactHost.querySelector('.catalog-provenance')?.textContent ?? '').not.toContain(
      'approximate',
    );
  });

  it('no-ops when there is no catalog', () => {
    const env = loadEnv();
    const host = document.createElement('div');
    env.renderCatalogProvenance(host, null);
    expect(host.querySelector('.catalog-provenance')).toBeNull();
  });
});
