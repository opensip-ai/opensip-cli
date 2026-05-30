/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View conformance — §10.1 invariant asserted at runtime.
 *
 * Every registered View must have:
 *  - id ∈ {hot, big, wide, coupling, untested, sccs, search, graph}
 *  - label: non-empty string
 *  - render: a function
 */

import { describe, expect, it } from 'vitest';

import { dashboardCodePathsJs } from '../code-paths.js';

const expectedIds = new Set([
  'hot',
  'big',
  'wide',
  'coupling',
  'untested',
  'sccs',
  'search',
  'graph',
]);

interface Probe {
  views: { id: string; label: string; render: unknown }[];
}

function loadViews(): Probe['views'] {
  const elSrc = `
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
var EDITOR_PROTOCOL = null;
`;
  const tail = `
return { views };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(elSrc + dashboardCodePathsJs() + tail);
  return (factory() as Probe).views;
}

describe('view conformance — §10.1', () => {
  it('exactly eight views are registered', () => {
    const views = loadViews();
    expect(views.length).toBe(8);
  });

  it('every view has a known id, non-empty label, and a render function', () => {
    const views = loadViews();
    for (const v of views) {
      expect(expectedIds.has(v.id)).toBe(true);
      expect(typeof v.label).toBe('string');
      expect(v.label.length).toBeGreaterThan(0);
      expect(typeof v.render).toBe('function');
    }
  });

  it('all expected ids are present', () => {
    const views = loadViews();
    const ids = new Set(views.map(v => v.id));
    for (const id of expectedIds) expect(ids.has(id)).toBe(true);
  });
});
