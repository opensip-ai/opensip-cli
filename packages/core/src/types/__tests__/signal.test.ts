import { describe, it, expect } from 'vitest';

import { createSignal } from '../../types/signal.js';

import type { CreateSignalInput } from '../../types/signal.js';

describe('createSignal', () => {
  const minimalInput: CreateSignalInput = {
    source: 'test-check',
    severity: 'medium',
    ruleId: 'rule-01',
    message: 'Something is wrong',
  };

  it('produces a signal with correct required fields', () => {
    const signal = createSignal(minimalInput);
    expect(signal.source).toBe('test-check');
    expect(signal.severity).toBe('medium');
    expect(signal.ruleId).toBe('rule-01');
    expect(signal.message).toBe('Something is wrong');
  });

  it('generates an id with sig_ prefix', () => {
    const signal = createSignal(minimalInput);
    expect(signal.id).toMatch(/^sig_[0-9a-f-]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createSignal(minimalInput).id));
    expect(ids.size).toBe(50);
  });

  it('defaults provider to opensip-tools', () => {
    const signal = createSignal(minimalInput);
    expect(signal.provider).toBe('opensip-tools');
  });

  it('uses custom provider when supplied', () => {
    const signal = createSignal({ ...minimalInput, provider: 'custom-tool' });
    expect(signal.provider).toBe('custom-tool');
  });

  it('defaults category to quality', () => {
    const signal = createSignal(minimalInput);
    expect(signal.category).toBe('quality');
  });

  it('uses custom category when supplied', () => {
    const signal = createSignal({ ...minimalInput, category: 'security' });
    expect(signal.category).toBe('security');
  });

  it('defaults metadata to empty object', () => {
    const signal = createSignal(minimalInput);
    expect(signal.metadata).toEqual({});
  });

  it('passes through metadata when supplied', () => {
    const meta = { custom: 'data', count: 3 };
    const signal = createSignal({ ...minimalInput, metadata: meta });
    expect(signal.metadata).toEqual(meta);
  });

  it('sets filePath from code.file', () => {
    const signal = createSignal({
      ...minimalInput,
      code: { file: 'src/index.ts', line: 10, column: 5 },
    });
    expect(signal.filePath).toBe('src/index.ts');
    expect(signal.line).toBe(10);
    expect(signal.column).toBe(5);
    expect(signal.code).toEqual({ file: 'src/index.ts', line: 10, column: 5 });
  });

  it('defaults filePath to empty string when no code', () => {
    const signal = createSignal(minimalInput);
    expect(signal.filePath).toBe('');
    expect(signal.line).toBeUndefined();
    expect(signal.column).toBeUndefined();
  });

  it('maps fix fields to fixAction and fixConfidence', () => {
    const signal = createSignal({
      ...minimalInput,
      fix: { action: 'auto-fix', confidence: 0.9 },
    });
    expect(signal.fixAction).toBe('auto-fix');
    expect(signal.fixConfidence).toBe(0.9);
  });

  it('leaves fix fields undefined when not supplied', () => {
    const signal = createSignal(minimalInput);
    expect(signal.fixAction).toBeUndefined();
    expect(signal.fixConfidence).toBeUndefined();
  });

  it('sets createdAt as ISO string', () => {
    const before = new Date().toISOString();
    const signal = createSignal(minimalInput);
    const after = new Date().toISOString();
    expect(signal.createdAt >= before).toBe(true);
    expect(signal.createdAt <= after).toBe(true);
  });

  it('passes through suggestion', () => {
    const signal = createSignal({ ...minimalInput, suggestion: 'Fix it' });
    expect(signal.suggestion).toBe('Fix it');
  });

  it('leaves suggestion undefined when not supplied', () => {
    const signal = createSignal(minimalInput);
    expect(signal.suggestion).toBeUndefined();
  });
});
