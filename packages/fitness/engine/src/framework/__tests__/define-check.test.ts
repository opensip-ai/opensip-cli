import { describe, expect, it } from 'vitest';

import { defineCheck } from '../define-check.js';

describe('defineCheck', () => {
  describe('analyze mode', () => {
    const noFooCheck = defineCheck({
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'no-foo',
      description: 'flag any line containing FOO',
      tags: ['quality'],
      analyze: (content, filePath) => {
        const out: { line: number; message: string; severity: 'error' | 'warning'; filePath: string }[] = [];
        const lines = content.split('\n');
        for (const [i, line] of lines.entries()) {
          if (line?.includes('FOO')) {
            out.push({ line: i + 1, message: 'FOO not allowed', severity: 'error', filePath });
          }
        }
        return out;
      },
    });

    it('returns a Check with the configured slug and id', () => {
      expect(noFooCheck.config.slug).toBe('no-foo');
      expect(noFooCheck.config.id).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('defaults itemType to "files"', () => {
      expect(noFooCheck.config.itemType).toBe('files');
    });

    it('marks scansFiles=true for analyze mode', () => {
      expect(noFooCheck.config.scansFiles).toBe(true);
    });

    it('records analysisMode "analyze"', () => {
      expect(noFooCheck.config.analysisMode).toBe('analyze');
    });

    it('preserves user-supplied tags', () => {
      expect(noFooCheck.config.tags).toEqual(['quality']);
    });

    it('exposes a getScope() and getMatcher() pair', () => {
      const scope = noFooCheck.getScope();
      expect(scope.include).toEqual([]);
      expect(noFooCheck.getMatcher('/tmp')).toBeDefined();
    });
  });

  describe('analyzeAll mode', () => {
    const allCheck = defineCheck({
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'all-mode-check',
      description: 'returns no violations',
      tags: ['demo'],
      // eslint-disable-next-line @typescript-eslint/require-await -- stub for shape verification
      analyzeAll: async () => [],
    });

    it('records analysisMode "analyzeAll"', () => {
      expect(allCheck.config.analysisMode).toBe('analyzeAll');
    });

    it('marks scansFiles=true for analyzeAll mode', () => {
      expect(allCheck.config.scansFiles).toBe(true);
    });
  });

  describe('command mode', () => {
    const cmd = defineCheck({
      id: '33333333-3333-4333-8333-333333333333',
      slug: 'cmd-check',
      description: 'shells out',
      tags: ['demo'],
      command: { bin: 'echo', args: ['hello'], parseOutput: () => [] },
    });

    it('records analysisMode "command"', () => {
      expect(cmd.config.analysisMode).toBe('command');
    });

    it('marks scansFiles=false for command mode', () => {
      expect(cmd.config.scansFiles).toBe(false);
    });
  });

  describe('scope handling', () => {
    it('passes through scope.languages and scope.concerns', () => {
      const c = defineCheck({
        id: '44444444-4444-4444-8444-444444444444',
        slug: 'scoped',
        description: 's',
        tags: ['demo'],
        scope: { languages: ['typescript', 'rust'], concerns: ['backend'] },
        analyze: () => [],
      });
      expect(c.config.checkScope?.languages).toEqual(['typescript', 'rust']);
      expect(c.config.checkScope?.concerns).toEqual(['backend']);
    });

    it('leaves checkScope undefined when scope is omitted', () => {
      const c = defineCheck({
        id: '55555555-5555-4555-8555-555555555555',
        slug: 'unscoped',
        description: 's',
        tags: ['demo'],
        analyze: () => [],
      });
      expect(c.config.checkScope).toBeUndefined();
    });
  });

  describe('runtime metadata passthrough', () => {
    it('preserves docs, disabled, confidence, and timeout', () => {
      const c = defineCheck({
        id: '66666666-6666-4666-8666-666666666666',
        slug: 'with-meta',
        description: 'meta',
        tags: ['demo'],
        docs: 'https://example.com/x',
        disabled: true,
        confidence: 'high',
        timeout: 1234,
        analyze: () => [],
      });
      expect(c.config.docs).toBe('https://example.com/x');
      expect(c.config.disabled).toBe(true);
      expect(c.config.confidence).toBe('high');
      expect(c.config.timeout).toBe(1234);
    });

    it('copies fileTypes when provided', () => {
      const c = defineCheck({
        id: '77777777-7777-4777-8777-777777777777',
        slug: 'typed',
        description: 'd',
        tags: ['demo'],
        fileTypes: ['ts', 'tsx'],
        analyze: () => [],
      });
      expect(c.config.fileTypes).toEqual(['ts', 'tsx']);
    });
  });

  describe('validation', () => {
    it('throws when id is missing', () => {
      expect(() =>
        // @ts-expect-error — testing the runtime guard
        defineCheck({ slug: 'no-id', description: 'd', tags: [], analyze: () => [] }),
      ).toThrow();
    });

    it('throws when id is not a UUID', () => {
      expect(() =>
        defineCheck({
          id: 'not-a-uuid',
          slug: 'bad-id',
          description: 'd',
          tags: ['demo'],
          analyze: () => [],
        }),
      ).toThrow();
    });

    it('throws when slug is missing', () => {
      expect(() =>
        defineCheck({
          id: '88888888-8888-4888-8888-888888888888',
          // @ts-expect-error — testing the runtime guard
          slug: undefined,
          description: 'd',
          tags: ['demo'],
          analyze: () => [],
        }),
      ).toThrow();
    });
  });
});
