/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * `renderFunctionRows` shared helper — §11.2 / §11.4.
 *
 * Three column configurations corresponding to the Hot/Big/Wide views:
 * verifies the helper produces the right header cells and the right
 * per-row cell values.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFunctionRowJs } from '../code-paths/function-row.js';

type RenderFn = (
  container: HTMLElement,
  rows: Record<string, unknown>[],
  cols: { label: string; value: (o: Record<string, unknown>) => unknown }[],
) => void;

function loadRenderFn(): RenderFn {
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
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  return new Function(elSrc + dashboardFunctionRowJs() + '\nreturn renderFunctionRows;')() as RenderFn;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('renderFunctionRows', () => {
  it('Hot view column shape: Function / Callers / Package / File', () => {
    const f = loadRenderFn();
    const c = document.createElement('div');
    f(c, [
      { simpleName: 'logger', __callers: 12, filePath: 'packages/core/src/lib/logger.ts:42' },
    ], [
      { label: 'Function', value: o => o.simpleName },
      { label: 'Callers', value: o => o.__callers },
      { label: 'Package', value: () => 'core' },
      { label: 'File', value: o => o.filePath },
    ]);
    // eslint-disable-next-line unicorn/prefer-spread -- TS NodeListOf iteration via spread requires lib.dom.iterable; Array.from is the portable form for the test target.
    const ths = Array.from(c.querySelectorAll('th'));
    expect(ths.map(t => t.textContent)).toEqual(['Function', 'Callers', 'Package', 'File']);
    // eslint-disable-next-line unicorn/prefer-spread -- See above.
    const tds = Array.from(c.querySelectorAll('tbody td'));
    expect(tds.map(t => t.textContent)).toEqual(['logger', '12', 'core', 'packages/core/src/lib/logger.ts:42']);
  });

  it('Big view column shape: Function / Lines / Kind / Package / File', () => {
    const f = loadRenderFn();
    const c = document.createElement('div');
    f(c, [{ simpleName: 'foo', __size: 42, kind: 'function-declaration', filePath: 'packages/x/src/x.ts:1' }], [
      { label: 'Function', value: o => o.simpleName },
      { label: 'Lines', value: o => o.__size },
      { label: 'Kind', value: o => o.kind },
      { label: 'Package', value: () => 'x' },
      { label: 'File', value: o => o.filePath },
    ]);
    expect(c.querySelectorAll('thead th').length).toBe(5);
  });

  it('Wide view shape includes a Signature column with the parameter thumb', () => {
    const f = loadRenderFn();
    const c = document.createElement('div');
    f(c, [{ simpleName: 'connect', __arity: 5, __thumb: '(a, b, c, d, e)', filePath: 'packages/x/x.ts:1' }], [
      { label: 'Function', value: o => o.simpleName },
      { label: 'Params', value: o => o.__arity },
      { label: 'Signature', value: o => o.__thumb },
      { label: 'Package', value: () => 'x' },
      { label: 'File', value: o => o.filePath },
    ]);
    const sigCell = c.querySelectorAll('tbody td')[2];
    expect(sigCell.textContent).toBe('(a, b, c, d, e)');
  });

  it('renders the empty state for zero rows', () => {
    const f = loadRenderFn();
    const c = document.createElement('div');
    f(c, [], [{ label: 'X', value: () => 'y' }]);
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
