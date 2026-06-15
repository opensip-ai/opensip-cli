import { describe, expect, it } from 'vitest';

import { buildMinimalTextTree } from '../languages/text-tree.js';

describe('buildMinimalTextTree', () => {
  it('returns the source, file path, and a line-starts index', () => {
    const tree = buildMinimalTextTree('foo\nbar', '/x.go');
    expect(tree.source).toBe('foo\nbar');
    expect(tree.filePath).toBe('/x.go');
    expect(tree.lineStarts).toEqual([0, 4]);
  });

  it('returns a tree for an empty string', () => {
    const tree = buildMinimalTextTree('', '/empty.go');
    expect(tree.source).toBe('');
    expect(tree.filePath).toBe('/empty.go');
    expect(tree.lineStarts).toEqual([0]);
  });

  it('records a line start past EOF when the source ends with a newline', () => {
    const tree = buildMinimalTextTree('a\n', '/x.go');
    expect(tree.lineStarts).toEqual([0, 2]);
  });

  it('handles consecutive newlines (blank lines)', () => {
    const tree = buildMinimalTextTree('\n\n', '/x.go');
    expect(tree.lineStarts).toEqual([0, 1, 2]);
  });

  it('preserves UTF-16 offsets for surrogate pairs', () => {
    const tree = buildMinimalTextTree('🚀\nx', '/x.go');
    // Rocket emoji is 2 UTF-16 code units; \n at index 2; line 1 at 3.
    expect(tree.source.length).toBe(4);
    expect(tree.lineStarts).toEqual([0, 3]);
  });
});
