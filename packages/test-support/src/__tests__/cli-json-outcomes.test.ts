import { describe, expect, it } from 'vitest';

import { parseCliJsonOutcomes } from '../cli-json-outcomes.js';

describe('parseCliJsonOutcomes', () => {
  it('returns an empty array for blank stdout', () => {
    expect(parseCliJsonOutcomes('')).toEqual([]);
    expect(parseCliJsonOutcomes('   \n')).toEqual([]);
  });

  it('parses a single top-level JSON object', () => {
    const stdout = '{\n  "kind": "session",\n  "ok": true\n}\n';
    expect(parseCliJsonOutcomes(stdout)).toEqual([{ kind: 'session', ok: true }]);
  });

  it('splits multiple pretty-printed objects at line-leading braces', () => {
    const stdout = [
      '{',
      '  "kind": "history",',
      '  "count": 1',
      '}',
      '{',
      '  "kind": "suite",',
      '  "passed": false',
      '}',
      '',
    ].join('\n');
    expect(parseCliJsonOutcomes(stdout)).toEqual([
      { kind: 'history', count: 1 },
      { kind: 'suite', passed: false },
    ]);
  });

  it('ignores leading non-JSON noise before the first object', () => {
    const stdout = 'note: still running\n{"kind":"ok"}\n';
    expect(parseCliJsonOutcomes(stdout)).toEqual([{ kind: 'ok' }]);
  });
});
