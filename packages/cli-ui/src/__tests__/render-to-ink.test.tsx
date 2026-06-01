import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { renderToInk } from '../render-to-ink.js';
import { ThemeProvider } from '../theme.js';
import { line, group, type ViewNode } from '../view-model.js';

/** Strip ANSI color sequences so we can assert on the visible text only. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- strips the ESC-introduced color codes from the Ink frame
  return s.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function frame(node: ViewNode): string {
  const { lastFrame } = render(<ThemeProvider>{renderToInk(node)}</ThemeProvider>);
  return stripAnsi(lastFrame() ?? '');
}

describe('renderToInk — visible text', () => {
  it('renders line span text', () => {
    expect(frame({ kind: 'line', spans: [{ text: 'hello ' }, { text: 'world', tone: 'success' }] })).toContain(
      'hello world',
    );
  });

  it('renders headings with == fences == (matches renderToText)', () => {
    expect(frame({ kind: 'heading', text: 'Catalog' })).toContain('== Catalog ==');
  });

  it('renders hints with pipe separators and two-space indent', () => {
    const out = frame({ kind: 'hints', items: [{ text: 'use --verbose', bold: ['--verbose'] }, { text: 'dashboard' }] });
    expect(out).toContain('use --verbose | dashboard');
    expect(out.startsWith('  ')).toBe(true);
  });

  it('indents group children', () => {
    const out = frame(group([line('one')], 2));
    expect(out).toContain('  one');
  });

  it('renders a table header and row cells', () => {
    const out = frame({
      kind: 'table',
      columns: ['check', 'status'],
      rows: [[{ text: 'a' }, { text: 'PASS', tone: 'success' }]],
    });
    expect(out).toContain('check  status');
    expect(out).toContain('a  PASS');
  });

  it('renders key/value pairs one per line', () => {
    const out = frame({ kind: 'keyValues', pairs: [{ label: 'recipe', value: 'example' }] });
    expect(out).toContain('recipe: example');
  });

  it('renders a separator rule', () => {
    expect(frame({ kind: 'separator' })).toContain('─');
  });

  it('renders a dim line without dropping its text', () => {
    expect(frame({ kind: 'line', spans: [{ text: 'note' }], dim: true })).toContain('note');
  });

  it('renders a group of mixed nodes incl. spacer', () => {
    const out = frame(group([line('top'), { kind: 'spacer' }, line('bottom')]));
    expect(out).toContain('top');
    expect(out).toContain('bottom');
  });
});
