import { runCheckOnFixture } from '@opensip-tools/fitness/internal';
import { describe, expect, it } from 'vitest';

import {
  analyzeUnimplementedMarkers,
  noUnimplementedMarkers,
} from '../checks/no-unimplemented-markers.js';

describe('analyzeUnimplementedMarkers', () => {
  describe('TypeScript / JavaScript', () => {
    it('flags throw new Error with a not-implemented message', () => {
      const v = analyzeUnimplementedMarkers(`throw new Error('not implemented')`, 'a.ts');
      expect(v).toHaveLength(1);
      expect(v[0]?.line).toBe(1);
      expect(v[0]?.severity).toBe('warning');
    });

    it('flags "unimplemented" phrasing too', () => {
      const v = analyzeUnimplementedMarkers(`throw new Error("unimplemented")`, 'a.js');
      expect(v).toHaveLength(1);
    });

    it('flags throw new NotImplementedError', () => {
      const v = analyzeUnimplementedMarkers(`throw new NotImplementedError()`, 'a.tsx');
      expect(v).toHaveLength(1);
    });

    it('flags a bare NotImplementedError() call', () => {
      const v = analyzeUnimplementedMarkers(`return NotImplementedError('x')`, 'a.mjs');
      expect(v).toHaveLength(1);
    });

    it('does NOT flag a plain throw with an unrelated message', () => {
      const v = analyzeUnimplementedMarkers(`throw new Error('connection refused')`, 'a.ts');
      expect(v).toHaveLength(0);
    });

    it('does NOT flag a normal string that merely contains a marker word', () => {
      const v = analyzeUnimplementedMarkers(
        `const msg = 'TODO: not implemented section header'`,
        'a.ts',
      );
      expect(v).toHaveLength(0);
    });

    it('does NOT flag the idiom when quoted as markdown inline-code (doc prose)', () => {
      // e.g. a check longDescription: "Stub methods that `throw new Error('Not implemented')`".
      const v = analyzeUnimplementedMarkers(
        "Detects stub methods that `throw new Error('Not implemented')` in prod",
        'a.ts',
      );
      expect(v).toHaveLength(0);
    });

    it('STILL flags a real throw using a template-literal message', () => {
      const v = analyzeUnimplementedMarkers('throw new Error(`not implemented: ${name}`)', 'a.ts');
      expect(v).toHaveLength(1);
    });
  });

  describe('Python', () => {
    it('flags raise NotImplementedError with a message', () => {
      const v = analyzeUnimplementedMarkers(`raise NotImplementedError("soon")`, 'a.py');
      expect(v).toHaveLength(1);
    });

    it('flags bare raise NotImplementedError', () => {
      const v = analyzeUnimplementedMarkers(`    raise NotImplementedError`, 'a.py');
      expect(v).toHaveLength(1);
    });

    it('does NOT flag an ellipsis stub body or pass', () => {
      const v = analyzeUnimplementedMarkers(`def f():\n    ...\n\ndef g():\n    pass`, 'a.py');
      expect(v).toHaveLength(0);
    });
  });

  describe('Rust', () => {
    it('flags todo!() macro', () => {
      const v = analyzeUnimplementedMarkers(`    todo!()`, 'a.rs');
      expect(v).toHaveLength(1);
    });

    it('flags unimplemented!() macro', () => {
      const v = analyzeUnimplementedMarkers(`    unimplemented!("later")`, 'a.rs');
      expect(v).toHaveLength(1);
    });

    it('does NOT flag a normal function body', () => {
      const v = analyzeUnimplementedMarkers(`fn f() -> i32 { 1 + 1 }`, 'a.rs');
      expect(v).toHaveLength(0);
    });
  });

  describe('Go', () => {
    it('flags panic with a not-implemented message', () => {
      const v = analyzeUnimplementedMarkers(`    panic("not implemented")`, 'a.go');
      expect(v).toHaveLength(1);
    });

    it('flags panic with a TODO message', () => {
      const v = analyzeUnimplementedMarkers(`    panic("TODO: wire this up")`, 'a.go');
      expect(v).toHaveLength(1);
    });

    it('does NOT flag a panic with an unrelated runtime message', () => {
      const v = analyzeUnimplementedMarkers(`    panic("index out of range")`, 'a.go');
      expect(v).toHaveLength(0);
    });
  });

  describe('Java', () => {
    it('flags throw new UnsupportedOperationException', () => {
      const v = analyzeUnimplementedMarkers(
        `throw new UnsupportedOperationException("Not supported yet.");`,
        'A.java',
      );
      expect(v).toHaveLength(1);
    });

    it('does NOT flag an ordinary exception throw', () => {
      const v = analyzeUnimplementedMarkers(`throw new IllegalArgumentException("bad");`, 'A.java');
      expect(v).toHaveLength(0);
    });
  });

  describe('C / C++', () => {
    it('flags throw std::logic_error with a not-implemented message', () => {
      const v = analyzeUnimplementedMarkers(`throw std::logic_error("not implemented");`, 'a.cpp');
      expect(v).toHaveLength(1);
    });

    it('flags an assert(... && "not implemented") stub', () => {
      const v = analyzeUnimplementedMarkers(`assert(false && "unimplemented path");`, 'a.h');
      expect(v).toHaveLength(1);
    });

    it('does NOT flag an unrelated logic_error or assert', () => {
      const v = analyzeUnimplementedMarkers(
        `throw std::logic_error("size mismatch");\nassert(x > 0);`,
        'a.cc',
      );
      expect(v).toHaveLength(0);
    });
  });

  describe('dispatch + edge cases', () => {
    it('returns [] for an unsupported extension', () => {
      const v = analyzeUnimplementedMarkers(`throw new Error('not implemented')`, 'a.txt');
      expect(v).toHaveLength(0);
    });

    it('counts at most one violation per line', () => {
      const v = analyzeUnimplementedMarkers(
        `throw new NotImplementedError('not implemented')`,
        'a.ts',
      );
      expect(v).toHaveLength(1);
    });

    it('reports accurate line numbers across a multi-line file', () => {
      const src = `line one\nthrow new Error('not implemented')\nline three`;
      const v = analyzeUnimplementedMarkers(src, 'a.ts');
      expect(v).toHaveLength(1);
      expect(v[0]?.line).toBe(2);
    });
  });

  describe('check wrapper (real execution)', () => {
    const marker = `export const compute = (): number => {\n  throw new Error('not implemented')\n}\n`;

    it('skips test files', async () => {
      const run = await runCheckOnFixture(noUnimplementedMarkers, {
        files: [{ path: 'foo.test.ts', content: marker }],
      });
      expect(run.findings).toHaveLength(0);
    });

    it('flags production source files', async () => {
      const run = await runCheckOnFixture(noUnimplementedMarkers, {
        files: [{ path: 'foo.ts', content: marker }],
      });
      expect(run.findings).toHaveLength(1);
    });
  });
});
