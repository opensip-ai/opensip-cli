import { describe, expect, it } from 'vitest';

import { hashFileContent, hashFunctionBody, makeFunctionId, parseFunctionId } from '../catalog/ids.js';

describe('makeFunctionId / parseFunctionId', () => {
  it('round-trips a typical id', () => {
    const id = makeFunctionId({ contentHash: 'abc123', filePath: 'src/foo.ts', simpleName: 'bar' });
    expect(id).toBe('fn:abc123@src/foo.ts#bar');
    expect(parseFunctionId(id)).toEqual({ contentHash: 'abc123', filePath: 'src/foo.ts', simpleName: 'bar' });
  });

  it('rejects ids without the prefix', () => {
    expect(parseFunctionId('not:abc@x#y')).toBeNull();
  });

  it('rejects ids missing the @', () => {
    expect(parseFunctionId('fn:abc')).toBeNull();
  });

  it('rejects ids missing the #', () => {
    expect(parseFunctionId('fn:abc@src/foo.ts')).toBeNull();
  });

  it('takes the last # as the simpleName boundary', () => {
    const id = 'fn:abc@src/foo#bar.ts#baz';
    expect(parseFunctionId(id)).toEqual({
      contentHash: 'abc',
      filePath: 'src/foo#bar.ts',
      simpleName: 'baz',
    });
  });

  it('rejects ids with empty components', () => {
    expect(parseFunctionId('fn:@src/foo.ts#bar')).toBeNull();
    expect(parseFunctionId('fn:abc@#bar')).toBeNull();
    expect(parseFunctionId('fn:abc@src/foo.ts#')).toBeNull();
  });
});

describe('hashFunctionBody', () => {
  it('returns a stable 16-char hex hash', () => {
    const h = hashFunctionBody('return 1;');
    expect(h).toMatch(/^[\da-f]{16}$/);
  });

  it('whitespace-collapses inputs (formatting changes do not change the hash)', () => {
    const a = hashFunctionBody('return 1;');
    const b = hashFunctionBody('  return    1;  ');
    const c = hashFunctionBody('return\n1;');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('different bodies produce different hashes', () => {
    expect(hashFunctionBody('return 1;')).not.toBe(hashFunctionBody('return 2;'));
  });
});

describe('hashFileContent', () => {
  it('returns a sha256 hex string', () => {
    const h = hashFileContent('hello world');
    expect(h).toMatch(/^[\da-f]{64}$/);
  });

  it('is content-sensitive (whitespace matters at the file level)', () => {
    expect(hashFileContent('a')).not.toBe(hashFileContent('a '));
  });
});
