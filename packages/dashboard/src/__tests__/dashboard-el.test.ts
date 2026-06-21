/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * `el(tag, attrs, children)` DOM-builder unit tests.
 *
 * Imports `el` DIRECTLY from `src/client/el.ts` (not via the eval'd client
 * bundle) so the call graph sees a real test→`el` edge: `el` is a high-blast
 * helper used across every client view, and exercising it here makes it
 * test-reachable (clears graph:high-blast-untested). The direct import also
 * type-checks the helper against DOM lib at the call site.
 *
 * Branch coverage: the tag, every special attribute key (`text`, `class`,
 * `on*` event handler, plain pass-through attribute), and every child shape
 * (string → text node, Node → appended, `null`/`undefined` → skipped, and the
 * '' empty-string child which is still appended).
 */

import { describe, expect, it } from 'vitest';

import { el } from '../client/el.js';

describe('el', () => {
  it('creates an element of the requested tag', () => {
    const node = el('section');
    expect(node.tagName).toBe('SECTION');
    expect(node.attributes.length).toBe(0);
    expect(node.childNodes.length).toBe(0);
  });

  it('sets textContent via the `text` key', () => {
    const node = el('span', { text: 'hello' });
    expect(node.textContent).toBe('hello');
    // `text` is a special key — it must NOT appear as a DOM attribute.
    expect(node.hasAttribute('text')).toBe(false);
  });

  it('sets className via the `class` key', () => {
    const node = el('div', { class: 'a b' });
    expect(node.className).toBe('a b');
    expect(node.hasAttribute('class')).toBe(true);
  });

  it('wires an `on*` key as an event listener', () => {
    let clicks = 0;
    const node = el('button', {
      onclick: () => {
        clicks++;
      },
    });
    // The handler is attached, not stored as an attribute.
    expect(node.hasAttribute('onclick')).toBe(false);
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(2);
  });

  it('passes any other key through to setAttribute', () => {
    const node = el('a', { href: '/x', 'data-body-hash': 'h1', 'aria-label': 'go' });
    expect(node.getAttribute('href')).toBe('/x');
    expect(node.dataset.bodyHash).toBe('h1');
    expect(node.getAttribute('aria-label')).toBe('go');
  });

  it('appends string children as text nodes', () => {
    const node = el('p', undefined, ['one', 'two']);
    expect(node.textContent).toBe('onetwo');
    expect(node.childNodes.length).toBe(2);
    expect(node.firstChild!.nodeType).toBe(3 /* TEXT_NODE */);
  });

  it('appends Node children directly', () => {
    const child = el('strong', { text: 'bold' });
    const node = el('div', undefined, [child]);
    expect(node.childNodes.length).toBe(1);
    expect(node.firstChild).toBe(child);
    expect(node.querySelector('strong')!.textContent).toBe('bold');
  });

  it('skips null and undefined children', () => {
    const node = el('div', undefined, [null, undefined, 'kept', null]);
    expect(node.childNodes.length).toBe(1);
    expect(node.textContent).toBe('kept');
  });

  it('still appends an empty-string child (falsy but not null/undefined)', () => {
    const node = el('div', undefined, ['']);
    expect(node.childNodes.length).toBe(1);
    expect(node.firstChild!.nodeType).toBe(3 /* TEXT_NODE */);
    expect(node.textContent).toBe('');
  });

  it('combines attrs and mixed children in one call', () => {
    const inner = el('em', { text: 'x' });
    const node = el('li', { class: 'item', 'data-id': '7' }, ['a', inner, null, 'b']);
    expect(node.className).toBe('item');
    expect(node.dataset.id).toBe('7');
    expect(node.childNodes.length).toBe(3);
    expect(node.textContent).toBe('axb');
  });
});
