/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Filter drawer — collapse/expand, active count, Clear button,
 * labeled groups (Package / Kind / Scope).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewsRegistryJs } from '../persistence/dashboard/code-paths/views-registry.js';

import type { GraphCatalog } from '../persistence/dashboard/code-paths/types.js';

interface FilterState {
  packages: Set<string>;
  kinds: Set<string>;
  includeTests: boolean;
  __open: boolean;
}

interface Env {
  filterState: FilterState;
  renderFilterChips: (container: HTMLElement, catalog: GraphCatalog) => void;
}

function loadEnv(): Env {
  const stubs = `
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
  return e;
}
let graphCatalog = null;
let graphIndexes = null;
`;
  const tail = `
return { filterState, renderFilterChips };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(stubs + dashboardPathUtilsJs() + dashboardViewsRegistryJs() + dashboardFiltersJs() + tail);
  return factory() as Env;
}

const sampleCatalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: 'now',
  functions: {
    a: [{
      qualifiedName: 'a', filePath: 'packages/cli/src/a.ts', line: 1, column: 0, endLine: 5,
      kind: 'function-declaration', params: [], returnType: null, enclosingClass: null,
      decorators: [], visibility: 'exported', inTestFile: false, definedInGenerated: false,
      calls: [], bodyHash: 'h1', simpleName: 'a',
    }],
    b: [{
      qualifiedName: 'b', filePath: 'packages/contracts/src/b.ts', line: 1, column: 0, endLine: 5,
      kind: 'method', params: [], returnType: null, enclosingClass: null,
      decorators: [], visibility: 'exported', inTestFile: false, definedInGenerated: false,
      calls: [], bodyHash: 'h2', simpleName: 'b',
    }],
  },
};

beforeEach(() => { document.body.innerHTML = ''; });

describe('Filter drawer', () => {
  it('renders collapsed by default with the Filters toggle and "none active" hint', () => {
    const env = loadEnv();
    const c = document.createElement('div');
    document.body.append(c);
    env.renderFilterChips(c, sampleCatalog);
    expect(c.querySelector('.code-paths-filter-toggle')).not.toBeNull();
    expect(c.querySelector('.code-paths-filter-count')!.textContent).toBe('none active');
    expect(c.querySelector('.code-paths-filter-body')).toBeNull();
  });

  it('clicking the toggle reveals labeled Package / Kind / Scope rows', () => {
    const env = loadEnv();
    const c = document.createElement('div');
    document.body.append(c);
    env.renderFilterChips(c, sampleCatalog);
    (c.querySelector<HTMLButtonElement>('.code-paths-filter-toggle'))!.click();
    expect(c.querySelector('.code-paths-filter-body')).not.toBeNull();
    // eslint-disable-next-line unicorn/prefer-spread -- NodeList spread requires lib.dom.iterable.
    const labels = Array.from(c.querySelectorAll('.code-paths-filter-label')).map(l => l.textContent);
    expect(labels).toEqual(['Package', 'Kind', 'Scope']);
  });

  it('shows the active-count when a chip is toggled on', () => {
    const env = loadEnv();
    const c = document.createElement('div');
    document.body.append(c);
    env.renderFilterChips(c, sampleCatalog);
    env.filterState.packages.add('cli');
    env.renderFilterChips(c, sampleCatalog);
    expect(c.querySelector('.code-paths-filter-count')!.textContent).toBe('1 active');
    expect(c.querySelector('.code-paths-filter-count')!.classList.contains('active')).toBe(true);
  });

  it('Clear button appears when any filter is active and resets state', () => {
    const env = loadEnv();
    env.filterState.packages.add('cli');
    env.filterState.kinds.add('method');
    env.filterState.includeTests = true;
    const c = document.createElement('div');
    document.body.append(c);
    env.renderFilterChips(c, sampleCatalog);
    expect(c.querySelector('.code-paths-filter-count')!.textContent).toBe('3 active');
    const clearBtn = c.querySelector<HTMLButtonElement>('.code-paths-filter-clear');
    expect(clearBtn).not.toBeNull();
    clearBtn!.click();
    expect(env.filterState.packages.size).toBe(0);
    expect(env.filterState.kinds.size).toBe(0);
    expect(env.filterState.includeTests).toBe(false);
    expect(c.querySelector('.code-paths-filter-clear')).toBeNull();
  });

  it('toggling a package chip updates the chip active state', () => {
    const env = loadEnv();
    const c = document.createElement('div');
    document.body.append(c);
    env.filterState.__open = true;
    env.renderFilterChips(c, sampleCatalog);
    const pkgChips = c.querySelectorAll<HTMLElement>('.code-paths-filter-row:nth-child(1) .code-paths-chip');
    expect(pkgChips.length).toBeGreaterThan(0);
    pkgChips[0].click();
    const refreshed = c.querySelectorAll<HTMLElement>('.code-paths-filter-row:nth-child(1) .code-paths-chip');
    expect(refreshed[0].classList.contains('active')).toBe(true);
    expect(env.filterState.packages.has(refreshed[0].textContent!)).toBe(true);
  });

  it('Scope row exposes Production-only / Include-tests as a radio pair', () => {
    const env = loadEnv();
    const c = document.createElement('div');
    document.body.append(c);
    env.filterState.__open = true;
    env.renderFilterChips(c, sampleCatalog);
    const radios = c.querySelectorAll<HTMLLabelElement>('.code-paths-filter-radio');
    expect(radios.length).toBe(2);
    expect(radios[0].textContent).toContain('Production only');
    expect(radios[1].textContent).toContain('Include tests');
    // Default: production-only is the active radio.
    expect(radios[0].classList.contains('active')).toBe(true);
    expect(radios[1].classList.contains('active')).toBe(false);
    radios[1].click();
    expect(env.filterState.includeTests).toBe(true);
    const refreshed = c.querySelectorAll<HTMLLabelElement>('.code-paths-filter-radio');
    expect(refreshed[1].classList.contains('active')).toBe(true);
  });
});
