import { describe, it, expect } from 'vitest';

import { renderToText } from '../render-to-text.js';
import { line, group, type ViewNode } from '../view-model.js';

/** Matches any ANSI escape sequence. */
// eslint-disable-next-line no-control-regex -- matches the ESC byte to assert its absence
const ANSI = /\u001B\[/;

/** One node of every kind — the basis for the no-ANSI invariant. */
const ALL_KINDS: readonly ViewNode[] = [
  { kind: 'line', spans: [{ text: 'plain' }, { text: 'red', tone: 'error', bold: true }] },
  { kind: 'line', spans: [{ text: 'dimmed' }], dim: true },
  { kind: 'heading', text: 'Findings', tone: 'brand' },
  { kind: 'keyValues', pairs: [{ label: 'recipe', value: 'example' }] },
  {
    kind: 'table',
    columns: ['check', 'status'],
    rows: [[{ text: 'a' }, { text: 'PASS', tone: 'success' }]],
  },
  { kind: 'hints', items: [{ text: 'use --verbose', bold: ['--verbose'] }, { text: 'dashboard' }] },
  { kind: 'separator' },
  { kind: 'spacer' },
  { kind: 'group', children: [line('child')], indent: 2 },
];

describe('renderToText — no-ANSI invariant', () => {
  it.each(ALL_KINDS.map((n) => [n.kind, n] as const))(
    'emits zero ANSI for node kind %s',
    (_kind, node) => {
      expect(renderToText(node)).not.toMatch(ANSI);
    },
  );
});

describe('renderToText — content', () => {
  it('joins line spans without styling', () => {
    expect(renderToText({ kind: 'line', spans: [{ text: 'a' }, { text: 'b', tone: 'error' }] })).toBe('ab');
  });

  it('renders headings with == fences ==', () => {
    expect(renderToText({ kind: 'heading', text: 'Catalog' })).toBe('== Catalog ==');
  });

  it('renders key/value pairs one per line', () => {
    expect(
      renderToText({ kind: 'keyValues', pairs: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }] }),
    ).toBe('a: 1\nb: 2');
  });

  it('renders hints with two-space indent and pipe separators', () => {
    expect(
      renderToText({ kind: 'hints', items: [{ text: 'x' }, { text: 'y' }] }),
    ).toBe('  x | y');
  });

  it('indents group children', () => {
    const node = group([line('one'), line('two')], 2);
    expect(renderToText(node)).toBe('  one\n  two');
  });

  it('renders spacer as a blank line', () => {
    expect(renderToText({ kind: 'spacer' })).toBe('');
  });

  it('nests group indentation additively', () => {
    const node = group([group([line('deep')], 2)], 2);
    expect(renderToText(node)).toBe('    deep');
  });
});
