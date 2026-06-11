import { describe, it, expect } from 'vitest';

import {
  buildSignalBatch,
  noopSignalSink,
  LanguageRegistry,
  RunScope,
  ToolRegistry,
} from '../index.js';

describe('noopSignalSink', () => {
  it('accepts nothing and never reports auth rejection', async () => {
    const batch = buildSignalBatch({ tool: 'fit', repo: {}, signals: [] });
    const result = await noopSignalSink.emit(batch);
    expect(result).toEqual({ accepted: 0, authRejected: false });
  });
});

describe('RunScope.signalSink', () => {
  it('defaults to the no-op sink', () => {
    const scope = new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
    expect(scope.signalSink).toBe(noopSignalSink);
  });

  it('carries an explicitly provided sink', () => {
    const custom = { emit: () => Promise.resolve({ accepted: 7, authRejected: false }) };
    const scope = new RunScope({
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
      signalSink: custom,
    });
    expect(scope.signalSink).toBe(custom);
  });
});
