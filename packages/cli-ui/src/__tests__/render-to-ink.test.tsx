import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { renderToInk } from '../render-to-ink.js';
import { ThemeProvider } from '../theme.js';
import { line, group, type ViewNode } from '../view-model.js';

/** Strip ANSI escapes so we can assert on the visible text only. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
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
});
