import { describe, expect, it } from 'vitest';

import { analyzeCallbackInvocationSafe } from '../callback-invocation-safe.js';

const SRC_FILE = 'packages/foo/src/notifier.ts';

describe('callback-invocation-safe', () => {
  it('flags unwrapped subscribers.forEach((cb) => cb(x))', () => {
    const src = `
      class Notifier {
        private subscribers: ((x: number) => void)[] = []
        notify(x: number) {
          this.subscribers.forEach((cb) => cb(x))
        }
      }
    `;
    const v = analyzeCallbackInvocationSafe(src, SRC_FILE);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]?.message).toMatch(/Direct callback invocation/);
  });

  it('flags unwrapped for-of over listeners', () => {
    const src = `
      class Bus {
        private listeners: (() => void)[] = []
        fire() {
          for (const cb of this.listeners) {
            cb()
          }
        }
      }
    `;
    const v = analyzeCallbackInvocationSafe(src, SRC_FILE);
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag when the invocation goes through a safe<Name>() wrapper', () => {
    const src = `
      class Notifier {
        private subscribers: ((x: number) => void)[] = []
        notify(x: number) {
          this.subscribers.forEach((cb) => this.safeInvokeSubscriber(cb, x))
        }
        private safeInvokeSubscriber(cb: any, x: number) {
          try { cb(x) } catch {}
        }
      }
    `;
    expect(analyzeCallbackInvocationSafe(src, SRC_FILE)).toHaveLength(0);
  });

  it('does NOT flag iteration over a non-callback-collection identifier', () => {
    const src = `
      const numbers = [1, 2, 3]
      numbers.forEach((n) => n)
      for (const x of numbers) { x }
    `;
    expect(analyzeCallbackInvocationSafe(src, SRC_FILE)).toHaveLength(0);
  });

  it('skips test files', () => {
    const src = `this.subscribers.forEach((cb) => cb())\n`;
    expect(analyzeCallbackInvocationSafe(src, 'packages/foo/src/__tests__/x.test.ts')).toHaveLength(
      0,
    );
  });

  it('skips files outside packages/', () => {
    const src = `this.subscribers.forEach((cb) => cb())\n`;
    expect(analyzeCallbackInvocationSafe(src, 'apps/web/src/x.ts')).toHaveLength(0);
  });

  it('honors the @callback-invocation-safe-by-caller pragma with a rationale', () => {
    const src = `
      // @callback-invocation-safe-by-caller -- caller wraps in try/catch
      this.subscribers.forEach((cb) => cb())
    `;
    expect(analyzeCallbackInvocationSafe(src, SRC_FILE)).toHaveLength(0);
  });

  it('flags bare pragma without rationale', () => {
    const src = `
      // @callback-invocation-safe-by-caller
      this.subscribers.forEach((cb) => cb())
    `;
    const v = analyzeCallbackInvocationSafe(src, SRC_FILE);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0]?.message).toContain('Bare pragmas are rejected');
  });
});
