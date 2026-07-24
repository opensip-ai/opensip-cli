import { describe, expect, it } from 'vitest';

import { createBoundedUtf8Capture } from '../bounded-text.js';

describe('createBoundedUtf8Capture', () => {
  it('decodes a multi-byte character split across chunk boundaries', () => {
    // 'é' is two UTF-8 bytes; split them across two appends.
    const full = Buffer.from('héllo', 'utf8');
    const capture = createBoundedUtf8Capture(100);
    capture.append(full.subarray(0, 2));
    capture.append(full.subarray(2));
    expect(capture.value).toBe('héllo');
    expect(capture.truncated).toBe(false);
  });

  it('decodes a 4-byte emoji split one byte per chunk', () => {
    const full = Buffer.from('😀', 'utf8');
    const capture = createBoundedUtf8Capture(100);
    for (let index = 0; index < full.length; index++) {
      capture.append(full.subarray(index, index + 1));
    }
    expect(capture.value).toBe('😀');
    expect(capture.truncated).toBe(false);
  });

  it('M18: does not leave a lone high surrogate when truncating mid-pair', () => {
    // U+1F600 😀 is a surrogate pair in JS strings (length 2).
    const capture = createBoundedUtf8Capture(1);
    capture.append(Buffer.from('😀', 'utf8'));
    expect(capture.truncated).toBe(true);
    // Cap of 1 code unit would cut after the high surrogate; drop it instead.
    expect(capture.value).toBe('');
    expect(capture.value).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('appends chunks until the limit is reached', () => {
    const capture = createBoundedUtf8Capture(6);
    capture.append(Buffer.from('abc'));
    capture.append(Buffer.from('def'));
    expect(capture.value).toBe('abcdef');
    expect(capture.truncated).toBe(false);
  });

  it('truncates at the configured limit', () => {
    const capture = createBoundedUtf8Capture(5);
    capture.append(Buffer.from('abc'));
    capture.append(Buffer.from('def'));
    expect(capture.value).toBe('abcde');
    expect(capture.truncated).toBe(true);
  });

  it('drops whole chunks once at the limit and reports truncation', () => {
    const capture = createBoundedUtf8Capture(3);
    capture.append(Buffer.from('abc'));
    expect(capture.truncated).toBe(false);
    capture.append(Buffer.from('xyz'));
    expect(capture.value).toBe('abc');
    expect(capture.truncated).toBe(true);
  });

  it('treats a zero cap as capture-nothing', () => {
    const capture = createBoundedUtf8Capture(0);
    capture.append(Buffer.from('abc'));
    expect(capture.value).toBe('');
    expect(capture.truncated).toBe(true);
  });

  it('does not report truncation for an empty or partial-only chunk at the limit', () => {
    const capture = createBoundedUtf8Capture(3);
    capture.append(Buffer.from('abc'));
    capture.append(Buffer.alloc(0));
    // First byte of a 2-byte sequence: decoder buffers it, emits nothing.
    capture.append(Buffer.from([0xc3]));
    expect(capture.value).toBe('abc');
    expect(capture.truncated).toBe(false);
  });

  it('drops a trailing incomplete sequence instead of emitting U+FFFD', () => {
    const capture = createBoundedUtf8Capture(100);
    capture.append(Buffer.from('ab', 'utf8'));
    capture.append(Buffer.from([0xc3])); // child killed mid-'é'
    expect(capture.value).toBe('ab');
    expect(capture.value).not.toContain('�');
  });
});
